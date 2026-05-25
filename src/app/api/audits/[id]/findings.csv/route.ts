/**
 * GET /api/audits/[id]/findings.csv
 *
 * Streams the audit's findings as a CSV file. Same access model as the PDF
 * route:
 *   - authenticated owner (RLS-scoped server client), OR
 *   - public `?token=<share_token>` (admin client, bypasses RLS).
 *
 * Output columns are documented in the header row of the file itself. Money
 * is emitted as dollars-with-decimals (not cents) so the file opens cleanly
 * in spreadsheet apps without per-column number formatting.
 *
 * NB: column count is fixed and append-only; do not reorder or rename
 * columns without bumping a migration of the operator-facing docs — folks
 * pipe this CSV into Sheets/Excel/Notion templates that key on the header.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import * as Sentry from '@sentry/nextjs';

import { FINDING_STATUS_VALUES } from '@/components/report/finding-status-meta';
import { hashTokenForAnalytics } from '@/lib/analytics/hash';
import { logTrailEvent } from '@/lib/audit-trail/log';
import { toCsv } from '@/lib/csv';
import {
  consumeRateLimit,
  rateLimitedResponse,
} from '@/lib/security/rate-limit';
import { getAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import type { FindingStatus, Severity } from '@/rules/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ParamsSchema = z.object({ id: z.string().uuid() });

const AUDIT_COLUMNS =
  'id,user_id,status,carrier,billing_period_start,billing_period_end,share_token,share_token_expires_at';

interface AuditAuthRow {
  id: string;
  user_id: string;
  status: string;
  carrier: string | null;
  billing_period_start: string | null;
  billing_period_end: string | null;
  share_token: string | null;
  share_token_expires_at: string | null;
}

interface FindingCsvRow {
  rule_id: string;
  severity: string;
  status: string | null;
  title: string;
  description: string;
  recommended_action: string;
  estimated_monthly_savings_cents: number;
  confidence: number;
  affected_line_ids: string[] | null;
  affected_account_ids: string[] | null;
}

const SEVERITY_RANK: Record<string, number> = {
  high: 0,
  medium: 1,
  low: 2,
  info: 3,
};

const SEVERITY_VALUES = ['high', 'medium', 'low', 'info'] as const;

const CSV_HEADER = [
  'rule_id',
  'severity',
  'status',
  'title',
  'description',
  'recommended_action',
  'estimated_monthly_savings_dollars',
  'estimated_annual_savings_dollars',
  'confidence',
  'affected_line_count',
  'affected_account_count',
] as const;

/**
 * Parse a comma-separated query param like `?status=approved,disputed`
 * against an allow-list. Returns `null` when the param was absent so the
 * caller can distinguish "no filter" from "empty filter".
 *
 * Returns an `Error` when the param was present but contained a value that
 * isn't in the allow-list. Callers map that to a 400 — silently dropping a
 * bad value could mask a typo in an analyst's bookmarked URL.
 */
function parseEnumCsv<T extends string>(
  raw: string | null,
  allowed: readonly T[],
): { ok: true; values: T[] | null } | { ok: false; error: string } {
  if (raw === null) return { ok: true, values: null };
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return { ok: true, values: [] };
  const allow = allowed as readonly string[];
  for (const p of parts) {
    if (!allow.includes(p)) {
      return { ok: false, error: `Unknown value "${p}".` };
    }
  }
  // Dedupe while preserving order.
  const seen = new Set<string>();
  const out: T[] = [];
  for (const p of parts) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p as T);
  }
  return { ok: true, values: out };
}

function csvFilename(auditId: string): string {
  return `carrieraudit-findings-${auditId.slice(0, 8)}.csv`;
}

function isShareTokenExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  const ts = Date.parse(expiresAt);
  if (Number.isNaN(ts)) return false;
  return ts <= Date.now();
}

function centsToDollarsString(cents: number): string {
  // toFixed(2) is the cheapest way to get a stable "12.34" representation
  // without ever falling into scientific notation; the CSV cell helper will
  // pass it through unquoted since it has no special chars.
  return (cents / 100).toFixed(2);
}

function findingsToCsv(rows: FindingCsvRow[]): string {
  // Sort high → info, then by monthly savings desc, then by title for
  // stable ordering. Matches the on-screen report order so a customer can
  // diff the CSV against the UI without surprises.
  const sorted = [...rows].sort((a, b) => {
    const sevA = SEVERITY_RANK[a.severity] ?? 99;
    const sevB = SEVERITY_RANK[b.severity] ?? 99;
    if (sevA !== sevB) return sevA - sevB;
    if (b.estimated_monthly_savings_cents !== a.estimated_monthly_savings_cents) {
      return (
        b.estimated_monthly_savings_cents - a.estimated_monthly_savings_cents
      );
    }
    return a.title.localeCompare(b.title);
  });

  const body = sorted.map((f) => [
    f.rule_id,
    f.severity,
    // DB default is 'new' (migration 0023); legacy rows may be null — fall
    // back to 'new' rather than emitting an empty cell.
    f.status ?? 'new',
    f.title,
    f.description,
    f.recommended_action,
    centsToDollarsString(f.estimated_monthly_savings_cents),
    centsToDollarsString(f.estimated_monthly_savings_cents * 12),
    f.confidence.toFixed(2),
    (f.affected_line_ids ?? []).length,
    (f.affected_account_ids ?? []).length,
  ]);

  return toCsv(CSV_HEADER, body);
}

function csvResponse(body: string, auditId: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${csvFilename(auditId)}"`,
      'Cache-Control': 'private, max-age=0, must-revalidate',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const params = await context.params;
  const parsed = ParamsSchema.safeParse(params);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid audit id.' }, { status: 400 });
  }
  const auditId = parsed.data.id;

  const url = new URL(request.url);
  const rawToken = url.searchParams.get('token');
  const token = rawToken && /^[A-Za-z0-9_-]{32}$/.test(rawToken) ? rawToken : null;

  if (rawToken && !token) {
    return new NextResponse('Not found.', { status: 404 });
  }

  // Optional filter params. Validated against the same enums the UI uses;
  // unknown values are rejected with a 400 so a bookmarked URL doesn't
  // silently drop the typo.
  const statusFilter = parseEnumCsv<FindingStatus>(
    url.searchParams.get('status'),
    FINDING_STATUS_VALUES,
  );
  const severityFilter = parseEnumCsv<Severity>(
    url.searchParams.get('severity'),
    SEVERITY_VALUES,
  );
  if (!statusFilter.ok) {
    return NextResponse.json({ error: statusFilter.error }, { status: 400 });
  }
  if (!severityFilter.ok) {
    return NextResponse.json({ error: severityFilter.error }, { status: 400 });
  }

  let audit: AuditAuthRow | null = null;

  if (token) {
    const limited = await consumeRateLimit({
      key: `audit-csv-public:${hashTokenForAnalytics(token)}`,
      limit: 10,
      windowSeconds: 300,
    });
    if (!limited.ok) {
      return rateLimitedResponse(limited.resetAt);
    }
    const admin = getAdminClient();
    const { data, error } = await admin
      .from('audits')
      .select(AUDIT_COLUMNS)
      .eq('id', auditId)
      .eq('share_token', token)
      .maybeSingle<AuditAuthRow>();
    if (error || !data) {
      return new NextResponse('Not found.', { status: 404 });
    }
    audit = data;
    if (isShareTokenExpired(audit.share_token_expires_at)) {
      return new NextResponse('Not found.', { status: 404 });
    }
  } else {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    }
    const limited = await consumeRateLimit({
      key: `audit-csv-auth:${user.id}`,
      limit: 30,
      windowSeconds: 300,
    });
    if (!limited.ok) {
      return rateLimitedResponse(limited.resetAt);
    }
    const { data, error } = await supabase
      .from('audits')
      .select(AUDIT_COLUMNS)
      .eq('id', auditId)
      .maybeSingle<AuditAuthRow>();
    if (error) {
      return NextResponse.json(
        { error: 'Failed to look up audit.' },
        { status: 500 },
      );
    }
    if (!data || data.user_id !== user.id) {
      return NextResponse.json({ error: 'Audit not found.' }, { status: 404 });
    }
    audit = data;
  }

  if (audit.status !== 'completed') {
    return NextResponse.json({ error: 'audit_not_completed' }, { status: 409 });
  }

  const admin = getAdminClient();
  let query = admin
    .from('findings')
    .select(
      'rule_id,severity,status,title,description,recommended_action,estimated_monthly_savings_cents,confidence,affected_line_ids,affected_account_ids',
    )
    .eq('audit_id', auditId);

  // Push the filter to the DB so we only fetch what the caller asked for —
  // matters most on audits with hundreds of findings. An empty allow-list
  // (e.g. `?status=` with no value) means "filter on, no values match" →
  // return zero rows without burning a DB query.
  if (statusFilter.values !== null) {
    if (statusFilter.values.length === 0) {
      return csvResponse(findingsToCsv([]), auditId);
    }
    query = query.in('status', statusFilter.values);
  }
  if (severityFilter.values !== null) {
    if (severityFilter.values.length === 0) {
      return csvResponse(findingsToCsv([]), auditId);
    }
    query = query.in('severity', severityFilter.values);
  }

  const { data: findings, error: findingsErr } = await query;

  if (findingsErr) {
    Sentry.captureException(findingsErr, {
      tags: { surface: 'findings.csv' },
      extra: { auditId },
    });
    return NextResponse.json(
      { error: 'Failed to load findings.' },
      { status: 500 },
    );
  }

  const csv = findingsToCsv((findings ?? []) as FindingCsvRow[]);
  // Auth-only audit trail; public-token exports aren't attributable to a user.
  if (token === null) {
    await logTrailEvent({ userId: audit.user_id, eventType: 'csv_exported', entityType: 'audit', entityId: auditId, metadata: { kind: 'findings', filtered_status: statusFilter.values, filtered_severity: severityFilter.values } });
  }
  return csvResponse(csv, auditId);
}
