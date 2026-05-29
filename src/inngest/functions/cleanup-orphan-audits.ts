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
      // L9: filter to credit-bearing audits at the query layer. The RPC's
      // internal guard (0016) already refuses to refund subscription audits,
      // but enforcing the invariant in the query means
      //   - cleaner observability ("we refunded N" is unambiguous)
      //   - resilience to future column drift (a code path that sets
      //     credit_consumed=true on a sub audit would otherwise quietly
      //     mint a credit via this cron)
      // `retry_count=0` excludes retried audits: POST /api/audits/[id]/retry
      // resets a failed row to `pending` and bumps retry_count while
      // retaining the original created_at. Without this filter, a retried
      // credit audit still waiting on /start could be falsely refunded.
      const { data, error } = await supabase
        .from('audits')
        .select('id, user_id, created_at')
        .eq('status', 'pending')
        .eq('credit_consumed', true)
        .eq('retry_count', 0)
        .lt('created_at', cutoff);
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
    // clobbered. Same TTL cutoff applies.
    //
    // `retry_count=0` excludes retried audits: POST /api/audits/[id]/retry
    // resets a failed row to `pending` with credit_consumed=false (after a
    // system refund) or for subscription users, but bumps retry_count. Those
    // rows retain the original created_at and would otherwise be falsely
    // marked upload-not-finalized while the worker is re-enqueued.
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
        .eq('retry_count', 0)
        .lt('created_at', cutoff)
        .select('id');
      if (error) {
        throw new Error(
          `audits update (fail-subscription-orphans) failed: ${error.message}`,
        );
      }
      const count = (data ?? []).length;
      if (count > 0) {
        logger.info('cleanupOrphanAudits: failed subscription orphans', {
          count,
        });
      }
      return count;
    });

    return { processed: orphans.length, subscriptionOrphans: subOrphanCount };
  },
);
