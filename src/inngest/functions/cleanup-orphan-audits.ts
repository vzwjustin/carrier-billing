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

const TTL_MINUTES = 30;

type OrphanRow = {
  id: string;
  user_id: string;
  created_at: string;
};

export const cleanupOrphanAuditsFn = inngest.createFunction(
  { id: 'cleanup-orphan-audits', retries: 1 },
  { cron: '*/15 * * * *' },
  async ({ step, logger }) => {
    const orphans = (await step.run('find-orphans', async () => {
      const supabase = getAdminClient();
      const cutoff = new Date(Date.now() - TTL_MINUTES * 60_000).toISOString();
      const { data, error } = await supabase
        .from('audits')
        .select('id, user_id, created_at')
        .eq('status', 'pending')
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

        const { error: rpcError } = await supabase.rpc(
          'increment_audit_credits',
          { profile_id: orphan.user_id, delta: 1 },
        );
        if (rpcError) {
          throw new Error(
            `increment_audit_credits (refund) failed: ${rpcError.message}`,
          );
        }

        // Status guard: only fail rows still in `pending` so a concurrent
        // /start that flipped the row to `extracting` wins the race.
        const { error: updateError } = await supabase
          .from('audits')
          .update({
            status: 'failed',
            failure_reason: 'upload-not-finalized',
            updated_at: new Date().toISOString(),
          })
          .eq('id', orphan.id)
          .eq('status', 'pending');
        if (updateError) {
          throw new Error(
            `audits update (mark-failed) failed: ${updateError.message}`,
          );
        }

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
