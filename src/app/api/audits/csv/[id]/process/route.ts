/**
 * POST /api/audits/csv/[id]/process — finalize a CSV import.
 *
 * After the wizard step 2 user picks a column mapping, this route:
 *   1. Validates ownership + audit state (`pending`, `source_format='csv'`).
 *   2. Consumes a credit if the user is on the credit plan (mirror of the
 *      PDF route's pre-pipeline gate).
 *   3. Downloads the uploaded CSV from storage.
 *   4. Parses it through `parseCsvToBill` with the supplied mapping.
 *   5. Persists the bill (accounts + lines + features/credits/dpp).
 *   6. Runs the rules engine and persists findings.
 *   7. Flips the audit to `completed` with aggregate counts.
 *
 * Per the brief: this route INLINES the persist-bill + rules + findings
 * flow rather than refactoring `src/inngest/functions/process-bill.ts`.
 * Inngest involvement for CSV can come later (Phase 6).
 *
 * Idempotency: this route is intentionally not retried by an Inngest
 * runner — it returns synchronously to the caller. We still status-guard
 * the transition (`pending → analyzing → completed`) so a duplicate POST
 * cannot double-charge or double-persist.
 *
 * PII discipline: every log line uses auditId/userId/counts only. Cell
 * values, mapping values, and bill content never leave this process.
 */

import { randomUUID } from 'node:crypto';

import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';

import { consumeAuditCreditForAudit } from '@/lib/access/decrement';
import { assertCanRunAudit } from '@/lib/access/gate';
import { dispatchAuditCompletedSideEffects } from '@/lib/audits/completed-side-effects';
import { loadParsedContractsForUser } from '@/lib/audits/load-parsed-contracts';
import { logTrailEvent } from '@/lib/audit-trail/log';
import { consumeRateLimit, rateLimitedResponse } from '@/lib/security/rate-limit';
import { getAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

import { parseCsvToBill } from '@/extraction/csv/parse';
import { ColumnMappingSchema } from '@/extraction/csv/mapping';
import type {
  ExtractedAccount,
  ExtractedBill,
} from '@/extraction/schema';
import { ALL_RULES } from '@/rules/registry';
import { runRules } from '@/rules/runner';
import type { Finding, RuleContext, Severity } from '@/rules/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ParamsSchema = z.object({ id: z.string().uuid() });

const BodySchema = z.object({
  mapping: ColumnMappingSchema,
});

type AuditRow = {
  id: string;
  user_id: string;
  status: string;
  storage_path: string;
  source_format: string;
};

function isAuditRow(value: unknown): value is AuditRow {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.user_id === 'string' &&
    typeof v.status === 'string' &&
    typeof v.storage_path === 'string' &&
    typeof v.source_format === 'string'
  );
}

type PersistBillResult = {
  accountIds: string[];
  /** lineIds[accountIdx][lineIdx] */
  lineIds: string[][];
};

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const params = await context.params;
  const paramsParsed = ParamsSchema.safeParse(params);
  if (!paramsParsed.success) {
    return NextResponse.json({ error: 'Invalid audit id.' }, { status: 400 });
  }
  const auditId = paramsParsed.data.id;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  const bodyParsed = BodySchema.safeParse(body);
  if (!bodyParsed.success) {
    return NextResponse.json(
      { error: 'Invalid mapping.' },
      { status: 400 },
    );
  }
  const mapping = bodyParsed.data.mapping;

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    }

    const limit = await consumeRateLimit({
      key: `audit-process-csv:${user.id}`,
      limit: 30,
      windowSeconds: 60 * 60,
    });
    if (!limit.ok) {
      return rateLimitedResponse(limit.resetAt);
    }

    // 1. Look up the audit and verify ownership + state.
    const admin = getAdminClient();
    const { data: rowData, error: fetchErr } = await admin
      .from('audits')
      .select('id,user_id,status,storage_path,source_format')
      .eq('id', auditId)
      .maybeSingle();
    if (fetchErr) {
      Sentry.captureException(fetchErr, {
        tags: { surface: 'audits.csv.process.fetch' },
        extra: { auditId, userId: user.id },
      });
      return NextResponse.json(
        { error: 'Failed to look up audit.' },
        { status: 500 },
      );
    }
    if (!rowData || !isAuditRow(rowData) || rowData.user_id !== user.id) {
      return NextResponse.json({ error: 'Audit not found.' }, { status: 404 });
    }
    if (rowData.source_format !== 'csv') {
      return NextResponse.json(
        { error: 'This audit is not a CSV import.' },
        { status: 400 },
      );
    }
    if (rowData.status !== 'pending') {
      return NextResponse.json(
        { error: `Audit is already ${rowData.status}.` },
        { status: 409 },
      );
    }

    // 2. Plan gate + credit consumption. Mirrors the PDF init route.
    const gate = await assertCanRunAudit(user.id);
    if (!gate.ok) {
      return NextResponse.json(
        {
          error: gate.reason === 'past_due' ? 'subscription_past_due' : 'no_plan',
          message:
            gate.reason === 'past_due'
              ? 'Your subscription is past due.'
              : 'No active plan or audit credits.',
        },
        { status: 402 },
      );
    }
    let creditConsumed = false;
    if (gate.reason === 'credit') {
      try {
        await consumeAuditCreditForAudit(user.id, auditId);
        creditConsumed = true;
      } catch (decrementErr) {
        Sentry.captureException(decrementErr, {
          tags: { surface: 'audits.csv.process.decrement' },
          extra: { auditId, userId: user.id },
        });
        return NextResponse.json(
          { error: 'no_plan', message: 'No audit credits available.' },
          { status: 402 },
        );
      }
    }

    // 3. Download CSV from storage. The bills bucket is private; service
    //    role bypasses RLS so the admin client is correct here.
    const download = await admin.storage
      .from('bills')
      .download(rowData.storage_path);
    if (download.error || !download.data) {
      await markFailed(admin, auditId, 'csv-download-failed');
      // System-fault → refund if we took a credit.
      if (creditConsumed) {
        await admin.rpc('refund_failed_audit', {
          p_audit_id: auditId,
          p_user_id: user.id,
        });
      }
      return NextResponse.json(
        { error: 'Could not read uploaded file.' },
        { status: 500 },
      );
    }
    const csvText = await download.data.text();

    // 4. Parse + validate.
    const parseRes = parseCsvToBill(csvText, mapping);
    if (!parseRes.ok) {
      await markFailed(admin, auditId, `csv-parse: ${parseRes.error}`);
      if (creditConsumed) {
        await admin.rpc('refund_failed_audit', {
          p_audit_id: auditId,
          p_user_id: user.id,
        });
      }
      return NextResponse.json({ error: parseRes.error }, { status: 400 });
    }
    const bill = parseRes.bill;
    const lineCount = bill.accounts.reduce<number>(
      (sum, a) => sum + a.lines.length,
      0,
    );
    if (lineCount === 0) {
      await markFailed(admin, auditId, 'no lines extracted');
      if (creditConsumed) {
        await admin.rpc('refund_failed_audit', {
          p_audit_id: auditId,
          p_user_id: user.id,
        });
      }
      return NextResponse.json(
        { error: 'CSV produced no lines.' },
        { status: 400 },
      );
    }

    // 5. Flip → analyzing (status-guarded). Mirrors process-bill.ts.
    const { data: analyzingRows, error: analyzingErr } = await admin
      .from('audits')
      .update({
        status: 'analyzing',
        carrier: bill.carrier,
        billing_period_start: bill.billing_period_start,
        billing_period_end: bill.billing_period_end,
        total_charges_cents: bill.total_charges_cents,
        account_count: bill.accounts.length,
        line_count: lineCount,
        page_count: 1,
        source_format: 'csv',
        updated_at: new Date().toISOString(),
      })
      .eq('id', auditId)
      .eq('status', 'pending')
      .select('id');
    if (analyzingErr || (analyzingRows ?? []).length === 0) {
      if (analyzingErr) {
        Sentry.captureException(analyzingErr, {
          tags: { surface: 'audits.csv.process.mark_analyzing' },
          extra: { auditId },
        });
      }
      // Lost the race or hard error — refund and bail.
      if (creditConsumed) {
        await admin.rpc('refund_failed_audit', {
          p_audit_id: auditId,
          p_user_id: user.id,
        });
      }
      return NextResponse.json(
        { error: 'Audit state changed during processing.' },
        { status: 409 },
      );
    }

    // 6. Persist bill child rows.
    let persisted: PersistBillResult;
    try {
      persisted = await persistBill(auditId, bill);
    } catch (persistErr) {
      Sentry.captureException(persistErr, {
        tags: { surface: 'audits.csv.process.persist_bill' },
        extra: { auditId },
      });
      await markFailed(admin, auditId, 'csv-persist-failed');
      if (creditConsumed) {
        await admin.rpc('refund_failed_audit', {
          p_audit_id: auditId,
          p_user_id: user.id,
        });
      }
      return NextResponse.json(
        { error: 'Failed to persist bill.' },
        { status: 500 },
      );
    }

    // 7. Run rules + translate indexes + persist findings.
    const loadedContracts = await loadParsedContractsForUser(user.id);
    const ctx: RuleContext = {
      bill,
      today: new Date(),
      carrier: bill.carrier,
      contracts: loadedContracts,
    };
    const ruleResult = await runRules(ctx, ALL_RULES);
    const findings = translatePerAccountLineIndexes(ruleResult.findings, bill);
    try {
      await persistFindings(auditId, findings, persisted);
    } catch (findingsErr) {
      Sentry.captureException(findingsErr, {
        tags: { surface: 'audits.csv.process.persist_findings' },
        extra: { auditId },
      });
      await markFailed(admin, auditId, 'csv-findings-persist-failed');
      if (creditConsumed) {
        await admin.rpc('refund_failed_audit', {
          p_audit_id: auditId,
          p_user_id: user.id,
        });
      }
      return NextResponse.json(
        { error: 'Failed to persist findings.' },
        { status: 500 },
      );
    }

    // 8. Flip → completed (status-guarded).
    const monthlySavings = findings.reduce<number>(
      (sum, f) => sum + (f.estimated_monthly_savings_cents ?? 0),
      0,
    );
    const highSeverityCount = findings.filter(
      (f) => f.severity === ('high' as Severity),
    ).length;
    const now = new Date().toISOString();
    const { data: completedRows, error: completedErr } = await admin
      .from('audits')
      .update({
        status: 'completed',
        completed_at: now,
        finding_count: findings.length,
        high_severity_count: highSeverityCount,
        estimated_monthly_savings_cents: monthlySavings,
        estimated_annual_savings_cents: monthlySavings * 12,
        updated_at: now,
      })
      .eq('id', auditId)
      .eq('status', 'analyzing')
      .select('id');
    if (completedErr || (completedRows ?? []).length === 0) {
      if (completedErr) {
        Sentry.captureException(completedErr, {
          tags: { surface: 'audits.csv.process.mark_completed' },
          extra: { auditId },
        });
      }
      return NextResponse.json(
        { error: 'Failed to finalize audit.' },
        { status: 500 },
      );
    }

    await dispatchAuditCompletedSideEffects({
      auditId,
      userId: user.id,
      carrier: bill.carrier,
      findingCount: findings.length,
      highSeverityCount,
      monthlySavingsCents: monthlySavings,
    });

    await logTrailEvent({ userId: user.id, eventType: 'audit_uploaded', entityType: 'audit', entityId: auditId, metadata: { source: 'csv', account_count: bill.accounts.length, line_count: lineCount, finding_count: findings.length }, actorEmail: user.email ?? null });

    return NextResponse.json({
      ok: true,
      auditId,
      accountCount: bill.accounts.length,
      lineCount,
      findingCount: findings.length,
    });
  } catch (err) {
    Sentry.captureException(err, { tags: { surface: 'audits.csv.process' } });
    return NextResponse.json(
      { error: 'Internal server error.' },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// Local copies of the persist / index-translate helpers.
//
// We deliberately don't import these from process-bill.ts — that module
// runs inside an Inngest worker and pulls a chain of inngest/contract
// imports that would couple this route to a worker-only surface. The
// duplication is intentional and called out in the file header.
// ---------------------------------------------------------------------------

async function persistBill(
  auditId: string,
  bill: ExtractedBill,
): Promise<PersistBillResult> {
  const supabase = getAdminClient();

  // Delete-then-insert for idempotent re-runs (e.g. a retry of process route).
  for (const table of [
    'bill_features',
    'bill_credits',
    'bill_dpp_installments',
    'bill_lines',
    'bill_accounts',
  ] as const) {
    const { error } = await supabase
      .from(table)
      .delete()
      .eq('audit_id', auditId);
    if (error) {
      throw new Error(`delete ${table} failed: ${error.message}`);
    }
  }

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
    const { error } = await supabase.from('bill_accounts').insert(accountRows);
    if (error) {
      throw new Error(`insert bill_accounts failed: ${error.message}`);
    }
  }

  type LineInsert = {
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
  };
  const lineRows: LineInsert[] = [];
  const lineOrigin: Array<{ accountIdx: number; lineIdx: number }> = [];
  bill.accounts.forEach((account, accountIdx) => {
    const accountRow = accountRows[accountIdx];
    if (!accountRow) return;
    account.lines.forEach((line, lineIdx) => {
      lineRows.push({
        id: randomUUID(),
        audit_id: auditId,
        account_id: accountRow.id,
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
      lineOrigin.push({ accountIdx, lineIdx });
    });
  });
  if (lineRows.length > 0) {
    const { error } = await supabase.from('bill_lines').insert(lineRows);
    if (error) {
      throw new Error(`insert bill_lines failed: ${error.message}`);
    }
  }

  // Build the per-account lineIds[][] structure for findings persistence.
  const lineIds: string[][] = bill.accounts.map((a) =>
    new Array<string>(a.lines.length),
  );
  lineRows.forEach((row, idx) => {
    const origin = lineOrigin[idx];
    if (!origin) return;
    const bucket = lineIds[origin.accountIdx];
    if (!bucket) return;
    bucket[origin.lineIdx] = row.id;
  });

  // CSV imports don't carry features / credits / DPP rows today — the
  // mapping surface is limited to per-line metadata. Leave them empty;
  // a future iteration of the wizard can add per-feature sub-tables.

  return {
    accountIds: accountRows.map((r) => r.id),
    lineIds,
  };
}

async function persistFindings(
  auditId: string,
  findings: Finding[],
  ids: PersistBillResult,
): Promise<void> {
  const supabase = getAdminClient();
  const { error: delErr } = await supabase
    .from('findings')
    .delete()
    .eq('audit_id', auditId);
  if (delErr) {
    throw new Error(`delete findings failed: ${delErr.message}`);
  }
  if (findings.length === 0) return;

  const flatLineIds: string[] = [];
  for (const bucket of ids.lineIds) {
    for (const id of bucket) flatLineIds.push(id);
  }

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

  const { error: insErr } = await supabase.from('findings').insert(rows);
  if (insErr) {
    throw new Error(`insert findings failed: ${insErr.message}`);
  }
}

/**
 * Per-account → global flat line-index translation (mirror of the helper in
 * process-bill.ts). Rules emit local-to-account indexes; persistFindings
 * resolves against a flattened list, so we translate before calling it.
 */
function translatePerAccountLineIndexes(
  findings: Finding[],
  bill: ExtractedBill,
): Finding[] {
  const accountLineCounts = bill.accounts.map(
    (a: ExtractedAccount) => a.lines.length,
  );
  const offsets: number[] = [];
  let running = 0;
  for (const n of accountLineCounts) {
    offsets.push(running);
    running += n;
  }

  return findings.map((f) => {
    if (f.affected_line_indexes.length === 0) return f;
    if (f.affected_account_indexes.length !== 1) {
      // Can't safely route — drop the line indexes.
      return { ...f, affected_line_indexes: [] };
    }
    const accountIdx = f.affected_account_indexes[0];
    if (
      typeof accountIdx !== 'number' ||
      accountIdx < 0 ||
      accountIdx >= accountLineCounts.length
    ) {
      return { ...f, affected_line_indexes: [], affected_account_indexes: [] };
    }
    const size = accountLineCounts[accountIdx] ?? 0;
    const offset = offsets[accountIdx] ?? 0;
    const out: number[] = [];
    for (const localIdx of f.affected_line_indexes) {
      if (typeof localIdx !== 'number' || localIdx < 0 || localIdx >= size) {
        continue;
      }
      out.push(offset + localIdx);
    }
    return { ...f, affected_line_indexes: out };
  });
}

async function markFailed(
  admin: ReturnType<typeof getAdminClient>,
  auditId: string,
  reason: string,
): Promise<void> {
  const trimmed = reason.length > 500 ? reason.slice(0, 500) : reason;
  const { error } = await admin
    .from('audits')
    .update({
      status: 'failed',
      failure_reason: trimmed,
      updated_at: new Date().toISOString(),
    })
    .eq('id', auditId)
    .in('status', ['pending', 'analyzing']);
  if (error) {
    Sentry.captureException(error, {
      tags: { surface: 'audits.csv.process.mark_failed' },
      extra: { auditId },
    });
  }
}

