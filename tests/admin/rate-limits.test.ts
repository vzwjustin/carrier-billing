/**
 * Admin rate-limit inspector — role gate + sort/limit shape.
 *
 * The page reads from `rate_limit_buckets` (migration 0016) and surfaces the
 * top 50 buckets by current count. There is no stored reset_at — the window
 * length is set per call by `consume_rate_limit`. We assert the page issues
 * an order(count desc).limit(50) read against the correct table.
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
// Admin client mock — record table + order + limit.
// ---------------------------------------------------------------------------

const orderArgs = vi.fn<(col: string, opts: { ascending?: boolean }) => void>();
const limitArgs = vi.fn<(n: number) => void>();
const finalResult = vi.fn<() => Promise<{ data: unknown[] }>>();

const adminFromMock = vi.fn((table: string) => {
  return {
    _table: table,
    select: (_cols: string) => ({
      order: (col: string, opts: { ascending?: boolean }) => {
        orderArgs(col, opts);
        return {
          limit: (n: number) => {
            limitArgs(n);
            return finalResult();
          },
        };
      },
    }),
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

const { default: AdminRateLimitsPage } = await import('@/app/(app)/admin/rate-limits/page');

beforeEach(() => {
  getUserMock.mockReset();
  profileMaybeSingleMock.mockReset();
  adminFromMock.mockClear();
  orderArgs.mockReset();
  limitArgs.mockReset();
  finalResult.mockReset();
  finalResult.mockResolvedValue({ data: [] });
});

describe('GET /admin/rate-limits', () => {
  it('role gate: anonymous caller is redirected to /dashboard', async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
    await expect(AdminRateLimitsPage()).rejects.toThrowError(NextRedirectError);
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
    await expect(AdminRateLimitsPage()).rejects.toThrowError(NextRedirectError);
  });

  it('reads rate_limit_buckets ordered by count desc, limit 50', async () => {
    getUserMock.mockResolvedValue({
      data: { user: { id: 'admin-1', email: 'admin@example.com' } },
      error: null,
    });
    profileMaybeSingleMock.mockResolvedValue({
      data: { role: 'admin', email: 'admin@example.com' },
      error: null,
    });
    finalResult.mockResolvedValue({
      data: [
        {
          key: 'audit-retry:user-1:abc',
          count: 7,
          window_start: new Date(Date.now() - 5 * 60_000).toISOString(),
          updated_at: new Date(Date.now() - 60_000).toISOString(),
        },
      ],
    });

    const element = await AdminRateLimitsPage();
    expect(element).toBeDefined();
    expect(adminFromMock).toHaveBeenCalledWith('rate_limit_buckets');
    expect(orderArgs).toHaveBeenCalledWith('count', { ascending: false });
    expect(limitArgs).toHaveBeenCalledWith(50);
  });
});
