import { inngest } from '../client';
import { ContractUploadedDataSchema, parseEventData } from '../events';
import { extractContract } from '@/contracts/extract';
import { logTrailEvent } from '@/lib/audit-trail/log';
import { getAdminClient } from '@/lib/supabase/admin';
import { scrubString } from '@/lib/observability/redact';

/**
 * process-contract Inngest function.
 *
 * Trigger: `contract.uploaded` with `{ contractId, userId, storagePath }`.
 *
 * Pipeline:
 *   1. mark-extracting:   guarded `pending → extracting` flip
 *   2. extract:           download PDF → extractContract() → returns ExtractedContract
 *   3. persist:           upsert header onto `contracts`, replace
 *                         `contract_terms` row, flip status to `parsed`
 *   4. on failure:        flip status to `failed` with a scrubbed failure_reason
 *
 * Mirrors `process-bill.ts` for status guards + side-effects in `step.run`,
 * but is simpler — there's no rules engine, no findings, no email.
 */

const FAILURE_REASON_MAX = 500;

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

export const processContractFn = inngest.createFunction(
  {
    id: 'process-contract',
    concurrency: { limit: 5 },
    retries: 2,
    timeouts: { finish: '10m' },
  },
  { event: 'contract.uploaded' },
  async ({ event, step, logger }) => {
    const { contractId, userId, storagePath } = parseEventData(
      'contract.uploaded',
      event.data,
      ContractUploadedDataSchema,
    );

    logger.info('processContract: start', {
      contractId,
      userId,
      runId: event.id,
    });

    try {
      // Step 1: mark-extracting. Same status-guard + ownership-recheck
      // pattern as process-bill mark-extracting.
      type MarkExtractingResult =
        | { proceed: true }
        | { proceed: false; reason: 'not-found' }
        | { proceed: false; reason: 'ownership-mismatch' }
        | { proceed: false; reason: 'already-advanced'; observedStatus: string };

      const markResult = (await step.run(
        'mark-extracting',
        async (): Promise<MarkExtractingResult> => {
          const supabase = getAdminClient();
          const { data: rowData, error: fetchErr } = await supabase
            .from('contracts')
            .select('id, user_id, status')
            .eq('id', contractId)
            .maybeSingle();
          if (fetchErr) {
            throw new Error(
              `contracts select (mark-extracting) failed: ${fetchErr.message}`,
            );
          }
          if (!rowData) return { proceed: false, reason: 'not-found' };
          const row = rowData as { id: string; user_id: string; status: string };
          if (row.user_id !== userId) {
            await supabase
              .from('contracts')
              .update({
                status: 'failed',
                failure_reason: 'ownership-mismatch',
                updated_at: new Date().toISOString(),
              })
              .eq('id', contractId);
            return { proceed: false, reason: 'ownership-mismatch' };
          }
          const { data: updatedRows, error: updErr } = await supabase
            .from('contracts')
            .update({
              status: 'extracting',
              updated_at: new Date().toISOString(),
            })
            .eq('id', contractId)
            .eq('status', 'pending')
            .select('id');
          if (updErr) {
            throw new Error(
              `contracts update (mark-extracting) failed: ${updErr.message}`,
            );
          }
          const affected = (updatedRows ?? []).length;
          if (affected === 0) {
            return {
              proceed: false,
              reason: 'already-advanced',
              observedStatus: row.status,
            };
          }
          return { proceed: true };
        },
      )) as MarkExtractingResult;

      if (!markResult.proceed) {
        logger.info('processContract: mark-extracting bailed', {
          contractId,
          reason: markResult.reason,
        });
        return { contractId, skipped: true, reason: markResult.reason };
      }

      // Step 2: extract. extractContract never throws into us — it returns
      // a tagged result. We translate `ok=false` into a thrown Error inside
      // step.run so Inngest retries up to the function's `retries: 2`.
      const extractResult = await step.run('extract', async () => {
        const supabase = getAdminClient();
        const download = await supabase.storage
          .from('contracts')
          .download(storagePath);
        if (download.error || !download.data) {
          throw new Error(
            `storage download failed: ${download.error?.message ?? 'no data'}`,
          );
        }
        const arrayBuffer = await download.data.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const result = await extractContract(buffer);
        if (!result.ok) {
          // Surface as a plain Error so the catch-block below marks the
          // contract failed. The error message is already scrubbed by
          // extractContract.
          throw new Error(`contract-extract: ${result.error}`);
        }
        return result.contract;
      });

      const contract = extractResult;

      // Step 3: persist. Upsert header onto `contracts`, replace any prior
      // contract_terms row, flip status to `parsed`.
      await step.run('persist', async () => {
        const supabase = getAdminClient();

        // (a) write header fields to the parent row
        const { error: updErr } = await supabase
          .from('contracts')
          .update({
            carrier: contract.header.carrier,
            ban_last4: contract.header.ban_last4,
            effective_date: contract.header.effective_date,
            expiration_date: contract.header.expiration_date,
            status: 'parsed',
            failure_reason: null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', contractId)
          .eq('status', 'extracting')
          .select('id');
        if (updErr) {
          throw new Error(`contracts update (persist) failed: ${updErr.message}`);
        }

        // (b) delete-then-insert contract_terms — idempotent on retry the
        // same way persist-bill is.
        const { error: delErr } = await supabase
          .from('contract_terms')
          .delete()
          .eq('contract_id', contractId);
        if (delErr) {
          throw new Error(
            `contract_terms delete (persist) failed: ${delErr.message}`,
          );
        }

        const { error: insErr } = await supabase.from('contract_terms').insert({
          contract_id: contractId,
          plan_name: contract.terms.plan_name,
          contracted_monthly_rate_cents:
            contract.terms.contracted_monthly_rate_cents,
          discount_percentage_bps: contract.terms.discount_percentage_bps,
          waived_fees: contract.terms.waived_fees,
          promo_credit_cents: contract.terms.promo_credit_cents,
          promo_duration_months: contract.terms.promo_duration_months,
          device_credit_terms: contract.terms.device_credit_terms,
          line_minimums: contract.terms.line_minimums,
          upgrade_fee_rules: contract.terms.upgrade_fee_rules,
          activation_fee_rules: contract.terms.activation_fee_rules,
          international_package_terms:
            contract.terms.international_package_terms,
          early_termination_terms: contract.terms.early_termination_terms,
          notes: contract.terms.notes,
        });
        if (insErr) {
          throw new Error(
            `contract_terms insert (persist) failed: ${insErr.message}`,
          );
        }
        return { ok: true };
      });

      await logTrailEvent({ userId, eventType: 'contract_uploaded', entityType: 'contract', entityId: contractId, metadata: { carrier: contract.header.carrier ?? null } });

      logger.info('processContract: parsed', { contractId });
      return { contractId, status: 'parsed' };
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : 'unknown error';
      const reason = truncate(scrubString(rawMessage), FAILURE_REASON_MAX);
      logger.error('processContract: failed', { contractId, reason });

      await step.run('mark-failed', async () => {
        const supabase = getAdminClient();
        // Only flip to `failed` from in-flight states — never stomp `parsed`.
        const { error } = await supabase
          .from('contracts')
          .update({
            status: 'failed',
            failure_reason: reason,
            updated_at: new Date().toISOString(),
          })
          .eq('id', contractId)
          .in('status', ['pending', 'extracting', 'failed']);
        if (error) {
          throw new Error(`contracts update (mark-failed) failed: ${error.message}`);
        }
        return { ok: true };
      });

      throw err;
    }
  },
);
