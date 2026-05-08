import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';

import {
  AuditViewer,
  type AuditStatusPayload,
} from '@/components/audits/audit-viewer';
import { createClient } from '@/lib/supabase/server';

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
}

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
      'id,original_filename,status,carrier,line_count,account_count,total_charges_cents,billing_period_start,billing_period_end,estimated_monthly_savings_cents,estimated_annual_savings_cents,finding_count,high_severity_count,failure_reason',
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

      <AuditViewer auditId={data.id} initial={initial} />
    </div>
  );
}
