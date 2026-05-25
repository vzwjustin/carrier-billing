/**
 * /audits/[id]/autopsy
 *
 * Bill Increase Autopsy page. Server-renders the most recent stored
 * comparison for this audit (where it's the CURRENT side) and lets the
 * user pick a "previous" audit to compare against. The actual engine run
 * fires from a client component via POST /api/audits/[id]/autopsy.
 */

import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';

import { AutopsyClient } from '@/components/autopsy/autopsy-client';
import { createClient } from '@/lib/supabase/server';

export const metadata = {
  title: 'Bill Increase Autopsy — CarrierAudit',
};

export const dynamic = 'force-dynamic';

const ParamsSchema = z.object({ id: z.string().uuid() });

interface AuditRow {
  id: string;
  user_id: string;
  status: string;
  carrier: string | null;
  billing_period_start: string | null;
  billing_period_end: string | null;
  total_charges_cents: number | null;
  original_filename: string;
}

interface ComparisonRow {
  id: string;
  previous_audit_id: string;
  current_audit_id: string;
  previous_total_cents: number;
  current_total_cents: number;
  net_change_cents: number;
  percent_change_bps: number | null;
  disputable_cents: number;
  optimization_cents: number;
  unexplained_cents: number;
  executive_summary: string;
  created_at: string;
}

interface DriverRow {
  id: string;
  category: string;
  title: string;
  summary: string;
  previous_cents: number;
  current_cents: number;
  difference_cents: number;
  affected_lines_count: number;
  confidence: number;
  is_disputable: boolean;
  is_optimization: boolean;
  is_unexplained: boolean;
  recommended_action: string | null;
  evidence: Record<string, unknown>;
}

export default async function AutopsyPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const resolved = await params;
  const parsed = ParamsSchema.safeParse(resolved);
  if (!parsed.success) notFound();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: audit, error } = await supabase
    .from('audits')
    .select(
      'id,user_id,status,carrier,billing_period_start,billing_period_end,total_charges_cents,original_filename',
    )
    .eq('id', parsed.data.id)
    .maybeSingle<AuditRow>();
  if (error || !audit) notFound();
  if (audit.user_id !== user.id) notFound();
  if (audit.status !== 'completed') {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <h1 className="text-2xl font-semibold text-neutral-900">
          Bill Increase Autopsy
        </h1>
        <p className="text-sm text-neutral-600">
          This audit is not yet completed. The autopsy can only run between two
          completed audits.
        </p>
      </div>
    );
  }

  // Other completed audits the user owns — candidates for the "previous" side.
  // Show the 25 most recent excluding the current one. Each row is small;
  // a fuller picker (search, paging) can come later.
  const { data: candidatesRaw } = await supabase
    .from('audits')
    .select(
      'id,billing_period_start,billing_period_end,total_charges_cents,carrier,original_filename,completed_at',
    )
    .eq('status', 'completed')
    .neq('id', audit.id)
    .order('billing_period_end', { ascending: false, nullsFirst: false })
    .limit(25);
  const candidates = (candidatesRaw ?? []) as Array<{
    id: string;
    billing_period_start: string | null;
    billing_period_end: string | null;
    total_charges_cents: number | null;
    carrier: string | null;
    original_filename: string;
  }>;

  // Existing autopsy result, if any.
  const { data: existing } = await supabase
    .from('bill_comparisons')
    .select(
      'id,previous_audit_id,current_audit_id,previous_total_cents,current_total_cents,net_change_cents,percent_change_bps,disputable_cents,optimization_cents,unexplained_cents,executive_summary,created_at',
    )
    .eq('current_audit_id', audit.id)
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<ComparisonRow>();

  let drivers: DriverRow[] = [];
  if (existing) {
    const { data: driversData } = await supabase
      .from('bill_change_drivers')
      .select(
        'id,category,title,summary,previous_cents,current_cents,difference_cents,affected_lines_count,confidence,is_disputable,is_optimization,is_unexplained,recommended_action,evidence',
      )
      .eq('bill_comparison_id', existing.id);
    drivers = (driversData ?? []) as DriverRow[];
    drivers.sort(
      (a, b) => Math.abs(b.difference_cents) - Math.abs(a.difference_cents),
    );
  }

  return (
    <AutopsyClient
      audit={{
        id: audit.id,
        carrier: audit.carrier,
        billing_period_start: audit.billing_period_start,
        billing_period_end: audit.billing_period_end,
        total_charges_cents: audit.total_charges_cents,
        original_filename: audit.original_filename,
      }}
      candidates={candidates}
      existing={existing ?? null}
      drivers={drivers}
    />
  );
}
