import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock node:dns/promises.lookup so we can control resolution per-test.
const lookupMock = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({
  lookup: lookupMock,
  default: { lookup: lookupMock },
}));

import {
  SsrfBlockedError,
  assertPublicHttpsTarget,
  isBlockedAddress,
} from '@/lib/security/ssrf-guard';

// Production calls `lookup(hostname, { all: true })` which returns LookupAddress[].
const mockedLookup = lookupMock as unknown as {
  mockResolvedValueOnce: (value: { address: string; family: number }[]) => void;
  mockReset: () => void;
};

afterEach(() => {
  mockedLookup.mockReset();
});

describe('isBlockedAddress', () => {
  it('rejects IPv4 loopback', () => {
    expect(isBlockedAddress('127.0.0.1')).toBe(true);
    expect(isBlockedAddress('127.10.20.30')).toBe(true);
  });

  it('rejects IPv4 RFC1918 private ranges', () => {
    expect(isBlockedAddress('10.0.0.1')).toBe(true);
    expect(isBlockedAddress('10.255.255.255')).toBe(true);
    expect(isBlockedAddress('172.16.0.1')).toBe(true);
    expect(isBlockedAddress('172.31.255.255')).toBe(true);
    expect(isBlockedAddress('192.168.1.1')).toBe(true);
  });

  it('rejects IPv4 link-local incl. EC2 IMDS', () => {
    expect(isBlockedAddress('169.254.0.1')).toBe(true);
    expect(isBlockedAddress('169.254.169.254')).toBe(true);
  });

  it('rejects IPv4 CGNAT (100.64/10)', () => {
    expect(isBlockedAddress('100.64.0.1')).toBe(true);
    expect(isBlockedAddress('100.127.255.255')).toBe(true);
  });

  it('rejects IPv4 special-purpose documentation and benchmarking ranges', () => {
    expect(isBlockedAddress('192.0.2.1')).toBe(true);
    expect(isBlockedAddress('198.18.0.1')).toBe(true);
    expect(isBlockedAddress('198.19.255.255')).toBe(true);
    expect(isBlockedAddress('198.51.100.1')).toBe(true);
    expect(isBlockedAddress('203.0.113.1')).toBe(true);
    expect(isBlockedAddress('192.88.99.1')).toBe(true);
  });

  it('rejects IPv4 0.0.0.0/8 + reserved/multicast', () => {
    expect(isBlockedAddress('0.0.0.0')).toBe(true);
    expect(isBlockedAddress('0.1.2.3')).toBe(true);
    expect(isBlockedAddress('224.0.0.1')).toBe(true);
    expect(isBlockedAddress('255.255.255.255')).toBe(true);
  });

  it('accepts genuine public IPv4', () => {
    expect(isBlockedAddress('8.8.8.8')).toBe(false);
    expect(isBlockedAddress('1.1.1.1')).toBe(false);
    expect(isBlockedAddress('142.250.190.46')).toBe(false);
  });

  it('rejects IPv6 loopback + unspecified', () => {
    expect(isBlockedAddress('::1')).toBe(true);
    expect(isBlockedAddress('::')).toBe(true);
  });

  it('rejects IPv6 ULA (fc00::/7) + link-local (fe80::/10)', () => {
    expect(isBlockedAddress('fc00::1')).toBe(true);
    expect(isBlockedAddress('fd12:3456::1')).toBe(true);
    expect(isBlockedAddress('fe80::1')).toBe(true);
  });

  it('rejects IPv6 multicast (ff00::/8)', () => {
    expect(isBlockedAddress('ff02::1')).toBe(true);
  });

  it('rejects IPv6 documentation and benchmarking ranges', () => {
    expect(isBlockedAddress('2001:db8::1')).toBe(true);
    expect(isBlockedAddress('2001:2::1')).toBe(true);
  });

  it('rejects IPv4-mapped IPv6 of private addresses', () => {
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedAddress('::ffff:169.254.169.254')).toBe(true);
    expect(isBlockedAddress('::ffff:10.0.0.1')).toBe(true);
  });

  it('R2-F2: rejects zero-padded loopback / unspecified (post-expand defense-in-depth)', () => {
    // The exact-match table catches `::1` and `0:0:0:0:0:0:0:1` but a fully
    // zero-padded form has its own canonical-looking representation that
    // reaches `isBlockedV6` and must be blocked post-expansion.
    expect(isBlockedAddress('0000:0000:0000:0000:0000:0000:0000:0001')).toBe(true);
    expect(isBlockedAddress('0000:0000:0000:0000:0000:0000:0000:0000')).toBe(true);
  });

  it('R2-F1: rejects 6to4 (2002::/16) embedding private IPv4', () => {
    // 2002:7f00:0001:: encodes 127.0.0.1; 2002:c0a8:0101:: encodes 192.168.1.1;
    // 2002:a9fe:a9fe:: encodes 169.254.169.254 (EC2 IMDS).
    expect(isBlockedAddress('2002:7f00:0001::')).toBe(true);
    expect(isBlockedAddress('2002:c0a8:0101::')).toBe(true);
    expect(isBlockedAddress('2002:a9fe:a9fe::')).toBe(true);
  });

  it('R2-F1: 6to4 embedding genuine public IPv4 is still allowed', () => {
    // 2002:0808:0808:: encodes 8.8.8.8 — public DNS, not a private range.
    // Confirms the 6to4 branch defers to isBlockedV4 instead of blocking the
    // entire 2002::/16 prefix.
    expect(isBlockedAddress('2002:0808:0808::')).toBe(false);
  });

  it('accepts genuine public IPv6', () => {
    expect(isBlockedAddress('2001:4860:4860::8888')).toBe(false);
  });

  it('rejects garbage', () => {
    expect(isBlockedAddress('not-an-ip')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
  });
});

describe('assertPublicHttpsTarget', () => {
  it('rejects http:// (non-HTTPS)', async () => {
    await expect(assertPublicHttpsTarget('http://example.com/hook')).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
    await expect(assertPublicHttpsTarget('http://example.com/hook')).rejects.toMatchObject({
      code: 'not_https',
    });
  });

  it('rejects ftp:// and other non-HTTPS schemes', async () => {
    await expect(assertPublicHttpsTarget('ftp://example.com/')).rejects.toMatchObject({
      code: 'not_https',
    });
  });

  it('rejects unparseable URLs', async () => {
    await expect(assertPublicHttpsTarget('not a url')).rejects.toMatchObject({ code: 'parse' });
  });

  it('rejects literal IPv4 loopback (127.0.0.1) without DNS', async () => {
    await expect(assertPublicHttpsTarget('https://127.0.0.1/')).rejects.toMatchObject({
      code: 'blocked',
    });
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it('rejects literal IPv6 loopback (::1) without DNS', async () => {
    await expect(assertPublicHttpsTarget('https://[::1]/')).rejects.toMatchObject({
      code: 'blocked',
    });
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it('rejects literal RFC1918 (10.0.0.1)', async () => {
    await expect(assertPublicHttpsTarget('https://10.0.0.1/')).rejects.toMatchObject({
      code: 'blocked',
    });
  });

  it('rejects literal RFC1918 (172.16.0.5)', async () => {
    await expect(assertPublicHttpsTarget('https://172.16.0.5/')).rejects.toMatchObject({
      code: 'blocked',
    });
  });

  it('rejects literal RFC1918 (192.168.1.10)', async () => {
    await expect(assertPublicHttpsTarget('https://192.168.1.10/')).rejects.toMatchObject({
      code: 'blocked',
    });
  });

  it('rejects literal link-local IMDS (169.254.169.254)', async () => {
    await expect(
      assertPublicHttpsTarget('https://169.254.169.254/latest/meta-data/'),
    ).rejects.toMatchObject({ code: 'blocked' });
  });

  it('rejects literal CGNAT (100.64.1.1)', async () => {
    await expect(assertPublicHttpsTarget('https://100.64.1.1/')).rejects.toMatchObject({
      code: 'blocked',
    });
  });

  it('rejects when DNS resolves to a private address', async () => {
    mockedLookup.mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }]);
    await expect(
      assertPublicHttpsTarget('https://internal.example.com/hook'),
    ).rejects.toMatchObject({ code: 'blocked' });
  });

  it('rejects when DNS resolves to IMDS', async () => {
    mockedLookup.mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }]);
    await expect(assertPublicHttpsTarget('https://rebind.example.com/')).rejects.toMatchObject({
      code: 'blocked',
    });
  });

  it('rejects when ANY of multiple DNS answers is private (rebinding)', async () => {
    mockedLookup.mockResolvedValueOnce([
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    await expect(assertPublicHttpsTarget('https://mixed.example.com/')).rejects.toMatchObject({
      code: 'blocked',
    });
  });

  it('accepts a hostname that resolves to a public IPv4 (8.8.8.8)', async () => {
    mockedLookup.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]);
    const r = await assertPublicHttpsTarget('https://dns.google/');
    expect(r.resolvedIp).toBe('8.8.8.8');
    expect(r.family).toBe(4);
    expect(r.hostname).toBe('dns.google');
  });

  it('accepts a hostname that resolves to a public IPv6', async () => {
    mockedLookup.mockResolvedValueOnce([{ address: '2001:4860:4860::8888', family: 6 }]);
    const r = await assertPublicHttpsTarget('https://dns.google/');
    expect(r.resolvedIp).toBe('2001:4860:4860::8888');
    expect(r.family).toBe(6);
  });

  it('rejects when DNS returns no addresses', async () => {
    mockedLookup.mockResolvedValueOnce([]);
    await expect(assertPublicHttpsTarget('https://void.example.com/')).rejects.toMatchObject({
      code: 'blocked',
    });
  });
});
