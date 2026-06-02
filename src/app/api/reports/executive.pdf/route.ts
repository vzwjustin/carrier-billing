/**
 * GET /api/reports/executive.pdf
 *
 * Streams a multi-audit "Executive Summary" PDF covering the requesting
 * user's most recent N completed audits. No share-token surface — this
 * report aggregates sensitive multi-period data and must be authenticated.
 *
 * Query params:
 *   - n: integer 1..12 (default 3) — how many recent audits to roll up.
 *
 * Rate-limit: 10 / 5 min per user (heavy render, expensive in cold path).
 *
 * Architecture:
 *   1. Resolve user → fetch their last N completed audits with the
 *      RLS-scoped server client. That's the only step that enforces
 *      isolation.
 *   2. With the audit ids in hand, use the admin client to fetch
 *      findings + comparisons + drivers + bill_lines for those audits.
 *      RLS is already satisfied by the prior SELECT.
 *   3. Hand to the pure builder, then lazy-import the renderer.
 */
import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';

import { trackServer } from '@/lib/analytics/events';
import { consumeRateLimit, rateLimitedResponse } from '@/lib/security/rate-limit';
import { getAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { buildExecutiveReport } from '@/reports/executive/builder';
import type {
  ExecutiveAuditRow,
  ExecutiveComparisonRow,
  ExecutiveDriverRow,
  ExecutiveFindingRow,
  ExecutiveLineRow,
} from '@/reports/executive/builder';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  n: z.coerce.number().int().min(1).max(12).default(3),
});

const AUDIT_COLUMNS =
  'id,carrier,billing_period_start,billing_period_end,total_charges_cents,account_count,line_count,finding_count,high_severity_count,estimated_monthly_savings_cents,estimated_annual_savings_cents,completed_at';

function ymd(d: Date): string {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function pdfFilename(userId: string, now: Date): string {
  return `carrieraudit-executive-${userId.slice(0, 8)}-${ymd(now)}.pdf`;
}

function pdfResponse(bytes: Uint8Array, filename: string): Response {
  const body = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${filename}"`,
      'Cache-Control': 'private, max-age=0, must-revalidate',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const parsedQuery = QuerySchema.safeParse({
    n: url.searchParams.get('n') ?? undefined,
  });
  if (!parsedQuery.success) {
    return NextResponse.json(
      { error: 'invalid_query', message: 'n must be an integer between 1 and 12.' },
      { status: 400 },
    );
  }
  const n = parsedQuery.data.n;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  // Heavy render — same rationale as the per-audit PDF: 10 / 5min keeps a
  // buggy client from pinning a worker on cache misses.
  const limited = await consumeRateLimit({
    key: `executive-pdf:${user.id}`,
    limit: 10,
    windowSeconds: 300,
  });
  if (!limited.ok) {
    return rateLimitedResponse(limited.resetAt);
  }

  // ── 1. Audits (RLS-scoped owner read) ─────────────────────────────
  const { data: auditsData, error: auditsErr } = await supabase
    .from('audits')
    .select(AUDIT_COLUMNS)
    .eq('status', 'completed')
    .order('completed_at', { ascending: false, nullsFirst: false })
    .limit(n)
    .returns<ExecutiveAuditRow[]>();
  if (auditsErr) {
    Sentry.captureException(auditsErr, {
      tags: { surface: 'executive_pdf.audits' },
    });
    return NextResponse.json({ error: 'Failed to load audits.' }, { status: 500 });
  }
  const audits = auditsData ?? [];
  const auditIds = audits.map((a) => a.id);

  // ── 2. Findings + comparisons + drivers + bill_lines (admin) ─────
  // RLS was already enforced by the user-scoped SELECT above. We use the
  // admin client here to avoid a chain of policy-checked joins on the
  // RPC path; this mirrors the pattern in the per-audit PDF route.
  let findings: ExecutiveFindingRow[] = [];
  let comparisons: ExecutiveComparisonRow[] = [];
  let drivers: ExecutiveDriverRow[] = [];
  let billLines: ExecutiveLineRow[] = [];

  if (auditIds.length > 0) {
    const admin = getAdminClient();
    const [findingsRes, comparisonsRes, linesRes] = await Promise.all([
      admin
        .from('findings')
        .select(
          'id,audit_id,rule_id,severity,title,description,recommended_action,estimated_monthly_savings_cents,confidence,affected_line_ids,affected_account_ids,evidence,status',
        )
        .in('audit_id', auditIds)
        .returns<ExecutiveFindingRow[]>(),
      admin
        .from('bill_comparisons')
        .select(
          'id,previous_audit_id,current_audit_id,previous_total_cents,current_total_cents,net_change_cents,percent_change_bps',
        )
        .in('current_audit_id', auditIds)
        .returns<ExecutiveComparisonRow[]>(),
      admin
        .from('bill_lines')
        .select('audit_id,cost_center,plan_base_cents')
        .in('audit_id', auditIds)
        .returns<ExecutiveLineRow[]>(),
    ]);

    const queryError = findingsRes.error ?? comparisonsRes.error ?? linesRes.error;
    if (queryError) {
      Sentry.captureException(queryError, {
        tags: { surface: 'executive_pdf.children' },
      });
      return NextResponse.json({ error: 'Failed to load report data.' }, { status: 500 });
    }
    findings = findingsRes.data ?? [];
    comparisons = comparisonsRes.data ?? [];
    billLines = linesRes.data ?? [];

    // Only fetch drivers if we actually have comparisons to attach them to.
    if (comparisons.length > 0) {
      const comparisonIds = comparisons.map((c) => c.id);
      const driversRes = await admin
        .from('bill_change_drivers')
        .select('id,bill_comparison_id,category,title,difference_cents,affected_lines_count')
        .in('bill_comparison_id', comparisonIds)
        .returns<ExecutiveDriverRow[]>();
      if (driversRes.error) {
        Sentry.captureException(driversRes.error, {
          tags: { surface: 'executive_pdf.drivers' },
        });
        return NextResponse.json({ error: 'Failed to load report data.' }, { status: 500 });
      }
      drivers = driversRes.data ?? [];
    }
  }

  const reportData = buildExecutiveReport({
    audits,
    findings,
    comparisons,
    drivers,
    billLines,
  });

  // Lazy-import the renderer so @react-pdf/renderer isn't dragged into
  // every cold start of this route.
  const { renderExecutivePdf } = await import('@/reports/executive/render');
  const now = new Date();
  const generatedOn = now.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  const buffer = await renderExecutivePdf(reportData, { generatedOn });
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  // Fire-and-forget analytics, matching the per-audit PDF route. We re-use
  // the existing `report_pdf_downloaded` event; the executive report is
  // logically a PDF download. A dedicated event would require adding to
  // the typed registry; we keep the surface narrow here.
  try {
    await trackServer(
      {
        name: 'report_pdf_downloaded',
        properties: { auditId: `executive:n=${n}`, isPublic: false },
      },
      user.id,
    );
  } catch {
    // Analytics must never delay or fail the response.
  }

  return pdfResponse(bytes, pdfFilename(user.id, now));
}
