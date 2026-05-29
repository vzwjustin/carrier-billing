/**
 * Share-link expiry checks for public audit surfaces.
 *
 * When `share_token_expires_at` exists in the schema, every active share link
 * must carry an explicit future expiry. NULL means "no TTL recorded" and is
 * rejected so pre-migration links cannot stay valid forever.
 *
 * When the expiry column is unavailable (stale PostgREST schema cache), callers
 * pass `expiryColumnAvailable: false` and access is not gated on expiry.
 */

export function isShareTokenExpired(
  expiresAt: string | null,
  expiryColumnAvailable = true,
): boolean {
  if (!expiryColumnAvailable) return false;
  if (!expiresAt) return true;
  const ts = Date.parse(expiresAt);
  if (Number.isNaN(ts)) return true;
  return ts <= Date.now();
}
