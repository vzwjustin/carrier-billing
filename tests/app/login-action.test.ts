import { beforeEach, describe, expect, it, vi } from 'vitest';

const redirectMock = vi.fn((path: string) => {
  const err = new Error('NEXT_REDIRECT') as Error & {
    digest: string;
    path: string;
  };
  err.digest = 'NEXT_REDIRECT;push';
  err.path = path;
  throw err;
});

const signInWithPasswordMock = vi.fn(async () => ({ error: null }));

vi.mock('next/navigation', () => ({
  redirect: (path: string) => redirectMock(path),
}));

vi.mock('@/lib/security/rate-limit', () => ({
  consumeRateLimit: vi.fn(async () => ({ ok: true })),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { signInWithPassword: signInWithPasswordMock },
  }),
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}));

import { signInAction } from '@/app/(auth)/login/actions';

beforeEach(() => {
  redirectMock.mockClear();
  signInWithPasswordMock.mockClear();
});

describe('signInAction next redirect guard', () => {
  it('rejects control characters and redirects to /dashboard', async () => {
    await expect(
      signInAction({
        email: 'user@example.com',
        password: 'correct-horse-battery-staple',
        next: '/ok\r\nLocation: https://evil.example',
      }),
    ).rejects.toMatchObject({ path: '/dashboard' });

    expect(redirectMock).toHaveBeenCalledWith('/dashboard');
  });
});
