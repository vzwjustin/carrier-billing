import type { Carrier } from '@/extraction/schema';
import type { Edi811Envelope, Edi811Segment } from '@/extraction/edi811/parser';
import { el } from '@/extraction/edi811/parser';

/**
 * Heuristic carrier detection for an EDI 811 interchange.
 *
 * Order of preference:
 *   1. ISA06 / ISA08 sender id — VZW, ATT, TMUS, TMOBILE etc.
 *   2. GS02 application sender code — same shape as ISA06 with carrier slugs.
 *   3. N1*RE (remit-to) party name — falls back to the human-readable header
 *      when the trading-partner ids aren't recognized.
 *
 * If none match, returns 'unknown'. The mapper still produces a usable
 * `ExtractedBill` for unknown carriers — the rules engine just won't apply
 * carrier-specific normalizations.
 */
export function detectCarrierFromEdi(
  envelope: Edi811Envelope,
  segments: Edi811Segment[],
): Carrier {
  const ids = [
    envelope.senderId,
    envelope.receiverId,
    envelope.applicationSenderCode ?? '',
  ]
    .map((s) => s.toUpperCase())
    .filter((s) => s.length > 0);

  for (const candidate of ids) {
    const carrier = matchTradingPartnerId(candidate);
    if (carrier !== 'unknown') return carrier;
  }

  // Fall back to the remit-to name if trading-partner ids weren't recognized.
  const remitName = findRemitToName(segments);
  if (remitName) {
    return matchPartyName(remitName);
  }

  return 'unknown';
}

function matchTradingPartnerId(id: string): Carrier {
  // Trading-partner ids in 811 interchanges are conventionally ALL-CAPS slugs
  // like VZW, VZWBILLING, ATT, ATTMOBILITY, TMUS. We match on prefix so future
  // carrier-internal subdivisions (e.g. ATTPREPAID) still resolve correctly.
  if (/^(VZW|VERIZON|CELLCO)/.test(id)) return 'verizon';
  if (/^(ATT|CINGULAR|NCI)/.test(id)) return 'att';
  if (/^(TMUS|TMOBILE|TMO|SPRINT)/.test(id)) return 'tmobile';
  return 'unknown';
}

function matchPartyName(name: string): Carrier {
  const haystack = name.toLowerCase();
  if (/verizon/.test(haystack)) return 'verizon';
  if (/at\s*&?\s*t|cingular/.test(haystack)) return 'att';
  if (/t-?mobile|sprint/.test(haystack)) return 'tmobile';
  return 'unknown';
}

function findRemitToName(segments: Edi811Segment[]): string | null {
  // N1 segments: N1*RE = remit-to, N1*BT = bill-to. We want RE.
  for (const seg of segments) {
    if (seg.id !== 'N1') continue;
    const qualifier = el(seg, 1).toUpperCase();
    if (qualifier !== 'RE') continue;
    const name = el(seg, 2).trim();
    if (name.length > 0) return name;
  }
  return null;
}
