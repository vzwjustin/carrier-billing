/**
 * Admin trail viewer page — role gate + filter shape.
 *
 * Exercises:
 *   - requireAdmin redirect for non-admins
 *   - event_type CSV and repeated-param parsing
 *   - 7d date window default (gte filter applied)
 *   - 'all' window omits the gte filter
 *   - user search builds the masked-email ILIKE pattern
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

class NextRedirectError extends Error {
  constructor(public readonly to: string) {
    super('NEXT_REDIRECT');
    this.name = 'NEXT_REDIRECT';
  }
}

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new NextRedirectError(to);
  },
}));

// ---------------------------------------------------------------------------
// requireAdmin mocks.
// ---------------------------------------------------------------------------

type GetUserResult = {
  data: { user: { id: string; email?: string } | null };
  error: null;
};
type MaybeSingleProfileResult = {
  data: { role: string; email: string } | null;
  error: null;
};

const getUserMock = vi.fn<() => Promise<GetUserResult>>();
const profileMaybeSingleMock = vi.fn<() => Promise<MaybeSingleProfileResult>>();

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: () => getUserMock() },
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, _val: string) => ({
          maybeSingle: () => profileMaybeSingleMock(),
        }),
      }),
    }),
  }),
}));

// ---------------------------------------------------------------------------
// Build a chained query mock that records every filter call.
// ---------------------------------------------------------------------------

interface ChainCalls {
  gte: Array<{ col: string; value: string }>;
  in: Array<{ col: string; values: unknown[] }>;
  ilike: Array<{ col: string; pattern: string }>;
  range: Array<{ from: number; to: number }>;
  order: Array<{ col: string; opts: unknown }>;
}

type ChainResult = { data: unknown[]; count: number | null };

interface ChainBuilder {
  order: (col: string, opts: unknown) => ChainBuilder;
  range: (from: number, to: number) => Promise<ChainResult>;
  gte: (col: string, value: string) => ChainBuilder;
  in: (col: string, values: unknown[]) => ChainBuilder;
  ilike: (col: string, pattern: string) => ChainBuilder;
}

function makeChain(result: ChainResult, calls: ChainCalls): ChainBuilder {
  const self: ChainBuilder = {
    order(col, opts) {
      calls.order.push({ col, opts });
      return self;
    },
    async range(from, to) {
      calls.range.push({ from, to });
      return result;
    },
    gte(col, value) {
      calls.gte.push({ col, value });
      return self;
    },
    in(col, values) {
      calls.in.push({ col, values });
      return self;
    },
    ilike(col, pattern) {
      calls.ilike.push({ col, pattern });
      return self;
    },
  };
  return self;
}

let chainResult: ChainResult = { data: [], count: 0 };
let chainCalls: ChainCalls = {
  gte: [],
  in: [],
  ilike: [],
  range: [],
  order: [],
};

const adminFromMock = vi.fn((table: string) => {
  if (table !== 'audit_trail_events') {
    throw new Error(`unexpected table: ${table}`);
  }
  return {
    select: (_cols: string, _opts?: unknown) => makeChain(chainResult, chainCalls),
  };
});

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({ from: adminFromMock }),
}));

vi.mock('@/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'placeholder',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-placeholder',
  },
}));

const { default: AdminTrailPage } = await import('@/app/(app)/admin/trail/page');

beforeEach(() => {
  getUserMock.mockReset();
  profileMaybeSingleMock.mockReset();
  adminFromMock.mockClear();
  chainResult = { data: [], count: 0 };
  chainCalls = { gte: [], in: [], ilike: [], range: [], order: [] };
});

function asAdmin(): void {
  getUserMock.mockResolvedValue({
    data: { user: { id: 'admin-1', email: 'admin@example.com' } },
    error: null,
  });
  profileMaybeSingleMock.mockResolvedValue({
    data: { role: 'admin', email: 'admin@example.com' },
    error: null,
  });
}

describe('GET /admin/trail', () => {
  it('role gate: anonymous caller is redirected to /dashboard', async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
    await expect(AdminTrailPage({ searchParams: Promise.resolve({}) })).rejects.toThrowError(
      NextRedirectError,
    );
  });

  it('role gate: non-admin profile is redirected to /dashboard', async () => {
    getUserMock.mockResolvedValue({
      data: { user: { id: 'u', email: 'u@example.com' } },
      error: null,
    });
    profileMaybeSingleMock.mockResolvedValue({
      data: { role: 'user', email: 'u@example.com' },
      error: null,
    });
    await expect(AdminTrailPage({ searchParams: Promise.resolve({}) })).rejects.toThrowError(
      NextRedirectError,
    );
  });

  it('default window is 7d (gte filter applied) and page-size is 50', async () => {
    asAdmin();
    await AdminTrailPage({ searchParams: Promise.resolve({}) });
    expect(chainCalls.gte).toHaveLength(1);
    expect(chainCalls.gte[0]?.col).toBe('created_at');
    expect(chainCalls.range).toEqual([{ from: 0, to: 49 }]);
  });

  it('window=all omits the gte filter', async () => {
    asAdmin();
    await AdminTrailPage({ searchParams: Promise.resolve({ window: 'all' }) });
    expect(chainCalls.gte).toHaveLength(0);
  });

  it('event_type as CSV is parsed into an IN clause; unknown types are dropped', async () => {
    asAdmin();
    await AdminTrailPage({
      searchParams: Promise.resolve({
        event_type: 'audit_uploaded,not_a_real_event,report_downloaded',
      }),
    });
    expect(chainCalls.in).toHaveLength(1);
    expect(chainCalls.in[0]?.col).toBe('event_type');
    expect(chainCalls.in[0]?.values).toEqual(['audit_uploaded', 'report_downloaded']);
  });

  it('event_type as repeated params is also accepted', async () => {
    asAdmin();
    await AdminTrailPage({
      searchParams: Promise.resolve({
        event_type: ['audit_uploaded', 'csv_exported'],
      }),
    });
    expect(chainCalls.in[0]?.values).toEqual(['audit_uploaded', 'csv_exported']);
  });

  it('user search builds an ILIKE pattern on actor_email', async () => {
    asAdmin();
    await AdminTrailPage({
      searchParams: Promise.resolve({ user: 'j***@', window: 'all' }),
    });
    expect(chainCalls.ilike).toHaveLength(1);
    expect(chainCalls.ilike[0]?.col).toBe('actor_email');
    expect(chainCalls.ilike[0]?.pattern.startsWith('j')).toBe(true);
    expect(chainCalls.ilike[0]?.pattern.endsWith('%')).toBe(true);
  });

  it('user search escapes ILIKE wildcards in the input', async () => {
    asAdmin();
    await AdminTrailPage({
      searchParams: Promise.resolve({ user: 'a%b_c', window: 'all' }),
    });
    expect(chainCalls.ilike[0]?.pattern).toBe('a\\%b\\_c%');
  });

  it('page=2 paginates by 50', async () => {
    asAdmin();
    await AdminTrailPage({ searchParams: Promise.resolve({ page: '2' }) });
    expect(chainCalls.range).toEqual([{ from: 50, to: 99 }]);
  });
});
