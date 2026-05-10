import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const VALID_AUDIT_ID = '11111111-1111-4111-8111-111111111111';
const SHARE_TOKEN = 'share-token-abc-123';

// ---------------------------------------------------------------------------
// Row + result types (no `any`)
// ---------------------------------------------------------------------------

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
  | { data: null; error: null }
  | { data: null; error: { message: string } };

type GetUserResult = {
  data: { user: { id: string; email?: string } | null };
  error: null;
};

type DownloadResult =
  | { data: Blob; error: null }
  | { data: null; error: { message: string } };

type UploadResult = { data: { path: string } | null; error: null };

type SelectListResult = { data: unknown[]; error: null };

// ---------------------------------------------------------------------------
// Mocks. Declared before the route is imported.
// ---------------------------------------------------------------------------

// Server-client (auth) mocks: from(...).select(...).eq(...).maybeSingle()
const getUserMock = vi.fn<() => Promise<GetUserResult>>();
const serverMaybeSingleMock = vi.fn<() => Promise<MaybeSingleResult>>();
const serverEqMock = vi.fn(() => ({
  maybeSingle: () => serverMaybeSingleMock(),
}));
const serverSelectMock = vi.fn(() => ({
  eq: (_col: string, _val: string) => serverEqMock(),
}));
const serverFromMock = vi.fn(() => ({
  select: (_cols: string) => serverSelectMock(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: () => getUserMock() },
    from: serverFromMock,
  }),
}));

// Admin-client mocks
const adminMaybeSingleMock = vi.fn<() => Promise<MaybeSingleResult>>();

// The result of admin.from(table).select(cols).eq(col, val):
//   - awaited directly  →  resolves to { data, error } (list reads)
//   - chained .eq().maybeSingle()  →  resolves to MaybeSingleResult (audit lookup)
type AdminEqBuilder = PromiseLike<SelectListResult> & {
  eq: (col: string, val: string) => { maybeSingle: () => Promise<MaybeSingleResult> };
  maybeSingle: () => Promise<MaybeSingleResult>;
};

function makeAdminEqBuilder(): AdminEqBuilder {
  const listPromise: Promise<SelectListResult> = Promise.resolve({
    data: [],
    error: null,
  });
  const builder: AdminEqBuilder = {
    then: listPromise.then.bind(listPromise) as PromiseLike<SelectListResult>['then'],
    eq: (_col2: string, _val2: string) => ({
      maybeSingle: () => adminMaybeSingleMock(),
    }),
    maybeSingle: () => adminMaybeSingleMock(),
  };
  return builder;
}

const adminSelectMock = vi.fn(() => ({
  eq: (_col: string, _val: string) => makeAdminEqBuilder(),
}));

const adminFromMock = vi.fn(() => ({
  select: (_cols: string) => adminSelectMock(),
}));

const downloadMock = vi.fn<() => Promise<DownloadResult>>();
const uploadMock = vi.fn<() => Promise<UploadResult>>();

const adminStorageFromMock = vi.fn(() => ({
  download: (_path: string) => downloadMock(),
  upload: (_path: string, _body: Uint8Array, _opts: unknown) => uploadMock(),
}));

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: adminFromMock,
    storage: { from: adminStorageFromMock },
  }),
}));

// PDF render mock — never actually run @react-pdf/renderer in tests.
const renderReportPdfMock = vi.fn<() => Promise<Buffer>>();
vi.mock('@/reports/pdf/render', () => ({
  renderReportPdf: () => renderReportPdfMock(),
}));

// Builder mock — return a minimal ReportData-shaped object.
const buildReportDataMock = vi.fn(() => ({
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
}));
vi.mock('@/reports/builder', () => ({
  buildReportData: (...args: unknown[]) => buildReportDataMock(...(args as [])),
}));

vi.mock('@/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'placeholder',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-placeholder',
  },
}));

// Import the route AFTER the mocks above are registered.
import { GET } from '@/app/api/audits/[id]/report.pdf/route';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function makeRequest(opts: { token?: string } = {}): Request {
  const url = new URL(
    `http://localhost/api/audits/${VALID_AUDIT_ID}/report.pdf`,
  );
  if (opts.token) url.searchParams.set('token', opts.token);
  return new Request(url);
}

function makeAudit(overrides: Partial<AuditFullRow> = {}): AuditFullRow {
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
    ...overrides,
  };
}

beforeEach(() => {
  getUserMock.mockReset();
  serverMaybeSingleMock.mockReset();
  serverEqMock.mockClear();
  serverSelectMock.mockClear();
  serverFromMock.mockClear();
  adminMaybeSingleMock.mockReset();
  adminSelectMock.mockClear();
  adminFromMock.mockClear();
  adminStorageFromMock.mockClear();
  downloadMock.mockReset();
  uploadMock.mockReset();
  renderReportPdfMock.mockReset();
  buildReportDataMock.mockClear();

  getUserMock.mockResolvedValue({
    data: { user: { id: 'user-uuid-1' } },
    error: null,
  });
  uploadMock.mockResolvedValue({
    data: { path: 'reports/x.pdf' },
    error: null,
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/audits/[id]/report.pdf', () => {
  it('returns 401 when there is no authenticated user and no share token', async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: null }, error: null });
    const res = await GET(makeRequest(), makeContext(VALID_AUDIT_ID));
    expect(res.status).toBe(401);
  });

  it('returns 400 when the audit id is not a uuid', async () => {
    const res = await GET(makeRequest(), makeContext('not-a-uuid'));
    expect(res.status).toBe(400);
  });

  it('returns 404 when the audit row is not found (auth path)', async () => {
    serverMaybeSingleMock.mockResolvedValueOnce({ data: null, error: null });
    const res = await GET(makeRequest(), makeContext(VALID_AUDIT_ID));
    expect(res.status).toBe(404);
  });

  it("returns 409 with body { error: 'audit_not_completed' } when status is not completed", async () => {
    serverMaybeSingleMock.mockResolvedValueOnce({
      data: makeAudit({ status: 'analyzing' }),
      error: null,
    });
    const res = await GET(makeRequest(), makeContext(VALID_AUDIT_ID));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('audit_not_completed');
  });

  it('returns 200 with the cached PDF when one already exists in storage', async () => {
    serverMaybeSingleMock.mockResolvedValueOnce({
      data: makeAudit(),
      error: null,
    });
    const cachedBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
    const fakeBlob = {
      arrayBuffer: () => Promise.resolve(cachedBytes.buffer.slice(0)),
      type: 'application/pdf',
    };
    downloadMock.mockResolvedValueOnce({ data: fakeBlob as unknown as Blob, error: null });

    const res = await GET(makeRequest(), makeContext(VALID_AUDIT_ID));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toContain(
      'inline; filename="carrieraudit-',
    );
    // Render must NOT be called when we have a cache hit.
    expect(renderReportPdfMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();

    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf[0]).toBe(0x25);
    expect(buf.length).toBe(4);
  });

  it('sets Referrer-Policy: no-referrer so ?token=<share_token> never leaks via Referer', async () => {
    // Cached path — same Response builder is used for the freshly-rendered
    // path, so a single cache-hit assertion is sufficient.
    serverMaybeSingleMock.mockResolvedValueOnce({
      data: makeAudit(),
      error: null,
    });
    const cachedBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const fakeBlob = {
      arrayBuffer: () => Promise.resolve(cachedBytes.buffer.slice(0)),
      type: 'application/pdf',
    };
    downloadMock.mockResolvedValueOnce({
      data: fakeBlob as unknown as Blob,
      error: null,
    });

    const res = await GET(makeRequest(), makeContext(VALID_AUDIT_ID));

    expect(res.status).toBe(200);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('renders, uploads, and returns a fresh PDF when no cache exists', async () => {
    serverMaybeSingleMock.mockResolvedValueOnce({
      data: makeAudit(),
      error: null,
    });
    downloadMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'not found' },
    });
    const rendered = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"
    renderReportPdfMock.mockResolvedValueOnce(rendered);

    const res = await GET(makeRequest(), makeContext(VALID_AUDIT_ID));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(renderReportPdfMock).toHaveBeenCalledTimes(1);
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(buildReportDataMock).toHaveBeenCalledTimes(1);

    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf.length).toBe(rendered.length);
    expect(buf[0]).toBe(0x25);
  });

  it('allows access via a valid share_token without authentication', async () => {
    // Even if no user is signed in, share_token mode should succeed.
    getUserMock.mockResolvedValueOnce({ data: { user: null }, error: null });

    adminMaybeSingleMock.mockResolvedValueOnce({
      data: makeAudit({ share_token: SHARE_TOKEN }),
      error: null,
    });
    const cachedBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const fakeBlob = {
      arrayBuffer: () => Promise.resolve(cachedBytes.buffer.slice(0)),
      type: 'application/pdf',
    };
    downloadMock.mockResolvedValueOnce({ data: fakeBlob as unknown as Blob, error: null });

    const res = await GET(
      makeRequest({ token: SHARE_TOKEN }),
      makeContext(VALID_AUDIT_ID),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    // Token path should NOT touch the server (auth) client.
    expect(serverFromMock).not.toHaveBeenCalled();
  });
});
