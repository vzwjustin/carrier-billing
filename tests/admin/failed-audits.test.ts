/**
 * Admin failed-audits page — role gate + happy-path query shape.
 *
 * Mirrors the App Router page-handler test pattern in
 * tests/audits/share-token.test.ts: invoke the server component function
 * directly with shaped params and assert it either returns a React element
 * or that the role-gate redirect sentinel throws.
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
// Mock the server supabase client used by requireAdmin().
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
    auth: {
      getUser: () => getUserMock(),
    },
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
// Mock the admin supabase client used by the page data reads.
// ---------------------------------------------------------------------------

type RangeResult = { data: unknown[]; count: number | null };
type InResult = { data: unknown[] };

const auditsRangeMock = vi.fn<() => Promise<RangeResult>>();
const auditsRangeFilterArgs = vi.fn<(args: { from: number; to: number }) => void>();
const auditsEqArgs = vi.fn<(col: string, value: unknown) => void>();
const profilesInMock = vi.fn<() => Promise<InResult>>();
const profilesInArgs = vi.fn<(col: string, values: unknown[]) => void>();

const adminFromMock = vi.fn((table: string) => {
  if (table === 'audits') {
    return {
      select: (_cols: string, _opts?: unknown) => ({
        eq: (col: string, value: string) => {
          auditsEqArgs(col, value);
          return {
            order: (_c: string, _o: unknown) => ({
              range: (from: number, to: number) => {
                auditsRangeFilterArgs({ from, to });
                return auditsRangeMock();
              },
            }),
          };
        },
      }),
    };
  }
  if (table === 'profiles') {
    return {
      select: (_cols: string) => ({
        in: (col: string, values: unknown[]) => {
          profilesInArgs(col, values);
          return profilesInMock();
        },
      }),
    };
  }
  throw new Error(`unexpected table: ${table}`);
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

// Stub the client component import to avoid pulling 'sonner' into the test
// graph (this is a server-component test that only renders the page shell).
vi.mock('@/components/admin/retry-button', () => ({
  RetryButton: ({ auditId }: { auditId: string }) => ({
    type: 'button',
    props: { 'data-audit-id': auditId },
  }),
}));

// Import after mocks are registered.
const { default: AdminFailedAuditsPage } = await import('@/app/(app)/admin/failed-audits/page');

beforeEach(() => {
  getUserMock.mockReset();
  profileMaybeSingleMock.mockReset();
  auditsRangeMock.mockReset();
  auditsRangeFilterArgs.mockReset();
  auditsEqArgs.mockReset();
  profilesInMock.mockReset();
  profilesInArgs.mockReset();
  adminFromMock.mockClear();
});

describe('GET /admin/failed-audits (role gate + query)', () => {
  it('role gate: anonymous caller is redirected to /dashboard', async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });

    await expect(AdminFailedAuditsPage({ searchParams: Promise.resolve({}) })).rejects.toThrowError(
      NextRedirectError,
    );
    // Confirm redirect destination matches the established admin gate.
    try {
      await AdminFailedAuditsPage({ searchParams: Promise.resolve({}) });
    } catch (err) {
      if (err instanceof NextRedirectError) expect(err.to).toBe('/dashboard');
    }
  });

  it('role gate: non-admin profile is redirected to /dashboard', async () => {
    getUserMock.mockResolvedValue({
      data: { user: { id: 'u1', email: 'u1@example.com' } },
      error: null,
    });
    profileMaybeSingleMock.mockResolvedValue({
      data: { role: 'user', email: 'u1@example.com' },
      error: null,
    });

    await expect(AdminFailedAuditsPage({ searchParams: Promise.resolve({}) })).rejects.toThrowError(
      NextRedirectError,
    );
  });

  it('happy path: admin sees status=failed query with default pagination', async () => {
    getUserMock.mockResolvedValue({
      data: { user: { id: 'admin-1', email: 'admin@example.com' } },
      error: null,
    });
    profileMaybeSingleMock.mockResolvedValue({
      data: { role: 'admin', email: 'admin@example.com' },
      error: null,
    });
    auditsRangeMock.mockResolvedValue({
      data: [
        {
          id: 'aud-1',
          user_id: 'user-1',
          original_filename: 'bill.pdf',
          failure_reason: 'pdf_parse_error',
          created_at: new Date('2026-05-01T10:00:00Z').toISOString(),
        },
      ],
      count: 1,
    });
    profilesInMock.mockResolvedValue({
      data: [{ id: 'user-1', email: 'user1@example.com' }],
    });

    const element = await AdminFailedAuditsPage({
      searchParams: Promise.resolve({}),
    });
    expect(element).toBeDefined();
    // Asserts the query filters on status=failed and uses 25-page paging.
    expect(auditsEqArgs).toHaveBeenCalledWith('status', 'failed');
    expect(auditsRangeFilterArgs).toHaveBeenCalledWith({ from: 0, to: 24 });
    // Profile lookup is keyed on the user_ids from the audits query.
    expect(profilesInArgs).toHaveBeenCalledWith('id', ['user-1']);
  });

  it('happy path: ?page=2 uses the next 25-row window', async () => {
    getUserMock.mockResolvedValue({
      data: { user: { id: 'admin-1', email: 'admin@example.com' } },
      error: null,
    });
    profileMaybeSingleMock.mockResolvedValue({
      data: { role: 'admin', email: 'admin@example.com' },
      error: null,
    });
    auditsRangeMock.mockResolvedValue({ data: [], count: 0 });

    await AdminFailedAuditsPage({
      searchParams: Promise.resolve({ page: '2' }),
    });
    expect(auditsRangeFilterArgs).toHaveBeenCalledWith({ from: 25, to: 49 });
  });
});
