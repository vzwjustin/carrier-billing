import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';

import {
  AuditViewer,
  type AuditStatusPayload,
} from '@/components/audits/audit-viewer';
import { trackServer } from '@/lib/analytics/events';
import { createClient } from '@/lib/supabase/server';
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

export const metadata = {
  title: 'Audit — CarrierAudit',
};

export const dynamic = 'force-dynamic';

const ParamsSchema = z.object({
  id: z.string().uuid(),
});

const STATUS_PROGRESS: Record<string, number> = {
  pending: 5,
  extracting: 25,
  analyzing: 70,
  completed: 100,
  failed: 100,
};

const STATUS_STEP: Record<string, string> = {
  pending: 'Waiting to start',
  extracting: 'Extracting bill contents',
  analyzing: 'Analyzing for waste',
  completed: 'Done',
  failed: 'Failed',
};

interface AuditRow {
  id: string;
  original_filename: string;
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
  failure_reason: string | null;
  completed_at: string | null;
}

const SEVERITY_RANK: Record<string, number> = {
  high: 0,
  medium: 1,
  low: 2,
  info: 3,
};

export default async function AuditDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const resolved = await params;
  const parsed = ParamsSchema.safeParse(resolved);
  if (!parsed.success) {
    notFound();
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('audits')
    .select(
      'id,original_filename,status,carrier,line_count,account_count,total_charges_cents,billing_period_start,billing_period_end,estimated_monthly_savings_cents,estimated_annual_savings_cents,finding_count,high_severity_count,failure_reason,completed_at',
    )
    .eq('id', parsed.data.id)
    .maybeSingle<AuditRow>();

  if (error || !data) {
    notFound();
  }

  const initial: AuditStatusPayload = {
    status: data.status,
    progress: STATUS_PROGRESS[data.status] ?? 0,
    currentStep: STATUS_STEP[data.status] ?? data.status,
    carrier: data.carrier,
    line_count: data.line_count,
    account_count: data.account_count,
    total_charges_cents: data.total_charges_cents,
    billing_period_start: data.billing_period_start,
    billing_period_end: data.billing_period_end,
    estimated_monthly_savings_cents: data.estimated_monthly_savings_cents,
    estimated_annual_savings_cents: data.estimated_annual_savings_cents,
    finding_count: data.finding_count,
    high_severity_count: data.high_severity_count,
    failure_reason: data.failure_reason,
  };

  // For completed audits, fetch the rest of the report data.
  let report: ReportData | undefined;
  if (data.status === 'completed') {
    const auditId = parsed.data.id;
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
    // Pre-sort: severity asc rank, then savings desc. The builder also
    // sorts within severity buckets, but doing it here keeps DB ordering
    // deterministic for snapshot-friendly tests.
    findings.sort((a, b) => {
      const ra = SEVERITY_RANK[a.severity] ?? 99;
      const rb = SEVERITY_RANK[b.severity] ?? 99;
      if (ra !== rb) return ra - rb;
      return (
        b.estimated_monthly_savings_cents - a.estimated_monthly_savings_cents
      );
    });

    const auditRow: ReportAuditRow = {
      id: data.id,
      carrier: data.carrier,
      billing_period_start: data.billing_period_start,
      billing_period_end: data.billing_period_end,
      total_charges_cents: data.total_charges_cents,
      account_count: data.account_count,
      line_count: data.line_count,
      finding_count: data.finding_count,
      high_severity_count: data.high_severity_count,
      estimated_monthly_savings_cents: data.estimated_monthly_savings_cents,
      estimated_annual_savings_cents: data.estimated_annual_savings_cents,
      completed_at: data.completed_at,
    };

    report = buildReportData({
      audit: auditRow,
      findings,
      accounts: (accountsRes.data ?? []) as ReportAccountRow[],
      lines: (linesRes.data ?? []) as ReportLineRow[],
      features: (featuresRes.data ?? []) as ReportFeatureRow[],
      credits: (creditsRes.data ?? []) as ReportCreditRow[],
      dppInstallments: (dppRes.data ?? []) as ReportDppInstallmentRow[],
    });

    // Phase 5 analytics: fire `report_viewed` server-side. Resolve user from
    // the SSR auth client so we get a stable distinctId. Errors swallowed —
    // analytics must never break the report viewer.
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        await trackServer(
          {
            name: 'report_viewed',
            properties: { auditId, isPublic: false },
          },
          user.id,
        );
      }
    } catch {
      // ignore
    }
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <Link
            href="/audits"
            className="text-xs text-neutral-500 hover:text-neutral-900"
          >
            ← All audits
          </Link>
          <h1 className="mt-2 max-w-xl truncate text-2xl font-semibold tracking-tight text-neutral-900">
            {data.original_filename}
          </h1>
        </div>
      </div>

      <AuditViewer auditId={data.id} initial={initial} report={report} />
    </div>
  );
}
