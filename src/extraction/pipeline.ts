import { detectCarrier } from '@/extraction/detect';
import { extractBill } from '@/extraction/llm';
import { extractText } from '@/extraction/pdf';
import { extractTextWithOCR, hasAwsCredentials } from '@/extraction/ocr';
import { normalize as normalizeVerizon } from '@/extraction/carriers/verizon';
import { normalize as normalizeAtt } from '@/extraction/carriers/att';
import { normalize as normalizeTmobile } from '@/extraction/carriers/tmobile';
import type { Carrier, ExtractedBill } from '@/extraction/schema';

/** Below this length we assume the PDF is image-only and route to OCR. */
const OCR_TEXT_THRESHOLD = 500;

export type PipelineStep =
  | 'extract_text'
  | 'ocr_fallback'
  | 'detect_carrier'
  | 'llm_extract'
  | 'normalize';

export class PipelineError extends Error {
  public readonly step: PipelineStep;
  public override readonly cause?: unknown;
  constructor(message: string, step: PipelineStep, cause?: unknown) {
    super(message);
    this.name = 'PipelineError';
    this.step = step;
    this.cause = cause;
  }
}

export type PipelineResult = {
  bill: ExtractedBill;
  pageCount: number;
  rawText: string;
  neededOcr: boolean;
  detectedCarrier: Carrier;
};

/**
 * Orchestrate the Phase 1 extraction pipeline:
 *
 *  1. Pull text + page count from the PDF.
 *  2. If text is too short, fall back to Textract OCR for the *raw text*
 *     (the LLM still receives the original PDF natively — OCR text is only
 *     used to drive carrier detection on scanned bills).
 *  3. Heuristic carrier detection on the raw text.
 *  4. LLM extraction (Claude with native PDF input) → validated `ExtractedBill`.
 *  5. If the LLM said `unknown` but our heuristic found a carrier, prefer
 *     the heuristic. Then run carrier-specific normalization.
 */
export async function runExtractionPipeline({
  buffer,
}: {
  buffer: Buffer;
}): Promise<PipelineResult> {
  // 1. Extract text + page count.
  let rawText: string;
  let pageCount: number;
  try {
    const out = await extractText(buffer);
    rawText = out.text;
    pageCount = out.pageCount;
  } catch (err) {
    throw new PipelineError('Failed to read PDF text', 'extract_text', err);
  }

  // 2. OCR fallback for image-only PDFs (requires AWS credentials).
  let neededOcr = false;
  if (rawText.trim().length < OCR_TEXT_THRESHOLD && hasAwsCredentials()) {
    neededOcr = true;
    try {
      const ocrText = await extractTextWithOCR(buffer);
      // Prefer the longer of the two — if OCR was empty, keep whatever pdf-parse gave us.
      if (ocrText.length > rawText.length) {
        rawText = ocrText;
      }
    } catch (err) {
      throw new PipelineError('OCR fallback failed', 'ocr_fallback', err);
    }
  }

  // 3. Heuristic carrier detection.
  let detectedCarrier: Carrier;
  try {
    detectedCarrier = detectCarrier(rawText);
  } catch (err) {
    throw new PipelineError(
      'Carrier detection failed',
      'detect_carrier',
      err,
    );
  }

  // 4. LLM extraction.
  let bill: ExtractedBill;
  try {
    bill = await extractBill(buffer);
  } catch (err) {
    throw new PipelineError('LLM extraction failed', 'llm_extract', err);
  }

  // 5. Reconcile carrier + normalize.
  try {
    if (bill.carrier === 'unknown' && detectedCarrier !== 'unknown') {
      bill = { ...bill, carrier: detectedCarrier };
    }
    bill = applyCarrierNormalization(bill);
  } catch (err) {
    throw new PipelineError('Normalization failed', 'normalize', err);
  }

  return {
    bill,
    pageCount,
    rawText,
    neededOcr,
    detectedCarrier,
  };
}

function applyCarrierNormalization(bill: ExtractedBill): ExtractedBill {
  switch (bill.carrier) {
    case 'verizon':
      return normalizeVerizon(bill);
    case 'att':
      return normalizeAtt(bill);
    case 'tmobile':
      return normalizeTmobile(bill);
    case 'unknown':
      return bill;
  }
}
