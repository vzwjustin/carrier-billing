import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for src/lib/supabase/middleware.ts — the SSR auth gate that powers
 * the route protection layer. Verifies:
 *
 *   1. Unauthenticated requests to PROTECTED_PREFIXES (`/dashboard`,
 *      `/audits`, `/settings`, `/billing`) redirect to /login with a `next`
 *      param so the user lands back on the intended page after sign-in.
 *   2. Authenticated requests to AUTH_PAGES (`/login`, `/signup`) redirect
 *      to /dashboard so signed-in users can't re-trigger the auth flow.
 *   3. Public paths return a passthrough response (no redirect).
 *
 * Supabase's createServerClient is mocked to control the auth state.
 * NextResponse.next is stubbed because jsdom's Headers shim doesn't pass
 * Next's `instanceof Headers` check inside its middleware-spec helpers.
 */

let currentUser: { id: string } | null = null;

const createServerClientMock = vi.hoisted(() =>
  vi.fn(() => ({
    auth: {
      getUser: async () => ({ data: { user: currentUser }, error: null }),
    },
  })),
);

vi.mock('@supabase/ssr', () => ({
  createServerClient: createServerClientMock,
}));

// Build a minimal NextResponse-shaped object — Next's middleware spec checks
// `instanceof Headers` inside NextResponse.next() which fails under jsdom's
// Headers shim. We stub the helpers so updateSession can build a passthrough
// response without tripping the runtime check. Redirects still use the real
// NextResponse.redirect (which doesn't do the headers check).
vi.mock('next/server', async () => {
  const actual =
    await vi.importActual<typeof import('next/server')>('next/server');
  return {
    ...actual,
    NextResponse: Object.assign(
      function NextResponse() {
        // Not used directly — included for type compatibility.
      },
      {
        next: () => {
          const headers = new Headers();
          const cookies = {
            set: () => {},
            get: () => undefined,
            getAll: () => [],
          };
          return {
            status: 200,
            headers,
            cookies,
          } as unknown as ReturnType<typeof actual.NextResponse.next>;
        },
        redirect: actual.NextResponse.redirect,
      },
    ),
  };
});

import { updateSession } from '@/lib/supabase/middleware';
import { NextRequest } from 'next/server';

function makeReq(path: string): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`);
}

beforeEach(() => {
  currentUser = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('updateSession — unauthenticated requests', () => {
  it('redirects to /login when accessing /dashboard', async () => {
    currentUser = null;
    const res = await updateSession(makeReq('/dashboard'));
    expect(res.status).toBe(307);
    const loc = res.headers.get('location');
    expect(loc).toContain('/login');
    expect(loc).toContain('next=%2Fdashboard');
  });

  it('redirects to /login when accessing /audits/abc/path', async () => {
    currentUser = null;
    const res = await updateSession(makeReq('/audits/abc/path'));
    expect(res.headers.get('location')).toContain('/login');
    expect(res.headers.get('location')).toContain('next=%2Faudits%2Fabc%2Fpath');
  });

  it('redirects to /login when accessing /settings', async () => {
    currentUser = null;
    const res = await updateSession(makeReq('/settings'));
    expect(res.headers.get('location')).toContain('/login');
  });

  it('redirects to /login when accessing /billing', async () => {
    currentUser = null;
    const res = await updateSession(makeReq('/billing'));
    expect(res.headers.get('location')).toContain('/login');
  });

  it('does NOT match prefix-only collisions (e.g. /dashboardx is not protected)', async () => {
    currentUser = null;
    const res = await updateSession(makeReq('/dashboardx'));
    // No redirect — passthrough response.
    expect(res.headers.get('location')).toBeNull();
  });

  it('does NOT redirect for public paths like /', async () => {
    currentUser = null;
    const res = await updateSession(makeReq('/'));
    expect(res.headers.get('location')).toBeNull();
  });

  it('does NOT redirect for /login itself when signed out', async () => {
    currentUser = null;
    const res = await updateSession(makeReq('/login'));
    expect(res.headers.get('location')).toBeNull();
  });
});

describe('updateSession — authenticated requests', () => {
  it('redirects /login to /dashboard for a signed-in user', async () => {
    currentUser = { id: 'user-1' };
    const res = await updateSession(makeReq('/login'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost:3000/dashboard');
  });

  it('redirects /signup to /dashboard for a signed-in user', async () => {
    currentUser = { id: 'user-1' };
    const res = await updateSession(makeReq('/signup'));
    expect(res.headers.get('location')).toBe('http://localhost:3000/dashboard');
  });

  it('strips query string on the auth-page → /dashboard redirect (prevent open-redirect via ?next=...)', async () => {
    currentUser = { id: 'user-1' };
    const res = await updateSession(makeReq('/login?next=//evil.com'));
    expect(res.headers.get('location')).toBe('http://localhost:3000/dashboard');
  });

  it('passes through protected paths for a signed-in user', async () => {
    currentUser = { id: 'user-1' };
    const res = await updateSession(makeReq('/dashboard'));
    expect(res.headers.get('location')).toBeNull();
  });
});

describe('updateSession — supabase client invocation', () => {
  it('always calls getUser to refresh the session', async () => {
    currentUser = null;
    await updateSession(makeReq('/'));
    expect(createServerClientMock).toHaveBeenCalledTimes(1);
  });

  it('passes the configured URL + anon key to createServerClient', async () => {
    currentUser = null;
    await updateSession(makeReq('/'));
    const args = createServerClientMock.mock.calls[0]!;
    expect(args[0]).toBe('http://localhost:54321');
    expect(args[1]).toBe('placeholder');
  });
});
