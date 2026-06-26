import type { ExtractedBill } from '@/extraction/schema';
import { normalize as normalizeVerizon } from '@/extraction/carriers/verizon';

// Xfinity Mobile is a Comcast MVNO that rides Verizon's network. As with
// Spectrum Mobile, the printed bills frequently mirror Verizon's plan-name
// and feature-label conventions — we inherit the Verizon normalization pass
// directly.
//
// If/when Xfinity-specific plan SKUs ("By the Gig", "Unlimited Intro" etc.)
// need their own canonical-name pass, layer it on top of the Verizon call.
// For now identity-through-verizon covers the observed shape.

export function normalize(bill: ExtractedBill): ExtractedBill {
  return normalizeVerizon(bill);
}
