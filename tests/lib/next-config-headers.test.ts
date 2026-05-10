// Asserts the Next.js header matcher config emits Referrer-Policy: no-referrer
// for the two routes that embed a share token in the URL:
//   - /share/:path*               (token in path segment, public viewer)
//   - /api/audits/:id*/report.pdf (token in ?token= query string)
//
// Without this override, the global Referrer-Policy: strict-origin-when-cross-origin
// default would still send the full URL (including the token) in the Referer
// header on same-origin navigation away from the page.
import { describe, expect, it } from 'vitest';

// Import the named export from next.config.ts. We deliberately do NOT import
// the default export (it is wrapped by withSentryConfig and may strip or
// transform the headers function depending on Sentry version).
import { headersConfig } from '../../next.config';

interface HeaderEntry {
  key: string;
  value: string;
}

interface MatcherEntry {
  source: string;
  headers: HeaderEntry[];
}

function findEntries(source: string): MatcherEntry[] {
  return (headersConfig as MatcherEntry[]).filter((e) => e.source === source);
}

function lastReferrerPolicyForSource(source: string): string | undefined {
  // Walk every matcher in declaration order. Per Next.js semantics, when
  // multiple matchers apply to the same path and set the same key, the LAST
  // one wins. We simulate that by tracking the most-recent value across
  // matchers whose source equals the requested source. (For a more rigorous
  // path-glob simulation we'd need a router, but we only assert for the exact
  // sources we declare, which is sufficient here.)
  let latest: string | undefined;
  for (const entry of headersConfig as MatcherEntry[]) {
    if (entry.source !== source) continue;
    for (const h of entry.headers) {
      if (h.key.toLowerCase() === 'referrer-policy') latest = h.value;
    }
  }
  return latest;
}

describe('next.config headers matcher', () => {
  it('declares an override for /share/:path* setting Referrer-Policy: no-referrer', () => {
    const entries = findEntries('/share/:path*');
    expect(entries.length).toBeGreaterThanOrEqual(1);

    const referrer = entries
      .flatMap((e) => e.headers)
      .find((h) => h.key.toLowerCase() === 'referrer-policy');
    expect(referrer?.value).toBe('no-referrer');
  });

  it('declares an override for /api/audits/:id*/report.pdf setting Referrer-Policy: no-referrer', () => {
    const entries = findEntries('/api/audits/:id*/report.pdf');
    expect(entries.length).toBeGreaterThanOrEqual(1);

    const referrer = entries
      .flatMap((e) => e.headers)
      .find((h) => h.key.toLowerCase() === 'referrer-policy');
    expect(referrer?.value).toBe('no-referrer');
  });

  it('preserves the default Referrer-Policy: strict-origin-when-cross-origin for /:path*', () => {
    // Sanity check that the override blocks did not accidentally weaken the
    // default for every other route.
    expect(lastReferrerPolicyForSource('/:path*')).toBe(
      'strict-origin-when-cross-origin',
    );
  });

  it('orders the overrides AFTER the default block (Next.js: last header wins)', () => {
    const sources = (headersConfig as MatcherEntry[]).map((e) => e.source);
    const defaultIdx = sources.indexOf('/:path*');
    const shareIdx = sources.indexOf('/share/:path*');
    const pdfIdx = sources.indexOf('/api/audits/:id*/report.pdf');

    expect(defaultIdx).toBeGreaterThanOrEqual(0);
    expect(shareIdx).toBeGreaterThan(defaultIdx);
    expect(pdfIdx).toBeGreaterThan(defaultIdx);
  });
});
