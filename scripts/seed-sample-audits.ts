/**
 * scripts/seed-sample-audits.ts
 *
 * Seeds three "sample audit" reports — one per carrier — that prospects can
 * view publicly from the landing page without signing up. Each fixture is
 * run through the real rules engine, so what visitors see is exactly what
 * a paying user would get for the same bill content.
 *
 * What this writes:
 *   - One `audits` row per carrier, status='completed', with stable share
 *     tokens (32 chars matching the share-route regex).
 *   - All child rows (bill_accounts, bill_lines, bill_features, bill_credits,
 *     bill_dpp_installments) — same shape the worker writes.
 *   - `findings` from a real run of ALL_RULES against the fixture bill.
 *
 * Usage:
 *   pnpm dlx tsx scripts/seed-sample-audits.ts
 *   pnpm dlx tsx scripts/seed-sample-audits.ts --owner-email tester@carrieraudit.dev
 *
 * Idempotency:
 *   Each fixture has a fixed audit UUID and a fixed share token. Re-running
 *   deletes the existing child rows and re-inserts, then upserts the audit.
 *   Safe to call from CI or a redeploy step.
 *
 * Output:
 *   Prints three share URLs you can paste into the landing page.
 */

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { loadDotEnvLocal } from './lib/env-loader';
import { ExtractedBillSchema, type ExtractedBill } from '@/extraction/schema';
import { ALL_RULES } from '@/rules/registry';
import { runRules } from '@/rules/runner';
import { translateLineIndexes } from '@/inngest/functions/process-bill';
import type { Finding } from '@/rules/types';

interface SampleSpec {
  /** Fixture base name under tests/fixtures/bills/ */
  fixture: string;
  /** Fixed audit row UUID. Re-running the script reuses this. */
  auditId: string;
  /** Fixed 32-char share token. Must match `[A-Za-z0-9_-]{32}`. */
  shareToken: string;
  /** Display filename surfaced in the report header. */
  originalFilename: string;
  /** Human description that won't appear in the report (just for our logs). */
  label: string;
}

const SAMPLES: SampleSpec[] = [
  {
    fixture: 'verizon-business-large',
    auditId: '00000000-0000-4000-8000-000000000001',
    // 32 chars; only [A-Za-z0-9_-]
    shareToken: 'verizon_business_large_sample_v1',
    originalFilename: 'Verizon-Business-Sample.pdf',
    label: 'Verizon Business — 25 lines, 2 accounts',
  },
  {
    fixture: 'att-business-multi-account',
    auditId: '00000000-0000-4000-8000-000000000002',
    shareToken: 'att_business_multi_account_2026_',
    originalFilename: 'ATT-Business-Sample.pdf',
    label: 'AT&T Business — multi-account',
  },
  {
    fixture: 'tmobile-business-large',
    auditId: '00000000-0000-4000-8000-000000000003',
    shareToken: 'tmobile_business_large_2026_demo',
    originalFilename: 'TMobile-Business-Sample.pdf',
    label: 'T-Mobile Business — large fleet',
  },
];

const FIXTURE_DIR = path.join(process.cwd(), 'tests', 'fixtures', 'bills');
const SHARE_TTL_YEARS = 75; // pin into year 2099 — these never auto-expire

// ──────────────────────────────────────────────────────────────────────────────
// CLI
// ──────────────────────────────────────────────────────────────────────────────

interface CliArgs {
  ownerEmail: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { ownerEmail: 'tester@carrieraudit.dev' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--owner-email' && argv[i + 1]) {
      out.ownerEmail = String(argv[i + 1]);
      i++;
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// Validation helpers
// ──────────────────────────────────────────────────────────────────────────────

function assertValidToken(token: string): void {
  if (token.length !== 32 || !/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error(
      `share token must be exactly 32 chars matching [A-Za-z0-9_-]: got ${token.length} chars: ${token}`,
    );
  }
}

function loadFixture(name: string): ExtractedBill {
  const file = path.join(FIXTURE_DIR, `${name}.expected.json`);
  const raw = readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw);
  // ExtractedBillSchema strips invalid fields and enforces shape.
  return ExtractedBillSchema.parse(parsed);
}

// ──────────────────────────────────────────────────────────────────────────────
// Persistence — duplicates the contract of process-bill.ts:persistBill but
// against a known auditId so we get stable child UUIDs each run.
// ──────────────────────────────────────────────────────────────────────────────

interface PersistedIds {
  accountIds: string[];
  /** Per-account nested line UUIDs, account-major. */
  lineIds: string[][];
}

async function persistBillRows(
  admin: SupabaseClient,
  auditId: string,
  bill: ExtractedBill,
): Promise<PersistedIds> {
  // Order matters — children first so FKs resolve on delete.
  for (const table of [
    'bill_features',
    'bill_credits',
    'bill_dpp_installments',
    'bill_lines',
    'bill_accounts',
  ] as const) {
    const { error } = await admin.from(table).delete().eq('audit_id', auditId);
    if (error) throw new Error(`delete ${table} failed: ${error.message}`);
  }

  // 1. Insert accounts with generated IDs we control.
  const accountRows = bill.accounts.map((account) => ({
    id: randomUUID(),
    audit_id: auditId,
    account_number_masked: account.account_number_last4,
    account_label: account.label,
    total_charges_cents: account.total_charges_cents,
    taxes_fees_cents: account.taxes_fees_cents,
    raw: account as unknown as Record<string, unknown>,
  }));
  if (accountRows.length > 0) {
    const { error } = await admin.from('bill_accounts').insert(accountRows);
    if (error) throw new Error(`insert bill_accounts failed: ${error.message}`);
  }

  // 2. Insert lines in account-major order, tracking origin for child rows.
  const lineRows: Array<{
    id: string;
    audit_id: string;
    account_id: string;
    mdn_masked: string | null;
    user_label: string | null;
    device_description: string | null;
    plan_name: string | null;
    plan_base_cents: number | null;
    data_used_gb: number | null;
    voice_used_min: number | null;
    sms_used_count: number | null;
    is_suspended: boolean;
    is_active_dpp: boolean;
    raw: Record<string, unknown>;
  }> = [];
  const lineOrigin: Array<{ accountIndex: number; lineIndex: number }> = [];

  bill.accounts.forEach((account, accountIndex) => {
    const accountId = accountRows[accountIndex]?.id;
    if (!accountId) throw new Error(`missing accountId for index ${accountIndex}`);
    account.lines.forEach((line, lineIndex) => {
      lineRows.push({
        id: randomUUID(),
        audit_id: auditId,
        account_id: accountId,
        mdn_masked: line.mdn_last4,
        user_label: line.user_label,
        device_description: line.device,
        plan_name: line.plan_name,
        plan_base_cents: line.plan_base_cents,
        data_used_gb: line.data_used_gb,
        voice_used_min: line.voice_used_min,
        sms_used_count: line.sms_used_count,
        is_suspended: line.is_suspended,
        is_active_dpp: line.dpp_installments.length > 0,
        raw: line as unknown as Record<string, unknown>,
      });
      lineOrigin.push({ accountIndex, lineIndex });
    });
  });

  if (lineRows.length > 0) {
    const { error } = await admin.from('bill_lines').insert(lineRows);
    if (error) throw new Error(`insert bill_lines failed: ${error.message}`);
  }

  // 3. Features / credits / dpp.
  const featureRows: Record<string, unknown>[] = [];
  const creditRows: Record<string, unknown>[] = [];
  const dppRows: Record<string, unknown>[] = [];

  lineRows.forEach((row, idx) => {
    const origin = lineOrigin[idx];
    if (!origin) return;
    const line = bill.accounts[origin.accountIndex]?.lines[origin.lineIndex];
    if (!line) return;
    for (const feature of line.features) {
      featureRows.push({
        line_id: row.id,
        audit_id: auditId,
        name: feature.name,
        category: feature.category,
        monthly_charge_cents: feature.monthly_cents,
      });
    }
    for (const credit of line.credits) {
      creditRows.push({
        line_id: row.id,
        account_id: null,
        audit_id: auditId,
        name: credit.name,
        monthly_amount_cents: credit.monthly_cents,
        expires_on: credit.expires_on,
        is_promo: credit.is_promo,
      });
    }
    for (const dpp of line.dpp_installments) {
      dppRows.push({
        line_id: row.id,
        audit_id: auditId,
        device_description: dpp.device,
        monthly_payment_cents: dpp.monthly_cents,
        remaining_payments: dpp.remaining_payments,
        total_payments: dpp.total_payments,
      });
    }
  });

  // 4. Account-level credits (no line_id).
  bill.accounts.forEach((account, accountIndex) => {
    const accountId = accountRows[accountIndex]?.id;
    if (!accountId) return;
    for (const credit of account.account_level_credits) {
      creditRows.push({
        line_id: null,
        account_id: accountId,
        audit_id: auditId,
        name: credit.name,
        monthly_amount_cents: credit.monthly_cents,
        expires_on: credit.expires_on,
        is_promo: credit.is_promo,
      });
    }
  });

  if (featureRows.length > 0) {
    const { error } = await admin.from('bill_features').insert(featureRows);
    if (error) throw new Error(`insert bill_features failed: ${error.message}`);
  }
  if (creditRows.length > 0) {
    const { error } = await admin.from('bill_credits').insert(creditRows);
    if (error) throw new Error(`insert bill_credits failed: ${error.message}`);
  }
  if (dppRows.length > 0) {
    const { error } = await admin.from('bill_dpp_installments').insert(dppRows);
    if (error) throw new Error(`insert bill_dpp_installments failed: ${error.message}`);
  }

  // 5. Build per-account nested line ID layout.
  const nestedLineIds: string[][] = bill.accounts.map((a) => new Array<string>(a.lines.length));
  lineRows.forEach((row, idx) => {
    const origin = lineOrigin[idx];
    if (!origin) return;
    const bucket = nestedLineIds[origin.accountIndex];
    if (!bucket) return;
    bucket[origin.lineIndex] = row.id;
  });

  return {
    accountIds: accountRows.map((r) => r.id),
    lineIds: nestedLineIds,
  };
}

async function persistFindings(
  admin: SupabaseClient,
  auditId: string,
  findings: Finding[],
  ids: PersistedIds,
): Promise<void> {
  const { error: delErr } = await admin.from('findings').delete().eq('audit_id', auditId);
  if (delErr) throw new Error(`delete findings failed: ${delErr.message}`);
  if (findings.length === 0) return;

  const flatLineIds: string[] = [];
  for (const bucket of ids.lineIds) for (const id of bucket) flatLineIds.push(id);

  const rows = findings.map((f) => {
    const lineUuids: string[] = [];
    for (const idx of f.affected_line_indexes) {
      const id = flatLineIds[idx];
      if (typeof id === 'string') lineUuids.push(id);
    }
    const accountUuids: string[] = [];
    for (const idx of f.affected_account_indexes) {
      const id = ids.accountIds[idx];
      if (typeof id === 'string') accountUuids.push(id);
    }
    return {
      audit_id: auditId,
      rule_id: f.rule_id,
      severity: f.severity,
      title: f.title,
      description: f.description,
      recommended_action: f.recommended_action,
      estimated_monthly_savings_cents: f.estimated_monthly_savings_cents,
      confidence: f.confidence,
      affected_line_ids: lineUuids,
      affected_account_ids: accountUuids,
      evidence: f.evidence as Record<string, unknown>,
    };
  });

  const { error: insErr } = await admin.from('findings').insert(rows);
  if (insErr) throw new Error(`insert findings failed: ${insErr.message}`);
}

// ──────────────────────────────────────────────────────────────────────────────
// Audit row upsert — completed state with stable share token
// ──────────────────────────────────────────────────────────────────────────────

async function upsertAuditRow(args: {
  admin: SupabaseClient;
  spec: SampleSpec;
  bill: ExtractedBill;
  ownerUserId: string;
  findings: Finding[];
}): Promise<void> {
  const { admin, spec, bill, ownerUserId, findings } = args;
  const lineCount = bill.accounts.reduce((sum, a) => sum + a.lines.length, 0);
  const monthlySavings = findings.reduce(
    (sum, f) => sum + (f.estimated_monthly_savings_cents ?? 0),
    0,
  );
  const annualSavings = monthlySavings * 12;
  const highSeverityCount = findings.filter((f) => f.severity === 'high').length;
  const expires = new Date(
    Date.UTC(new Date().getUTCFullYear() + SHARE_TTL_YEARS, 0, 1),
  ).toISOString();
  const now = new Date().toISOString();
  const storagePath = `${ownerUserId}/${spec.auditId}/${spec.originalFilename}`;

  const baseRow: Record<string, unknown> = {
    id: spec.auditId,
    user_id: ownerUserId,
    status: 'completed',
    storage_path: storagePath,
    original_filename: spec.originalFilename,
    carrier: bill.carrier,
    billing_period_start: bill.billing_period_start,
    billing_period_end: bill.billing_period_end,
    total_charges_cents: bill.total_charges_cents,
    account_count: bill.accounts.length,
    line_count: lineCount,
    finding_count: findings.length,
    high_severity_count: highSeverityCount,
    estimated_monthly_savings_cents: monthlySavings,
    estimated_annual_savings_cents: annualSavings,
    share_token: spec.shareToken,
    share_token_expires_at: expires,
    completed_at: now,
    updated_at: now,
    // file_size_bytes / page_count / source_format may not exist on older
    // schemas — fall back below if PostgREST rejects.
    file_size_bytes: 0,
    page_count: 1,
    source_format: 'pdf',
    credit_consumed: true,
  };

  // Use upsert keyed on id so re-running the script is idempotent.
  // Older deployments may be missing newer columns — strip them one at a time
  // and retry until the upsert succeeds or hits a non-schema error.
  const optionalCols = [
    'source_format',
    'page_count',
    'file_size_bytes',
    'credit_consumed',
    'share_token',
    'share_token_expires_at',
    'high_severity_count',
    'estimated_monthly_savings_cents',
    'estimated_annual_savings_cents',
  ];
  const stripped: Record<string, unknown> = { ...baseRow };
  const droppedCols = new Set<string>();
  let lastError: { code?: string; message?: string } | null = null;
  // Up to N retries (one per optional column).
  for (let attempt = 0; attempt <= optionalCols.length; attempt++) {
    const { error } = await admin.from('audits').upsert(stripped, { onConflict: 'id' });
    if (!error) {
      lastError = null;
      break;
    }
    lastError = error as { code?: string; message?: string };
    if (lastError.code !== 'PGRST204') break; // unrelated error — bail
    const msg = String(lastError.message ?? '');
    const offending = optionalCols.find((c) => msg.includes(c) && !droppedCols.has(c));
    if (!offending) break;
    delete stripped[offending];
    droppedCols.add(offending);
  }

  if (lastError) {
    throw new Error(`audits upsert failed: ${lastError.message}`);
  }

  // Re-apply share token via UPDATE if we had to strip it from the upsert
  // (we still need it for the public route to find the row). Try writing
  // both fields first; if the schema is missing share_token_expires_at,
  // fall back to writing just share_token.
  if (droppedCols.has('share_token')) {
    const candidate: Record<string, unknown> = { share_token: spec.shareToken };
    if (droppedCols.has('share_token_expires_at')) {
      candidate['share_token_expires_at'] = expires;
    }
    let upd = await admin.from('audits').update(candidate).eq('id', spec.auditId);
    if (
      upd.error &&
      (upd.error as { code?: string }).code === 'PGRST204' &&
      'share_token_expires_at' in candidate
    ) {
      delete candidate['share_token_expires_at'];
      upd = await admin.from('audits').update(candidate).eq('id', spec.auditId);
    }
    if (upd.error) {
      throw new Error(`audits update (share token) failed: ${upd.error.message}`);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────────

async function resolveOwnerUserId(
  admin: SupabaseClient,
  email: string,
): Promise<string> {
  const list = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (list.error) throw new Error(`listUsers failed: ${list.error.message}`);
  const found = list.data.users.find(
    (u) => (u.email ?? '').toLowerCase() === email.toLowerCase(),
  );
  if (!found) {
    throw new Error(
      `Owner user ${email} not found. Run scripts/create-test-user.ts first.`,
    );
  }
  return found.id;
}

async function main(): Promise<void> {
  const env = loadDotEnvLocal();
  const url = env['NEXT_PUBLIC_SUPABASE_URL'] ?? process.env['NEXT_PUBLIC_SUPABASE_URL'];
  const serviceKey =
    env['SUPABASE_SERVICE_ROLE_KEY'] ?? process.env['SUPABASE_SERVICE_ROLE_KEY'];
  const appUrl =
    env['NEXT_PUBLIC_APP_URL'] ?? process.env['NEXT_PUBLIC_APP_URL'] ?? 'http://localhost:3000';

  if (!url || !serviceKey) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local',
    );
  }

  const { ownerEmail } = parseArgs(process.argv.slice(2));
  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Sanity: all share tokens must match the route guard before any DB work.
  for (const spec of SAMPLES) assertValidToken(spec.shareToken);

  const ownerUserId = await resolveOwnerUserId(admin, ownerEmail);
  console.log(`[ok] owner user: ${ownerEmail} (${ownerUserId})`);

  for (const spec of SAMPLES) {
    console.log(`\n--- ${spec.label} (${spec.fixture})`);

    const bill = loadFixture(spec.fixture);

    // 1. Run rules first (no DB writes needed — bill is in-memory).
    const ruleResult = await runRules(
      { bill, today: new Date(), carrier: bill.carrier },
      ALL_RULES,
    );
    if (ruleResult.errors.length > 0) {
      console.warn(`    rule errors: ${JSON.stringify(ruleResult.errors)}`);
    }

    // 2. Translate per-account line indexes → flat indexes.
    const translated = translateLineIndexes(
      ruleResult.findings,
      bill,
      {
        auditId: spec.auditId,
        warn: (msg, ctx) => console.warn(`    [translate] ${msg}`, ctx ?? {}),
      },
    );

    // 3. Upsert the audit row FIRST so child-table FK references resolve.
    //    Children (bill_accounts, bill_lines, …) reference audits.id.
    await upsertAuditRow({
      admin,
      spec,
      bill,
      ownerUserId,
      findings: translated,
    });

    // 4. Persist bill rows (idempotent — delete + insert child tables).
    const ids = await persistBillRows(admin, spec.auditId, bill);
    console.log(
      `    persisted: ${ids.accountIds.length} accounts, ${ids.lineIds.reduce(
        (s, a) => s + a.length,
        0,
      )} lines`,
    );

    // 5. Persist findings (need bill_lines IDs in place for FK).
    await persistFindings(admin, spec.auditId, translated, ids);

    const monthlySavings = translated.reduce(
      (s, f) => s + (f.estimated_monthly_savings_cents ?? 0),
      0,
    );
    console.log(
      `    rules ran: ${translated.length} findings, $${(monthlySavings / 100).toFixed(2)}/mo savings`,
    );
    console.log(`    share URL: ${appUrl.replace(/\/+$/, '')}/share/${spec.shareToken}`);
  }

  console.log('\n[done] sample audits seeded. Public URLs above.');
}

main().catch((err) => {
  console.error('[fail]', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
