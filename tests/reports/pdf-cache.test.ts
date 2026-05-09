/**
 * PDF report cache tests for `/api/audits/[id]/report.pdf`.
 *
 * Existing `pdf-route.test.ts` covers individual cache miss/hit cases. This
 * file specifically exercises the *cache lifecycle* across two consecutive
 * calls to the same route, asserting:
 *
 *   - First GET → cache miss → renderer is invoked, upload is called, PDF returned
 *   - Second GET → cache hit  → renderer is NOT invoked, upload NOT called,
 *                                cached bytes are returned
 *
 * The cache is the `reports` Supabase Storage bucket; the route looks for
 * `${auditId}.pdf` there before rendering. We model that bucket as an
 * in-memory map so two sequential GETs see a consistent storage state.
 *
 * The route source (src/app/api/audits/[id]/report.pdf/route.ts) does NOT
 * accept a force-regen query param — invalidation is implicit (the cached
 * file lives until storage is wiped or the audit is deleted). This test
 * documents that contract; if a force-regen flag is added later the test
 * here should be expanded to cover it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Constants & types
// ---------------------------------------------------------------------------

const VALID_AUDIT_ID = '11111111-1111-4111-8111-111111111111';

type AuditFullRow = {
  id: string;
  user_id: string;
  status: string;
  carrier: string | null;
  billing_period_start: string | null;
  billing_period_end: string | null;
  total_charges_cents: number | null;
  account_count: number | null;
  line_count: number | null;
  finding_count: number | null;
  high_severity_count: number | null;
  estimated_monthly_savings_cents: number | null;
  estimated_annual_savings_cents: number | null;
  completed_at: string | null;
  share_token: string | null;
};

type MaybeSingleResult =
  | { data: AuditFullRow; error: null }
  | { data: null; error: null };

type SelectListResult = { data: unknown[]; error: null };

// ---------------------------------------------------------------------------
// Storage simulator: an in-memory map keyed by `${bucket}:${path}`.
// Mirrors a tiny slice of the Supabase Storage API.
// ---------------------------------------------------------------------------

const storage = new Map<string, Uint8Array>();

function makeFakeBlob(bytes: Uint8Array): Blob {
  // The route only calls `.arrayBuffer()` and reads `.type` — return a minimal
  // Blob-like object that satisfies that contract without bringing in jsdom's
  // Blob, which does not always cooperate with Uint8Array slices.
  const ab: ArrayBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return {
    arrayBuffer: () => Promise.resolve(ab),
    type: 'application/pdf',
  } as unknown as Blob;
}

// ---------------------------------------------------------------------------
// Server-client mocks (auth path only — no share token)
// ---------------------------------------------------------------------------

const getUserMock = vi.fn(async () => ({
  data: { user: { id: 'user-uuid-1', email: 'a@b.com' } },
  error: null,
}));

const serverMaybeSingleMock = vi.fn<() => Promise<MaybeSingleResult>>();
const serverFromMock = vi.fn(() => ({
  select: () => ({
    eq: () => ({
      maybeSingle: () => serverMaybeSingleMock(),
    }),
  }),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: () => getUserMock() },
    from: serverFromMock,
  }),
}));

// ---------------------------------------------------------------------------
// Admin client: list reads + storage download/upload backed by `storage`.
// ---------------------------------------------------------------------------

function makeAdminEqBuilder(): unknown {
  const listPromise = Promise.resolve<SelectListResult>({
    data: [],
    error: null,
  });
  return Object.assign(listPromise, {
    eq: (_col: string, _val: string) => ({
      maybeSingle: async () => ({ data: null, error: null }),
    }),
    maybeSingle: async () => ({ data: null, error: null }),
  });
}

const adminFromMock = vi.fn(() => ({
  select: () => ({
    eq: () => makeAdminEqBuilder(),
  }),
}));

const downloadSpy = vi.fn(async (path: string) => {
  const key = `reports:${path}`;
  const bytes = storage.get(key);
  if (!bytes) return { data: null, error: { message: 'not found' } };
  return { data: makeFakeBlob(bytes), error: null };
});

const uploadSpy = vi.fn(async (path: string, body: Uint8Array) => {
  storage.set(`reports:${path}`, new Uint8Array(body));
  return { data: { path }, error: null };
});

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: adminFromMock,
    storage: {
      from: (_bucket: string) => ({
        download: (path: string) => downloadSpy(path),
        upload: (path: string, body: Uint8Array, _opts: unknown) =>
          uploadSpy(path, body),
      }),
    },
  }),
}));

// PDF renderer mock — never bring in @react-pdf/renderer in tests.
const renderReportPdfMock = vi.fn<() => Promise<Buffer>>();
vi.mock('@/reports/pdf/render', () => ({
  renderReportPdf: () => renderReportPdfMock(),
}));

// Builder mock — return a minimal ReportData shape so the route can pass it
// down to the (mocked) renderer without exploding.
vi.mock('@/reports/builder', () => ({
  buildReportData: () => ({
    audit: {
      id: VALID_AUDIT_ID,
      carrier: 'verizon',
      billing_period_start: '2026-04-01',
      billing_period_end: '2026-04-30',
      total_charges_cents: 100000,
      account_count: 1,
      line_count: 10,
      finding_count: 0,
      high_severity_count: 0,
      estimated_monthly_savings_cents: 0,
      estimated_annual_savings_cents: 0,
      completed_at: '2026-05-01T00:00:00Z',
    },
    findingsBySeverity: { high: [], medium: [], low: [], info: [] },
    bill: { accounts: [] },
  }),
}));

vi.mock('@/lib/analytics/events', () => ({
  trackServer: async () => undefined,
  trackClient: () => undefined,
}));

vi.mock('@/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'placeholder',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-placeholder',
  },
}));

import { GET } from '@/app/api/audits/[id]/report.pdf/route';

function makeAudit(over: Partial<AuditFullRow> = {}): AuditFullRow {
  return {
    id: VALID_AUDIT_ID,
    user_id: 'user-uuid-1',
    status: 'completed',
    carrier: 'verizon',
    billing_period_start: '2026-04-01',
    billing_period_end: '2026-04-30',
    total_charges_cents: 100000,
    account_count: 1,
    line_count: 10,
    finding_count: 0,
    high_severity_count: 0,
    estimated_monthly_savings_cents: 0,
    estimated_annual_savings_cents: 0,
    completed_at: '2026-05-01T00:00:00Z',
    share_token: null,
    ...over,
  };
}

function makeContext(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function makeRequest(): Request {
  return new Request(
    `http://localhost/api/audits/${VALID_AUDIT_ID}/report.pdf`,
  );
}

beforeEach(() => {
  storage.clear();
  serverMaybeSingleMock.mockReset();
  serverFromMock.mockClear();
  adminFromMock.mockClear();
  downloadSpy.mockClear();
  uploadSpy.mockClear();
  renderReportPdfMock.mockReset();
  getUserMock.mockClear();
});

describe('GET /api/audits/[id]/report.pdf — cache lifecycle', () => {
  it('first call: cache miss → renderer invoked, PDF uploaded, bytes returned', async () => {
    // The audits lookup is invoked twice across the two calls; we make it
    // return the same row each time.
    serverMaybeSingleMock.mockResolvedValue({
      data: makeAudit(),
      error: null,
    });
    const rendered = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]); // "%PDF-1"
    renderReportPdfMock.mockResolvedValueOnce(rendered);

    const res1 = await GET(makeRequest(), makeContext(VALID_AUDIT_ID));
    expect(res1.status).toBe(200);
    expect(renderReportPdfMock).toHaveBeenCalledTimes(1);
    expect(uploadSpy).toHaveBeenCalledTimes(1);

    const body1 = new Uint8Array(await res1.arrayBuffer());
    expect(body1.length).toBe(rendered.length);
    expect(body1[0]).toBe(0x25); // %
    expect(body1[1]).toBe(0x50); // P

    // The byte slice we just received should now be cached in storage.
    expect(storage.has(`reports:${VALID_AUDIT_ID}.pdf`)).toBe(true);
  });

  it('second call: cache hit → renderer NOT invoked, upload NOT called, cached bytes returned', async () => {
    serverMaybeSingleMock.mockResolvedValue({
      data: makeAudit(),
      error: null,
    });

    // Pre-populate the cache as if a prior call had rendered + uploaded.
    const cachedBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xca, 0xfe]);
    storage.set(`reports:${VALID_AUDIT_ID}.pdf`, cachedBytes);

    const res = await GET(makeRequest(), makeContext(VALID_AUDIT_ID));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(renderReportPdfMock).not.toHaveBeenCalled();
    expect(uploadSpy).not.toHaveBeenCalled();

    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.length).toBe(cachedBytes.length);
    expect(Array.from(body)).toEqual(Array.from(cachedBytes));
  });

  it('two-call lifecycle: miss → hit using one shared storage map', async () => {
    serverMaybeSingleMock.mockResolvedValue({
      data: makeAudit(),
      error: null,
    });
    const rendered = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x99]);
    renderReportPdfMock.mockResolvedValueOnce(rendered);

    // First request: cache miss, renderer fires, upload writes the cache.
    const res1 = await GET(makeRequest(), makeContext(VALID_AUDIT_ID));
    expect(res1.status).toBe(200);
    expect(renderReportPdfMock).toHaveBeenCalledTimes(1);
    expect(uploadSpy).toHaveBeenCalledTimes(1);

    // Second request: same audit, same path, but cache is now warm.
    const res2 = await GET(makeRequest(), makeContext(VALID_AUDIT_ID));
    expect(res2.status).toBe(200);
    // Renderer count must NOT have grown; upload count must NOT have grown.
    expect(renderReportPdfMock).toHaveBeenCalledTimes(1);
    expect(uploadSpy).toHaveBeenCalledTimes(1);

    // Bytes match what was cached.
    const body2 = new Uint8Array(await res2.arrayBuffer());
    expect(body2.length).toBe(rendered.length);
  });

  it('does NOT support a force-regen query param — extra params are ignored', async () => {
    // Document the current contract: ?force=1 / ?regen=1 are NOT honored.
    // The cache is consulted regardless. If/when a regen flag is added,
    // update this test accordingly.
    serverMaybeSingleMock.mockResolvedValue({
      data: makeAudit(),
      error: null,
    });
    const cachedBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    storage.set(`reports:${VALID_AUDIT_ID}.pdf`, cachedBytes);

    const url = new URL(
      `http://localhost/api/audits/${VALID_AUDIT_ID}/report.pdf`,
    );
    url.searchParams.set('force', '1');
    const res = await GET(new Request(url), makeContext(VALID_AUDIT_ID));

    expect(res.status).toBe(200);
    // Cache still wins despite ?force=1 being present.
    expect(renderReportPdfMock).not.toHaveBeenCalled();
  });
});
