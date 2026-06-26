import { inngest } from '../client';
import { getAdminClient } from '@/lib/supabase/admin';

/**
 * cleanup-orphan-audits — TTL safety net for the two-step upload flow.
 *
 * The upload flow is split: POST /api/audits creates the row + decrements
 * the credit, then a separate POST /api/audits/[id]/start triggers the
 * `bill.uploaded` Inngest event. If the user PUTs the file but never hits
 * /start (closes tab, network fail), the row sits in `status='pending'`
 * with the credit already gone. This job refunds and marks them failed.
 *
 * 30-minute TTL: long enough for slow uploads, short enough that orphans
 * don't accumulate.
 *
 * Idempotent: same orphan won't double-refund because the second run won't
 * find it in `pending` status.
 *
 * PII discipline (CLAUDE.md §1#9): logs only auditId, userId, counts.
 */

export const TTL_MINUTES = 30;

export type OrphanRow = {
  id: string;
  user_id: string;
  created_at: string;
  updated_at: string;
};

/**
 * Atomic refund + status-flip via the `refund_orphan_audit` Postgres RPC
 * (defined in supabase/migrations/0005_check_constraints_and_refund_rpc.sql).
 *
 * The RPC flips `status = 'failed'` gated on `status = 'pending'` and only
 * refunds the credit if the flip actually happened — both writes happen in a
 * single PL/pgSQL block. That makes the operation idempotent (a concurrent
 * /start that already advanced the row no-ops here, leaving the credit with
 * the user) and atomic (no partial state on retry).
 *
 * Errors are re-thrown so Inngest retries the step.
 *
 * Exported for unit testing — the production caller is `cleanupOrphanAuditsFn`
 * below.
 */
export async function refundOrphanAudit(
  supabase: ReturnType<typeof getAdminClient>,
  orphan: OrphanRow,
): Promise<void> {
  const { error: rpcError } = await supabase.rpc('refund_orphan_audit', {
    p_audit_id: orphan.id,
    p_user_id: orphan.user_id,
    p_reason: 'upload-not-finalized',
  });
  if (rpcError) {
    throw new Error(`refund_orphan_audit failed: ${rpcError.message}`);
  }
}

export const cleanupOrphanAuditsFn = inngest.createFunction(
  { id: 'cleanup-orphan-audits', retries: 1 },
  { cron: '*/15 * * * *' },
  async ({ step, logger }) => {
    const orphans = (await step.run('find-orphans', async () => {
      const supabase = getAdminClient();
      const cutoff = new Date(Date.now() - TTL_MINUTES * 60_000).toISOString();
      // Select all stale pending audits. The RPC is responsible for refunding
      // only credit_consumed rows; subscription-backed pending orphans still
      // need to be failed so they do not accumulate forever.
      // TTL is anchored on `updated_at`, not `created_at`. Retried audits
      // (POST /api/audits/[id]/retry) reset to `pending` and bump
      // `updated_at`, so the 30-minute window restarts from the retry — we
      // neither falsely refund a fresh retry nor strand a stuck one forever.
      const { data, error } = await supabase
        .from('audits')
        .select('id, user_id, created_at, updated_at')
        .eq('status', 'pending')
        .lt('updated_at', cutoff);
      if (error) {
        throw new Error(`audits select (find-orphans) failed: ${error.message}`);
      }
      return (data ?? []) as OrphanRow[];
    })) as OrphanRow[];

    logger.info('cleanupOrphanAudits: found orphans', { count: orphans.length });

    for (const orphan of orphans) {
      await step.run(`refund-and-fail-${orphan.id}`, async () => {
        const supabase = getAdminClient();
        await refundOrphanAudit(supabase, orphan);
        logger.info('cleanupOrphanAudits: refunded and failed', {
          auditId: orphan.id,
          userId: orphan.user_id,
        });
        return { ok: true };
      });
    }

    // L4: parallel sweep for subscription orphans. Subscription users never
    // consumed a credit (credit_consumed=false), so the refund RPC correctly
    // refuses to touch them — but that meant they accumulated in `pending`
    // forever, cluttering the audits list and skewing per-user counts. Flip
    // them to `failed` directly. No refund (nothing was spent), no Sentry
    // (this is a routine garbage-collect, not a system fault).
    //
    // Status-guarded UPDATE: only `pending` rows are touched, so a row that
    // advanced to `extracting` after the find-orphans select cannot be
    // clobbered. Same `updated_at` TTL cutoff as the credit sweep above.
    const subOrphanCount = await step.run('fail-subscription-orphans', async () => {
      const supabase = getAdminClient();
      const cutoff = new Date(Date.now() - TTL_MINUTES * 60_000).toISOString();
      const { data, error } = await supabase
        .from('audits')
        .update({
          status: 'failed',
          failure_reason: 'upload-not-finalized',
          updated_at: new Date().toISOString(),
        })
        .eq('status', 'pending')
        .eq('credit_consumed', false)
        .lt('updated_at', cutoff)
        .select('id');
      if (error) {
        throw new Error(`audits update (fail-subscription-orphans) failed: ${error.message}`);
      }
      const count = (data ?? []).length;
      if (count > 0) {
        logger.info('cleanupOrphanAudits: failed subscription orphans', {
          count,
        });
      }
      return count;
    });

    // #2 backstop: reclaim credits leaked when the synchronous CSV route
    // (no retrying worker) crashed between markFailed and its refund call,
    // leaving status='failed' + credit_consumed=true. refund_failed_audit is
    // idempotent and atomic (0034), so an already-refunded row (credit_consumed
    // now false) is not matched here and never double-refunds. TTL on
    // updated_at avoids racing a refund that's still in flight.
    const leakedRefunds = await step.run('refund-leaked-credits', async () => {
      const supabase = getAdminClient();
      const cutoff = new Date(Date.now() - TTL_MINUTES * 60_000).toISOString();
      const { data, error } = await supabase
        .from('audits')
        .select('id, user_id')
        .eq('status', 'failed')
        .eq('credit_consumed', true)
        .lt('updated_at', cutoff);
      if (error) {
        throw new Error(`audits select (refund-leaked-credits) failed: ${error.message}`);
      }
      const rows = (data ?? []) as Array<{ id: string; user_id: string }>;
      let refunded = 0;
      for (const row of rows) {
        const { error: rpcErr } = await supabase.rpc('refund_failed_audit', {
          p_audit_id: row.id,
          p_user_id: row.user_id,
        });
        if (rpcErr) {
          // 0034 raises on profile mismatch; log and continue so one bad row
          // doesn't wedge the whole sweep.
          logger.warn('cleanupOrphanAudits: refund_failed_audit error', {
            auditId: row.id,
          });
          continue;
        }
        refunded += 1;
      }
      if (refunded > 0) {
        logger.info('cleanupOrphanAudits: reclaimed leaked credits', { refunded });
      }
      return refunded;
    });

    // #8 backstop: finalize CSV audits stuck in 'analyzing' (the synchronous
    // route persisted bill + findings but the summary flip failed and there is
    // no worker to retry). Scoped to source_format='csv' because a CSV audit
    // only reaches 'analyzing' AFTER findings are persisted, so recomputing the
    // summary from the findings table is safe and preserves the user's report.
    // PDF audits are intentionally left to process-bill's own retry/refund path.
    const reclaimedAnalyzing = await step.run('complete-stuck-csv-analyzing', async () => {
      const supabase = getAdminClient();
      const cutoff = new Date(Date.now() - TTL_MINUTES * 60_000).toISOString();
      const { data, error } = await supabase
        .from('audits')
        .select('id')
        .eq('status', 'analyzing')
        .eq('source_format', 'csv')
        // O1: only reclaim CSV audits that were NOT handed to an Inngest worker
        // (synchronous CSV path leaves inngest_run_id NULL). Excludes any row a
        // worker might still be writing findings to, closing the narrow race
        // where the query-time finding_count recompute could read a partial
        // findings set while persist-findings is in flight.
        .is('inngest_run_id', null)
        .lt('updated_at', cutoff);
      if (error) {
        throw new Error(`audits select (complete-stuck-csv-analyzing) failed: ${error.message}`);
      }
      const rows = (data ?? []) as Array<{ id: string }>;
      let completed = 0;
      for (const row of rows) {
        const { data: fRows, error: fErr } = await supabase
          .from('findings')
          .select('severity, estimated_monthly_savings_cents')
          .eq('audit_id', row.id);
        if (fErr) {
          logger.warn('cleanupOrphanAudits: findings read failed', { auditId: row.id });
          continue;
        }
        const findings = (fRows ?? []) as Array<{
          severity: string;
          estimated_monthly_savings_cents: number | null;
        }>;
        const monthly = findings.reduce((s, f) => s + (f.estimated_monthly_savings_cents ?? 0), 0);
        const high = findings.filter((f) => f.severity === 'high').length;
        const now = new Date().toISOString();
        const { error: upErr } = await supabase
          .from('audits')
          .update({
            status: 'completed',
            completed_at: now,
            finding_count: findings.length,
            high_severity_count: high,
            estimated_monthly_savings_cents: monthly,
            estimated_annual_savings_cents: monthly * 12,
            updated_at: now,
          })
          .eq('id', row.id)
          .eq('status', 'analyzing');
        if (upErr) {
          logger.warn('cleanupOrphanAudits: complete stuck analyzing failed', {
            auditId: row.id,
          });
          continue;
        }
        completed += 1;
      }
      if (completed > 0) {
        logger.info('cleanupOrphanAudits: completed stuck CSV analyzing', { completed });
      }
      return completed;
    });

    return {
      processed: orphans.length,
      subscriptionOrphans: subOrphanCount,
      leakedRefunds,
      reclaimedAnalyzing,
    };
  },
);
