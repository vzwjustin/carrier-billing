/**
 * Persist a fresh AutopsyResult to `bill_comparisons` + `bill_change_drivers`.
 * Idempotent: DELETE existing comparison for the (previous, current) pair
 * inside a transaction, then INSERT new. (Postgres doesn't expose a true
 * transaction over the Supabase REST client — we serialize via the unique
 * index `bill_comparisons_pair_uniq` and accept that a concurrent re-run
 * loser sees a 23505 unique-violation, which the API route translates to
 * "comparison already running, try again".)
 */

import * as Sentry from '@sentry/nextjs';

import { inngest } from '@/inngest/client';
import { getAdminClient } from '@/lib/supabase/admin';
import type { AutopsyResult } from './types';

export interface PersistComparisonInput {
  userId: string;
  previousAuditId: string;
  currentAuditId: string;
  result: AutopsyResult;
}

export interface PersistedComparison {
  id: string;
}

export class ComparisonAlreadyRunningError extends Error {
  constructor() {
    super('A comparison for this audit pair is already being generated.');
    this.name = 'ComparisonAlreadyRunningError';
  }
}

export async function persistComparison(
  input: PersistComparisonInput,
): Promise<PersistedComparison> {
  const admin = getAdminClient();

  // Clean any previous comparison for this pair so re-runs replace cleanly.
  // FK ON DELETE CASCADE drops the bill_change_drivers rows for us.
  const { error: delErr } = await admin
    .from('bill_comparisons')
    .delete()
    .eq('previous_audit_id', input.previousAuditId)
    .eq('current_audit_id', input.currentAuditId);
  if (delErr) {
    Sentry.captureException(delErr, {
      tags: { surface: 'autopsy.persist.delete' },
    });
    throw new Error(`failed to clear prior comparison: ${delErr.message}`);
  }

  const { data: inserted, error: insErr } = await admin
    .from('bill_comparisons')
    .insert({
      user_id: input.userId,
      previous_audit_id: input.previousAuditId,
      current_audit_id: input.currentAuditId,
      previous_total_cents: input.result.previous_total_cents,
      current_total_cents: input.result.current_total_cents,
      net_change_cents: input.result.net_change_cents,
      percent_change_bps: input.result.percent_change_bps,
      disputable_cents: input.result.disputable_cents,
      optimization_cents: input.result.optimization_cents,
      unexplained_cents: input.result.unexplained_cents,
      executive_summary: input.result.executive_summary,
      metadata: input.result.metadata,
    })
    .select('id')
    .single();
  if (insErr || !inserted) {
    if (insErr?.code === '23505') {
      // Lost the race against a concurrent re-run.
      throw new ComparisonAlreadyRunningError();
    }
    Sentry.captureException(insErr, {
      tags: { surface: 'autopsy.persist.insert' },
    });
    throw new Error(`failed to persist comparison: ${insErr?.message ?? 'unknown'}`);
  }

  if (input.result.drivers.length > 0) {
    const driverRows = input.result.drivers.map((d) => ({
      bill_comparison_id: inserted.id,
      category: d.category,
      title: d.title,
      summary: d.summary,
      previous_cents: d.previous_cents,
      current_cents: d.current_cents,
      difference_cents: d.difference_cents,
      affected_lines_count: d.affected_lines_count,
      confidence: d.confidence,
      is_disputable: d.is_disputable,
      is_optimization: d.is_optimization,
      is_unexplained: d.is_unexplained,
      recommended_action: d.recommended_action,
      evidence: d.evidence,
    }));
    const { error: driversErr } = await admin
      .from('bill_change_drivers')
      .insert(driverRows);
    if (driversErr) {
      // Roll back the parent comparison so we don't leave an orphan with
      // no drivers.
      await admin.from('bill_comparisons').delete().eq('id', inserted.id);
      Sentry.captureException(driversErr, {
        tags: { surface: 'autopsy.persist.drivers' },
      });
      throw new Error(`failed to persist change drivers: ${driversErr.message}`);
    }
  }

  // Fire `bill.comparison_persisted` so the Slack notifier (and any future
  // listener) can react. PII-safe: cents + counts + UUIDs only — no driver
  // titles, summaries, or evidence. The dispatcher decides whether to
  // notify based on the user's `slack_notify_on_autopsy` flag and the
  // disputable amount.
  //
  // Best-effort: an event-send failure must not block the persisted-
  // comparison response, since the rows are already in the DB.
  try {
    await inngest.send({
      id: `comparison-persisted-${inserted.id}`,
      name: 'bill.comparison_persisted',
      data: {
        comparisonId: inserted.id,
        userId: input.userId,
        previousAuditId: input.previousAuditId,
        currentAuditId: input.currentAuditId,
        disputableCents: input.result.disputable_cents,
        netChangeCents: input.result.net_change_cents,
        driversCount: input.result.drivers.length,
      },
    });
  } catch (sendErr) {
    Sentry.captureException(sendErr, {
      tags: { surface: 'autopsy.persist.event_send' },
      extra: { comparisonId: inserted.id },
    });
  }

  return { id: inserted.id };
}
