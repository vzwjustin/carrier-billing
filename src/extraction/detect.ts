import type { Carrier } from '@/extraction/schema';

/**
 * Heuristic carrier detection from raw bill text. Order matters — the first
 * matching pattern wins, which keeps multi-mention bills (e.g. a Verizon bill
 * that references AT&T as a competitor) classified by their dominant header.
 *
 * MVNO tie-breaker: Spectrum Mobile and Xfinity Mobile both ride Verizon's
 * network and Cricket Wireless rides AT&T's, so the underlying carrier name
 * frequently appears in the fine print of those bills. We check MVNO headers
 * BEFORE Verizon/AT&T so operators dispute against the actual reseller
 * (Spectrum / Xfinity / Cricket), not the underlying network. US Cellular is
 * a full MNO so the order doesn't matter for it, but we keep it grouped with
 * the new carriers for readability.
 */
export function detectCarrier(text: string): Carrier {
  const haystack = text.toLowerCase();

  // --- MVNOs first (tie-breaker over their underlying networks) -------------

  // Spectrum Mobile (Charter MVNO on Verizon). "Charter Communications" is a
  // secondary brand signal — sometimes only the parent brand appears on the
  // corporate-billing header.
  if (/spectrum\s+mobile/.test(haystack) || /charter\s+communications/.test(haystack)) {
    return 'spectrum';
  }

  // Xfinity Mobile (Comcast MVNO on Verizon). "Comcast" is the parent-brand
  // secondary signal.
  if (/xfinity\s+mobile/.test(haystack) || /\bcomcast\b/.test(haystack)) {
    return 'xfinity';
  }

  // Cricket Wireless (AT&T MVNO). Anchor on the full brand to avoid catching
  // a bare "Cricket" mention (e.g. a sports-team reference in promo copy).
  if (/cricket\s+wireless/.test(haystack)) {
    return 'cricket';
  }

  // --- US Cellular (regional MNO) ------------------------------------------
  // Matches "US Cellular", "U.S. Cellular", "U S Cellular" — periods and
  // optional whitespace are common variants on the printed header.
  if (/u\.?\s*s\.?\s*cellular/.test(haystack)) {
    return 'uscellular';
  }

  // --- National MNOs --------------------------------------------------------

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
