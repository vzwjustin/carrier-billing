import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * SSRF guard for outbound user-supplied URLs (outbound webhook destinations,
 * inbound forwarding hooks, etc.).
 *
 * Two responsibilities:
 *   1. `assertPublicHttpsTarget(url)` — accept a string URL and reject if the
 *      scheme is not HTTPS or any DNS-resolved address falls in a private,
 *      loopback, link-local, CGNAT, or otherwise non-public range. Returns the
 *      first resolved address for observability/tests; normal callers should
 *      still fetch the original URL so HTTPS certificate validation and SNI use
 *      the intended hostname.
 *   2. `isBlockedAddress(ip)` — exposed for tests + callers that already have
 *      a resolved address (e.g. validating a redirect Location host).
 *
 * Intentionally dependency-free: a tiny CIDR/range check beats pulling in
 * `ipaddr.js` or `ip` for half a dozen ranges.
 */

const ERR_NOT_HTTPS = 'URL must use https://';
const ERR_PARSE = 'Invalid URL';
const ERR_BLOCKED = 'URL resolves to a non-public address';
const ERR_NO_HOST = 'URL has no host';

export class SsrfBlockedError extends Error {
  readonly code: 'not_https' | 'parse' | 'blocked' | 'no_host';
  constructor(code: SsrfBlockedError['code'], message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
    this.code = code;
  }
}

interface ResolvedTarget {
  resolvedIp: string;
  family: 4 | 6;
  hostname: string;
}

/**
 * Validate a URL is safe to fetch from a server-side context.
 *
 * Rejects:
 *   - non-HTTPS schemes
 *   - hostnames whose DNS resolution returns any address in a non-public range
 *
 * Returns the first resolved address. Call this immediately before fetching the
 * original URL. This preflight blocks obvious SSRF targets, including mixed
 * public/private DNS answers, but does not pin fetch's later DNS lookup; callers
 * requiring full DNS-rebinding resistance need a transport-level custom lookup
 * that preserves the original hostname for TLS/SNI.
 */
export async function assertPublicHttpsTarget(
  url: string,
): Promise<ResolvedTarget> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfBlockedError('parse', ERR_PARSE);
  }

  if (parsed.protocol !== 'https:') {
    throw new SsrfBlockedError('not_https', ERR_NOT_HTTPS);
  }

  const hostname = parsed.hostname;
  if (!hostname) {
    throw new SsrfBlockedError('no_host', ERR_NO_HOST);
  }

  // URL.hostname returns IPv6 wrapped in brackets (`[::1]`); strip them
  // before passing to isIP / isBlockedAddress, which expect bare addresses.
  const rawHost =
    hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname;

  // If the URL is already a literal IP, validate that directly — no DNS
  // lookup needed (and `dns.lookup` would echo it back anyway on most stacks).
  const literalFamily = isIP(rawHost);
  if (literalFamily !== 0) {
    if (isBlockedAddress(rawHost)) {
      throw new SsrfBlockedError('blocked', ERR_BLOCKED);
    }
    return {
      resolvedIp: rawHost,
      family: literalFamily === 4 ? 4 : 6,
      hostname,
    };
  }

  // Resolve all addresses; reject if ANY are blocked. A multi-A response that
  // mixes a public + private address is a classic rebinding setup.
  const addrs = await lookup(hostname, { all: true });
  if (addrs.length === 0) {
    throw new SsrfBlockedError('blocked', ERR_BLOCKED);
  }
  for (const a of addrs) {
    if (isBlockedAddress(a.address)) {
      throw new SsrfBlockedError('blocked', ERR_BLOCKED);
    }
  }
  const first = addrs[0]!;
  return {
    resolvedIp: first.address,
    family: first.family === 4 ? 4 : 6,
    hostname,
  };
}

/**
 * Returns true if the address is in a blocked range (loopback, private,
 * link-local incl. IMDS 169.254.169.254, CGNAT, multicast, IPv6 ULA/link-local,
 * IPv4-mapped IPv6 representations of the same).
 */
export function isBlockedAddress(addr: string): boolean {
  const family = isIP(addr);
  if (family === 4) return isBlockedV4(addr);
  if (family === 6) return isBlockedV6(addr);
  // Not a valid IP literal — treat as blocked (caller should never hit this).
  return true;
}

function isBlockedV4(addr: string): boolean {
  const parts = addr.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];

  // 0.0.0.0/8 — "this network", includes 0.0.0.0 unspecified.
  if (a === 0) return true;
  // 10.0.0.0/8 — RFC1918 private.
  if (a === 10) return true;
  // 127.0.0.0/8 — loopback.
  if (a === 127) return true;
  // 169.254.0.0/16 — link-local (incl. EC2/GCP IMDS at 169.254.169.254).
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 — RFC1918 private.
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 — RFC1918 private.
  if (a === 192 && b === 168) return true;
  // 100.64.0.0/10 — CGNAT (RFC6598).
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 224.0.0.0/4 — multicast.
  if (a >= 224 && a <= 239) return true;
  // 240.0.0.0/4 — reserved (incl. broadcast 255.255.255.255).
  if (a >= 240) return true;
  return false;
}

function isBlockedV6(addrIn: string): boolean {
  const addr = addrIn.toLowerCase();

  // ::1 — loopback. (Could be expanded form too.)
  if (addr === '::1' || addr === '0:0:0:0:0:0:0:1') return true;
  // :: — unspecified.
  if (addr === '::' || addr === '0:0:0:0:0:0:0:0') return true;

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) — defer to
  // the v4 check on the embedded address.
  const v4MappedMatch = addr.match(/^::ffff:([0-9.]+)$/);
  if (v4MappedMatch && v4MappedMatch[1] && isIP(v4MappedMatch[1]) === 4) {
    return isBlockedV4(v4MappedMatch[1]);
  }
  const v4CompatMatch = addr.match(/^::([0-9.]+)$/);
  if (v4CompatMatch && v4CompatMatch[1] && isIP(v4CompatMatch[1]) === 4) {
    return isBlockedV4(v4CompatMatch[1]);
  }

  // Expand to 8 hextets for prefix checks.
  const hextets = expandV6(addr);
  if (!hextets) return true;

  // R2-F2 fix: post-expansion loopback/unspecified detection. The exact-match
  // checks at the top of this function catch the canonical `::1` / `::` and
  // the colon-separated 8-hextet form `0:0:0:0:0:0:0:1`, but a zero-padded
  // form like `0000:0000:0000:0000:0000:0000:0000:0001` reaches this point.
  // Block it post-expansion. Same defense applies to the unspecified address.
  if (
    hextets[0] === 0 &&
    hextets[1] === 0 &&
    hextets[2] === 0 &&
    hextets[3] === 0 &&
    hextets[4] === 0 &&
    hextets[5] === 0 &&
    hextets[6] === 0 &&
    (hextets[7] === 0 || hextets[7] === 1)
  ) {
    return true;
  }

  const first = hextets[0]!;

  // fc00::/7 — unique local addresses (fc00..fdff).
  if ((first & 0xfe00) === 0xfc00) return true;
  // fe80::/10 — link-local.
  if ((first & 0xffc0) === 0xfe80) return true;
  // ff00::/8 — multicast.
  if ((first & 0xff00) === 0xff00) return true;

  // R2-F1 fix: 6to4 prefix (2002::/16, RFC 3056). hextets[1..2] hold the
  // embedded IPv4. An attacker supplying `2002:7f00:0001::` reaches a host
  // representing 127.0.0.1 via 6to4 tunnel encoding. Even on systems where
  // 6to4 is no longer routable, defense-in-depth blocks the form before any
  // future stack re-enables it.
  if ((first & 0xffff) === 0x2002) {
    const h1 = hextets[1]!;
    const h2 = hextets[2]!;
    const embedded =
      `${(h1 >> 8) & 0xff}.${h1 & 0xff}.${(h2 >> 8) & 0xff}.${h2 & 0xff}`;
    return isBlockedV4(embedded);
  }

  // C1 fix: IPv4-mapped hex-group form (::ffff:h1:h2 where hextets 0–4 are 0
  // and hextet 5 is 0xffff). The dot-notation regex above catches
  // `::ffff:a.b.c.d`; this catches `::ffff:7f00:1` (= 127.0.0.1) etc.
  if (
    hextets[0] === 0 &&
    hextets[1] === 0 &&
    hextets[2] === 0 &&
    hextets[3] === 0 &&
    hextets[4] === 0 &&
    hextets[5] === 0xffff
  ) {
    const h6 = hextets[6]!;
    const h7 = hextets[7]!;
    const embedded = `${(h6 >> 8) & 0xff}.${h6 & 0xff}.${(h7 >> 8) & 0xff}.${h7 & 0xff}`;
    return isBlockedV4(embedded);
  }

  // C2 fix: NAT64 prefix (64:ff9b::/96, RFC 6052/6146). On IPv6-only or
  // dual-stack NAT64 hosts this maps IPv4 into IPv6 space. hextets 6–7 hold
  // the embedded IPv4 in the same layout as the v4-mapped case above.
  if (
    hextets[0] === 0x0064 &&
    hextets[1] === 0xff9b &&
    hextets[2] === 0 &&
    hextets[3] === 0 &&
    hextets[4] === 0 &&
    hextets[5] === 0
  ) {
    const h6 = hextets[6]!;
    const h7 = hextets[7]!;
    const embedded = `${(h6 >> 8) & 0xff}.${h6 & 0xff}.${(h7 >> 8) & 0xff}.${h7 & 0xff}`;
    return isBlockedV4(embedded);
  }

  return false;
}

function expandV6(addr: string): number[] | null {
  // Strip zone id (e.g. "fe80::1%eth0").
  const noZone = addr.split('%')[0]!;
  // Handle :: shortcut by splitting on it.
  const parts = noZone.split('::');
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const total = 8;
  const fillCount = total - left.length - right.length;
  if (fillCount < 0) return null;
  if (parts.length === 1 && left.length !== total) return null;
  const middle: string[] = parts.length === 2 ? new Array(fillCount).fill('0') : [];
  const all = [...left, ...middle, ...right];
  if (all.length !== total) return null;
  const out: number[] = [];
  for (const h of all) {
    if (!/^[0-9a-f]{1,4}$/.test(h)) return null;
    out.push(parseInt(h, 16));
  }
  return out;
}
