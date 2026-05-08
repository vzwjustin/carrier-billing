import {
  TextractClient,
  DetectDocumentTextCommand,
  StartDocumentTextDetectionCommand,
  GetDocumentTextDetectionCommand,
  type Block,
} from '@aws-sdk/client-textract';
import { env } from '@/env';

/**
 * Lazy AWS Textract client. Mirrors the stripe/anthropic pattern so missing
 * AWS credentials at build/test time don't crash module evaluation.
 */
let cached: TextractClient | null = null;
function getClient(): TextractClient {
  if (cached) return cached;
  cached = new TextractClient({
    region: env.AWS_REGION,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  });
  return cached;
}

export class OcrError extends Error {
  public override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'OcrError';
    this.cause = cause;
  }
}

// Textract sync API caps documents around 5 MB / single page. Multi-page
// scanned PDFs must use the async API which requires the document to be in S3.
const SYNC_MAX_BYTES = 5 * 1024 * 1024;

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Extract plain text from a (likely scanned) PDF using AWS Textract. Used as
 * a fallback when `pdf-parse` returns too little text. Concatenates all
 * `BlockType === 'LINE'` blocks separated by newlines.
 *
 * For small (<5MB) buffers we use the synchronous `DetectDocumentTextCommand`.
 * For larger / multi-page buffers we use the async pattern via S3.
 *
 * TODO(phase-1.5): wire S3 upload for async Textract; current async path
 * assumes the buffer can be uploaded by the caller — for now the sync path
 * is the primary code path for Phase 1.
 */
export async function extractTextWithOCR(buffer: Buffer): Promise<string> {
  if (buffer.byteLength <= SYNC_MAX_BYTES) {
    return runSync(buffer);
  }
  return runAsync(buffer);
}

async function runSync(buffer: Buffer): Promise<string> {
  const client = getClient();
  try {
    const out = await client.send(
      new DetectDocumentTextCommand({
        Document: { Bytes: buffer },
      }),
    );
    return collectLines(out.Blocks ?? []);
  } catch (err) {
    throw new OcrError('Textract sync detection failed', err);
  }
}

/**
 * Async multi-page Textract path. Requires the PDF to live in S3 — the
 * caller must arrange the upload and pass a `{ bucket, key }` reference.
 *
 * In Phase 1 we don't have an S3 staging bucket wired up yet, so this path
 * throws a clear error explaining what's needed. Phase 1.5 will plumb the
 * staging bucket through.
 */
async function runAsync(buffer: Buffer): Promise<string> {
  throw new OcrError(
    `Async Textract path requires S3 staging which is not yet wired up. ` +
      `Bill (${buffer.length} bytes) exceeds the 5MB sync limit; defer OCR to Phase 1.5.`,
  );
}

/**
 * Internal: poll an async Textract job until it completes or times out.
 * Exported shape kept private; used only when the async path is wired.
 */
async function _pollJob(jobId: string): Promise<string> {
  const client = getClient();
  const startedAt = Date.now();
  const lines: Block[] = [];

  // Pagination across NextToken once the job succeeds.
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    const out = await client.send(
      new GetDocumentTextDetectionCommand({ JobId: jobId }),
    );
    const status = out.JobStatus;
    if (status === 'FAILED') {
      throw new OcrError(`Textract job failed: ${out.StatusMessage ?? ''}`);
    }
    if (status === 'SUCCEEDED') {
      lines.push(...(out.Blocks ?? []));
      let token = out.NextToken;
      while (token) {
        const next = await client.send(
          new GetDocumentTextDetectionCommand({
            JobId: jobId,
            NextToken: token,
          }),
        );
        lines.push(...(next.Blocks ?? []));
        token = next.NextToken;
      }
      return collectLines(lines);
    }
    // Status is IN_PROGRESS or PARTIAL_SUCCESS — wait and retry.
    await sleep(POLL_INTERVAL_MS);
  }
  throw new OcrError('Textract job timed out');
}

// Keep the helper referenced so tooling doesn't strip it; it's part of the
// async path that Phase 1.5 will activate.
void _pollJob;
void StartDocumentTextDetectionCommand;

function collectLines(blocks: Block[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.BlockType === 'LINE' && typeof b.Text === 'string') {
      out.push(b.Text);
    }
  }
  return out.join('\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
