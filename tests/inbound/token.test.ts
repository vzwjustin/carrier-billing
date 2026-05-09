import { describe, expect, it } from 'vitest';

import {
  generateInboundToken,
  parseInboundRecipient,
  verifyHmac,
} from '@/lib/inbound/token';
import { createHmac } from 'node:crypto';

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
    expect(
      parseInboundRecipient('bills+abc234567@inbound.example.com'),
    ).toEqual({ token: 'abc234567', domain: 'inbound.example.com' });
  });

  it('handles angle-bracket-wrapped addresses with display name', () => {
    expect(
      parseInboundRecipient(
        'CarrierAudit <bills+xyzpdq2345@inbound.example.com>',
      ),
    ).toEqual({ token: 'xyzpdq2345', domain: 'inbound.example.com' });
  });

  it('lower-cases token + domain', () => {
    expect(
      parseInboundRecipient('Bills+ABCDE2345@INBOUND.example.com'),
    ).toEqual({ token: 'abcde2345', domain: 'inbound.example.com' });
  });

  it('returns null when local-part has no token suffix', () => {
    expect(parseInboundRecipient('bills@inbound.example.com')).toBeNull();
  });

  it('returns null when token is too short', () => {
    expect(parseInboundRecipient('bills+abc@inbound.example.com')).toBeNull();
  });

  it('returns null when local-part is wrong (e.g. reports+token)', () => {
    expect(
      parseInboundRecipient('reports+abc234567@inbound.example.com'),
    ).toBeNull();
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
    expect(
      verifyHmac(body, goodSig.replace(/^./, '0'), secret),
    ).toBe(false);
  });

  it('returns false when length differs (timing-safe)', () => {
    expect(verifyHmac(body, goodSig.slice(0, -1), secret)).toBe(false);
  });

  it('returns false when body differs', () => {
    expect(verifyHmac(`${body} `, goodSig, secret)).toBe(false);
  });
});
