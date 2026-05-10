import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// SDK mocks. We replace the AWS SDKs with fake constructors and command
// classes so no real AWS calls happen and we can assert on call ordering.
// ---------------------------------------------------------------------------

type SendCall = { command: string; input: unknown };

// Hoist mock-side state so `vi.mock` factories (which run before the rest of
// the module body) can reference them. Without `vi.hoisted`, the classes
// would be in the temporal-dead-zone when the factories execute.
const { sentryCaptureException } = vi.hoisted(() => ({
  sentryCaptureException: vi.fn(),
}));
vi.mock('@sentry/nextjs', () => ({
  captureException: sentryCaptureException,
}));

const {
  textractSend,
  s3Send,
  FakeDetectDocumentTextCommand,
  FakeStartDocumentTextDetectionCommand,
  FakeGetDocumentTextDetectionCommand,
  FakePutObjectCommand,
  FakeDeleteObjectCommand,
} = vi.hoisted(() => {
  class FakeDetectDocumentTextCommand {
    public readonly __name = 'DetectDocumentTextCommand';
    constructor(public readonly input: unknown) {}
  }
  class FakeStartDocumentTextDetectionCommand {
    public readonly __name = 'StartDocumentTextDetectionCommand';
    constructor(public readonly input: unknown) {}
  }
  class FakeGetDocumentTextDetectionCommand {
    public readonly __name = 'GetDocumentTextDetectionCommand';
    constructor(public readonly input: unknown) {}
  }
  class FakePutObjectCommand {
    public readonly __name = 'PutObjectCommand';
    constructor(public readonly input: unknown) {}
  }
  class FakeDeleteObjectCommand {
    public readonly __name = 'DeleteObjectCommand';
    constructor(public readonly input: unknown) {}
  }
  return {
    textractSend: vi.fn(),
    s3Send: vi.fn(),
    FakeDetectDocumentTextCommand,
    FakeStartDocumentTextDetectionCommand,
    FakeGetDocumentTextDetectionCommand,
    FakePutObjectCommand,
    FakeDeleteObjectCommand,
  };
});

vi.mock('@aws-sdk/client-textract', () => {
  return {
    TextractClient: class {
      send = textractSend;
    },
    DetectDocumentTextCommand: FakeDetectDocumentTextCommand,
    StartDocumentTextDetectionCommand: FakeStartDocumentTextDetectionCommand,
    GetDocumentTextDetectionCommand: FakeGetDocumentTextDetectionCommand,
  };
});

vi.mock('@aws-sdk/client-s3', () => {
  return {
    S3Client: class {
      send = s3Send;
    },
    PutObjectCommand: FakePutObjectCommand,
    DeleteObjectCommand: FakeDeleteObjectCommand,
  };
});

// Mock env so we can flip AWS_TEXTRACT_S3_BUCKET on/off per test.
vi.mock('@/env', () => {
  return {
    env: {
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'AKIA-test',
      AWS_SECRET_ACCESS_KEY: 'secret-test',
      AWS_TEXTRACT_S3_BUCKET: 'carrieraudit-textract-staging-test',
    },
  };
});

// Import under test AFTER the mocks are registered.
import {
  extractTextWithOCR,
  OcrError,
  __resetClientsForTests,
} from '@/extraction/ocr';
import { env } from '@/env';

const SYNC_BUFFER = Buffer.alloc(1024, 0); // ≤5MB → sync path
function asyncBuffer(): Buffer {
  // 6 MB → triggers the async path
  return Buffer.alloc(6 * 1024 * 1024 + 1, 0);
}

function recordCalls(mock: ReturnType<typeof vi.fn>): SendCall[] {
  return mock.mock.calls.map(([cmd]) => {
    const c = cmd as { __name: string; input: unknown };
    return { command: c.__name, input: c.input };
  });
}

beforeEach(() => {
  textractSend.mockReset();
  s3Send.mockReset();
  sentryCaptureException.mockReset();
  __resetClientsForTests();
  // Restore default bucket before each test
  (env as { AWS_TEXTRACT_S3_BUCKET?: string }).AWS_TEXTRACT_S3_BUCKET =
    'carrieraudit-textract-staging-test';
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Sync path
// ---------------------------------------------------------------------------

describe('extractTextWithOCR — sync path', () => {
  it('returns concatenated LINE blocks for small buffers', async () => {
    textractSend.mockResolvedValueOnce({
      Blocks: [
        { BlockType: 'PAGE' },
        { BlockType: 'LINE', Text: 'Verizon Business' },
        { BlockType: 'WORD', Text: 'ignored' },
        { BlockType: 'LINE', Text: 'Account number: ****1234' },
        { BlockType: 'LINE' /* no Text → skipped */ },
      ],
    });

    const out = await extractTextWithOCR(SYNC_BUFFER);

    expect(out).toBe('Verizon Business\nAccount number: ****1234');
    expect(textractSend).toHaveBeenCalledTimes(1);
    const call = recordCalls(textractSend)[0];
    expect(call?.command).toBe('DetectDocumentTextCommand');
    // S3 must NOT have been touched on the sync path
    expect(s3Send).not.toHaveBeenCalled();
  });

  it('wraps SDK errors in OcrError', async () => {
    textractSend.mockRejectedValueOnce(new Error('boom'));
    await expect(extractTextWithOCR(SYNC_BUFFER)).rejects.toBeInstanceOf(
      OcrError,
    );
  });
});

// ---------------------------------------------------------------------------
// Async path
// ---------------------------------------------------------------------------

describe('extractTextWithOCR — async path', () => {
  it('throws when AWS_TEXTRACT_S3_BUCKET is unset', async () => {
    (env as { AWS_TEXTRACT_S3_BUCKET?: string }).AWS_TEXTRACT_S3_BUCKET =
      undefined;

    await expect(extractTextWithOCR(asyncBuffer())).rejects.toMatchObject({
      name: 'OcrError',
      message: expect.stringContaining('AWS_TEXTRACT_S3_BUCKET'),
    });

    expect(s3Send).not.toHaveBeenCalled();
    expect(textractSend).not.toHaveBeenCalled();
  });

  it('uploads → starts → polls → returns text → deletes the staged object', async () => {
    // S3: put then delete (in that order)
    s3Send.mockResolvedValueOnce({}); // PutObject
    s3Send.mockResolvedValueOnce({}); // DeleteObject

    // Textract: start, then a SUCCEEDED poll
    textractSend.mockResolvedValueOnce({ JobId: 'job-abc' });
    textractSend.mockResolvedValueOnce({
      JobStatus: 'SUCCEEDED',
      Blocks: [
        { BlockType: 'LINE', Text: 'Hello' },
        { BlockType: 'LINE', Text: 'World' },
      ],
    });

    const out = await extractTextWithOCR(asyncBuffer());

    expect(out).toBe('Hello\nWorld');

    const s3Calls = recordCalls(s3Send);
    const tCalls = recordCalls(textractSend);

    expect(s3Calls.map((c) => c.command)).toEqual([
      'PutObjectCommand',
      'DeleteObjectCommand',
    ]);
    expect(tCalls.map((c) => c.command)).toEqual([
      'StartDocumentTextDetectionCommand',
      'GetDocumentTextDetectionCommand',
    ]);

    // The Put and Delete must reference the same bucket and key
    const put = s3Calls[0]?.input as {
      Bucket: string;
      Key: string;
      ContentType: string;
    };
    const del = s3Calls[1]?.input as { Bucket: string; Key: string };
    expect(put.Bucket).toBe('carrieraudit-textract-staging-test');
    expect(put.ContentType).toBe('application/pdf');
    expect(put.Key).toMatch(/^carrieraudit\/textract-staging\/.+\.pdf$/);
    expect(del.Bucket).toBe(put.Bucket);
    expect(del.Key).toBe(put.Key);

    // StartDocumentTextDetection must point at the same S3 location
    const start = tCalls[0]?.input as {
      DocumentLocation: { S3Object: { Bucket: string; Name: string } };
    };
    expect(start.DocumentLocation.S3Object).toEqual({
      Bucket: put.Bucket,
      Name: put.Key,
    });

    // GetDocumentTextDetection must reference the JobId returned by Start
    const get = tCalls[1]?.input as { JobId: string };
    expect(get.JobId).toBe('job-abc');
  });

  it('deletes the staged object even when Textract errors', async () => {
    s3Send.mockResolvedValueOnce({}); // Put
    s3Send.mockResolvedValueOnce({}); // Delete

    // Textract Start fails
    textractSend.mockRejectedValueOnce(new Error('textract down'));

    await expect(extractTextWithOCR(asyncBuffer())).rejects.toBeInstanceOf(
      OcrError,
    );

    const s3Calls = recordCalls(s3Send);
    expect(s3Calls.map((c) => c.command)).toEqual([
      'PutObjectCommand',
      'DeleteObjectCommand',
    ]);
  });

  it('also cleans up when the job returns FAILED', async () => {
    s3Send.mockResolvedValueOnce({}); // Put
    s3Send.mockResolvedValueOnce({}); // Delete

    textractSend.mockResolvedValueOnce({ JobId: 'job-fail' });
    textractSend.mockResolvedValueOnce({
      JobStatus: 'FAILED',
      StatusMessage: 'unsupported document',
    });

    await expect(extractTextWithOCR(asyncBuffer())).rejects.toMatchObject({
      name: 'OcrError',
      message: expect.stringContaining('unsupported document'),
    });

    const s3Calls = recordCalls(s3Send);
    expect(s3Calls.map((c) => c.command)).toEqual([
      'PutObjectCommand',
      'DeleteObjectCommand',
    ]);
  });

  it('logs S3 cleanup failure to Sentry but still returns the OCR result', async () => {
    // Put succeeds, Delete fails — cleanup error must not poison the result.
    s3Send.mockResolvedValueOnce({}); // Put
    s3Send.mockRejectedValueOnce(new Error('AccessDenied: cannot delete'));

    textractSend.mockResolvedValueOnce({ JobId: 'job-cleanup' });
    textractSend.mockResolvedValueOnce({
      JobStatus: 'SUCCEEDED',
      Blocks: [{ BlockType: 'LINE', Text: 'Survived cleanup error' }],
    });

    const out = await extractTextWithOCR(asyncBuffer());

    // OCR result returned despite cleanup failure
    expect(out).toBe('Survived cleanup error');

    // Sentry was called with warning level, module/op tags, and PII-free extra
    expect(sentryCaptureException).toHaveBeenCalledTimes(1);
    const [errArg, ctx] = sentryCaptureException.mock.calls[0] as [
      Error,
      {
        level: string;
        tags: Record<string, string>;
        extra: Record<string, string>;
      },
    ];
    expect(errArg).toBeInstanceOf(Error);
    expect(ctx.level).toBe('warning');
    expect(ctx.tags).toEqual({ module: 'extraction.ocr', op: 's3_cleanup' });
    expect(ctx.extra).toEqual({
      bucket: 'carrieraudit-textract-staging-test',
      keyPrefix: 'carrieraudit/textract-staging/',
    });
    // Defense in depth: full S3 key (which embeds the random UUID) must NOT
    // appear anywhere in the captured payload.
    const payload = JSON.stringify(ctx);
    expect(payload).not.toMatch(/\.pdf/);

    // Both Put and Delete commands were attempted in that order
    const s3Calls = recordCalls(s3Send);
    expect(s3Calls.map((c) => c.command)).toEqual([
      'PutObjectCommand',
      'DeleteObjectCommand',
    ]);
  });

  it('logs cleanup failure to Sentry even when the OCR job itself failed', async () => {
    // OCR fails AND cleanup fails — the original OCR error must propagate,
    // and the cleanup failure must be reported to Sentry (not lost).
    s3Send.mockResolvedValueOnce({}); // Put
    s3Send.mockRejectedValueOnce(new Error('cleanup boom'));

    textractSend.mockRejectedValueOnce(new Error('textract down'));

    await expect(extractTextWithOCR(asyncBuffer())).rejects.toBeInstanceOf(
      OcrError,
    );

    expect(sentryCaptureException).toHaveBeenCalledTimes(1);
    const [, ctx] = sentryCaptureException.mock.calls[0] as [
      Error,
      { level: string; tags: Record<string, string> },
    ];
    expect(ctx.level).toBe('warning');
    expect(ctx.tags).toEqual({ module: 'extraction.ocr', op: 's3_cleanup' });
  });

  it('times out after 5 minutes of IN_PROGRESS polling', async () => {
    vi.useFakeTimers();

    s3Send.mockResolvedValueOnce({}); // Put
    s3Send.mockResolvedValueOnce({}); // Delete (cleanup)

    textractSend.mockResolvedValueOnce({ JobId: 'job-slow' });
    // Every poll responds IN_PROGRESS — should eventually time out.
    textractSend.mockResolvedValue({ JobStatus: 'IN_PROGRESS' });

    const promise = extractTextWithOCR(asyncBuffer());
    // Surface unhandled rejections so the runner doesn't warn.
    const settled = promise.catch((e: unknown) => e);

    // Advance fake time past the 5-minute deadline. We pump in 5s slices to
    // mirror the real polling cadence and let pending microtasks settle so
    // mocked send() promises resolve before the next sleep.
    for (let i = 0; i < 65; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
    }

    const result = await settled;
    expect(result).toBeInstanceOf(OcrError);
    expect((result as OcrError).message).toMatch(/timed out/i);

    // Cleanup must still have run.
    const s3Calls = recordCalls(s3Send);
    expect(s3Calls.map((c) => c.command)).toEqual([
      'PutObjectCommand',
      'DeleteObjectCommand',
    ]);
  });
});
