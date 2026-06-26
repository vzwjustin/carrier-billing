import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for GET /api/reports/executive.pdf.
 *
 * No public share-token surface — this report aggregates multi-period
 * sensitive data so it must be authenticated. Coverage:
 *   - 400 invalid n (too high, too low, non-int)
 *   - 401 missing session
 *   - 429 per-user rate-limit (10/5min) keyed on `executive-pdf:<userId>`
 *   - 200 happy path with the PDF stream + filename + private cache headers
 *   - 500 generic on supabase errors (no leak)
 *   - Default n=3 when query param is absent
 */

const USER_ID = '33333333-3333-4333-8333-333333333333';

const {
  getUserMock,
  auditsResolveMock,
  findingsResolveMock,
  comparisonsResolveMock,
  linesResolveMock,
  driversResolveMock,
  consumeRateLimitMock,
  renderPdfMock,
  trackServerMock,
} = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  auditsResolveMock: vi.fn(),
  findingsResolveMock: vi.fn(),
  comparisonsResolveMock: vi.fn(),
  linesResolveMock: vi.fn(),
  driversResolveMock: vi.fn(),
  consumeRateLimitMock: vi.fn(),
  renderPdfMock: vi.fn(),
  trackServerMock: vi.fn(),
}));

function makeAuditsChain() {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.order = () => chain;
  chain.limit = () => chain;
  chain.returns = () => auditsResolveMock();
  return chain;
}

function makeAdminInChain(resolve: () => Promise<unknown>) {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.in = () => chain;
  chain.returns = () => resolve();
  return chain;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: getUserMock },
    from: () => makeAuditsChain(),
  }),
}));

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: (table: string) => {
      if (table === 'findings') return makeAdminInChain(findingsResolveMock);
      if (table === 'bill_comparisons') return makeAdminInChain(comparisonsResolveMock);
      if (table === 'bill_lines') return makeAdminInChain(linesResolveMock);
      if (table === 'bill_change_drivers') return makeAdminInChain(driversResolveMock);
      throw new Error(`unexpected admin.from(${table})`);
    },
  }),
}));

vi.mock('@/lib/security/rate-limit', () => ({
  consumeRateLimit: consumeRateLimitMock,
  rateLimitedResponse: () => new Response('rate-limited', { status: 429 }),
}));

vi.mock('@/lib/analytics/events', () => ({
  trackServer: trackServerMock,
}));

vi.mock('@/reports/executive/render', () => ({
  renderExecutivePdf: renderPdfMock,
}));

vi.mock('@/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'placeholder',
  },
}));

import { GET } from '@/app/api/reports/executive.pdf/route';

beforeEach(() => {
  getUserMock.mockReset();
  auditsResolveMock.mockReset();
  findingsResolveMock.mockReset();
  comparisonsResolveMock.mockReset();
  linesResolveMock.mockReset();
  driversResolveMock.mockReset();
  consumeRateLimitMock.mockReset();
  renderPdfMock.mockReset();
  trackServerMock.mockReset();

  getUserMock.mockResolvedValue({
    data: { user: { id: USER_ID } },
    error: null,
  });
  consumeRateLimitMock.mockResolvedValue({
    ok: true,
    resetAt: new Date().toISOString(),
  });
  auditsResolveMock.mockResolvedValue({
    data: [
      {
        id: 'audit-1',
        carrier: 'verizon',
        billing_period_start: '2026-04-01',
        billing_period_end: '2026-04-30',
        total_charges_cents: 50000,
        account_count: 1,
        line_count: 5,
        finding_count: 0,
        high_severity_count: 0,
        estimated_monthly_savings_cents: 0,
        estimated_annual_savings_cents: 0,
        completed_at: '2026-05-01T00:00:00Z',
      },
    ],
    error: null,
  });
  findingsResolveMock.mockResolvedValue({ data: [], error: null });
  comparisonsResolveMock.mockResolvedValue({ data: [], error: null });
  linesResolveMock.mockResolvedValue({ data: [], error: null });
  driversResolveMock.mockResolvedValue({ data: [], error: null });
  // Return a minimal "PDF" buffer. The route wraps it in a Response.
  renderPdfMock.mockResolvedValue(Buffer.from('%PDF-1.4 fake'));
  trackServerMock.mockResolvedValue(undefined);
});

describe('GET /api/reports/executive.pdf — query validation', () => {
  it('returns 400 when n is non-numeric', async () => {
    const res = await GET(new Request('http://localhost/api/reports/executive.pdf?n=banana'));
    expect(res.status).toBe(400);
  });

  it('returns 400 when n is below the minimum (0)', async () => {
    const res = await GET(new Request('http://localhost/api/reports/executive.pdf?n=0'));
    expect(res.status).toBe(400);
  });

  it('returns 400 when n exceeds the maximum (13)', async () => {
    const res = await GET(new Request('http://localhost/api/reports/executive.pdf?n=13'));
    expect(res.status).toBe(400);
  });

  it('defaults n to 3 when missing', async () => {
    const res = await GET(new Request('http://localhost/api/reports/executive.pdf'));
    expect(res.status).toBe(200);
  });
});

describe('GET /api/reports/executive.pdf — auth', () => {
  it('returns 401 when no session (no public share surface)', async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: null }, error: null });
    const res = await GET(new Request('http://localhost/api/reports/executive.pdf'));
    expect(res.status).toBe(401);
    expect(renderPdfMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/reports/executive.pdf — rate limit', () => {
  it('uses a per-user rate-limit key (10/5min)', async () => {
    await GET(new Request('http://localhost/api/reports/executive.pdf'));
    const call = consumeRateLimitMock.mock.calls[0]?.[0] as {
      key: string;
      limit: number;
      windowSeconds: number;
    };
    expect(call.key).toBe(`executive-pdf:${USER_ID}`);
    expect(call.limit).toBe(10);
    expect(call.windowSeconds).toBe(300);
  });

  it('returns 429 when rate-limit is exhausted', async () => {
    consumeRateLimitMock.mockResolvedValueOnce({
      ok: false,
      resetAt: new Date().toISOString(),
    });
    const res = await GET(new Request('http://localhost/api/reports/executive.pdf'));
    expect(res.status).toBe(429);
    expect(renderPdfMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/reports/executive.pdf — error paths', () => {
  it('returns 500 when the audits SELECT errors (no leak)', async () => {
    auditsResolveMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'connection refused' },
    });
    const res = await GET(new Request('http://localhost/api/reports/executive.pdf'));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Failed to load audits.');
    expect(body.error).not.toContain('connection');
  });

  it('returns 500 when any child SELECT (findings, comparisons, lines) errors', async () => {
    findingsResolveMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'db down' },
    });
    const res = await GET(new Request('http://localhost/api/reports/executive.pdf'));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Failed to load report data.');
  });
});

describe('GET /api/reports/executive.pdf — happy path', () => {
  it('returns 200 with a PDF body, inline disposition, private no-cache headers', async () => {
    const res = await GET(new Request('http://localhost/api/reports/executive.pdf'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    const disposition = res.headers.get('Content-Disposition') ?? '';
    expect(disposition).toContain('inline');
    // Filename includes the user-id-prefix + date.
    expect(disposition).toContain(`carrieraudit-executive-${USER_ID.slice(0, 8)}-`);
    expect(res.headers.get('Cache-Control')).toContain('private');
    expect(res.headers.get('Cache-Control')).toContain('must-revalidate');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  it('returns the bytes from renderExecutivePdf in the response', async () => {
    const bytes = Buffer.from('%PDF-1.7 hello');
    renderPdfMock.mockResolvedValueOnce(bytes);
    const res = await GET(new Request('http://localhost/api/reports/executive.pdf'));
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.toString('utf8')).toBe('%PDF-1.7 hello');
  });

  it('fires the report_pdf_downloaded analytics event with executive: prefix', async () => {
    await GET(new Request('http://localhost/api/reports/executive.pdf?n=5'));
    expect(trackServerMock).toHaveBeenCalledTimes(1);
    const evt = trackServerMock.mock.calls[0]?.[0] as {
      name: string;
      properties: { auditId: string; isPublic: boolean };
    };
    expect(evt.name).toBe('report_pdf_downloaded');
    expect(evt.properties.auditId).toBe('executive:n=5');
    expect(evt.properties.isPublic).toBe(false);
  });

  it('does NOT fail the response when analytics throws', async () => {
    trackServerMock.mockRejectedValueOnce(new Error('posthog down'));
    const res = await GET(new Request('http://localhost/api/reports/executive.pdf'));
    expect(res.status).toBe(200);
  });

  it('skips child fetches and renders an empty report when the user has no completed audits', async () => {
    auditsResolveMock.mockResolvedValueOnce({ data: [], error: null });
    const res = await GET(new Request('http://localhost/api/reports/executive.pdf'));
    expect(res.status).toBe(200);
    expect(findingsResolveMock).not.toHaveBeenCalled();
    expect(comparisonsResolveMock).not.toHaveBeenCalled();
    expect(linesResolveMock).not.toHaveBeenCalled();
    expect(renderPdfMock).toHaveBeenCalledTimes(1);
  });
});
