import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Inbound HTTP webhook token utilities (separate surface from the
 * `inbound_email_token` above). These tokens authenticate external callers
 * (Slack bots, Linear automations, etc.) POSTing to
 * `/api/inbound/finding-status`.
 *
 * Format: 32-char base64url (`randomBytes(24).toString('base64url')` → 24
 * bytes = 192 bits of entropy, encoded as 32 chars in [A-Za-z0-9_-]). The DB
 * CHECK constraint in `0029_inbound_finding_webhook.sql` enforces the shape.
 *
 * Tokens are minted lazily (operator clicks "Generate" in the settings UI)
 * and revoked by setting the column to NULL. Rotation = revoke + mint.
 */

const INBOUND_WEBHOOK_TOKEN_BYTES = 24;
export const INBOUND_WEBHOOK_TOKEN_LENGTH = 32;

export function generateInboundWebhookToken(): string {
  return randomBytes(INBOUND_WEBHOOK_TOKEN_BYTES).toString('base64url');
}

const INBOUND_WEBHOOK_TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

export function isInboundWebhookTokenShape(value: unknown): value is string {
  return typeof value === 'string' && INBOUND_WEBHOOK_TOKEN_RE.test(value);
}

/**
 * Inbound email token utilities.
 *
 * Each user gets an opaque 16-char base32 token stored on `profiles`. The
 * forwarding address they hand to a carrier is then:
 *
 *   bills+<token>@<INBOUND_EMAIL_DOMAIN>
 *
 * The token is unique-indexed on `profiles.inbound_email_token`, so an
 * inbound recipient resolves to exactly one user. Tokens are revocable by
 * generating a fresh one (this implicitly invalidates the old address).
 */

const TOKEN_BYTES = 10; // 10 bytes → 16 base32 chars (~80 bits entropy)
const TOKEN_LENGTH = 16;

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

export function generateInboundToken(): string {
  const bytes = randomBytes(TOKEN_BYTES);
  let bits = 0;
  let bitCount = 0;
  let out = '';
  for (const byte of bytes) {
    bits = (bits << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      const idx = (bits >> bitCount) & 0x1f;
      out += BASE32[idx];
    }
  }
  return out;
}

export async function getOrCreateInboundToken(
  admin: SupabaseClient,
  userId: string,
): Promise<string> {
  const { data, error } = await admin
    .from('profiles')
    .select('inbound_email_token')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    throw new Error(`profile read failed: ${error.message}`);
  }

  const existing = (data as { inbound_email_token?: string | null } | null)?.inbound_email_token;
  if (typeof existing === 'string' && existing.length > 0) {
    return existing;
  }

  // CAS-style write: only set the column if it's still NULL. We retry on the
  // unique-index violation (23505) — collision is astronomically unlikely with
  // 80 bits of entropy but not impossible, and silently dropping back to a
  // re-read would give the *other* user our token. Fail loud, regenerate.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const fresh = generateInboundToken();
    const { data: updated, error: updateErr } = await admin
      .from('profiles')
      .update({
        inbound_email_token: fresh,
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId)
      .is('inbound_email_token', null)
      .select('inbound_email_token');

    if (updateErr) {
      const code = (updateErr as { code?: string }).code;
      if (code === '23505') {
        // Unique-index collision: another row already holds this token.
        // Try again with a fresh value.
        continue;
      }
      throw new Error(`inbound token write failed: ${updateErr.message}`);
    }

    const rows = (updated ?? []) as Array<{ inbound_email_token?: string | null }>;
    if (rows.length === 1) {
      // We won the CAS — `fresh` is now persisted.
      return fresh;
    }

    // 0 rows: another caller wrote a token between our read and the CAS.
    // Re-read and return whatever value won the race.
    const reread = await admin
      .from('profiles')
      .select('inbound_email_token')
      .eq('id', userId)
      .maybeSingle();
    if (reread.error) {
      throw new Error(`inbound token reread failed: ${reread.error.message}`);
    }
    const persisted = (reread.data as { inbound_email_token?: string | null } | null)
      ?.inbound_email_token;
    if (typeof persisted === 'string' && persisted.length > 0) {
      return persisted;
    }
    // Profile vanished or still NULL (the row exists but the CAS matched 0
    // because of an unrelated update; loop to try again).
  }
  throw new Error('inbound token write failed: too many collisions');
}

const HEX64_RE = /^(sha256=)?[0-9a-fA-F]{64}$/;
// SHA-256 in base64 is 44 chars (43 + '=' padding). Accept both standard and
// URL-safe alphabets — Postmark uses standard, some other providers use URL-safe.
const BASE64_SHA256_RE = /^(sha256=)?[A-Za-z0-9+/_-]{43}=?$/;

/**
 * Constant-time HMAC-SHA256 comparison so the verifier doesn't leak signature
 * mismatches via timing. Accepts either bare hex or `sha256=<hex>` (the
 * GitHub/Postmark convention) and is case-insensitive. L-10: also accepts
 * base64-encoded signatures (standard or URL-safe) — try hex first, fall back
 * to base64 on length mismatch / decode failure.
 */
export function verifyHmac(body: string, signatureHex: string, secret: string): boolean {
  if (typeof signatureHex !== 'string') return false;
  const stripped = signatureHex.replace(/^sha256=/, '');
  const expected = createHmac('sha256', secret).update(body).digest();
  if (expected.length !== 32) return false;

  // Try hex first.
  if (HEX64_RE.test(signatureHex)) {
    const receivedBuf = Buffer.from(stripped.toLowerCase(), 'hex');
    if (receivedBuf.length === 32) {
      try {
        if (timingSafeEqual(expected, receivedBuf)) return true;
      } catch {
        // fall through to base64
      }
    }
  }

  // Fall back to base64 (standard or URL-safe).
  if (BASE64_SHA256_RE.test(signatureHex)) {
    // Normalize URL-safe alphabet to standard before decoding.
    const normalized = stripped.replace(/-/g, '+').replace(/_/g, '/');
    const receivedBuf = Buffer.from(normalized, 'base64');
    if (receivedBuf.length === 32) {
      try {
        return timingSafeEqual(expected, receivedBuf);
      } catch {
        return false;
      }
    }
  }

  return false;
}

/**
 * Parse a `bills+<token>@<domain>` recipient and return the token. Accepts
 * angle-bracket-wrapped addresses (`Foo Bar <bills+abc@example.com>`).
 *
 * Token must be exactly TOKEN_LENGTH base32 chars — `generateInboundToken`
 * always emits that, so anything else is malformed.
 */
const RECIPIENT_RE = new RegExp(
  `(?:^|<)\\s*bills\\+([a-z2-7]{${TOKEN_LENGTH}})@([a-z0-9.-]+)\\s*>?`,
  'i',
);

export function parseInboundRecipient(to: string): { token: string; domain: string } | null {
  const match = to.match(RECIPIENT_RE);
  if (!match) return null;
  const [, token, domain] = match;
  if (!token || !domain) return null;
  return { token: token.toLowerCase(), domain: domain.toLowerCase() };
}
