import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for POST /api/inbound/finding-status — the externally-callable
 * webhook that lets Slack/Linear/etc. flip a finding's status using an
 * inbound webhook token instead of a Supabase session cookie.
 *
 * Coverage:
 *   - 401 on missing / shape-invalid / unknown token (no DB queries for
 *     shape-invalid; one DB query for unknown).
 *   - 400 on body validation failures.
 *   - 404 on cross-tenant ownership mismatch (token-A user cannot touch
 *     token-B user's finding).
 *   - 200 happy path AND fires `finding.status_changed` Inngest event with
 *     the previous status captured from the pre-image SELECT.
 */

type ProfileRow = { id: string } | null;
type FindingRow = {
  id: string;
  audit_id: string;
  status: string;
  audits: { id: string; user_id: string } | null;
} | null;
type DbResp<T> = { data: T; error: null | { message: string; code?: string } };

const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345'; // 32 base64url chars
const SHAPE_INVALID_TOKEN = 'too-short';
const UNKNOWN_TOKEN = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PROFILE_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_PROFILE_ID = '44444444-4444-4444-8444-444444444444';
const AUDIT_ID = '11111111-1111-4111-8111-111111111111';
const FINDING_ID = '22222222-2222-4222-8222-222222222222';

// ─── Mocks ────────────────────────────────────────────────────────────────
const {
  profileSelectMock,
  findingSelectMock,
  findingUpdateMock,
  inngestSendMock,
} = vi.hoisted(() => ({
  profileSelectMock: vi.fn<() => Promise<DbResp<ProfileRow>>>(),
  findingSelectMock: vi.fn<() => Promise<DbResp<FindingRow>>>(),
  findingUpdateMock: vi.fn<() => Promise<{ error: null | { message: string } }>>(),
  inngestSendMock: vi.fn(async (_event: unknown) => undefined),
}));

// Per-call routing: the route hits `from('profiles').select(...)` first, then
// `from('findings').select(...)`, then `from('findings').update(...)`. We
// dispatch by table name to keep the mock obvious.
function makeFromChain(table: string) {
  if (table === 'profiles') {
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: () => profileSelectMock(),
        }),
      }),
      update: (_payload: unknown) => ({
        eq: () => Promise.resolve({ error: null }),
      }),
    };
  }
  if (table === 'findings') {
    return {
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () => findingSelectMock(),
          }),
        }),
      }),
      update: (_payload: unknown) => ({
        eq: () => ({
          eq: () => findingUpdateMock(),
        }),
      }),
    };
  }
  throw new Error(`unexpected table in mock: ${table}`);
}

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: (table: string) => makeFromChain(table),
  }),
}));

vi.mock('@/inngest/client', () => ({
  inngest: { send: (event: unknown) => inngestSendMock(event) },
}));

vi.mock('@/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'placeholder',
    INNGEST_EVENT_KEY: undefined,
  },
}));

// Import AFTER mocks.
import { POST } from '@/app/api/inbound/finding-status/route';

function makeReq(opts: {
  token?: string | null;
  body?: unknown;
}): Request {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (opts.token !== null && opts.token !== undefined) {
    headers['X-CarrierAudit-Token'] = opts.token;
  }
  return new Request('http://localhost/api/inbound/finding-status', {
    method: 'POST',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

function validBody() {
  return {
    audit_id: AUDIT_ID,
    finding_id: FINDING_ID,
    status: 'approved',
    note: 'Approved via Slack automation.',
  };
}

beforeEach(() => {
  profileSelectMock.mockReset();
  findingSelectMock.mockReset();
  findingUpdateMock.mockReset();
  inngestSendMock.mockReset();

  // Defaults: authed token resolves to PROFILE_ID, finding exists and is owned
  // by PROFILE_ID, update succeeds.
  profileSelectMock.mockResolvedValue({
    data: { id: PROFILE_ID },
    error: null,
  });
  findingSelectMock.mockResolvedValue({
    data: {
      id: FINDING_ID,
      audit_id: AUDIT_ID,
      status: 'in_review',
      audits: { id: AUDIT_ID, user_id: PROFILE_ID },
    },
    error: null,
  });
  findingUpdateMock.mockResolvedValue({ error: null });
});

describe('POST /api/inbound/finding-status — token auth', () => {
  it('returns 401 when the header is missing', async () => {
    const res = await POST(makeReq({ token: null, body: validBody() }));
    expect(res.status).toBe(401);
    // Shape-invalid path: never even queries the DB.
    expect(profileSelectMock).not.toHaveBeenCalled();
  });

  it('returns 401 when the token is the wrong shape (no DB query)', async () => {
    const res = await POST(
      makeReq({ token: SHAPE_INVALID_TOKEN, body: validBody() }),
    );
    expect(res.status).toBe(401);
    expect(profileSelectMock).not.toHaveBeenCalled();
  });

  it('returns 401 when the token does not match a profile', async () => {
    profileSelectMock.mockResolvedValueOnce({ data: null, error: null });
    const res = await POST(
      makeReq({ token: UNKNOWN_TOKEN, body: validBody() }),
    );
    expect(res.status).toBe(401);
    // We DID query the DB (shape was valid) but no profile matched.
    expect(profileSelectMock).toHaveBeenCalledTimes(1);
    // No event fired on auth failure.
    expect(inngestSendMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/inbound/finding-status — body validation', () => {
  it('returns 400 when the body is not valid JSON', async () => {
    const res = await POST(
      new Request('http://localhost/api/inbound/finding-status', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CarrierAudit-Token': TOKEN,
        },
        body: 'not-json',
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when status is not a valid enum value', async () => {
    const res = await POST(
      makeReq({
        token: TOKEN,
        body: { ...validBody(), status: 'invented-status' },
      }),
    );
    expect(res.status).toBe(400);
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it('returns 400 when the note exceeds 500 chars', async () => {
    const res = await POST(
      makeReq({
        token: TOKEN,
        body: { ...validBody(), note: 'a'.repeat(501) },
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when audit_id is not a uuid', async () => {
    const res = await POST(
      makeReq({
        token: TOKEN,
        body: { ...validBody(), audit_id: 'not-a-uuid' },
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /api/inbound/finding-status — ownership check', () => {
  it('returns 404 when the finding is owned by a different user', async () => {
    // Token resolves to PROFILE_ID, but the finding's audit is owned by
    // someone else. Must NOT update + must NOT fire the event.
    findingSelectMock.mockResolvedValueOnce({
      data: {
        id: FINDING_ID,
        audit_id: AUDIT_ID,
        status: 'new',
        audits: { id: AUDIT_ID, user_id: OTHER_PROFILE_ID },
      },
      error: null,
    });

    const res = await POST(makeReq({ token: TOKEN, body: validBody() }));
    expect(res.status).toBe(404);
    expect(findingUpdateMock).not.toHaveBeenCalled();
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the finding does not exist', async () => {
    findingSelectMock.mockResolvedValueOnce({ data: null, error: null });
    const res = await POST(makeReq({ token: TOKEN, body: validBody() }));
    expect(res.status).toBe(404);
    expect(findingUpdateMock).not.toHaveBeenCalled();
    expect(inngestSendMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/inbound/finding-status — happy path', () => {
  it('updates the finding and fires finding.status_changed with previousStatus', async () => {
    const res = await POST(makeReq({ token: TOKEN, body: validBody() }));
    expect(res.status).toBe(200);

    expect(findingUpdateMock).toHaveBeenCalledTimes(1);
    expect(inngestSendMock).toHaveBeenCalledTimes(1);

    const sent = inngestSendMock.mock.calls[0]?.[0] as
      | undefined
      | {
          id?: string;
          name?: string;
          data?: Record<string, unknown>;
        };
    expect(sent?.name).toBe('finding.status_changed');
    expect(sent?.data).toMatchObject({
      auditId: AUDIT_ID,
      findingId: FINDING_ID,
      status: 'approved',
      previousStatus: 'in_review',
      userId: PROFILE_ID,
    });
    // Idempotency key present so Inngest dedupes retries.
    expect(typeof sent?.id).toBe('string');
    expect(sent?.id?.length ?? 0).toBeGreaterThan(0);
  });

  it('returns 200 even if inngest.send throws (best-effort)', async () => {
    inngestSendMock.mockRejectedValueOnce(new Error('inngest unavailable'));
    const res = await POST(makeReq({ token: TOKEN, body: validBody() }));
    expect(res.status).toBe(200);
    // Update still happened.
    expect(findingUpdateMock).toHaveBeenCalledTimes(1);
  });
});
