/**
 * GET /api/audits/[id]/cost-centers.csv
 *
 * Streams the audit's cost-center roll-up as a CSV. Same access model as
 * findings.csv: authenticated owner OR public `?token=<share_token>`.
 *
 * Columns: cost_center, line_count, monthly_total_dollars, annual_total_dollars
 * Unassigned lines roll up under the literal label "(unassigned)" so they're
 * visible to the operator.
 */
import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';

import { hashTokenForAnalytics } from '@/lib/analytics/hash';
import {
  aggregateCostCenters,
  type CostCenterLineInput,
} from '@/lib/cost-centers/aggregate';
import { toCsv } from '@/lib/csv';
import {
  consumeRateLimit,
  rateLimitedResponse,
} from '@/lib/security/rate-limit';
import { isShareTokenExpired } from '@/lib/share-token';
import { getAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ParamsSchema = z.object({ id: z.string().uuid() });

const AUDIT_COLUMNS =
  'id,user_id,status,share_token,share_token_expires_at';

interface AuditAuthRow {
  id: string;
  user_id: string;
  status: string;
  share_token: string | null;
  share_token_expires_at: string | null;
}

const CSV_HEADER = [
  'cost_center',
  'line_count',
  'monthly_total_dollars',
  'annual_total_dollars',
] as const;

function csvFilename(auditId: string): string {
  return `carrieraudit-cost-centers-${auditId.slice(0, 8)}.csv`;
}

function centsToDollarsString(cents: number): string {
  return (cents / 100).toFixed(2);
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
  const token =
    rawToken && /^[A-Za-z0-9_-]{32}$/.test(rawToken) ? rawToken : null;

  if (rawToken && !token) {
    return new NextResponse('Not found.', { status: 404 });
  }

  let audit: AuditAuthRow | null = null;

  if (token) {
    const limited = await consumeRateLimit({
      key: `cost-centers-csv-public:${hashTokenForAnalytics(token)}`,
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
      key: `cost-centers-csv-auth:${user.id}`,
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
    return NextResponse.json(
      { error: 'audit_not_completed' },
      { status: 409 },
    );
  }

  const admin = getAdminClient();
  const { data: lines, error: linesErr } = await admin
    .from('bill_lines')
    .select('cost_center,plan_base_cents')
    .eq('audit_id', auditId);

  if (linesErr) {
    Sentry.captureException(linesErr, {
      tags: { surface: 'cost-centers.csv' },
      extra: { auditId },
    });
    return NextResponse.json(
      { error: 'Failed to load bill lines.' },
      { status: 500 },
    );
  }

  const rollup = aggregateCostCenters(
    (lines ?? []) as CostCenterLineInput[],
  );

  const body = rollup.map((row) => [
    row.cost_center,
    row.line_count,
    centsToDollarsString(row.monthly_total_cents),
    centsToDollarsString(row.monthly_total_cents * 12),
  ]);

  const csv = toCsv(CSV_HEADER, body);
  return csvResponse(csv, auditId);
}
