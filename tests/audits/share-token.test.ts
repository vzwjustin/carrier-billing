/**
 * Share-token edge cases for the public `/share/[token]` page handler.
 *
 * The existing `tests/audits/share-api.test.ts` covers the *creation* of share
 * tokens via `POST /api/audits/[id]/share`. This file covers the *consumption*
 * side — the public read-only viewer at `/share/[token]`.
 *
 * Cases covered:
 *   (a) valid token → renders the read-only ReportView (returns a JSX element)
 *   (b) unknown token → calls notFound() (App Router 404)
 *   (c) empty / too-short / non-string token → calls notFound() (treated as 404)
 *   (d) audit found via token but status !== 'completed' → notFound()
 *
 * Following the App Router testing pattern from CLAUDE.md §9, we invoke the
 * server component function directly with shaped params and assert it either
 * returns a React element or that notFound() throws.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// notFound() from next/navigation throws a sentinel error in App Router.
// We mock it to throw a recognizable "NEXT_NOT_FOUND" error our tests assert.
// ---------------------------------------------------------------------------

class NextNotFoundError extends Error {
  constructor() {
    super('NEXT_NOT_FOUND');
    this.name = 'NEXT_NOT_FOUND';
  }
}

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new NextNotFoundError();
  },
}));

// ---------------------------------------------------------------------------
// Mock the admin supabase client used by the share page.
// ---------------------------------------------------------------------------

interface AuditRow {
  id: string;
  status: string;
  carrier: string | null;
  line_count: number | null;
  account_count: number | null;
  total_charges_cents: number | null;
  billing_period_start: string | null;
  billing_period_end: string | null;
  estimated_monthly_savings_cents: number | null;
  estimated_annual_savings_cents: number | null;
  finding_count: number | null;
  high_severity_count: number | null;
  completed_at: string | null;
  share_token_expires_at: string | null;
}

type MaybeSingleResult =
  | { data: AuditRow; error: null }
  | { data: null; error: null }
  | { data: null; error: { code?: string; message: string } };

type ListResult = { data: unknown[]; error: null };
type EqProxy = Promise<ListResult> & {
  eq: (_col: string, _val: string) => EqProxy;
  maybeSingle: () => Promise<MaybeSingleResult>;
};

const auditMaybeSingleMock = vi.fn<() => Promise<MaybeSingleResult>>();

// admin.from('audits').select(...).eq('share_token', token).maybeSingle()
// admin.from('findings'|'bill_*').select(...).eq('audit_id', id) → list
function makeAdminTableBuilder(table: string) {
  const makeEqProxy = (): EqProxy => {
    const listPromise = Promise.resolve<ListResult>({
      data: [],
      error: null,
    });
    const proxy = Object.assign(listPromise, {
      eq: (_col: string, _val: string) => proxy,
      maybeSingle: (): Promise<MaybeSingleResult> => {
        if (table !== 'audits') {
          return Promise.resolve<MaybeSingleResult>({
            data: null,
            error: null,
          });
        }
        return auditMaybeSingleMock();
      },
    });
    return proxy;
  };

  return {
    select: (_cols: string) => ({
      eq: (_col: string, _val: string): EqProxy => makeEqProxy(),
    }),
  };
}

const adminFromMock = vi.fn((table: string) => makeAdminTableBuilder(table));

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({ from: adminFromMock }),
}));

// Analytics: stub trackServer so we don't hit PostHog from a server component.
vi.mock('@/lib/analytics/events', () => ({
  trackServer: async () => undefined,
  trackClient: () => undefined,
}));

vi.mock('@/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'placeholder',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-placeholder',
    NEXT_PUBLIC_APP_URL: 'https://app.carrieraudit.test',
  },
}));

// Stub the heavy ReportView so we don't have to render every child component.
vi.mock('@/components/audits/report-view', () => ({
  ReportView: ({ isPublic }: { isPublic?: boolean }) => ({
    type: 'div',
    props: {
      'data-testid': 'report-view',
      'data-public': isPublic ? 'true' : 'false',
    },
  }),
}));

// Import after the mocks above.
import ShareReportPage, { generateMetadata } from '@/app/share/[token]/page';

const VALID_AUDIT_ID = '11111111-1111-4111-8111-111111111111';

function makeAudit(over: Partial<AuditRow> = {}): AuditRow {
  return {
    id: VALID_AUDIT_ID,
    status: 'completed',
    carrier: 'verizon',
    line_count: 5,
    account_count: 1,
    total_charges_cents: 50000,
    billing_period_start: '2026-04-01',
    billing_period_end: '2026-04-30',
    estimated_monthly_savings_cents: 0,
    estimated_annual_savings_cents: 0,
    finding_count: 0,
    high_severity_count: 0,
    completed_at: '2026-05-01T00:00:00Z',
    // 30 days out — well within the share window.
    share_token_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    ...over,
  };
}

// Tokens are exactly 32 chars (randomBytes(24).toString('base64url')). Use
// padded literal strings of length 32 throughout the suite.
const VALID_TOKEN_32 = 'abcdefghij1234567890abcdefghij12';

beforeEach(() => {
  auditMaybeSingleMock.mockReset();
  adminFromMock.mockClear();
});

describe('GET /share/[token] page handler', () => {
  it('(a) valid token → renders the read-only viewer', async () => {
    auditMaybeSingleMock.mockResolvedValueOnce({
      data: makeAudit(),
      error: null,
    });

    const element = await ShareReportPage({
      params: Promise.resolve({ token: VALID_TOKEN_32 }),
    });

    // The function should return a JSX element (not throw notFound).
    expect(element).toBeDefined();
    // The audits lookup must have been issued.
    expect(adminFromMock).toHaveBeenCalledWith('audits');
  });

  it('(b) unknown token → notFound() is invoked', async () => {
    // Token passes length sanity; supabase reports no row.
    auditMaybeSingleMock.mockResolvedValueOnce({ data: null, error: null });

    const unknownToken = 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'; // 32 chars
    await expect(
      ShareReportPage({
        params: Promise.resolve({ token: unknownToken }),
      }),
    ).rejects.toThrowError(NextNotFoundError);
  });

  it('(c1) empty token → notFound() before any DB call', async () => {
    await expect(
      ShareReportPage({
        params: Promise.resolve({ token: '' }),
      }),
    ).rejects.toThrowError(NextNotFoundError);

    // Empty token never hits the DB.
    expect(adminFromMock).not.toHaveBeenCalled();
  });

  it('(c2) too-short token (invalid format) → notFound() before any DB call', async () => {
    await expect(
      ShareReportPage({
        params: Promise.resolve({ token: 'tiny' }),
      }),
    ).rejects.toThrowError(NextNotFoundError);

    expect(adminFromMock).not.toHaveBeenCalled();
  });

  it('(c3) absurdly long token → notFound() before any DB call', async () => {
    const huge = 'x'.repeat(200);
    await expect(
      ShareReportPage({
        params: Promise.resolve({ token: huge }),
      }),
    ).rejects.toThrowError(NextNotFoundError);

    expect(adminFromMock).not.toHaveBeenCalled();
  });

  it('(c4) tightened length validator rejects 31-char and 33-char candidates (L)', async () => {
    const tooShort = 'x'.repeat(31);
    const tooLong = 'x'.repeat(33);

    await expect(
      ShareReportPage({ params: Promise.resolve({ token: tooShort }) }),
    ).rejects.toThrowError(NextNotFoundError);
    await expect(
      ShareReportPage({ params: Promise.resolve({ token: tooLong }) }),
    ).rejects.toThrowError(NextNotFoundError);

    expect(adminFromMock).not.toHaveBeenCalled();
  });

  it('(d) audit found via token but status !== completed → notFound()', async () => {
    // A token can exist on a row whose status is still `analyzing`. Sharing
    // that link should 404 until the audit is complete — public viewers
    // never see partial/failed audits.
    auditMaybeSingleMock.mockResolvedValueOnce({
      data: makeAudit({ status: 'analyzing' }),
      error: null,
    });

    await expect(
      ShareReportPage({
        params: Promise.resolve({ token: VALID_TOKEN_32 }),
      }),
    ).rejects.toThrowError(NextNotFoundError);
  });

  it('(e) audit found but share_token_expires_at is in the past → notFound() (H11)', async () => {
    auditMaybeSingleMock.mockResolvedValueOnce({
      data: makeAudit({
        share_token_expires_at: new Date(Date.now() - 1_000).toISOString(),
      }),
      error: null,
    });

    await expect(
      ShareReportPage({
        params: Promise.resolve({ token: VALID_TOKEN_32 }),
      }),
    ).rejects.toThrowError(NextNotFoundError);
  });

  it('(f) audit found with NULL expiry (grandfathered share) → renders normally', async () => {
    auditMaybeSingleMock.mockResolvedValueOnce({
      data: makeAudit({ share_token_expires_at: null }),
      error: null,
    });

    const element = await ShareReportPage({
      params: Promise.resolve({ token: VALID_TOKEN_32 }),
    });
    expect(element).toBeDefined();
  });

  it('(g) retries without share_token_expires_at when PostgREST schema cache is stale', async () => {
    auditMaybeSingleMock
      .mockResolvedValueOnce({
        data: null,
        error: { code: 'PGRST204', message: 'column share_token_expires_at not found' },
      })
      .mockResolvedValueOnce({
        data: makeAudit({ share_token_expires_at: null }),
        error: null,
      });

    const element = await ShareReportPage({
      params: Promise.resolve({ token: VALID_TOKEN_32 }),
    });

    expect(element).toBeDefined();
    expect(auditMaybeSingleMock).toHaveBeenCalledTimes(2);
  });

  it('(h) metadata retries without share_token_expires_at when PostgREST schema cache is stale', async () => {
    auditMaybeSingleMock
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: 'PGRST204',
          message: 'column share_token_expires_at not found',
        },
      })
      .mockResolvedValueOnce({
        data: makeAudit({
          estimated_annual_savings_cents: 1_234_500,
          finding_count: 2,
          share_token_expires_at: null,
        }),
        error: null,
      });

    const metadata = await generateMetadata({
      params: Promise.resolve({ token: VALID_TOKEN_32 }),
    });

    expect(metadata.title).toBe('Verizon bill audit — $12.3k/yr in potential savings');
    expect(auditMaybeSingleMock).toHaveBeenCalledTimes(2);
  });
});
