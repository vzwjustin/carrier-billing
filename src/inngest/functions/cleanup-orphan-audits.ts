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
      // Subscription audits stuck in `pending` are still handled — they
      // simply do not flow through the refund path; manual reconciliation
      // is the right answer for them.
      const { data, error } = await supabase
        .from('audits')
        .select('id, user_id, created_at')
        .eq('status', 'pending')
        .eq('credit_consumed', true)
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

    return { processed: orphans.length };
  },
);
