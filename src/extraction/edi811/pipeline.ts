import { z } from 'zod';

import type { Carrier, ExtractedBill } from '@/extraction/schema';
import { ExtractedBillSchema } from '@/extraction/schema';
import { detectCarrierFromEdi } from '@/extraction/edi811/detect';
import {
  Edi811ParseError,
  parseEdi811,
  type Edi811Envelope,
  type Edi811Segment,
} from '@/extraction/edi811/parser';
import { mapEdi811ToBill, type CarrierMapHooks } from '@/extraction/edi811/mapper';
import { ATT_HOOKS } from '@/extraction/edi811/carriers/att';
import { TMOBILE_HOOKS } from '@/extraction/edi811/carriers/tmobile';
import { VERIZON_HOOKS } from '@/extraction/edi811/carriers/verizon';

export type Edi811PipelineStep = 'decode' | 'parse' | 'detect' | 'map' | 'validate';

export class Edi811PipelineError extends Error {
  public readonly step: Edi811PipelineStep;
  public override readonly cause?: unknown;
  constructor(message: string, step: Edi811PipelineStep, cause?: unknown) {
    super(message);
    this.name = 'Edi811PipelineError';
    this.step = step;
    this.cause = cause;
  }
}

/**
 * (C6) Hard cap on raw EDI 811 size before decode/parse. A real wireless 811
 * for a multi-thousand-line enterprise account tops out around 1–2 MB; 5 MB
 * leaves comfortable headroom while preventing a maliciously-crafted file
 * from forcing the worker to allocate an unbounded segment array.
 */
export const MAX_EDI_BYTES = 5 * 1024 * 1024;

export type Edi811PipelineResult = {
  bill: ExtractedBill;
  detectedCarrier: Carrier;
  envelope: Edi811Envelope;
  segmentCount: number;
};

/**
 * Decode + parse + map an EDI 811 file into the same `ExtractedBill` shape
 * the PDF pipeline produces. The result is run through `ExtractedBillSchema`
 * before returning, so downstream code can trust the contract.
 */
export async function runEdi811Pipeline({
  buffer,
}: {
  buffer: Buffer;
}): Promise<Edi811PipelineResult> {
  // 0. (C6) Size cap. Reject before decode so a large adversarial file does
  //    not get materialized as a JS string (which doubles peak memory) or
  //    parsed into a segment array. The error message references only the
  //    limit + observed bytes — no EDI content — so it's safe to surface
  //    into `audits.failure_reason`.
  if (buffer.byteLength > MAX_EDI_BYTES) {
    throw new Edi811PipelineError(
      `EDI exceeds ${MAX_EDI_BYTES} byte limit (got ${buffer.byteLength})`,
      'decode',
    );
  }

  // 1. Decode bytes → text. EDI files are 7-bit ASCII per spec; UTF-8 is a
  //    safe superset and tolerates the BOM some Windows-shipped files carry.
  let text: string;
  try {
    text = decodeEdi(buffer);
  } catch (err) {
    throw new Edi811PipelineError('Failed to decode EDI bytes', 'decode', err);
  }

  // 2. Parse envelope + segments.
  let envelope: Edi811Envelope;
  let segments: Edi811Segment[];
  try {
    const out = parseEdi811(text);
    envelope = out.envelope;
    segments = out.segments;
  } catch (err) {
    if (err instanceof Edi811ParseError) {
      throw new Edi811PipelineError(err.message, 'parse', err);
    }
    throw new Edi811PipelineError('Failed to parse EDI 811 transaction', 'parse', err);
  }

  // 3. Detect carrier.
  let carrier: Carrier;
  try {
    carrier = detectCarrierFromEdi(envelope, segments);
  } catch (err) {
    throw new Edi811PipelineError('Failed to detect carrier', 'detect', err);
  }

  // 4. Map to `ExtractedBill` using the carrier-specific hooks.
  let billCandidate: unknown;
  try {
    const hooks = pickHooks(carrier);
    billCandidate = mapEdi811ToBill(segments, carrier, hooks);
  } catch (err) {
    throw new Edi811PipelineError('Failed to map EDI segments to bill', 'map', err);
  }

  // 5. Validate against the schema. This catches degenerate inputs (no lines,
  //    bad date formats, illegal credit signs) at the EDI boundary so the
  //    rest of the pipeline can trust the result.
  let bill: ExtractedBill;
  try {
    bill = ExtractedBillSchema.parse(billCandidate);
  } catch (err) {
    throw new Edi811PipelineError(
      formatZodError(err) ?? 'Mapped bill failed schema validation',
      'validate',
      err,
    );
  }

  return {
    bill,
    detectedCarrier: carrier,
    envelope,
    segmentCount: segments.length,
  };
}

function pickHooks(carrier: Carrier): CarrierMapHooks {
  switch (carrier) {
    case 'verizon':
      return VERIZON_HOOKS;
    case 'att':
      return ATT_HOOKS;
    case 'tmobile':
      return TMOBILE_HOOKS;
    case 'unknown':
      return {};
  }
}

function decodeEdi(buffer: Buffer): string {
  let text = buffer.toString('utf8');
  // Strip a UTF-8 BOM if present.
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  return text;
}

function formatZodError(err: unknown): string | null {
  if (!(err instanceof z.ZodError)) return null;
  // Surface the first issue only — full Zod errors can leak structure that
  // looks like raw bill content. Keep it terse.
  const issue = err.issues[0];
  if (!issue) return null;
  const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
  return `schema:${path}: ${issue.message}`;
}
