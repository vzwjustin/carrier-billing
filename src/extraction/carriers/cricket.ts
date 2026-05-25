import type { ExtractedBill } from '@/extraction/schema';
import { normalize as normalizeAtt } from '@/extraction/carriers/att';

// Cricket Wireless is an AT&T-owned MVNO that rides AT&T's network. Cricket
// bills frequently reuse AT&T's feature labels (Mobile Insurance, DPP/Next
// Up naming, etc.) — we inherit AT&T's normalization pass directly.
//
// If/when Cricket-specific plan SKUs ("Cricket More", "Cricket Core" etc.)
// need their own canonical-name pass, layer it on top of the AT&T call. For
// now identity-through-att covers the observed shape.

export function normalize(bill: ExtractedBill): ExtractedBill {
  return normalizeAtt(bill);
}
