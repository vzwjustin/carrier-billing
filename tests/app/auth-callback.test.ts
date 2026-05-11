import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

// Mock supabase server client used by the callback route.
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      exchangeCodeForSession: async (_code: string) => ({ error: null }),
    },
  }),
}));

// Import the route handler after mocks are set up.
const { GET } = await import('@/app/auth/callback/route');

function makeRequest(url: string): NextRequest {
  return new NextRequest(url);
}

describe('auth/callback next param redirect guard', () => {
  it('redirects to /dashboard when next is absent', async () => {
    const req = makeRequest('http://localhost:3000/auth/callback?code=abc');
    const res = await GET(req as Parameters<typeof GET>[0]);
    expect(res.headers.get('location')).toBe('http://localhost:3000/dashboard');
  });

  it('redirects to next path when it starts with /', async () => {
    const req = makeRequest('http://localhost:3000/auth/callback?code=abc&next=/audits/123');
    const res = await GET(req as Parameters<typeof GET>[0]);
    expect(res.headers.get('location')).toBe('http://localhost:3000/audits/123');
  });

  it('rejects protocol-relative //evil.com and falls back to /dashboard', async () => {
    const req = makeRequest(
      'http://localhost:3000/auth/callback?code=abc&next=//evil.com/steal',
    );
    const res = await GET(req as Parameters<typeof GET>[0]);
    const location = res.headers.get('location') ?? '';
    expect(location).not.toContain('evil.com');
    expect(location).toBe('http://localhost:3000/dashboard');
  });

  it('rejects backslash-relative /\\evil.com and falls back to /dashboard', async () => {
    const req = makeRequest(
      'http://localhost:3000/auth/callback?code=abc&next=%2F%5Cevil.com%2Fsteal',
    );
    const res = await GET(req as Parameters<typeof GET>[0]);
    const location = res.headers.get('location') ?? '';
    expect(location).not.toContain('evil.com');
    expect(location).toBe('http://localhost:3000/dashboard');
  });

  it('allows next path with query string', async () => {
    const req = makeRequest(
      'http://localhost:3000/auth/callback?code=abc&next=/path%3Fx%3Dy',
    );
    const res = await GET(req as Parameters<typeof GET>[0]);
    expect(res.headers.get('location')).toBe('http://localhost:3000/path?x=y');
  });
});
