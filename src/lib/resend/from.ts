/**
 * Outbound email sender.
 *
 * Reads `EMAIL_FROM` from env so operators can swap sender addresses
 * (e.g. between Resend's onboarding sandbox and a verified domain) without
 * a code change. Falls back to the production sender when unset.
 *
 * Format must match RFC 5322 sender header, e.g. `Name <user@domain>`.
 */
export const FROM_ADDRESS =
  process.env.EMAIL_FROM?.trim() || 'CarrierAudit <reports@carrieraudit.com>';
