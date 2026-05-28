import type { ExtractedBill } from '@/extraction/schema';
import { normalize as normalizeVerizon } from '@/extraction/carriers/verizon';

// Spectrum Mobile is a Charter Communications MVNO that rides Verizon's
// network. Bills frequently reproduce Verizon's plan names + feature labels
// verbatim (Verizon Cloud, TravelPass, etc. appear when a Spectrum customer
// adds a Verizon-branded service through the carrier portal), so we inherit
// the Verizon normalization pass directly.
//
// If/when Spectrum-specific plan SKUs ("Unlimited Plus", "By the Gig" etc.)
// need their own canonical-name pass, layer it on top before/after the
// Verizon call. For now identity-through-verizon covers the observed shape.

export function normalize(bill: ExtractedBill): ExtractedBill {
  return normalizeVerizon(bill);
}
