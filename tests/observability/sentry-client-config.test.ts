import type { ErrorEvent } from '@sentry/nextjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { initMock } = vi.hoisted(() => ({
  initMock: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => ({
  init: initMock,
}));

describe('sentry.client.config', () => {
  const originalDsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

  beforeEach(() => {
    vi.resetModules();
    initMock.mockReset();
    process.env.NEXT_PUBLIC_SENTRY_DSN = 'https://public@example.com/1';
  });

  afterEach(() => {
    if (originalDsn === undefined) {
      delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    } else {
      process.env.NEXT_PUBLIC_SENTRY_DSN = originalDsn;
    }
  });

  it('registers the shared PII scrubber for browser events', async () => {
    await import('../../sentry.client.config');

    expect(initMock).toHaveBeenCalledTimes(1);
    const options = initMock.mock.calls[0]?.[0] as
      | { beforeSend?: (event: ErrorEvent) => ErrorEvent | null }
      | undefined;
    expect(options?.beforeSend).toEqual(expect.any(Function));

    const scrubbed = options?.beforeSend?.({
      type: undefined,
      message: 'crashed while rendering jane@example.com account 1234567',
    });

    expect(scrubbed?.message).toContain('[email]');
    expect(scrubbed?.message).not.toContain('jane@example.com');
    expect(scrubbed?.message).not.toContain('1234567');
  });
});
