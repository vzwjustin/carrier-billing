/**
 * Unit tests for the typed analytics helpers.
 *
 * trackServer must:
 *  1. Resolve silently when getPostHogServer() returns null (no key in env).
 *  2. Call capture + shutdown when the server client is present.
 *  3. Never throw, even when capture/shutdown errors out.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/posthog/server', () => ({
  getPostHogServer: vi.fn(),
}));

import { trackServer } from '@/lib/analytics/events';
import { getPostHogServer } from '@/lib/posthog/server';

const mockGetPostHogServer = vi.mocked(getPostHogServer);

afterEach(() => {
  vi.resetAllMocks();
});

describe('trackServer', () => {
  it('returns silently when getPostHogServer returns null', async () => {
    mockGetPostHogServer.mockReturnValue(null);

    await expect(
      trackServer(
        {
          name: 'audit_uploaded',
          properties: { auditId: 'a1', sizeBytes: 1024 },
        },
        'user-1',
      ),
    ).resolves.toBeUndefined();
  });

  it('calls capture + shutdown when posthog server is present', async () => {
    const capture = vi.fn();
    const shutdown = vi.fn().mockResolvedValue(undefined);
    mockGetPostHogServer.mockReturnValue({
      capture,
      shutdown,
    } as unknown as ReturnType<typeof getPostHogServer>);

    await trackServer(
      {
        name: 'audit_completed',
        properties: {
          auditId: 'a1',
          carrier: 'verizon',
          finding_count: 3,
          high_severity_count: 1,
          estimated_monthly_savings_cents: 12345,
        },
      },
      'user-1',
    );

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith({
      distinctId: 'user-1',
      event: 'audit_completed',
      properties: expect.objectContaining({
        auditId: 'a1',
        carrier: 'verizon',
        finding_count: 3,
      }),
    });
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('does not throw when capture errors out', async () => {
    const capture = vi.fn().mockImplementation(() => {
      throw new Error('boom');
    });
    const shutdown = vi.fn().mockResolvedValue(undefined);
    mockGetPostHogServer.mockReturnValue({
      capture,
      shutdown,
    } as unknown as ReturnType<typeof getPostHogServer>);

    await expect(
      trackServer(
        { name: 'report_shared', properties: { auditId: 'a1' } },
        'user-1',
      ),
    ).resolves.toBeUndefined();
  });

  it('does not throw when shutdown rejects', async () => {
    const capture = vi.fn();
    const shutdown = vi.fn().mockRejectedValue(new Error('flush failed'));
    mockGetPostHogServer.mockReturnValue({
      capture,
      shutdown,
    } as unknown as ReturnType<typeof getPostHogServer>);

    await expect(
      trackServer(
        {
          name: 'checkout_completed',
          properties: { mode: 'subscription', userId: 'u' },
        },
        'u',
      ),
    ).resolves.toBeUndefined();
    expect(capture).toHaveBeenCalled();
  });
});
