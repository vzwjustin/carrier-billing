/**
 * Middleware CSP behavior tests.
 *
 * These assertions lock in two security-relevant pieces of the
 * Content-Security-Policy emitted by `src/middleware.ts`:
 *
 *   1. `unsafe-eval` is allowed only in non-production builds (Next.js dev
 *      HMR needs it; PostHog and Stripe.js do not).
 *   2. `img-src` uses an explicit allowlist — bare `https:` would defeat
 *      the purpose of the allowlist.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildCsp } from '../../src/middleware';

function getDirective(csp: string, name: string): string | undefined {
  const parts = csp.split(';').map((p) => p.trim());
  for (const part of parts) {
    if (part === '' ) continue;
    const space = part.indexOf(' ');
    const key = space === -1 ? part : part.slice(0, space);
    if (key === name) {
      return space === -1 ? '' : part.slice(space + 1);
    }
  }
  return undefined;
}

describe('middleware CSP — script-src `unsafe-eval` gating', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does NOT include unsafe-eval in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const csp = buildCsp();
    const scriptSrc = getDirective(csp, 'script-src');
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    // Sanity: the rest of the script-src allowlist still includes Stripe + PostHog
    expect(scriptSrc).toContain('https://js.stripe.com');
    expect(scriptSrc).toContain('https://*.posthog.com');
  });

  it('DOES include unsafe-eval outside production (Next dev HMR)', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const csp = buildCsp();
    const scriptSrc = getDirective(csp, 'script-src');
    expect(scriptSrc).toContain("'unsafe-eval'");
  });

  it('DOES include unsafe-eval in test mode (vitest, harness)', () => {
    vi.stubEnv('NODE_ENV', 'test');
    const csp = buildCsp();
    const scriptSrc = getDirective(csp, 'script-src');
    expect(scriptSrc).toContain("'unsafe-eval'");
  });
});

describe('middleware CSP — img-src allowlist', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does NOT use bare `https:` (would defeat the allowlist)', () => {
    const csp = buildCsp();
    const imgSrc = getDirective(csp, 'img-src');
    expect(imgSrc).toBeDefined();
    // Bare `https:` is only present as part of the explicit Supabase hostname
    // (`https://*.supabase.co`); a standalone `https:` token is forbidden.
    const tokens = (imgSrc ?? '').split(/\s+/).filter((t) => t.length > 0);
    expect(tokens).not.toContain('https:');
  });

  it('allows the Supabase storage host and same-origin/data/blob', () => {
    const csp = buildCsp();
    const imgSrc = getDirective(csp, 'img-src');
    expect(imgSrc).toContain("'self'");
    expect(imgSrc).toContain('data:');
    expect(imgSrc).toContain('blob:');
    expect(imgSrc).toContain('https://*.supabase.co');
  });
});
