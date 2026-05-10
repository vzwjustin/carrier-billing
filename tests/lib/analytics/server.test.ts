import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AnalyticsEvent } from '@/lib/analytics/events';

/**
 * trackServer is a thin wrapper over PostHog Node's `capture()`. The
 * regression these tests guard against is the discriminated-union cast
 * (`as Record<string, unknown>`) that was previously bypassing exhaustiveness:
 * if a new event variant ships with a property shape that doesn't match
 * the expected payload, removing the cast surfaces it at typecheck time.
 *
 * At runtime we just verify the wrapper passes the right arguments through
 * and never throws — analytics must never break product flow.
 */

const captureMock = vi.fn();
const shutdownMock = vi.fn().mockResolvedValue(undefined);
const getPostHogServerMock = vi.fn();

vi.mock('@/lib/posthog/server', () => ({
  getPostHogServer: () => getPostHogServerMock(),
}));

beforeEach(() => {
  captureMock.mockReset();
  shutdownMock.mockClear();
  getPostHogServerMock.mockReset();
});

afterEach(() => {
  vi.resetModules();
});

describe('trackServer', () => {
  it('forwards the event name + properties to PostHog and shuts the client down', async () => {
    getPostHogServerMock.mockReturnValue({
      capture: captureMock,
      shutdown: shutdownMock,
    });
    const { trackServer } = await import('@/lib/analytics/server');

    const event: AnalyticsEvent = {
      name: 'audit_completed',
      properties: {
        auditId: 'aud_123',
        carrier: 'verizon',
        finding_count: 3,
        high_severity_count: 1,
        estimated_monthly_savings_cents: 4500,
      },
    };
    await trackServer(event, 'user_42');

    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(captureMock).toHaveBeenCalledWith({
      distinctId: 'user_42',
      event: 'audit_completed',
      properties: event.properties,
    });
    expect(shutdownMock).toHaveBeenCalledTimes(1);
  });

  it('is a silent no-op when PostHog is unconfigured', async () => {
    getPostHogServerMock.mockReturnValue(null);
    const { trackServer } = await import('@/lib/analytics/server');

    await expect(
      trackServer(
        {
          name: 'checkout_started',
          properties: { mode: 'one_time' },
        },
        'user_42',
      ),
    ).resolves.toBeUndefined();
    expect(captureMock).not.toHaveBeenCalled();
    expect(shutdownMock).not.toHaveBeenCalled();
  });

  it('swallows capture errors so analytics never breaks product flow', async () => {
    captureMock.mockImplementation(() => {
      throw new Error('posthog network down');
    });
    getPostHogServerMock.mockReturnValue({
      capture: captureMock,
      shutdown: shutdownMock,
    });
    const { trackServer } = await import('@/lib/analytics/server');

    await expect(
      trackServer(
        { name: 'report_shared', properties: { auditId: 'aud_x' } },
        'user_42',
      ),
    ).resolves.toBeUndefined();
  });
});
