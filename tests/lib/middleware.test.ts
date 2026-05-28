import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for the top-level middleware() in src/middleware.ts.
 *
 * The CSP string building is covered separately by middleware-csp.test.ts.
 * This file pins the composition: middleware delegates to updateSession,
 * then layers the CSP header onto whatever response that returned (whether
 * a NextResponse.next() or a redirect to /login).
 */

const updateSessionMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase/middleware', () => ({
  updateSession: updateSessionMock,
}));

import { middleware } from '@/middleware';
import { NextResponse } from 'next/server';

function makeReq(url = 'http://localhost:3000/dashboard'): NextRequest {
  return new NextRequest(url);
}

beforeEach(() => {
  updateSessionMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('middleware() — CSP application', () => {
  it('sets Content-Security-Policy on the response from updateSession', async () => {
    updateSessionMock.mockResolvedValue(NextResponse.next());
    const res = await middleware(makeReq());
    expect(res.headers.get('Content-Security-Policy')).not.toBeNull();
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
  });

  it('preserves a redirect from updateSession AND attaches the CSP header', async () => {
    // When updateSession returns a redirect to /login, the CSP must still
    // be set — otherwise the redirect-to-login page would render without
    // a policy.
    const redirect = NextResponse.redirect('http://localhost:3000/login');
    updateSessionMock.mockResolvedValue(redirect);

    const res = await middleware(makeReq('http://localhost:3000/dashboard'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
    expect(res.headers.get('Content-Security-Policy')).not.toBeNull();
  });

  it('calls updateSession once per request', async () => {
    updateSessionMock.mockResolvedValue(NextResponse.next());
    await middleware(makeReq());
    expect(updateSessionMock).toHaveBeenCalledTimes(1);
  });

  it('forwards the actual request object to updateSession', async () => {
    updateSessionMock.mockResolvedValue(NextResponse.next());
    const req = makeReq('http://localhost:3000/settings');
    await middleware(req);
    expect(updateSessionMock).toHaveBeenCalledWith(req);
  });
});

describe('middleware config matcher', () => {
  it('exports a Next.js-compatible matcher config', async () => {
    const mod = await import('@/middleware');
    expect(mod.config).toBeDefined();
    expect(Array.isArray(mod.config.matcher)).toBe(true);
    expect(mod.config.matcher.length).toBeGreaterThan(0);
  });

  it('explicitly excludes /api routes (so middleware does not double-handle them)', async () => {
    const mod = await import('@/middleware');
    const source = JSON.stringify(mod.config.matcher);
    expect(source).toContain('api/');
  });

  it('excludes the Sentry tunnel path (/monitoring)', async () => {
    const mod = await import('@/middleware');
    const source = JSON.stringify(mod.config.matcher);
    expect(source).toContain('monitoring');
  });

  it('excludes _next static + image optimization paths', async () => {
    const mod = await import('@/middleware');
    const source = JSON.stringify(mod.config.matcher);
    expect(source).toContain('_next/static');
    expect(source).toContain('_next/image');
  });
});
