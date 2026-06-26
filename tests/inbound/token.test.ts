import { createHmac } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import {
  generateInboundToken,
  getOrCreateInboundToken,
  parseInboundRecipient,
  verifyHmac,
} from '@/lib/inbound/token';

describe('generateInboundToken', () => {
  it('returns a 16-char base32 string', () => {
    for (let i = 0; i < 100; i += 1) {
      const t = generateInboundToken();
      expect(t).toMatch(/^[a-z2-7]{16}$/);
    }
  });

  it('returns distinct tokens on successive calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) seen.add(generateInboundToken());
    expect(seen.size).toBe(50);
  });
});

describe('parseInboundRecipient', () => {
  it('extracts token + domain from a plain address', () => {
    expect(parseInboundRecipient('bills+abcdefgh23456pqr@inbound.example.com')).toEqual({
      token: 'abcdefgh23456pqr',
      domain: 'inbound.example.com',
    });
  });

  it('handles angle-bracket-wrapped addresses with display name', () => {
    expect(
      parseInboundRecipient('CarrierAudit <bills+xyzpdq2345abcdef@inbound.example.com>'),
    ).toEqual({ token: 'xyzpdq2345abcdef', domain: 'inbound.example.com' });
  });

  it('lower-cases token + domain', () => {
    expect(parseInboundRecipient('Bills+ABCDE2345FGHIJ23@INBOUND.example.com')).toEqual({
      token: 'abcde2345fghij23',
      domain: 'inbound.example.com',
    });
  });

  it('returns null when local-part has no token suffix', () => {
    expect(parseInboundRecipient('bills@inbound.example.com')).toBeNull();
  });

  it('returns null when token is too short (not exactly 16)', () => {
    expect(parseInboundRecipient('bills+abc@inbound.example.com')).toBeNull();
    expect(parseInboundRecipient('bills+abc234567@inbound.example.com')).toBeNull();
  });

  it('returns null when token is too long (not exactly 16)', () => {
    expect(parseInboundRecipient('bills+abcdefghij234567abc@inbound.example.com')).toBeNull();
  });

  it('returns null when local-part is wrong (e.g. reports+token)', () => {
    expect(parseInboundRecipient('reports+abcdefgh23456789@inbound.example.com')).toBeNull();
  });

  it('returns null on garbage input', () => {
    expect(parseInboundRecipient('not an email')).toBeNull();
    expect(parseInboundRecipient('')).toBeNull();
  });
});

describe('verifyHmac', () => {
  const secret = 'shared-secret-1234567890abcdef';
  const body = '{"hello":"world"}';
  const goodSig = createHmac('sha256', secret).update(body).digest('hex');

  it('returns true for matching signature', () => {
    expect(verifyHmac(body, goodSig, secret)).toBe(true);
  });

  it('returns false for a different signature', () => {
    expect(verifyHmac(body, goodSig.replace(/^./, '0'), secret)).toBe(false);
  });

  it('returns false when length differs (timing-safe)', () => {
    expect(verifyHmac(body, goodSig.slice(0, -1), secret)).toBe(false);
  });

  it('returns false when body differs', () => {
    expect(verifyHmac(`${body} `, goodSig, secret)).toBe(false);
  });

  it('accepts uppercase hex (case-insensitive)', () => {
    expect(verifyHmac(body, goodSig.toUpperCase(), secret)).toBe(true);
  });

  it('accepts a sha256= prefix', () => {
    expect(verifyHmac(body, `sha256=${goodSig}`, secret)).toBe(true);
  });

  it('accepts uppercase hex with a sha256= prefix', () => {
    expect(verifyHmac(body, `sha256=${goodSig.toUpperCase()}`, secret)).toBe(true);
  });

  it('returns false on junk (non-hex) input', () => {
    expect(verifyHmac(body, 'not hex', secret)).toBe(false);
  });

  it('returns false when input has wrong length even with the prefix', () => {
    expect(verifyHmac(body, `sha256=${goodSig.slice(0, -2)}`, secret)).toBe(false);
  });

  it('does not throw on non-string signature', () => {
    expect(verifyHmac(body, undefined as unknown as string, secret)).toBe(false);
  });
});

describe('getOrCreateInboundToken', () => {
  type SelectResult = {
    data: { inbound_email_token: string | null } | null;
    error: { message: string } | null;
  };
  type UpdateResult = {
    data: Array<{ inbound_email_token: string | null }> | null;
    error: { message: string; code?: string } | null;
  };

  function makeAdmin(selectResults: SelectResult[], updateResults: UpdateResult[]): SupabaseClient {
    return {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () =>
              selectResults.shift() ?? {
                data: null,
                error: { message: 'unexpected select' },
              },
          }),
        }),
        update: () => ({
          eq: () => ({
            is: () => ({
              select: async () =>
                updateResults.shift() ?? {
                  data: null,
                  error: { message: 'unexpected update' },
                },
            }),
          }),
        }),
      }),
    } as unknown as SupabaseClient;
  }

  it('surfaces race-path reread errors instead of mislabeling them as collisions', async () => {
    const admin = makeAdmin(
      [
        { data: { inbound_email_token: null }, error: null },
        { data: null, error: { message: 'database unavailable' } },
      ],
      [{ data: [], error: null }],
    );

    await expect(getOrCreateInboundToken(admin, 'user_1')).rejects.toThrow(
      'inbound token reread failed: database unavailable',
    );
  });

  // L-10: accept base64 signatures (some providers send base64 instead of hex).
  const secret = 'shared-secret-1234567890abcdef';
  const body = '{"hello":"world"}';

  it('accepts a base64-encoded signature', () => {
    const b64 = createHmac('sha256', secret).update(body).digest('base64');
    expect(verifyHmac(body, b64, secret)).toBe(true);
  });

  it('accepts a base64 signature with a sha256= prefix', () => {
    const b64 = createHmac('sha256', secret).update(body).digest('base64');
    expect(verifyHmac(body, `sha256=${b64}`, secret)).toBe(true);
  });

  it('accepts a url-safe base64 signature', () => {
    const b64 = createHmac('sha256', secret).update(body).digest('base64');
    const urlSafe = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(verifyHmac(body, urlSafe, secret)).toBe(true);
  });

  it('returns false for a wrong base64 signature', () => {
    const b64 = createHmac('sha256', secret).update('different body').digest('base64');
    expect(verifyHmac(body, b64, secret)).toBe(false);
  });
});
