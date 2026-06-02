import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for POST /api/settings/slack — the authenticated route that lets
 * a user save / update / clear their Slack incoming-webhook URL and notify
 * preferences.
 *
 * Coverage:
 *   - 401 on missing session
 *   - 400 on malformed JSON / wrong webhook shape (non-Slack URL)
 *   - 200 happy path (save) — DB update called with expected payload
 *   - 200 clear flow (null + empty string both clear)
 *   - 200 toggles flags without requiring url
 */

type _Resp<T> = { data: T; error: null | { message: string; code?: string } };

const USER_ID = '33333333-3333-4333-8333-333333333333';

const { getUserMock, updateMock } = vi.hoisted(() => ({
  getUserMock: vi.fn<() => Promise<{ data: { user: { id: string } | null }; error: null }>>(),
  updateMock:
    vi.fn<(_patch: Record<string, unknown>) => Promise<{ error: null | { message: string } }>>(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: getUserMock },
  }),
}));

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: (_table: string) => ({
      update: (patch: Record<string, unknown>) => ({
        eq: async (_col: string, _val: string) => updateMock(patch),
      }),
    }),
  }),
}));

vi.mock('@/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'placeholder',
    NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
    INNGEST_EVENT_KEY: undefined,
  },
}));

import { POST } from '@/app/api/settings/slack/route';

function makeReq(body: unknown): Request {
  return new Request('http://localhost/api/settings/slack', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === '__raw_malformed__' ? '{not json' : JSON.stringify(body),
  });
}

beforeEach(() => {
  getUserMock.mockReset();
  updateMock.mockReset();
  getUserMock.mockResolvedValue({
    data: { user: { id: USER_ID } },
    error: null,
  } as Awaited<ReturnType<typeof getUserMock>>);
  updateMock.mockResolvedValue({ error: null } as Awaited<ReturnType<typeof updateMock>>);
});

describe('POST /api/settings/slack — auth', () => {
  it('returns 401 when there is no session', async () => {
    getUserMock.mockResolvedValueOnce({
      data: { user: null },
      error: null,
    } as Awaited<ReturnType<typeof getUserMock>>);
    const res = await POST(
      makeReq({
        webhook_url: 'https://hooks.slack.com/services/T1/B1/abc',
      }),
    );
    expect(res.status).toBe(401);
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/settings/slack — body validation', () => {
  it('returns 400 on malformed JSON', async () => {
    const res = await POST(makeReq('__raw_malformed__'));
    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('rejects URLs that do not start with https://hooks.slack.com/', async () => {
    const res = await POST(makeReq({ webhook_url: 'https://evil.example.com/webhook' }));
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toMatch(/hooks\.slack\.com/);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('rejects http:// URLs (only https hooks.slack.com)', async () => {
    const res = await POST(makeReq({ webhook_url: 'http://hooks.slack.com/services/T1/B1/abc' }));
    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('rejects garbage strings', async () => {
    const res = await POST(makeReq({ webhook_url: 'not a url' }));
    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/settings/slack — happy path', () => {
  it('saves a valid Slack URL and trims whitespace', async () => {
    const res = await POST(
      makeReq({
        webhook_url: '  https://hooks.slack.com/services/T1/B1/abcdef  ',
        notify_on_high_finding: true,
        notify_on_autopsy: false,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; has_webhook: boolean };
    expect(body).toEqual({ ok: true, has_webhook: true });

    expect(updateMock).toHaveBeenCalledTimes(1);
    const patch = updateMock.mock.calls[0]?.[0];
    expect(patch?.['slack_webhook_url']).toBe('https://hooks.slack.com/services/T1/B1/abcdef');
    expect(patch?.['slack_notify_on_high_finding']).toBe(true);
    expect(patch?.['slack_notify_on_autopsy']).toBe(false);
  });

  it('saves without touching flags when they are omitted', async () => {
    const res = await POST(
      makeReq({
        webhook_url: 'https://hooks.slack.com/services/T2/B2/xyz',
      }),
    );
    expect(res.status).toBe(200);
    const patch = updateMock.mock.calls[0]?.[0];
    expect(patch).not.toHaveProperty('slack_notify_on_high_finding');
    expect(patch).not.toHaveProperty('slack_notify_on_autopsy');
    expect(patch?.['slack_webhook_url']).toBe('https://hooks.slack.com/services/T2/B2/xyz');
  });
});

describe('POST /api/settings/slack — clear flow', () => {
  it('clears the URL when webhook_url is null', async () => {
    const res = await POST(makeReq({ webhook_url: null }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; has_webhook: boolean };
    expect(body).toEqual({ ok: true, has_webhook: false });
    const patch = updateMock.mock.calls[0]?.[0];
    expect(patch?.['slack_webhook_url']).toBeNull();
  });

  it('clears the URL when webhook_url is empty string', async () => {
    const res = await POST(makeReq({ webhook_url: '   ' }));
    expect(res.status).toBe(200);
    const patch = updateMock.mock.calls[0]?.[0];
    expect(patch?.['slack_webhook_url']).toBeNull();
  });

  it('can flip flags while clearing URL', async () => {
    const res = await POST(
      makeReq({
        webhook_url: null,
        notify_on_high_finding: false,
        notify_on_autopsy: true,
      }),
    );
    expect(res.status).toBe(200);
    const patch = updateMock.mock.calls[0]?.[0];
    expect(patch?.['slack_webhook_url']).toBeNull();
    expect(patch?.['slack_notify_on_high_finding']).toBe(false);
    expect(patch?.['slack_notify_on_autopsy']).toBe(true);
  });
});

describe('POST /api/settings/slack — DB failure', () => {
  it('returns 500 when the profiles update fails', async () => {
    updateMock.mockResolvedValueOnce({
      error: { message: 'boom' },
    } as Awaited<ReturnType<typeof updateMock>>);
    const res = await POST(makeReq({ webhook_url: 'https://hooks.slack.com/services/T/B/x' }));
    expect(res.status).toBe(500);
  });
});
