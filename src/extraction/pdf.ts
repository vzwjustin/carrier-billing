import pdfParse from 'pdf-parse';

/**
 * Thin wrapper around `pdf-parse`. Returns extracted text and page count.
 * `pdf-parse` is CommonJS — imported via the default export.
 */
export async function extractText(
  buffer: Buffer,
): Promise<{ text: string; pageCount: number }> {
  try {
    // `max: 0` parses all pages.
    const data = await pdfParse(buffer, { max: 0 });
    return {
      text: data.text ?? '',
      pageCount: data.numpages ?? 0,
    };
  } catch (err) {
    throw new PdfParseError('Failed to parse PDF', err);
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
