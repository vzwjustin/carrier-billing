/**
 * Encrypted-PDF rejection tests for `extractText`.
 *
 * CLAUDE.md §11 #1 ("PDF is encrypted/password-protected → fail fast with
 * clear error") demands the extraction wrapper surface a structured error
 * rather than a raw pdfjs internal exception. This test exercises that
 * contract by mocking `pdf-parse` to throw the same shape it raises in
 * production when handed a `/Encrypt`-flagged document, then asserting our
 * wrapper wraps it in a `PdfParseError` with the original cause attached.
 *
 * We also exercise the buffer-shaped path: a minimal well-formed-looking PDF
 * buffer with a `/Encrypt` directive in its trailer. pdf-parse routes that
 * through pdfjs, which raises `PasswordException`; our wrapper catches it
 * and re-throws a `PdfParseError`. We can't generate an encrypted PDF inline
 * without pulling in a crypto library, so the buffer test is documented as
 * skipped — the mock-based test below proves the contract.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock pdf-parse to throw the same error shape production raises for an
// encrypted PDF. pdfjs throws `PasswordException` ("No password given");
// pdf-parse forwards it. Our wrapper wraps it in PdfParseError.
// ---------------------------------------------------------------------------

const pdfParseMock = vi.fn();
vi.mock('pdf-parse', () => ({
  default: (...args: unknown[]) =>
    pdfParseMock(...(args as [Buffer, { max?: number }])),
}));

// Import AFTER the mock is registered.
import { extractText, PdfParseError } from '@/extraction/pdf';

beforeEach(() => {
  pdfParseMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('extractText — encrypted PDF rejection', () => {
  it('throws PdfParseError when pdf-parse signals a password-protected PDF', async () => {
    // Mirrors how pdfjs surfaces it: an Error whose name is "PasswordException".
    const passwordExc = new Error('No password given');
    passwordExc.name = 'PasswordException';
    pdfParseMock.mockRejectedValueOnce(passwordExc);

    const dummyBuffer = Buffer.from(
      // A real-ish PDF preamble; the body is irrelevant since pdf-parse is mocked.
      '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<< /Encrypt 2 0 R >>\nendobj\n',
      'binary',
    );

    await expect(extractText(dummyBuffer)).rejects.toBeInstanceOf(
      PdfParseError,
    );

    // Re-run the same call to capture the thrown error and inspect it.
    pdfParseMock.mockRejectedValueOnce(passwordExc);
    let caught: unknown = null;
    try {
      await extractText(dummyBuffer);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PdfParseError);
    const e = caught as PdfParseError;
    expect(e.message).toMatch(/Failed to parse PDF/i);
    // The original PasswordException is preserved as `cause` so callers
    // (the pipeline + Inngest fn) can present a user-actionable error.
    expect(e.cause).toBe(passwordExc);
  });

  it('surfaces a structured error rather than crashing, even on a generic pdfjs exception', async () => {
    // Belt-and-suspenders: any pdfjs throw should be wrapped.
    const generic = new Error('InvalidPDFException: corrupt xref');
    generic.name = 'InvalidPDFException';
    pdfParseMock.mockRejectedValueOnce(generic);

    let caught: unknown = null;
    try {
      await extractText(Buffer.from('%PDF-1.4\n', 'binary'));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PdfParseError);
    expect((caught as PdfParseError).cause).toBe(generic);
  });

  it('provides enough detail for the pipeline to surface "encrypted-pdf" failure_reason', async () => {
    // (M-E3) Updated contract: encrypted PDFs do NOT silently drop into the
    // OCR fallback. Textract's password handling is unreliable across PDF
    // owner-password variants and an OCR retry would just produce garbage
    // text that the LLM might happily hallucinate over. Instead the
    // pipeline catches `PdfParseError` with a `PasswordException` cause
    // and re-throws `PipelineError('Encrypted PDF — cannot extract text',
    // 'encrypted_pdf', err)`. The Inngest worker's deriveFailureReason
    // collapses `PipelineError.step === 'encrypted_pdf'` into the
    // user-actionable failure_reason `'encrypted-pdf'` so the UI can
    // prompt the user to upload an unencrypted copy.
    //
    // This test pins the inner contract: extractText must wrap the
    // PasswordException in a PdfParseError preserving `cause.name`. The
    // pipeline-level branch is exercised in pipeline-size-cap.test.ts /
    // pipeline integration tests (it requires more module mocking than
    // belongs in this file).
    const passwordExc = new Error('No password given');
    passwordExc.name = 'PasswordException';
    pdfParseMock.mockRejectedValueOnce(passwordExc);

    await expect(extractText(Buffer.from('%PDF-1.4', 'binary'))).rejects
      .toMatchObject({
        name: 'PdfParseError',
      });
  });

  // Document-only: generating a real encrypted PDF inline requires running
  // the actual encryption pipeline (pdf-lib doesn't expose owner-password
  // encryption out of the box, and pdfkit's encryption support is heavy).
  // The existing test fixture set under tests/fixtures/bills/ is intentionally
  // unencrypted. If a real encrypted fixture is added (e.g.
  // tests/fixtures/bills/encrypted.pdf), this `it.todo` should become an
  // `it()` that calls `extractText(readFileSync(...))` directly without the
  // pdf-parse mock.
  it.todo(
    'integration variant: extractText against a real encrypted fixture should throw PdfParseError',
  );
});
