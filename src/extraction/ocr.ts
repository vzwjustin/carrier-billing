import { randomUUID } from 'node:crypto';
import * as Sentry from '@sentry/nextjs';
import {
  TextractClient,
  DetectDocumentTextCommand,
  StartDocumentTextDetectionCommand,
  GetDocumentTextDetectionCommand,
  type Block,
} from '@aws-sdk/client-textract';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { env } from '@/env';

/**
 * Lazy AWS Textract client. Mirrors the stripe/anthropic pattern so missing
 * AWS credentials at build/test time don't crash module evaluation.
 */
export function hasAwsCredentials(): boolean {
  return !!(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);
}

let cachedTextract: TextractClient | null = null;
export function getTextractClient(): TextractClient {
  if (cachedTextract) return cachedTextract;
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
    throw new OcrError('AWS credentials not configured — OCR unavailable');
  }
  cachedTextract = new TextractClient({
    region: env.AWS_REGION,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  });
  return cachedTextract;
}

/** Lazy S3 client used to stage PDFs for the async Textract path. */
let cachedS3: S3Client | null = null;
export function getS3Client(): S3Client {
  if (cachedS3) return cachedS3;
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
    throw new OcrError('AWS credentials not configured — S3 unavailable');
  }
  cachedS3 = new S3Client({
    region: env.AWS_REGION,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  });
  return cachedS3;
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
 * Routing (bug #4): Textract's synchronous `DetectDocumentText` accepts
 * SINGLE-PAGE documents only — a multi-page PDF MUST use the async
 * `StartDocumentTextDetection` path regardless of byte size, or Textract
 * rejects it with `UnsupportedDocumentException`. So we only take the sync
 * path when the document is known to be a single page AND under the 5 MB
 * sync cap; everything else (multi-page, oversized, or unknown page count)
 * goes async, which requires `AWS_TEXTRACT_S3_BUCKET`.
 */
export async function extractTextWithOCR(
  buffer: Buffer,
  opts?: { pageCount?: number },
): Promise<string> {
  const pageCount = opts?.pageCount;
  // Require EXACTLY 1 page for sync: pdf-parse uses 0 as its "unknown page
  // count" sentinel, and an unknown count must route async (safer for a
  // possibly-multi-page doc) rather than risk Textract's single-page-only
  // sync API rejecting it.
  const knownSinglePage = pageCount === 1;
  if (knownSinglePage && buffer.byteLength <= SYNC_MAX_BYTES) {
    return runSync(buffer);
  }
  return runAsync(buffer);
}

async function runSync(buffer: Buffer): Promise<string> {
  const client = getTextractClient();
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
 * Async multi-page Textract path:
 *   1. Stage the PDF to S3 under a unique key
 *   2. StartDocumentTextDetection pointing at the S3 object
 *   3. Poll GetDocumentTextDetection every 5s for up to 5 minutes
 *   4. Concatenate `LINE` blocks across paginated results
 *   5. Always delete the S3 object in `finally`
 */
async function runAsync(buffer: Buffer): Promise<string> {
  const bucket = env.AWS_TEXTRACT_S3_BUCKET;
  if (!bucket) {
    throw new OcrError('Async Textract requires AWS_TEXTRACT_S3_BUCKET to be configured.');
  }

  const key = `carrieraudit/textract-staging/${randomUUID()}.pdf`;
  const s3 = getS3Client();
  const textract = getTextractClient();

  // Step 1: upload. If this fails there's nothing to clean up yet.
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: buffer,
        ContentType: 'application/pdf',
      }),
    );
  } catch (err) {
    throw new OcrError('Failed to stage PDF to S3 for async Textract', err);
  }

  try {
    // Step 2: start the async Textract job.
    let jobId: string | undefined;
    try {
      const started = (await textract.send(
        new StartDocumentTextDetectionCommand({
          DocumentLocation: { S3Object: { Bucket: bucket, Name: key } },
        }),
      )) as unknown as { JobId?: string };
      jobId = started.JobId;
    } catch (err) {
      throw new OcrError('Failed to start Textract job', err);
    }
    if (!jobId) {
      throw new OcrError('Textract did not return a JobId');
    }

    // Steps 3-4: poll and aggregate.
    return await pollJob(jobId);
  } finally {
    // Cleanup is best-effort: bucket lifecycle from
    // `scripts/configure-textract-bucket.ts` reaps orphans daily. We swallow
    // errors here so a cleanup failure doesn't mask an OCR result the caller
    // is awaiting, but we surface them to Sentry so persistent leaks show up.
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    } catch (cleanupErr) {
      Sentry.captureException(cleanupErr, {
        level: 'warning',
        tags: { module: 'extraction.ocr', op: 's3_cleanup' },
        extra: { bucket, keyPrefix: 'carrieraudit/textract-staging/' },
      });
    }
  }
}

/**
 * Poll an async Textract job until it completes or the wall-clock deadline
 * elapses. Returns the concatenated `LINE` text across all paginated pages.
 */
async function pollJob(jobId: string): Promise<string> {
  const client = getTextractClient();
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  const lines: Block[] = [];

  while (Date.now() < deadline) {
    let typed: {
      JobStatus?: string;
      StatusMessage?: string;
      Blocks?: Block[];
      NextToken?: string;
    };
    try {
      const out = await client.send(new GetDocumentTextDetectionCommand({ JobId: jobId }));
      // The SDK's send() return type is a giant union; we narrow off the
      // response shape we know GetDocumentTextDetection returns at runtime.
      typed = out as unknown as {
        JobStatus?: string;
        StatusMessage?: string;
        Blocks?: Block[];
        NextToken?: string;
      };
    } catch (err) {
      throw new OcrError('Textract polling failed', err);
    }

    const status = typed.JobStatus;
    if (status === 'FAILED') {
      throw new OcrError(`Textract job failed: ${typed.StatusMessage ?? ''}`.trim());
    }
    if (status === 'SUCCEEDED' || status === 'PARTIAL_SUCCESS') {
      if (status === 'PARTIAL_SUCCESS') {
        Sentry.captureMessage('Textract PARTIAL_SUCCESS — OCR output may be incomplete', {
          level: 'warning',
          tags: { module: 'extraction.ocr', op: 'textract_poll' },
          extra: { jobId },
        });
      }
      lines.push(...(typed.Blocks ?? []));
      let token = typed.NextToken;
      while (token) {
        try {
          const next = (await client.send(
            new GetDocumentTextDetectionCommand({
              JobId: jobId,
              NextToken: token,
            }),
          )) as unknown as { Blocks?: Block[]; NextToken?: string };
          lines.push(...(next.Blocks ?? []));
          token = next.NextToken;
        } catch (err) {
          throw new OcrError('Textract pagination failed', err);
        }
      }
      return collectLines(lines);
    }

    // Throw immediately on any status we don't recognise — do not silently
    // drain the polling deadline and misreport as a timeout.
    if (status && status !== 'IN_PROGRESS') {
      throw new OcrError(`Unexpected Textract job status: ${status}`);
    }

    // IN_PROGRESS — wait and retry, but not past deadline.
    if (Date.now() + POLL_INTERVAL_MS >= deadline) break;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new OcrError('Textract job timed out after 5 minutes');
}

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

/** Test-only: reset cached clients so vi.mock can swap implementations. */
export function __resetClientsForTests(): void {
  cachedTextract = null;
  cachedS3 = null;
}
