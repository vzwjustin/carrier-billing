import { PDFParse } from 'pdf-parse';

/**
 * Thin wrapper around `pdf-parse` (v2). Returns extracted text and page count.
 * v2 exposes a class-based API (`PDFParse`) instead of v1's single function;
 * `destroy()` must be awaited to release the worker.
 */
export async function extractText(buffer: Buffer): Promise<{ text: string; pageCount: number }> {
  // Buffer extends Uint8Array; pdf-parse normalises it to a typed array internally.
  const parser = new PDFParse({ data: buffer });
  try {
    const data = await parser.getText();
    return {
      text: data.text ?? '',
      pageCount: data.total ?? 0,
    };
  } catch (err) {
    throw new PdfParseError('Failed to parse PDF', err);
  } finally {
    await parser.destroy();
  }
}

export class PdfParseError extends Error {
  public override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'PdfParseError';
    this.cause = cause;
  }
}
