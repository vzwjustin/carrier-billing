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
import { getAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ParamsSchema = z.object({ id: z.string().uuid() });

const AUDIT_COLUMNS =
  'id,user_id,status,carrier,billing_period_start,billing_period_end,total_charges_cents,account_count,line_count,finding_count,high_severity_count,estimated_monthly_savings_cents,estimated_annual_savings_cents,completed_at,share_token';

interface AuditFullRow extends ReportAuditRow {
  user_id: string;
  status: string;
  share_token: string | null;
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
  const token = url.searchParams.get('token');

  // ---- Resolve & authorize the audit ------------------------------------
  let audit: AuditFullRow | null = null;

  if (token) {
    const admin = getAdminClient();
    const { data, error } = await admin
      .from('audits')
      .select(AUDIT_COLUMNS)
      .eq('id', auditId)
      .eq('share_token', token)
      .maybeSingle<AuditFullRow>();
    if (error) {
      return NextResponse.json(
        { error: 'Failed to look up audit.' },
        { status: 500 },
      );
    }
    audit = data ?? null;
    if (!audit) {
      return NextResponse.json({ error: 'Audit not found.' }, { status: 404 });
    }
  } else {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    }
    const { data, error } = await supabase
      .from('audits')
      .select(AUDIT_COLUMNS)
      .eq('id', auditId)
      .maybeSingle<AuditFullRow>();
    if (error) {
      return NextResponse.json(
        { error: 'Failed to look up audit.' },
        { status: 500 },
      );
    }
    audit = data ?? null;
    if (!audit) {
      return NextResponse.json({ error: 'Audit not found.' }, { status: 404 });
    }
  }

  if (audit.status !== 'completed') {
    return NextResponse.json(
      { error: 'audit_not_completed' },
      { status: 409 },
    );
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

  // ---- Otherwise render fresh, persist, and return ----------------------
  const [accountsRes, linesRes, featuresRes, creditsRes, dppRes, findingsRes] =
    await Promise.all([
      admin
        .from('bill_accounts')
        .select('id,audit_id,label,account_number_masked,total_charges_cents')
        .eq('audit_id', auditId),
      admin
        .from('bill_lines')
        .select('id,audit_id,account_id')
        .eq('audit_id', auditId),
      admin
        .from('bill_features')
        .select('id,line_id,audit_id')
        .eq('audit_id', auditId),
      admin
        .from('bill_credits')
        .select('id,line_id,account_id,audit_id')
        .eq('audit_id', auditId),
      admin
        .from('bill_dpp_installments')
        .select('id,line_id,audit_id')
        .eq('audit_id', auditId),
      admin
        .from('findings')
        .select(
          'id,rule_id,severity,title,description,recommended_action,estimated_monthly_savings_cents,confidence,affected_line_ids,affected_account_ids,evidence',
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
    return NextResponse.json(
      { error: 'Failed to load audit data.' },
      { status: 500 },
    );
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
  const pdfBytes = new Uint8Array(
    pdfBuffer.buffer,
    pdfBuffer.byteOffset,
    pdfBuffer.byteLength,
  );

  // Best-effort cache write. If it fails we still return the rendered PDF.
  await admin.storage.from('reports').upload(storagePath, pdfBytes, {
    contentType: 'application/pdf',
    upsert: true,
  });

  await trackPdfDownload(auditId, audit.user_id, token);
  return pdfResponse(pdfBytes, auditId);
}

/**
 * Fire-and-forget analytics for a PDF download. Errors swallowed — the user
 * already has the PDF; analytics must never delay or fail the response.
 *
 * distinctId: the share token for public downloads, the user id otherwise.
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
      shareToken ?? userId,
    );
  } catch {
    // ignore
  }
}
