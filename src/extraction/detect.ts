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

  // AT&T: matches "at&t business/wireless/mobility" or a bare "at&t" header.
  if (/at&t\s+(business|wireless|mobility)|at\s*&\s*t/.test(haystack)) {
    return 'att';
  }

  // T-Mobile: matches "t-mobile" or "t mobile" with optional spacing.
  if (/t-mobile|t\s*mobile/.test(haystack)) {
    return 'tmobile';
  }

  return 'unknown';
}
