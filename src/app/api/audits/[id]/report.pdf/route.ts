/**
 * GET /api/audits/[id]/report.pdf
 *
 * Streams the audit's PDF report. Supports two access modes:
 *  - Authenticated user (server client, RLS-scoped to owner)
 *  - Public via `?token=<share_token>` (admin client, bypasses RLS)
 *
 * Caches generated PDFs at `reports/{auditId}.pdf` in the private
 * `reports` bucket. The route always serves the bytes through Next —
 * never via a direct storage URL — so the bucket can stay private.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { trackServer } from '@/lib/analytics/events';
import { hashTokenForAnalytics } from '@/lib/analytics/hash';
import { buildReportData } from '@/reports/builder';
import type {
  ReportAccountRow,
  ReportAuditRow,
  ReportCreditRow,
  ReportDppInstallmentRow,
  ReportFeatureRow,
  ReportFindingRow,
  ReportLineRow,
} from '@/reports/types';
import * as Sentry from '@sentry/nextjs';
import {
  consumeRateLimit,
  rateLimitedResponse,
} from '@/lib/security/rate-limit';
import { getAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ParamsSchema = z.object({ id: z.string().uuid() });

const AUDIT_COLUMNS =
  'id,user_id,status,carrier,billing_period_start,billing_period_end,total_charges_cents,account_count,line_count,finding_count,high_severity_count,estimated_monthly_savings_cents,estimated_annual_savings_cents,completed_at,share_token,share_token_expires_at';

interface AuditFullRow extends ReportAuditRow {
  user_id: string;
  status: string;
  share_token: string | null;
  share_token_expires_at: string | null;
}

function isShareTokenExpired(expiresAt: string | null): boolean {
  // NULL on a row that already has a share_token means the token is
  // grandfathered (created before the expiry column existed). We treat that
  // as "still valid" so we don't break working public links on deploy.
  // For freshly-revoked rows, share_token is null already, which the caller
  // checks first.
  if (!expiresAt) return false;
  const ts = Date.parse(expiresAt);
  if (Number.isNaN(ts)) return false;
  return ts <= Date.now();
}

function pdfFilename(auditId: string): string {
  return `carrieraudit-${auditId.slice(0, 8)}.pdf`;
}

function pdfResponse(bytes: Uint8Array, auditId: string): Response {
  // ArrayBuffer is universally accepted by Response; avoids the
  // Uint8Array<ArrayBufferLike> vs BodyInit lib mismatch on newer @types/node.
  const body = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${pdfFilename(auditId)}"`,
      'Cache-Control': 'private, max-age=0, must-revalidate',
      // The public URL for this route can carry `?token=<share_token>`.
      // `no-referrer` keeps that token out of the Referer header on any
      // outbound navigation triggered from the PDF (e.g. clickable links).
      // Mirrors `next.config.ts` matcher; route headers win if they ever
      // diverge.
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

  // ---- Resolve & authorize the audit ------------------------------------
  let audit: AuditFullRow | null = null;

  if (rawToken && !token) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  if (token) {
    // L5: rate-limit the public token path on a hashed token derivative. The
    // PDF render is expensive on cache miss and the public surface is the
    // higher-risk one (no session cookie required). 10 reqs / 5 min per
    // token is far above any legitimate share-link usage and bounds the
    // worst-case render cost from a hostile burst.
    const limited = await consumeRateLimit({
      key: `audit-pdf-public:${hashTokenForAnalytics(token)}`,
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
      .maybeSingle<AuditFullRow>();
    // Public token surface — collapse all lookup failures (no row, transient
    // DB error) into a uniform 404. This matches `notFound()` shape used by
    // the share page and prevents differential leaks (e.g. "this audit id
    // exists, but the token is wrong" vs "lookup failed").
    if (error || !data) {
      return new NextResponse('Not found.', { status: 404 });
    }
    audit = data;
    // H11 — reject expired or revoked tokens. share_token already matched in
    // the query, but if it's been nulled out between SELECT planning and
    // execution we'd never get here; the expiry check catches the lifecycle
    // case where the row still has the token but the window has elapsed.
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
    // L5: rate-limit the authenticated path too. The user controls cache
    // misses indirectly (deleting the cache object would force a re-render
    // on next download), and a buggy client polling for the PDF would
    // otherwise pin a worker. 30 reqs / 5 min covers any sane user pattern.
    const limited = await consumeRateLimit({
      key: `audit-pdf-auth:${user.id}`,
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
      .maybeSingle<AuditFullRow>();
    if (error) {
      return NextResponse.json({ error: 'Failed to look up audit.' }, { status: 500 });
    }
    audit = data ?? null;
    if (!audit) {
      return NextResponse.json({ error: 'Audit not found.' }, { status: 404 });
    }
    if (audit.user_id !== user.id) {
      return NextResponse.json({ error: 'Audit not found.' }, { status: 404 });
    }
  }

  if (audit.status !== 'completed') {
    return NextResponse.json({ error: 'audit_not_completed' }, { status: 409 });
  }

  const admin = getAdminClient();
  const storagePath = `${auditId}.pdf`;

  // ---- Serve cached PDF if present --------------------------------------
  const cached = await admin.storage.from('reports').download(storagePath);
  if (cached.data) {
    const arrayBuf = await cached.data.arrayBuffer();
    await trackPdfDownload(auditId, audit.user_id, token);
    return pdfResponse(new Uint8Array(arrayBuf), auditId);
  }
  if (cached.error && cached.error.message !== 'The resource was not found') {
    Sentry.captureException(cached.error, {
      tags: { surface: 'report.pdf.cache_read' },
    });
  }

  // ---- Otherwise render fresh, persist, and return ----------------------
  const [accountsRes, linesRes, featuresRes, creditsRes, dppRes, findingsRes] = await Promise.all([
    admin
      .from('bill_accounts')
      .select('id,audit_id,account_label,account_number_masked,total_charges_cents')
      .eq('audit_id', auditId),
    admin.from('bill_lines').select('id,audit_id,account_id').eq('audit_id', auditId),
    admin.from('bill_features').select('id,line_id,audit_id').eq('audit_id', auditId),
    admin.from('bill_credits').select('id,line_id,account_id,audit_id').eq('audit_id', auditId),
    admin.from('bill_dpp_installments').select('id,line_id,audit_id').eq('audit_id', auditId),
    admin
      .from('findings')
      .select(
        'id,rule_id,severity,title,description,recommended_action,estimated_monthly_savings_cents,confidence,affected_line_ids,affected_account_ids,evidence,status',
      )
      .eq('audit_id', auditId),
  ]);

  const queryError =
    accountsRes.error ??
    linesRes.error ??
    featuresRes.error ??
    creditsRes.error ??
    dppRes.error ??
    findingsRes.error;
  if (queryError) {
    return NextResponse.json({ error: 'Failed to load audit data.' }, { status: 500 });
  }

  const reportData = buildReportData({
    audit,
    accounts: (accountsRes.data ?? []) as ReportAccountRow[],
    lines: (linesRes.data ?? []) as ReportLineRow[],
    features: (featuresRes.data ?? []) as ReportFeatureRow[],
    credits: (creditsRes.data ?? []) as ReportCreditRow[],
    dppInstallments: (dppRes.data ?? []) as ReportDppInstallmentRow[],
    findings: (findingsRes.data ?? []) as ReportFindingRow[],
  });

  // Lazy-import the renderer so the heavy @react-pdf/renderer dependency
  // is only loaded on the first cold cache miss for this route.
  const { renderReportPdf } = await import('@/reports/pdf/render');
  const pdfBuffer = await renderReportPdf(reportData);
  const pdfBytes = new Uint8Array(pdfBuffer.buffer, pdfBuffer.byteOffset, pdfBuffer.byteLength);

  // Best-effort cache write. If it fails we still return the rendered PDF —
  // but capture the failure (H9). Silently discarding the upload result meant
  // every subsequent download did a full cold render (DB query + heavy
  // @react-pdf/renderer pass) with no signal that the cache was broken.
  const cacheWrite = await admin.storage
    .from('reports')
    .upload(storagePath, pdfBytes, {
      contentType: 'application/pdf',
      upsert: true,
    });
  if (cacheWrite.error) {
    Sentry.captureException(cacheWrite.error, {
      tags: { surface: 'pdf.cache_write' },
      extra: { auditId, storagePath },
    });
    // L5: some upload failure modes leave a zero-byte/partial object
    // behind. A subsequent request would hit the cache path, download
    // the empty body, and serve a 0-byte PDF. Best-effort scrub so the
    // next miss re-renders cleanly. Swallow remove errors — the cache
    // is only an optimization.
    try {
      await admin.storage.from('reports').remove([storagePath]);
    } catch (removeErr) {
      Sentry.captureException(removeErr, {
        tags: { surface: 'pdf.cache_scrub' },
        extra: { auditId, storagePath },
      });
    }
  }

  await trackPdfDownload(auditId, audit.user_id, token);
  return pdfResponse(pdfBytes, auditId);
}

/**
 * Fire-and-forget analytics for a PDF download. Errors swallowed — the user
 * already has the PDF; analytics must never delay or fail the response.
 *
 * distinctId: hashed share token for public downloads, the user id otherwise.
 */
async function trackPdfDownload(
  auditId: string,
  userId: string,
  shareToken: string | null,
): Promise<void> {
  try {
    await trackServer(
      {
        name: 'report_pdf_downloaded',
        properties: { auditId, isPublic: shareToken !== null },
      },
      shareToken ? hashTokenForAnalytics(shareToken) : userId,
    );
  } catch {
    // ignore
  }
}
