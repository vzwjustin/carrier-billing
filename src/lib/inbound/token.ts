import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

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

const TOKEN_BYTES = 10; // 10 bytes → 16 base32 chars (no padding)

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

  const existing = (data as { inbound_email_token?: string | null } | null)
    ?.inbound_email_token;
  if (typeof existing === 'string' && existing.length > 0) {
    return existing;
  }

  // Generate + persist atomically. If another caller wrote one between the
  // read and the update we accept the loser-wrote-token via the unique index;
  // re-fetch to return whichever value won.
  const fresh = generateInboundToken();
  const { error: updateErr } = await admin
    .from('profiles')
    .update({
      inbound_email_token: fresh,
      updated_at: new Date().toISOString(),
    })
    .eq('id', userId)
    .is('inbound_email_token', null);

  if (updateErr) {
    // Most likely a unique-index collision (we generated the same token as
    // another user — astronomically unlikely with 10 bytes of entropy, but
    // not impossible). Re-read and try again once.
    const reread = await admin
      .from('profiles')
      .select('inbound_email_token')
      .eq('id', userId)
      .maybeSingle();
    const nowExisting = (
      reread.data as { inbound_email_token?: string | null } | null
    )?.inbound_email_token;
    if (typeof nowExisting === 'string' && nowExisting.length > 0) {
      return nowExisting;
    }
    throw new Error(`inbound token write failed: ${updateErr.message}`);
  }

  // Re-read in case a concurrent update beat us to it.
  const reread = await admin
    .from('profiles')
    .select('inbound_email_token')
    .eq('id', userId)
    .maybeSingle();
  const persisted = (
    reread.data as { inbound_email_token?: string | null } | null
  )?.inbound_email_token;
  return persisted ?? fresh;
}

/**
 * Constant-time HMAC-SHA256 comparison so the verifier doesn't leak signature
 * mismatches via timing.
 */
export function verifyHmac(
  body: string,
  signatureHex: string,
  secret: string,
): boolean {
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  if (expected.length !== signatureHex.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHex));
  } catch {
    return false;
  }
}

/**
 * Parse a `bills+<token>@<domain>` recipient and return the token. Accepts
 * angle-bracket-wrapped addresses (`Foo Bar <bills+abc@example.com>`).
 */
const RECIPIENT_RE =
  /(?:^|<)\s*bills\+([a-z2-7]{6,32})@([a-z0-9.-]+)\s*>?/i;

export function parseInboundRecipient(
  to: string,
): { token: string; domain: string } | null {
  const match = to.match(RECIPIENT_RE);
  if (!match) return null;
  const [, token, domain] = match;
  if (!token || !domain) return null;
  return { token: token.toLowerCase(), domain: domain.toLowerCase() };
}
