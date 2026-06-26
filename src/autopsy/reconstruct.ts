/**
 * Reconstruct an `ExtractedBill` snapshot from the persisted DB rows of a
 * completed audit. The autopsy engine takes ExtractedBill on both sides;
 * keeping this reconstruction in one place means the comparison engine
 * never sees DB-shaped data and stays pure / unit-testable.
 *
 * What's lost in the round-trip:
 *   - The original `notes[]` (we don't persist them) — set to []
 *   - `confidence` (we don't persist it on audits) — set to undefined
 * These don't affect the autopsy: the engine doesn't consume either.
 */

import { ExtractedBillSchema, type ExtractedBill } from '@/extraction/schema';
import { getAdminClient } from '@/lib/supabase/admin';

interface AuditRow {
  carrier: string | null;
  billing_period_start: string | null;
  billing_period_end: string | null;
  total_charges_cents: number | null;
}

interface AccountRow {
  id: string;
  account_number_masked: string | null;
  account_label: string | null;
  total_charges_cents: number | null;
  taxes_fees_cents: number | null;
}

interface LineRow {
  id: string;
  account_id: string;
  mdn_masked: string | null;
  user_label: string | null;
  device_description: string | null;
  plan_name: string | null;
  plan_base_cents: number | null;
  data_used_gb: number | null;
  voice_used_min: number | null;
  sms_used_count: number | null;
  is_suspended: boolean | null;
}

interface FeatureRow {
  line_id: string;
  name: string;
  category: string | null;
  monthly_charge_cents: number;
}

interface CreditRow {
  line_id: string | null;
  account_id: string | null;
  name: string;
  monthly_amount_cents: number;
  expires_on: string | null;
  is_promo: boolean | null;
}

interface DppRow {
  line_id: string;
  device_description: string | null;
  monthly_payment_cents: number;
  remaining_payments: number | null;
  total_payments: number | null;
}

/**
 * Pull the audit + its bill_* rows and rebuild an ExtractedBill. Throws on
 * missing audit. Returns null if the audit hasn't completed and bill rows
 * don't exist yet.
 */
export async function reconstructExtractedBill(auditId: string): Promise<ExtractedBill | null> {
  const admin = getAdminClient();

  const [auditRes, accountsRes, linesRes, featuresRes, creditsRes, dppRes] = await Promise.all([
    admin
      .from('audits')
      .select('carrier,billing_period_start,billing_period_end,total_charges_cents')
      .eq('id', auditId)
      .maybeSingle<AuditRow>(),
    admin
      .from('bill_accounts')
      .select('id,account_number_masked,account_label,total_charges_cents,taxes_fees_cents')
      .eq('audit_id', auditId),
    admin
      .from('bill_lines')
      .select(
        'id,account_id,mdn_masked,user_label,device_description,plan_name,plan_base_cents,data_used_gb,voice_used_min,sms_used_count,is_suspended',
      )
      .eq('audit_id', auditId),
    admin
      .from('bill_features')
      .select('line_id,name,category,monthly_charge_cents')
      .eq('audit_id', auditId),
    admin
      .from('bill_credits')
      .select('line_id,account_id,name,monthly_amount_cents,expires_on,is_promo')
      .eq('audit_id', auditId),
    admin
      .from('bill_dpp_installments')
      .select('line_id,device_description,monthly_payment_cents,remaining_payments,total_payments')
      .eq('audit_id', auditId),
  ]);

  if (auditRes.error || !auditRes.data) return null;
  const audit = auditRes.data;
  if (
    !audit.billing_period_start ||
    !audit.billing_period_end ||
    audit.total_charges_cents === null
  ) {
    return null;
  }
  if (
    accountsRes.error ||
    linesRes.error ||
    featuresRes.error ||
    creditsRes.error ||
    dppRes.error
  ) {
    return null;
  }

  const accounts = (accountsRes.data ?? []) as AccountRow[];
  const lines = (linesRes.data ?? []) as LineRow[];
  const features = (featuresRes.data ?? []) as FeatureRow[];
  const credits = (creditsRes.data ?? []) as CreditRow[];
  const dpp = (dppRes.data ?? []) as DppRow[];

  // Group children by parent id for an O(1) lookup during reconstruction.
  const featuresByLine = bucketBy(features, (f) => f.line_id);
  const creditsByLine = bucketBy(
    credits.filter((c): c is CreditRow & { line_id: string } => c.line_id !== null),
    (c) => c.line_id,
  );
  const creditsByAccount = bucketBy(
    credits.filter((c): c is CreditRow & { account_id: string } => c.account_id !== null),
    (c) => c.account_id,
  );
  const dppByLine = bucketBy(dpp, (d) => d.line_id);
  const linesByAccount = bucketBy(lines, (l) => l.account_id);

  const carrier =
    audit.carrier && ['verizon', 'att', 'tmobile'].includes(audit.carrier)
      ? audit.carrier
      : 'unknown';

  const reconstructed: unknown = {
    carrier,
    billing_period_start: audit.billing_period_start,
    billing_period_end: audit.billing_period_end,
    total_charges_cents: audit.total_charges_cents,
    accounts: accounts.map((acc) => ({
      account_number_last4: last4FromMasked(acc.account_number_masked),
      label: acc.account_label,
      total_charges_cents: acc.total_charges_cents ?? 0,
      taxes_fees_cents: acc.taxes_fees_cents,
      account_level_credits: (creditsByAccount.get(acc.id) ?? []).map(creditRowToSchema),
      lines: (linesByAccount.get(acc.id) ?? []).map((line) => ({
        mdn_last4: last4FromMasked(line.mdn_masked),
        user_label: line.user_label,
        device: line.device_description,
        plan_name: line.plan_name,
        plan_base_cents: line.plan_base_cents,
        data_used_gb: line.data_used_gb,
        voice_used_min: line.voice_used_min,
        sms_used_count: line.sms_used_count,
        is_suspended: line.is_suspended ?? false,
        features: (featuresByLine.get(line.id) ?? []).map(featureRowToSchema),
        credits: (creditsByLine.get(line.id) ?? []).map(creditRowToSchema),
        dpp_installments: (dppByLine.get(line.id) ?? []).map(dppRowToSchema),
      })),
    })),
    notes: [],
  };

  // Parse through the schema so any persisted-but-stale data (an old enum
  // value, a missing field added by a later migration) blows up here
  // rather than downstream in the engine.
  return ExtractedBillSchema.parse(reconstructed);
}

function bucketBy<T, K>(items: T[], keyFn: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const k = keyFn(item);
    const bucket = out.get(k);
    if (bucket) bucket.push(item);
    else out.set(k, [item]);
  }
  return out;
}

function last4FromMasked(masked: string | null): string | null {
  if (!masked) return null;
  const m = /(\d{4})\D*$/.exec(masked);
  return m?.[1] ?? null;
}

function featureRowToSchema(row: FeatureRow): unknown {
  return {
    name: row.name,
    category: row.category ?? 'other',
    monthly_cents: row.monthly_charge_cents,
  };
}

function creditRowToSchema(row: CreditRow): unknown {
  return {
    name: row.name,
    monthly_cents: row.monthly_amount_cents,
    expires_on: row.expires_on,
    is_promo: row.is_promo ?? true,
  };
}

function dppRowToSchema(row: DppRow): unknown {
  return {
    device: row.device_description ?? 'Unknown device',
    monthly_cents: row.monthly_payment_cents,
    remaining_payments: row.remaining_payments,
    total_payments: row.total_payments,
  };
}
