import { NextResponse } from 'next/server';
import { z } from 'zod';

import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
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
  pending: 'Queued',
  extracting: 'Reading PDF and extracting bill data',
  analyzing: 'Running audit rules',
  completed: 'Done',
  failed: 'Failed',
};

interface AuditStatusRow {
  status: string;
  carrier: string | null;
  line_count: number | null;
  total_charges_cents: number | null;
  failure_reason: string | null;
  account_count: number | null;
  billing_period_start: string | null;
  billing_period_end: string | null;
  estimated_monthly_savings_cents: number | null;
  estimated_annual_savings_cents: number | null;
  finding_count: number | null;
  high_severity_count: number | null;
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const params = await context.params;
  const parsed = ParamsSchema.safeParse(params);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid audit id.' }, { status: 400 });
  }

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    }

    const { data, error } = await supabase
      .from('audits')
      .select(
        'status,carrier,line_count,total_charges_cents,failure_reason,account_count,billing_period_start,billing_period_end,estimated_monthly_savings_cents,estimated_annual_savings_cents,finding_count,high_severity_count',
      )
      .eq('id', parsed.data.id)
      .maybeSingle<AuditStatusRow>();

    if (error) {
      return NextResponse.json(
        { error: 'Failed to look up audit.' },
        { status: 500 },
      );
    }
    if (!data) {
      return NextResponse.json({ error: 'Audit not found.' }, { status: 404 });
    }

    const status = data.status;
    const progress = STATUS_PROGRESS[status] ?? 0;
    const currentStep = STATUS_STEP[status] ?? status;

    return NextResponse.json({
      status,
      progress,
      currentStep,
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
    });
  } catch {
    return NextResponse.json(
      { error: 'Internal server error.' },
      { status: 500 },
    );
  }
}
