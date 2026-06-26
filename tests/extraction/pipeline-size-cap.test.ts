/**
 * H5 — `runExtractionPipeline` must reject oversized PDFs at entry, BEFORE
 * any text extraction, OCR, or LLM call. Without this gate a 30 MB bill
 * inflates to a >100 MB working set (raw + base64 + pdf-parse text + OCR
 * buffer) and OOMs the Inngest worker under concurrent load.
 *
 * The test mocks every downstream module the pipeline touches and asserts
 * that an oversized buffer throws a `PipelineError(step: 'size_check')`
 * without invoking any of them. A buffer at the limit (or below) flows
 * normally through the mocked happy path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const extractTextMock = vi.hoisted(() =>
  vi.fn(async () => ({ text: 'fake text content '.repeat(60), pageCount: 1 })),
);
vi.mock('@/extraction/pdf', () => ({
  extractText: extractTextMock,
  PdfParseError: class extends Error {},
}));

const detectCarrierMock = vi.hoisted(() => vi.fn(() => 'verizon'));
vi.mock('@/extraction/detect', () => ({
  detectCarrier: detectCarrierMock,
}));

const ocrMock = vi.hoisted(() => vi.fn(async () => ''));
vi.mock('@/extraction/ocr', () => ({
  extractTextWithOCR: ocrMock,
  hasAwsCredentials: () => false,
}));

const extractBillMock = vi.hoisted(() =>
  vi.fn(async () => ({
    carrier: 'verizon',
    billing_period_start: '2026-04-01',
    billing_period_end: '2026-04-30',
    total_charges_cents: 1000,
    accounts: [
      {
        account_number_last4: '1234',
        label: null,
        total_charges_cents: 1000,
        taxes_fees_cents: null,
        account_level_credits: [],
        lines: [],
      },
    ],
    notes: [],
  })),
);
vi.mock('@/extraction/llm', () => ({
  extractBill: extractBillMock,
  ExtractionError: class extends Error {},
}));

vi.mock('@/extraction/carriers/verizon', () => ({
  normalize: <T>(b: T) => b,
}));
vi.mock('@/extraction/carriers/att', () => ({
  normalize: <T>(b: T) => b,
}));
vi.mock('@/extraction/carriers/tmobile', () => ({
  normalize: <T>(b: T) => b,
}));

import { MAX_PDF_BYTES, PipelineError, runExtractionPipeline } from '@/extraction/pipeline';

beforeEach(() => {
  extractTextMock.mockClear();
  detectCarrierMock.mockClear();
  ocrMock.mockClear();
  extractBillMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runExtractionPipeline — H5 PDF size cap', () => {
  it('exposes the cap as a 25 MB constant', () => {
    expect(MAX_PDF_BYTES).toBe(25 * 1024 * 1024);
  });

  it('throws PipelineError(size_check) when the buffer exceeds 25 MB', async () => {
    // 26 MB — over the limit. Use Buffer.alloc which lazily allocates an
    // already-zeroed buffer; no real PDF content needed.
    const oversized = Buffer.alloc(MAX_PDF_BYTES + 1024 * 1024);

    let caught: unknown = null;
    try {
      await runExtractionPipeline({ buffer: oversized });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PipelineError);
    const e = caught as PipelineError;
    expect(e.step).toBe('size_check');
    // Error message must NOT echo bill content — only structural counters.
    expect(e.message).toMatch(/byte limit/i);
    expect(e.message).toContain(String(oversized.byteLength));
  });

  it('does not invoke ANY downstream pipeline step on size-cap rejection', async () => {
    const oversized = Buffer.alloc(MAX_PDF_BYTES + 1);
    await expect(runExtractionPipeline({ buffer: oversized })).rejects.toBeInstanceOf(
      PipelineError,
    );

    // Critical: the LLM, OCR, pdf-parse, and detect calls must not have run.
    // Otherwise we still pay for memory + API on the rejected payload.
    expect(extractTextMock).not.toHaveBeenCalled();
    expect(ocrMock).not.toHaveBeenCalled();
    expect(detectCarrierMock).not.toHaveBeenCalled();
    expect(extractBillMock).not.toHaveBeenCalled();
  });

  it('passes a buffer at the cap through to the rest of the pipeline', async () => {
    // Exactly at the cap (the check is `> MAX_PDF_BYTES`).
    const atCap = Buffer.alloc(MAX_PDF_BYTES);
    const result = await runExtractionPipeline({ buffer: atCap });

    expect(extractTextMock).toHaveBeenCalledTimes(1);
    expect(extractBillMock).toHaveBeenCalledTimes(1);
    expect(result.bill.carrier).toBe('verizon');
  });
});
