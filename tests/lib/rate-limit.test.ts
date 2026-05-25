import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { rpcMock, captureExceptionMock, captureMessageMock } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  captureExceptionMock: vi.fn(),
  captureMessageMock: vi.fn(),
}));

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    rpc: rpcMock,
  }),
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: captureExceptionMock,
  captureMessage: captureMessageMock,
}));

import { consumeRateLimit } from '@/lib/security/rate-limit';

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'development');
  rpcMock.mockReset();
  captureExceptionMock.mockClear();
  captureMessageMock.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('consumeRateLimit logging hygiene', () => {
  it('scrubs PII from the local missing-RPC console warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    rpcMock.mockResolvedValueOnce({
      data: null,
      error: {
        code: 'PGRST202',
        message: 'function consume_rate_limit not found',
      },
    });

    await consumeRateLimit({
      key: 'auth:login:user@example.com',
      limit: 10,
      windowSeconds: 600,
    });

    const logged = warnSpy.mock.calls.flat().join(' ');
    expect(logged).not.toContain('user@example.com');
    expect(logged).toContain('[email]');
  });

  it('scrubs PII from Sentry extras when rate limiting fails closed', async () => {
    rpcMock.mockResolvedValueOnce({
      data: null,
      error: {
        code: 'XX000',
        message: 'database unavailable',
      },
    });

    await expect(
      consumeRateLimit({
        key: 'auth:login:user@example.com',
        limit: 10,
        windowSeconds: 600,
      }),
    ).rejects.toThrow('rate_limit_unavailable');

    const context = captureExceptionMock.mock.calls[0]?.[1] as
      | { extra?: { key?: string } }
      | undefined;
    expect(context?.extra?.key).not.toContain('user@example.com');
    expect(context?.extra?.key).toContain('[email]');
  });
});
