import type { Carrier } from '@/extraction/schema';

/**
 * Heuristic carrier detection from raw bill text. Order matters — the first
 * matching pattern wins, which keeps multi-mention bills (e.g. a Verizon bill
 * that references AT&T as a competitor) classified by their dominant header.
 */
export function detectCarrier(text: string): Carrier {
  const haystack = text.toLowerCase();

  // Verizon: matches "verizon wireless" or "verizon business" headers.
  if (/verizon\s+wireless|verizon\s+business/.test(haystack)) {
    return 'verizon';
  }

  // AT&T: require a carrier-context keyword right after the brand. A bare
  // "AT&T" mention (e.g. "port-in from AT&T") on a Sprint legacy bill would
  // previously misclassify the whole bill, sending it through the AT&T
  // normalizer + AT&T plan patterns. M8: anchor on the canonical phrases.
  if (/at\s*&\s*t\s+(business|wireless|mobility|inc)/.test(haystack)) {
    return 'att';
  }

  // T-Mobile: matches "t-mobile" or "t mobile" with optional spacing.
  if (/t-mobile|t\s*mobile/.test(haystack)) {
    return 'tmobile';
  }

  return 'unknown';
}
