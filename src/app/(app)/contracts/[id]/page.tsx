import { notFound } from 'next/navigation';
import { z } from 'zod';

import { TermsEditor } from '@/components/contracts/terms-editor';
import { createClient } from '@/lib/supabase/server';
import { formatIsoDateDisplay } from '@/lib/dates';
import { cn } from '@/lib/utils';

export const metadata = {
  title: 'Contract — CarrierAudit',
};

export const dynamic = 'force-dynamic';

const ParamsSchema = z.object({
  id: z.string().uuid(),
});

interface ContractRow {
  id: string;
  user_id: string;
  original_filename: string;
  carrier: string | null;
  ban_last4: string | null;
  effective_date: string | null;
  expiration_date: string | null;
  status: string;
  failure_reason: string | null;
  created_at: string;
}

interface ContractTermsRow {
  contract_id: string;
  plan_name: string | null;
  contracted_monthly_rate_cents: number | null;
  discount_percentage_bps: number | null;
  promo_credit_cents: number | null;
  promo_duration_months: number | null;
  device_credit_terms: string | null;
  line_minimums: number | null;
  upgrade_fee_rules: string | null;
  activation_fee_rules: string | null;
  international_package_terms: string | null;
  early_termination_terms: string | null;
  notes: string | null;
}

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-neutral-100 text-neutral-700',
  extracting: 'bg-blue-100 text-blue-700',
  parsed: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
};

const STATUS_LABELS: Record<string, string> = {
  pending: 'Queued',
  extracting: 'Extracting',
  parsed: 'Parsed',
  failed: 'Failed',
};

const CARRIER_LABELS: Record<string, string> = {
  verizon: 'Verizon',
  att: 'AT&T',
  tmobile: 'T-Mobile',
  unknown: 'Unknown',
};

export default async function ContractDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const resolved = await params;
  const parsed = ParamsSchema.safeParse(resolved);
  if (!parsed.success) {
    notFound();
  }
  const contractId = parsed.data.id;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    notFound();
  }

  const { data: contractData } = await supabase
    .from('contracts')
    .select(
      'id,user_id,original_filename,carrier,ban_last4,effective_date,expiration_date,status,failure_reason,created_at',
    )
    .eq('id', contractId)
    .maybeSingle<ContractRow>();
  if (!contractData) {
    notFound();
  }
  if (contractData.user_id !== user.id) {
    notFound();
  }

  const { data: termsData } = await supabase
    .from('contract_terms')
    .select(
      'contract_id,plan_name,contracted_monthly_rate_cents,discount_percentage_bps,promo_credit_cents,promo_duration_months,device_credit_terms,line_minimums,upgrade_fee_rules,activation_fee_rules,international_package_terms,early_termination_terms,notes',
    )
    .eq('contract_id', contractId)
    .maybeSingle<ContractTermsRow>();

  const initial = {
    plan_name: termsData?.plan_name ?? null,
    contracted_monthly_rate_cents: termsData?.contracted_monthly_rate_cents ?? null,
    discount_percentage_bps: termsData?.discount_percentage_bps ?? null,
    promo_credit_cents: termsData?.promo_credit_cents ?? null,
    promo_duration_months: termsData?.promo_duration_months ?? null,
    device_credit_terms: termsData?.device_credit_terms ?? null,
    line_minimums: termsData?.line_minimums ?? null,
    upgrade_fee_rules: termsData?.upgrade_fee_rules ?? null,
    activation_fee_rules: termsData?.activation_fee_rules ?? null,
    international_package_terms: termsData?.international_package_terms ?? null,
    early_termination_terms: termsData?.early_termination_terms ?? null,
    notes: termsData?.notes ?? null,
  };

  const statusCls =
    STATUS_STYLES[contractData.status] ?? 'bg-neutral-100 text-neutral-700';
  const statusLabel = STATUS_LABELS[contractData.status] ?? contractData.status;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight text-neutral-900">
              {contractData.original_filename}
            </h1>
            <p className="mt-1 text-sm text-neutral-500">
              Uploaded {formatIsoDateDisplay(contractData.created_at)}
            </p>
          </div>
          <span
            className={cn(
              'inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium',
              statusCls,
            )}
          >
            {statusLabel}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 rounded-lg border border-neutral-200 bg-white p-4 md:grid-cols-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
            Carrier
          </p>
          <p className="mt-1 text-sm text-neutral-900">
            {contractData.carrier
              ? (CARRIER_LABELS[contractData.carrier] ?? contractData.carrier)
              : '—'}
          </p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
            BAN (last 4)
          </p>
          <p className="mt-1 font-mono text-sm text-neutral-900">
            {contractData.ban_last4 ? `…${contractData.ban_last4}` : '—'}
          </p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
            Effective
          </p>
          <p className="mt-1 text-sm text-neutral-900">
            {formatIsoDateDisplay(contractData.effective_date)}
          </p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
            Expires
          </p>
          <p className="mt-1 text-sm text-neutral-900">
            {formatIsoDateDisplay(contractData.expiration_date)}
          </p>
        </div>
      </div>

      {contractData.status === 'failed' && contractData.failure_reason ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <p className="font-medium">Extraction failed</p>
          <p className="mt-1 break-words">{contractData.failure_reason}</p>
        </div>
      ) : null}

      {contractData.status === 'extracting' ? (
        <div className="rounded-md border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800">
          Extraction is in progress. Refresh the page in a moment to see the
          parsed terms.
        </div>
      ) : null}

      <div className="rounded-lg border border-neutral-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-neutral-900">
          Extracted terms
        </h2>
        <p className="mt-1 text-sm text-neutral-500">
          Edit any field below and save. These terms drive the
          contract-vs-bill audit rule.
        </p>
        <div className="mt-6">
          <TermsEditor
            contractId={contractId}
            initial={initial}
            canReextract={contractData.status !== 'extracting'}
          />
        </div>
      </div>
    </div>
  );
}
