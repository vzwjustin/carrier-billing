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
