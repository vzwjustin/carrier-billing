import { inngest } from '../client';
import { getAdminClient } from '@/lib/supabase/admin';

/**
 * cleanup-expired-share-tokens — daily cron that revokes audit share tokens
 * past their `share_token_expires_at`.
 *
 * The read-side (`/api/audits/[id]/report.pdf` + `/share/[token]`) already
 * 404s on expired tokens, but leaving the row populated is two kinds of
 * footgun:
 *   1. A future code path that forgets the expiry check would treat the
 *      revoked link as live.
 *   2. The share_token column is indexed; growing the working set with
 *      logically-dead rows wastes index space over years of operation.
 *
 * The job runs nightly at 03:17 UTC (off the hour to avoid contending with
 * Stripe's hourly retries on `replay-billing-events`). Idempotent: a second
 * run within the same window finds zero rows to update.
 *
 * PII discipline (CLAUDE.md §1#9): logs only the row count, never the token
 * value or audit ids.
 */

export const cleanupExpiredShareTokensFn = inngest.createFunction(
  { id: 'cleanup-expired-share-tokens', retries: 1 },
  { cron: '17 3 * * *' },
  async ({ step, logger }) => {
    const result = await step.run('revoke-expired-tokens', async () => {
      const supabase = getAdminClient();
      // Use the cron's own clock (now()) rather than passing a JS-side
      // timestamp — keeps the comparison apples-to-apples with the read-side
      // expiry check and avoids skew between the worker host and Postgres.
      const { data, error } = await supabase
        .from('audits')
        .update({ share_token: null, share_token_expires_at: null })
        .not('share_token_expires_at', 'is', null)
        .lt('share_token_expires_at', new Date().toISOString())
        .select('id');
      if (error) {
        throw new Error(`cleanup-expired-share-tokens update failed: ${error.message}`);
      }
      return { revoked: data?.length ?? 0 };
    });

    logger.info('cleanupExpiredShareTokens: revoked expired tokens', result);
    return result;
  },
);
