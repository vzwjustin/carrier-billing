import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { ReportView } from '@/components/audits/report-view';
import { trackServer } from '@/lib/analytics/events';
import { getAdminClient } from '@/lib/supabase/admin';
import { buildReportData } from '@/reports/builder';
import type {
  ReportAccountRow,
  ReportAuditRow,
  ReportCreditRow,
  ReportData,
  ReportDppInstallmentRow,
  ReportFeatureRow,
  ReportFindingRow,
  ReportLineRow,
} from '@/reports/types';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Shared audit — CarrierAudit',
  robots: { index: false, follow: false },
};

const SEVERITY_RANK: Record<string, number> = {
  high: 0,
  medium: 1,
  low: 2,
  info: 3,
};

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
}

export default async function ShareReportPage({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<React.JSX.Element> {
  const { token } = await params;

  // Token sanity. We accept base64url which is at most 40 chars for 24 bytes,
  // but be permissive and just enforce a minimum to avoid trivial probing.
  if (typeof token !== 'string' || token.length < 16 || token.length > 128) {
    notFound();
  }

  // Public route — use the admin client so we don't require an auth cookie.
  // We still gate access by the share_token + completed status.
  const supabase = getAdminClient();
  const { data: audit, error } = await supabase
    .from('audits')
    .select(
      'id,status,carrier,line_count,account_count,total_charges_cents,billing_period_start,billing_period_end,estimated_monthly_savings_cents,estimated_annual_savings_cents,finding_count,high_severity_count,completed_at',
    )
    .eq('share_token', token)
    .maybeSingle<AuditRow>();

  if (error || !audit) {
    notFound();
  }

  if (audit.status !== 'completed') {
    notFound();
  }

  const auditId = audit.id;
  const [findingsRes, accountsRes, linesRes, featuresRes, creditsRes, dppRes] =
    await Promise.all([
      supabase
        .from('findings')
        .select(
          'id,rule_id,severity,title,description,recommended_action,estimated_monthly_savings_cents,confidence,affected_line_ids,affected_account_ids,evidence',
        )
        .eq('audit_id', auditId),
      supabase
        .from('bill_accounts')
        .select('id,audit_id,label,account_number_masked,total_charges_cents')
        .eq('audit_id', auditId),
      supabase
        .from('bill_lines')
        .select('id,audit_id,account_id')
        .eq('audit_id', auditId),
      supabase
        .from('bill_features')
        .select('id,line_id,audit_id')
        .eq('audit_id', auditId),
      supabase
        .from('bill_credits')
        .select('id,line_id,account_id,audit_id')
        .eq('audit_id', auditId),
      supabase
        .from('bill_dpp_installments')
        .select('id,line_id,audit_id')
        .eq('audit_id', auditId),
    ]);

  const findings = (findingsRes.data ?? []) as ReportFindingRow[];
  findings.sort((a, b) => {
    const ra = SEVERITY_RANK[a.severity] ?? 99;
    const rb = SEVERITY_RANK[b.severity] ?? 99;
    if (ra !== rb) return ra - rb;
    return b.estimated_monthly_savings_cents - a.estimated_monthly_savings_cents;
  });

  const auditRow: ReportAuditRow = {
    id: audit.id,
    carrier: audit.carrier,
    billing_period_start: audit.billing_period_start,
    billing_period_end: audit.billing_period_end,
    total_charges_cents: audit.total_charges_cents,
    account_count: audit.account_count,
    line_count: audit.line_count,
    finding_count: audit.finding_count,
    high_severity_count: audit.high_severity_count,
    estimated_monthly_savings_cents: audit.estimated_monthly_savings_cents,
    estimated_annual_savings_cents: audit.estimated_annual_savings_cents,
    completed_at: audit.completed_at,
  };

  const report: ReportData = buildReportData({
    audit: auditRow,
    findings,
    accounts: (accountsRes.data ?? []) as ReportAccountRow[],
    lines: (linesRes.data ?? []) as ReportLineRow[],
    features: (featuresRes.data ?? []) as ReportFeatureRow[],
    credits: (creditsRes.data ?? []) as ReportCreditRow[],
    dppInstallments: (dppRes.data ?? []) as ReportDppInstallmentRow[],
  });

  // Phase 5 analytics: fire `report_viewed` for the public share. The share
  // token serves as the anonymous distinctId — viewers aren't logged in.
  try {
    await trackServer(
      {
        name: 'report_viewed',
        properties: { auditId, isPublic: true },
      },
      token,
    );
  } catch {
    // ignore
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
          Wireless bill audit
        </h1>
        <p className="mt-1 text-sm text-neutral-600">
          Read-only shared report.
        </p>
      </div>
      <ReportView report={report} isPublic />
    </div>
  );
}
