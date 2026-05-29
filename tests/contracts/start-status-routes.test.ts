import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for POST /api/contracts/[id]/start and GET /api/contracts/[id]/status.
 *
 * Coverage:
 *   - 401 on missing session
 *   - 404 when contract row is RLS-hidden or owned by a different user
 *   - 409 when contract is already extracting (or in another unrecoverable state)
 *   - Re-extract path: parsed/failed → reset to pending + send contract.uploaded
 *   - 429 on status route when rate limit exhausted
 */

const USER_ID = '33333333-3333-4333-8333-333333333333';
const CONTRACT_ID = '11111111-1111-4111-8111-111111111111';

interface ContractRow {
  id: string;
  user_id: string;
  status: string;
  storage_path: string;
  extract_attempt: number;
}

interface ContractStatusRow {
  user_id: string;
  status: string;
  carrier: string | null;
  ban_last4: string | null;
  effective_date: string | null;
  expiration_date: string | null;
  failure_reason: string | null;
}

const {
  getUserMock,
  maybeSingleMock,
  updateMock,
  inngestSendMock,
  consumeRateLimitMock,
} = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  maybeSingleMock: vi.fn(),
  updateMock: vi.fn(),
  inngestSendMock: vi.fn(),
  consumeRateLimitMock: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: getUserMock },
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: maybeSingleMock }),
      }),
      update: (patch: Record<string, unknown>) => ({
        eq: () => ({
          eq: async () => updateMock(patch),
        }),
      }),
    }),
  }),
}));

vi.mock('@/inngest/client', () => ({
  inngest: { send: inngestSendMock },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  consumeRateLimit: consumeRateLimitMock,
  rateLimitedResponse: () => new Response('rate-limited', { status: 429 }),
}));

vi.mock('@/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'placeholder',
  },
}));

import { POST } from '@/app/api/contracts/[id]/start/route';
import { GET } from '@/app/api/contracts/[id]/status/route';

function makeContext(id: string = CONTRACT_ID): {
  params: Promise<{ id: string }>;
} {
  return { params: Promise.resolve({ id }) };
}

function makeContract(over: Partial<ContractRow> = {}): ContractRow {
  return {
    id: CONTRACT_ID,
    user_id: USER_ID,
    status: 'pending',
    storage_path: `${USER_ID}/${CONTRACT_ID}/contract.pdf`,
    extract_attempt: 0,
    ...over,
  };
}

function makeContractStatusRow(
  over: Partial<ContractStatusRow> = {},
): ContractStatusRow {
  return {
    user_id: USER_ID,
    status: 'parsed',
    carrier: 'verizon',
    ban_last4: '1234',
    effective_date: '2025-01-01',
    expiration_date: '2027-01-01',
    failure_reason: null,
    ...over,
  };
}

beforeEach(() => {
  getUserMock.mockReset();
  maybeSingleMock.mockReset();
  updateMock.mockReset();
  inngestSendMock.mockReset();
  consumeRateLimitMock.mockReset();
  getUserMock.mockResolvedValue({
    data: { user: { id: USER_ID } },
    error: null,
  });
  consumeRateLimitMock.mockResolvedValue({
    ok: true,
    resetAt: new Date().toISOString(),
  });
  updateMock.mockResolvedValue({ error: null });
  inngestSendMock.mockResolvedValue({ ids: ['evt_x'] });
});

// ───────────────────────────────────────────────────────────────────────────
// POST /api/contracts/[id]/start
// ───────────────────────────────────────────────────────────────────────────

describe('POST /api/contracts/[id]/start — auth + validation', () => {
  it('returns 400 when id is not a uuid', async () => {
    maybeSingleMock.mockResolvedValueOnce({ data: makeContract(), error: null });
    const res = await POST(
      new Request('http://localhost/api/contracts/bad/start', { method: 'POST' }),
      makeContext('not-a-uuid'),
    );
    expect(res.status).toBe(400);
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it('returns 401 when no session', async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: null }, error: null });
    const res = await POST(
      new Request('http://localhost/api/contracts/x/start', { method: 'POST' }),
      makeContext(),
    );
    expect(res.status).toBe(401);
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it('returns 404 when contract row is RLS-hidden', async () => {
    maybeSingleMock.mockResolvedValueOnce({ data: null, error: null });
    const res = await POST(
      new Request('http://localhost/api/contracts/x/start', { method: 'POST' }),
      makeContext(),
    );
    expect(res.status).toBe(404);
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it('returns 404 when contract belongs to a different user', async () => {
    maybeSingleMock.mockResolvedValueOnce({
      data: makeContract({ user_id: 'someone-else' }),
      error: null,
    });
    const res = await POST(
      new Request('http://localhost/api/contracts/x/start', { method: 'POST' }),
      makeContext(),
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /api/contracts/[id]/start — status guards', () => {
  it('returns 409 when contract is already extracting (no duplicate enqueue)', async () => {
    maybeSingleMock.mockResolvedValueOnce({
      data: makeContract({ status: 'extracting' }),
      error: null,
    });
    const res = await POST(
      new Request('http://localhost/api/contracts/x/start', { method: 'POST' }),
      makeContext(),
    );
    expect(res.status).toBe(409);
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it('returns 409 with the observed state when status is not restartable', async () => {
    maybeSingleMock.mockResolvedValueOnce({
      data: makeContract({ status: 'unknown-state' }),
      error: null,
    });
    const res = await POST(
      new Request('http://localhost/api/contracts/x/start', { method: 'POST' }),
      makeContext(),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('unknown-state');
  });
});

describe('POST /api/contracts/[id]/start — happy paths', () => {
  it('enqueues contract.uploaded without resetting when status is already pending', async () => {
    maybeSingleMock.mockResolvedValueOnce({ data: makeContract(), error: null });
    const res = await POST(
      new Request('http://localhost/api/contracts/x/start', { method: 'POST' }),
      makeContext(),
    );
    expect(res.status).toBe(200);
    expect(updateMock).not.toHaveBeenCalled();
    expect(inngestSendMock).toHaveBeenCalledTimes(1);
    const evt = inngestSendMock.mock.calls[0]?.[0] as {
      id: string;
      name: string;
      data: { contractId: string; userId: string; storagePath: string };
    };
    expect(evt.name).toBe('contract.uploaded');
    expect(evt.data.contractId).toBe(CONTRACT_ID);
    expect(evt.data.userId).toBe(USER_ID);
  });

  it('resets parsed → pending then enqueues (re-extract)', async () => {
    maybeSingleMock.mockResolvedValueOnce({
      data: makeContract({ status: 'parsed' }),
      error: null,
    });
    const res = await POST(
      new Request('http://localhost/api/contracts/x/start', { method: 'POST' }),
      makeContext(),
    );
    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledTimes(1);
    const patch = updateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(patch.status).toBe('pending');
    expect(patch.failure_reason).toBeNull();
    expect(inngestSendMock).toHaveBeenCalledTimes(1);
  });

  it('resets failed → pending then enqueues (re-extract after a failure)', async () => {
    maybeSingleMock.mockResolvedValueOnce({
      data: makeContract({ status: 'failed' }),
      error: null,
    });
    const res = await POST(
      new Request('http://localhost/api/contracts/x/start', { method: 'POST' }),
      makeContext(),
    );
    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(inngestSendMock).toHaveBeenCalledTimes(1);
  });

  it('returns 500 when reset UPDATE errors (does not enqueue)', async () => {
    maybeSingleMock.mockResolvedValueOnce({
      data: makeContract({ status: 'parsed' }),
      error: null,
    });
    updateMock.mockResolvedValueOnce({ error: { message: 'db error' } });
    const res = await POST(
      new Request('http://localhost/api/contracts/x/start', { method: 'POST' }),
      makeContext(),
    );
    expect(res.status).toBe(500);
    expect(inngestSendMock).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// GET /api/contracts/[id]/status
// ───────────────────────────────────────────────────────────────────────────

describe('GET /api/contracts/[id]/status', () => {
  it('returns 400 when id is not a uuid', async () => {
    const res = await GET(
      new Request('http://localhost/api/contracts/bad/status'),
      makeContext('not-a-uuid'),
    );
    expect(res.status).toBe(400);
  });

  it('returns 401 when no session', async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: null }, error: null });
    const res = await GET(
      new Request('http://localhost/api/contracts/x/status'),
      makeContext(),
    );
    expect(res.status).toBe(401);
  });

  it('uses a per-user rate-limit key (60/min)', async () => {
    maybeSingleMock.mockResolvedValueOnce({
      data: makeContractStatusRow(),
      error: null,
    });
    await GET(
      new Request('http://localhost/api/contracts/x/status'),
      makeContext(),
    );
    const call = consumeRateLimitMock.mock.calls[0]?.[0] as {
      key: string;
      limit: number;
    };
    expect(call.key).toBe(`contract-status:${USER_ID}`);
    expect(call.limit).toBe(60);
  });

  it('returns 429 when rate limit exhausted', async () => {
    consumeRateLimitMock.mockResolvedValueOnce({
      ok: false,
      resetAt: new Date().toISOString(),
    });
    const res = await GET(
      new Request('http://localhost/api/contracts/x/status'),
      makeContext(),
    );
    expect(res.status).toBe(429);
  });

  it('returns 404 when contract row is RLS-hidden', async () => {
    maybeSingleMock.mockResolvedValueOnce({ data: null, error: null });
    const res = await GET(
      new Request('http://localhost/api/contracts/x/status'),
      makeContext(),
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 when contract belongs to a different user', async () => {
    maybeSingleMock.mockResolvedValueOnce({
      data: makeContractStatusRow({ user_id: 'someone-else' }),
      error: null,
    });
    const res = await GET(
      new Request('http://localhost/api/contracts/x/status'),
      makeContext(),
    );
    expect(res.status).toBe(404);
  });

  it('returns the status payload (no user_id leak) for the owner', async () => {
    maybeSingleMock.mockResolvedValueOnce({
      data: makeContractStatusRow({ status: 'parsed' }),
      error: null,
    });
    const res = await GET(
      new Request('http://localhost/api/contracts/x/status'),
      makeContext(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('parsed');
    expect(body.carrier).toBe('verizon');
    expect(body.ban_last4).toBe('1234');
    // Critically: the user_id column must not leak to the client.
    expect(body).not.toHaveProperty('user_id');
  });
});
