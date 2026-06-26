/**
 * Shared constants for audit share-tokens.
 *
 * A share token is generated server-side via `randomBytes(SHARE_TOKEN_BYTES).toString('base64url')`,
 * which yields a string of exactly SHARE_TOKEN_LENGTH base64url characters
 * (no padding, since 24 bytes is a multiple of 3).
 *
 * The regex is intentionally strict: only base64url alphabet, exactly
 * SHARE_TOKEN_LENGTH characters. It must match anywhere the public token
 * is parsed from user input (query string, route segment, etc.).
 */
export const SHARE_TOKEN_BYTES = 24;
export const SHARE_TOKEN_LENGTH = 32;
export const SHARE_TOKEN_REGEX = /^[A-Za-z0-9_-]{32}$/;

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
