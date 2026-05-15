import { randomUUID } from 'node:crypto';

import { inngest } from '../client';
import { getAdminClient } from '@/lib/supabase/admin';
import {
  runExtractionPipeline,
  PipelineError,
} from '@/extraction/pipeline';
import { runEdi811Pipeline, Edi811PipelineError } from '@/extraction/edi811/pipeline';
import { ExtractionError, redactDetails } from '@/extraction/llm';
import type {
  ExtractedBill,
  ExtractedAccount,
  ExtractedLine,
} from '@/extraction/schema';
import { runRules } from '@/rules/runner';
import { ALL_RULES } from '@/rules/registry';
import type { Finding, RuleContext, Severity } from '@/rules/types';
import { trackServer } from '@/lib/analytics/events';
import { BillUploadedDataSchema, parseEventData } from '../events';

/**
 * process-bill Inngest function (Phase 1 + Phase 2).
 *
 * Trigger: `bill.uploaded` event with `{ auditId, userId, storagePath }`.
 *
 * Pipeline:
 *   1. mark-extracting:   flip the audit row to status='extracting' + stash run id
 *   2. extract:           download PDF from storage, run the extraction pipeline,
 *                         return the parsed `ExtractedBill` (JSON-serializable so
 *                         it can cross step boundaries on retry)
 *   3. mark-analyzing:    persist top-level audit metadata + move status to 'analyzing'
 *   4. persist-bill:      delete + reinsert all child rows; returns generated UUIDs
 *                         in stable order. Delete-first makes the step idempotent.
 *   5. run-rules:         pure evaluation against the in-memory bill via @/rules
 *   6. persist-findings:  delete + reinsert findings (idempotent on retry); maps
 *                         rule-emitted indexes to the UUIDs from step 4
 *   7. mark-completed:    aggregate counts + savings, flip status to 'completed'
 *
 * Every step is idempotent so Inngest can retry safely.
 *
 * PII discipline (CLAUDE.md §1#9): we only ever log auditId/userId/step IDs and
 * generic counts. We never log raw bill content, employee names, phone numbers,
 * account numbers, or finding evidence.
 */

const FAILURE_REASON_MAX = 500;

/**
 * Hard wall on the extraction step. Inngest's per-function deadline is 15min;
 * we leave a 3-minute buffer so a hung OCR / LLM call doesn't fight the runner
 * for the function's overall deadline. On expiry the audit goes to `failed`
 * with reason `extraction-timeout` rather than getting stuck mid-pipeline.
 */
const EXTRACTION_TIMEOUT_MS = 12 * 60 * 1000;

class ExtractionTimeoutError extends Error {
  constructor(public readonly afterMs: number) {
    super(`extraction-timeout: exceeded ${afterMs}ms`);
    this.name = 'ExtractionTimeoutError';
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Convert a thrown error into a one-line `failure_reason` safe for the
 * `audits.failure_reason` column. Implements CLAUDE.md §1#9 (no PII in logs):
 *  - `ExtractionError.details` is passed through `redactDetails()` so any
 *    `raw`/`text`/`content` fields and digit-run substrings get scrubbed
 *    before they're rendered into the message string.
 *  - `PipelineError` surfaces its step label (safe — no bill content).
 *  - Everything else falls back to `err.message`.
 *
 * We never include `error.stack`. We never serialize raw extracted bills.
 */
function deriveFailureReason(err: unknown): string {
  if (err instanceof ExtractionTimeoutError) {
    return truncate(`extraction-timeout: ${err.afterMs}ms`, FAILURE_REASON_MAX);
  }
  if (err instanceof Edi811PipelineError) {
    // EDI errors don't carry raw bill content the way LLM errors do, but
    // truncate defensively so a giant zod issue can't blow the column.
    const stepLabel = typeof err.step === 'string' ? err.step : 'unknown';
    return truncate(`edi811:${stepLabel}: ${err.message}`, FAILURE_REASON_MAX);
  }
  if (err instanceof PipelineError) {
    // (M-E3) Encrypted PDFs get a distinct, user-actionable failure reason
    // so the UI can prompt for an unencrypted upload instead of showing
    // the generic "extraction failed" label.
    if (err.step === 'encrypted_pdf') {
      return truncate('encrypted-pdf', FAILURE_REASON_MAX);
    }
    // The pipeline wraps an inner ExtractionError as `.cause`; redact its
    // details before formatting in case the LLM bounced raw bill text into
    // a validation issue.
    const stepLabel = typeof err.step === 'string' ? err.step : 'unknown';
    let detailSuffix = '';
    if (err.cause instanceof ExtractionError && err.cause.details !== undefined) {
      try {
        const safe = redactDetails(err.cause.details);
        const json = JSON.stringify(safe);
        if (typeof json === 'string' && json.length > 0) {
          detailSuffix = ` ${json.slice(0, 200)}`;
        }
      } catch {
        // Redaction must never crash the failure path — drop the suffix.
      }
    }
    return truncate(
      `extraction:${stepLabel}: ${err.message}${detailSuffix}`,
      FAILURE_REASON_MAX,
    );
  }
  if (err instanceof ExtractionError) {
    let detailSuffix = '';
    if (err.details !== undefined) {
      try {
        const safe = redactDetails(err.details);
        const json = JSON.stringify(safe);
        if (typeof json === 'string' && json.length > 0) {
          detailSuffix = ` ${json.slice(0, 200)}`;
        }
      } catch {
        // intentional no-op
      }
    }
    return truncate(`${err.message}${detailSuffix}`, FAILURE_REASON_MAX);
  }
  if (err instanceof Error) {
    return truncate(err.message, FAILURE_REASON_MAX);
  }
  return 'Unknown failure';
}

/**
 * Race a promise against a timer. Used to wall the extraction step so a hung
 * OCR / LLM call cannot eat the whole 15-minute Inngest deadline.
 */
function withTimeout<T>(
  task: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_resolve, reject) => {
    handle = setTimeout(() => {
      reject(new ExtractionTimeoutError(ms));
    }, ms);
    // Avoid keeping the event loop alive on Node — Inngest workers are
    // long-lived but we don't want stray timers piling up across retries.
    if (
      typeof handle === 'object' &&
      handle !== null &&
      typeof (handle as { unref?: () => void }).unref === 'function'
    ) {
      (handle as { unref: () => void }).unref();
    }
  });
  return Promise.race<T>([
    task.finally(() => {
      if (handle) clearTimeout(handle);
    }),
    timer,
  ]).catch((err: unknown) => {
    // Tag the timeout origin so the failure reason is unambiguous in logs.
    if (err instanceof ExtractionTimeoutError) {
      // M7: preserve the original error's stack + chain via `.cause` so
      // Sentry breadcrumbs keep the deep frame. Allocating a fresh
      // `ExtractionTimeoutError` lets us prefix the label without
      // mutating the shared original error (which Promise.race could
      // surface to multiple callers).
      const tagged = new ExtractionTimeoutError(err.afterMs);
      tagged.message = `${label}: ${tagged.message}`;
      if (err.stack) {
        tagged.stack = err.stack;
      }
      (tagged as { cause?: unknown }).cause = err;
      throw tagged;
    }
    throw err;
  });
}

function isNotAWirelessBill(err: unknown): boolean {
  // (M-E4) The EDI 811 path raises an Edi811PipelineError whose message
  // includes "not a wireless bill" when the transaction set isn't 811. Treat
  // it identically to the LLM `not_a_wireless_bill` sentinel so users see the
  // same friendly failure regardless of upload format.
  if (err instanceof Edi811PipelineError) {
    return /not[_ ]a[_ ]wireless[_ ]bill/i.test(err.message);
  }
  if (!(err instanceof PipelineError)) return false;
  // The extraction layer surfaces this either via a `code` field or by wrapping
  // the LLM's `{error:'not_a_wireless_bill'}` sentinel into the message.
  const maybeCode = (err as unknown as { code?: unknown }).code;
  if (typeof maybeCode === 'string' && maybeCode === 'not_a_wireless_bill') {
    return true;
  }
  return /not[_ ]a[_ ]wireless[_ ]bill/i.test(err.message);
}

/**
 * H3: classify a failure for credit-refund purposes.
 *
 * User-fault failures (the bill itself was unprocessable for reasons the
 * user is best positioned to fix) do NOT refund the credit:
 *   - `not_a_wireless_bill` — uploaded something we can't audit.
 *   - `encrypted-pdf` — locked PDF; user must re-export an unlocked copy.
 *
 * System-fault failures (transient OCR/LLM/storage errors, timeouts,
 * empty-extraction edge cases) DO refund — the user should not pay for
 * the system's inability to complete the audit.
 *
 * `failure_reason` is the canonical input: it is the same redacted string
 * that lands in `audits.failure_reason`. Matching on it keeps the rule
 * surface narrow and easy to reason about.
 */
function isUserFaultFailure(failureReason: string): boolean {
  if (failureReason.startsWith('encrypted-pdf')) return true;
  if (
    /Document does not appear to be a US business wireless bill/i.test(
      failureReason,
    )
  ) {
    return true;
  }
  return false;
}

type ExtractionStepResult = {
  bill: ExtractedBill;
  pageCount: number;
  sizeBytes: number;
  neededOcr: boolean;
  /** Which ingest pipeline produced the bill — useful for log triage. */
  source: 'pdf' | 'edi811';
};

/**
 * Sniff the first bytes of an uploaded file to decide which pipeline to run.
 *
 * EDI 811 files start with the ASCII literal `ISA` (the X12 interchange
 * envelope). PDF files start with `%PDF-`. We branch on the buffer rather
 * than the filename so a confusingly-named EDI file (`.txt`/`.dat`) still
 * routes correctly, and a PDF mistakenly labelled `.edi` doesn't get fed
 * to the X12 parser.
 */
function isEdi811Buffer(buffer: Buffer): boolean {
  if (buffer.length < 3) return false;
  return buffer.slice(0, 3).toString('ascii') === 'ISA';
}

/**
 * Output of the persist-bill step. Returned (and therefore Inngest-cached)
 * so downstream steps can map rule-emitted 0-based indexes to UUIDs without
 * re-querying the DB.
 *
 * `lineIds[accountIdx][lineIdx]` is the id of the line at that position
 * inside `bill.accounts[accountIdx].lines[lineIdx]`.
 */
type PersistBillResult = {
  accountIds: string[];
  lineIds: string[][];
};

type RuleStepResult = {
  findings: Finding[];
  errors: Array<{ rule_id: string; message: string }>;
};

export const processBillFn = inngest.createFunction(
  {
    id: 'process-bill',
    concurrency: { limit: 5 },
    retries: 2,
    timeouts: { finish: '15m' },
  },
  { event: 'bill.uploaded' },
  async ({ event, step, logger }) => {
    // M11: Zod-parse the event payload before any handler logic touches it.
    // Inngest gives a TS-typed view but no runtime guarantee — a misshapen
    // payload from a replay tool or future SDK rev would otherwise crash
    // deep in the pipeline with a `Cannot read property` error.
    const { auditId, userId, storagePath } = parseEventData(
      'bill.uploaded',
      event.data,
      BillUploadedDataSchema,
    );

    logger.info('processBill: start', {
      auditId,
      userId,
      runId: event.id,
    });

    try {
      // ─────────────────────────────────────────────────────────────────────
      // Step 1: mark-extracting
      //
      // Three correctness concerns this step encodes:
      //
      //   (B3) Status guard. Only the `pending` → `extracting` transition is
      //   legal. If a duplicate trigger or a different runner already advanced
      //   the row, we bail out — we must not stomp on `failed`/`completed`/
      //   `extracting` rows. A 0-row update is the canonical signal here.
      //
      //   (I1) Ownership re-check. RLS isn't in play for service-role writes,
      //   so the worker re-validates that `event.data.userId` matches the
      //   audit's owner. A mismatched event payload is treated as a
      //   `failure_reason='ownership-mismatch'` and short-circuits the run.
      //
      //   We fetch first, branch on the row state, then issue the guarded
      //   update with `.select()` to read back the rows-affected count. The
      //   step returns a tagged status the outer fn uses to decide whether
      //   to continue or return early.
      // ─────────────────────────────────────────────────────────────────────
      type MarkExtractingResult =
        | { proceed: true }
        | { proceed: false; reason: 'not-found' }
        | { proceed: false; reason: 'ownership-mismatch' }
        | { proceed: false; reason: 'already-advanced'; observedStatus: string };

      const markResult = (await step.run(
        'mark-extracting',
        async (): Promise<MarkExtractingResult> => {
          const supabase = getAdminClient();

          // 1. Fetch the row (no filters except id) so we can distinguish
          //    "not found" / "wrong owner" / "already advanced" from each
          //    other for accurate failure reasons.
          const { data: rowData, error: fetchErr } = await supabase
            .from('audits')
            .select('id, user_id, status')
            .eq('id', auditId)
            .maybeSingle();
          if (fetchErr) {
            throw new Error(
              `audits select (mark-extracting) failed: ${fetchErr.message}`,
            );
          }
          if (!rowData) {
            return { proceed: false, reason: 'not-found' };
          }
          const row = rowData as { id: string; user_id: string; status: string };

          // 2. (I1) Ownership re-check. If the event payload's userId does
          //    not match the audit's owner, the event is bad — flip the row
          //    to failed so the user isn't left with a stuck audit. We don't
          //    return ownership info to the caller, so this is purely
          //    defense-in-depth on top of the route-level check.
          if (row.user_id !== userId) {
            const { error: ownErr } = await supabase
              .from('audits')
              .update({
                status: 'failed',
                failure_reason: 'ownership-mismatch',
                updated_at: new Date().toISOString(),
              })
              .eq('id', auditId);
            if (ownErr) {
              throw new Error(
                `audits update (ownership-mismatch) failed: ${ownErr.message}`,
              );
            }
            return { proceed: false, reason: 'ownership-mismatch' };
          }

          // 3. (B3) Status-guarded transition. `pending → extracting` only.
          //    If 0 rows are affected, another runner won the race and we
          //    bail without throwing — Inngest must not retry this run.
          const { data: updatedRows, error: updErr } = await supabase
            .from('audits')
            .update({
              status: 'extracting',
              inngest_run_id: event.id ?? null,
              updated_at: new Date().toISOString(),
            })
            .eq('id', auditId)
            .eq('status', 'pending')
            .select('id');
          if (updErr) {
            throw new Error(
              `audits update (mark-extracting) failed: ${updErr.message}`,
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
        // Bail out gracefully — another runner has it, or ownership/route
        // safety already handled this audit. We log enough to triage but
        // never re-throw, so Inngest does not retry.
        logger.info('processBill: mark-extracting bailed', {
          auditId,
          reason: markResult.reason,
        });
        return { auditId, skipped: true, reason: markResult.reason };
      }

      // ─────────────────────────────────────────────────────────────────────
      // Step 2: extract — does ALL buffer-based I/O in one step.
      // We collapse fetch-pdf + extract-text + carrier-detect + llm-extract
      // because Buffers aren't JSON-serializable across step boundaries.
      // The output of this step IS serializable.
      // ─────────────────────────────────────────────────────────────────────
      const extractResult = (await step.run('extract', async () => {
        const supabase = getAdminClient();
        const download = await supabase.storage
          .from('bills')
          .download(storagePath);
        if (download.error || !download.data) {
          throw new Error(
            `storage download failed: ${download.error?.message ?? 'no data'}`,
          );
        }
        const arrayBuffer = await download.data.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const sizeBytes = buffer.length;

        // (E5) Cap the extraction at EXTRACTION_TIMEOUT_MS (12 minutes).
        // The OCR fallback inside the pipeline polls Textract, which has been
        // observed to wedge on bad inputs; without a wall here, a single bad
        // bill would burn the entire 15-minute Inngest deadline before the
        // outer error handler could mark the audit failed. On expiry we
        // throw an ExtractionTimeoutError, which deriveFailureReason maps to
        // `extraction-timeout: <ms>ms` in `audits.failure_reason`.
        if (isEdi811Buffer(buffer)) {
          const pipeline = await withTimeout(
            runEdi811Pipeline({ buffer }),
            EXTRACTION_TIMEOUT_MS,
            'runEdi811Pipeline',
          );
          const result: ExtractionStepResult = {
            bill: pipeline.bill,
            // EDI files have no page concept; record 1 so the schema-bounded
            // page_count column gets a sensible value.
            pageCount: 1,
            sizeBytes,
            neededOcr: false,
            source: 'edi811',
          };
          return result;
        }
        const pipeline = await withTimeout(
          runExtractionPipeline({ buffer }),
          EXTRACTION_TIMEOUT_MS,
          'runExtractionPipeline',
        );
        const result: ExtractionStepResult = {
          bill: pipeline.bill,
          pageCount: pipeline.pageCount,
          sizeBytes,
          neededOcr: pipeline.neededOcr,
          source: 'pdf',
        };
        return result;
      })) as ExtractionStepResult;

      const { bill, pageCount, sizeBytes, neededOcr, source } = extractResult;
      const lineCount = bill.accounts.reduce<number>(
        (sum: number, a: ExtractedAccount) => sum + a.lines.length,
        0,
      );

      // CLAUDE.md §11 #12: schema allows accounts with empty `lines`, so guard
      // here. Plain Error → catch path → failure_reason='no lines extracted'.
      if (lineCount === 0) {
        throw new Error('no lines extracted');
      }

      logger.info('processBill: extraction ok', {
        auditId,
        carrier: bill.carrier,
        pageCount,
        accountCount: bill.accounts.length,
        lineCount,
        neededOcr,
        source,
      });

      // ─────────────────────────────────────────────────────────────────────
      // Step 3: mark-analyzing — persist audit-level summary
      //
      // (H6) Status-guarded transition. Mirror `mark-extracting` (L321):
      // the only legal source state here is `extracting`. If a delayed retry
      // observes the row already in `analyzing` or `completed` (because an
      // earlier run won the race), short-circuit and return — do NOT throw.
      // A throw would put Inngest into the catch-block which would, in turn,
      // try to mark the audit `failed` and clobber a successful terminal
      // state. A 0-rows-affected outcome means "lost the race", not "broken".
      // ─────────────────────────────────────────────────────────────────────
      type MarkAnalyzingResult =
        | { ok: true }
        | { ok: false; reason: 'status-guard' };
      const analyzingResult = (await step.run(
        'mark-analyzing',
        async (): Promise<MarkAnalyzingResult> => {
          const supabase = getAdminClient();
          const { data: rows, error } = await supabase
            .from('audits')
            .update({
              status: 'analyzing',
              carrier: bill.carrier,
              billing_period_start: bill.billing_period_start,
              billing_period_end: bill.billing_period_end,
              total_charges_cents: bill.total_charges_cents,
              account_count: bill.accounts.length,
              line_count: lineCount,
              page_count: pageCount,
              file_size_bytes: sizeBytes,
              source_format: source === 'edi811' ? 'edi_811' : 'pdf',
              updated_at: new Date().toISOString(),
            })
            .eq('id', auditId)
            .eq('status', 'extracting')
            .select('id');
          if (error) {
            throw new Error(
              `audits update (mark-analyzing) failed: ${error.message}`,
            );
          }
          const affected = (rows ?? []).length;
          if (affected === 0) {
            // Lost the status race. Drop a Sentry breadcrumb so the divergence
            // is visible during triage but never throw — a stale retry losing
            // the race is not an error condition.
            try {
              const Sentry = await import('@sentry/nextjs');
              Sentry.addBreadcrumb({
                category: 'process-bill',
                level: 'info',
                message: 'mark-analyzing status guard fired',
                data: { auditId },
              });
            } catch {
              // Sentry is optional in some environments.
            }
            return { ok: false, reason: 'status-guard' };
          }
          return { ok: true };
        },
      )) as MarkAnalyzingResult;

      if (!analyzingResult.ok) {
        logger.info('processBill: mark-analyzing bailed (status guard)', {
          auditId,
          reason: analyzingResult.reason,
        });
        return { auditId, skipped: true, reason: analyzingResult.reason };
      }

      // ─────────────────────────────────────────────────────────────────────
      // Step 4: persist-bill — delete-then-insert all child rows.
      // Idempotent across retries because the delete fully resets prior state.
      // Returns the inserted UUIDs in stable order so downstream steps can
      // resolve rule-finding indexes (which are 0-based positions) to ids.
      // ─────────────────────────────────────────────────────────────────────
      const persistResult = (await step.run('persist-bill', async () => {
        const ids = await persistBill(auditId, bill);
        const result: PersistBillResult = {
          accountIds: ids.accountIds,
          lineIds: ids.lineIds,
        };
        return result;
      })) as PersistBillResult;

      // ─────────────────────────────────────────────────────────────────────
      // Step 5: run-rules — pure function over the in-memory ExtractedBill.
      // The `bill` is already in scope from `extract`, so this step is
      // deterministic + fast. Per-rule errors are captured and surfaced; they
      // don't fail the audit. (CLAUDE.md §6 Phase 2 task #2.)
      // ─────────────────────────────────────────────────────────────────────
      const ruleResult = (await step.run('run-rules', async () => {
        const ctx: RuleContext = {
          bill,
          today: new Date(),
          carrier: bill.carrier,
        };
        const out = await runRules(ctx, ALL_RULES);
        const r: RuleStepResult = {
          findings: out.findings,
          errors: out.errors,
        };
        return r;
      })) as RuleStepResult;

      const findings = ruleResult.findings;
      const ruleErrors = ruleResult.errors;

      logger.info('processBill: rules ran', {
        auditId,
        findingCount: findings.length,
        ruleErrorCount: ruleErrors.length,
      });

      // (B1) Translate per-account line indexes to global flat indexes
      // before handing findings to persistFindings (see translateLineIndexes
      // below for the full rationale). H5: collect drop stats so the
      // persist-findings breadcrumb can surface aggregate visibility — a
      // dropped index leaves a finding with empty affected_line_indexes,
      // which renders in the report as a "Potential saving" with no
      // affected lines listed. Without observability that looks like a
      // rule bug to support staff.
      const indexStats: IndexTranslationStats = {
        droppedLineIndexes: 0,
        findingsWithDroppedAccount: 0,
      };
      const translatedFindings = translateLineIndexes(
        findings,
        bill,
        {
          auditId,
          warn: (msg, ctx) => logger.warn(msg, ctx),
        },
        indexStats,
      );

      // ─────────────────────────────────────────────────────────────────────
      // Step 6: persist-findings — delete-then-insert for idempotent retries.
      //
      // (B5) Finding-linkage on Inngest retry. `persistResult` here is the
      // output of `step.run('persist-bill', …)` — Inngest caches step
      // outputs across retries, so even if the worker is replayed after a
      // failure later in the pipeline, this closure observes the SAME
      // accountIds + lineIds the persist-bill step actually committed to the
      // database. (If persist-bill itself was re-run, its delete-then-insert
      // produced new UUIDs and Inngest cached those new ids; we then map
      // findings against that latest committed set.) The closure capture is
      // safe; do not refactor this to re-read accountIds from the DB.
      // ─────────────────────────────────────────────────────────────────────
      await step.run('persist-findings', async () => {
        await persistFindings(auditId, translatedFindings, persistResult);
        // H5: surface drop counts as a Sentry breadcrumb. Always emit (even
        // at 0) so absence in Sentry === query-related issue, not normal
        // operation.
        try {
          const Sentry = await import('@sentry/nextjs');
          if (
            indexStats.droppedLineIndexes > 0 ||
            indexStats.findingsWithDroppedAccount > 0
          ) {
            Sentry.addBreadcrumb({
              category: 'rules',
              level: 'warning',
              message: 'index_translation_drops',
              data: {
                auditId,
                droppedLineIndexes: indexStats.droppedLineIndexes,
                findingsWithDroppedAccount:
                  indexStats.findingsWithDroppedAccount,
                findingCount: findings.length,
              },
            });
          }
          if (ruleErrors.length > 0) {
            Sentry.addBreadcrumb({
              category: 'rules',
              level: 'warning',
              message: 'rule_evaluation_errors',
              data: {
                auditId,
                count: ruleErrors.length,
                rule_ids: ruleErrors.map((e) => e.rule_id),
              },
            });
            Sentry.captureMessage('rule_evaluation_errors', {
              level: 'warning',
              extra: {
                auditId,
                errors: ruleErrors,
              },
            });
          }
        } catch {
          // Sentry is optional in some environments; never let telemetry
          // failure block the pipeline.
        }
        return { ok: true, inserted: findings.length };
      });

      // ─────────────────────────────────────────────────────────────────────
      // Step 7: mark-completed — aggregate totals + flip status.
      //
      // (H7) Status-guarded transition. Mirror mark-analyzing (L474–509):
      // only the `analyzing → completed` transition is legal. A retried run
      // where the step.run DB write succeeded but the step threw before
      // returning will re-execute this block; without a guard the update
      // overwrites aggregate columns and resets completed_at. 0 rows
      // affected means we lost the race — bail without throwing so Inngest
      // does not treat the retry as a failure.
      // ─────────────────────────────────────────────────────────────────────
      const markCompletedResult = await step.run('mark-completed', async () => {
        const findingCount = findings.length;
        const highSeverityCount = findings.filter(
          (f) => f.severity === ('high' as Severity),
        ).length;
        const monthlySavings = findings.reduce<number>(
          (sum, f) => sum + (f.estimated_monthly_savings_cents ?? 0),
          0,
        );
        const annualSavings = monthlySavings * 12;
        const now = new Date().toISOString();

        const supabase = getAdminClient();
        const { data: rows, error } = await supabase
          .from('audits')
          .update({
            status: 'completed',
            completed_at: now,
            finding_count: findingCount,
            high_severity_count: highSeverityCount,
            estimated_monthly_savings_cents: monthlySavings,
            estimated_annual_savings_cents: annualSavings,
            updated_at: now,
          })
          .eq('id', auditId)
          .eq('status', 'analyzing')
          .select('id');
        if (error) {
          throw new Error(
            `audits update (mark-completed) failed: ${error.message}`,
          );
        }
        if ((rows ?? []).length === 0) {
          // Lost the status race — another runner already completed or failed
          // this audit. Do not throw; the audit is in a terminal state.
          return { ok: false as const, reason: 'status-guard' as const };
        }
        return { ok: true as const };
      });

      // M5: if mark-completed lost the status race, another runner already
      // owns the completion (and therefore the downstream PostHog event +
      // `audit.completed` Inngest send). Short-circuit so we don't double-
      // emit analytics. The send-trigger step is still safe under retry
      // (dedupe key `${auditId}-completed`), but PostHog has no such guard.
      if (markCompletedResult.ok === false) {
        logger.info('processBill: mark-completed lost race; skipping downstream', {
          auditId,
        });
        return {
          auditId,
          carrier: bill.carrier,
          accountCount: bill.accounts.length,
          lineCount,
          findingCount: findings.length,
          status: 'already-completed',
        };
      }

      logger.info('processBill: phase 2 complete (status=completed)', {
        auditId,
        findingCount: findings.length,
      });

      // Phase 5 analytics: fire `audit_completed`. Wrapped + try/catch so a
      // PostHog outage cannot fail an already-completed audit. trackServer is
      // already defensive but we belt-and-suspenders here.
      try {
        const monthlySavings = findings.reduce<number>(
          (sum, f) => sum + (f.estimated_monthly_savings_cents ?? 0),
          0,
        );
        const highSeverityCount = findings.filter(
          (f) => f.severity === ('high' as Severity),
        ).length;
        await trackServer(
          {
            name: 'audit_completed',
            properties: {
              auditId,
              carrier: bill.carrier,
              finding_count: findings.length,
              high_severity_count: highSeverityCount,
              estimated_monthly_savings_cents: monthlySavings,
            },
          },
          userId,
        );
      } catch (analyticsErr) {
        logger.error('processBill: trackServer failed (audit still completed)', {
          auditId,
          message:
            analyticsErr instanceof Error
              ? analyticsErr.message
              : 'unknown analytics error',
        });
      }

      // ─────────────────────────────────────────────────────────────────────
      // Phase 3: send-trigger — fire `audit.completed` so the email pipeline
      // can deliver the report. Wrapped in try/catch + step.run so:
      //   - the audit is already 'completed' before this runs (email is
      //     best-effort and must not regress the audit's status), and
      //   - Inngest gives us retry isolation + dedupe via step.run.
      // ─────────────────────────────────────────────────────────────────────
      try {
        await step.run('send-trigger', async () => {
          // (H5) Stable idempotency key — Inngest dedupes events by `id`, so
          // a retried `send-trigger` step (or a retried outer function that
          // re-enters this block) cannot fire `audit.completed` twice and
          // double-send the report email. The same pattern is used at the
          // upload site (`${auditId}-uploaded`) — keep the convention.
          await inngest.send({
            id: `${auditId}-completed`,
            name: 'audit.completed',
            data: { auditId, userId },
          });
          return { ok: true };
        });
      } catch (sendErr) {
        // Email is best-effort — never fail a completed audit because of it.
        logger.error('processBill: send-trigger failed (audit still completed)', {
          auditId,
          userId,
          message:
            sendErr instanceof Error ? sendErr.message : 'unknown send error',
        });
      }

      return {
        auditId,
        carrier: bill.carrier,
        accountCount: bill.accounts.length,
        lineCount,
        findingCount: findings.length,
      };
    } catch (err) {
      // Failure path: mark the audit failed before re-throwing so Inngest
      // records the failure and the user sees a real error in the UI.
      const reason = isNotAWirelessBill(err)
        ? 'Document does not appear to be a US business wireless bill'
        : deriveFailureReason(err);

      logger.error('processBill: failed', {
        auditId,
        userId,
        reason,
      });

      await step.run('mark-failed', async () => {
        const supabase = getAdminClient();
        // (B3) Status-guarded mark-failed.
        //
        // Inngest will retry the function on raw throws, and on every retry
        // the catch-block runs `mark-failed` again. Without a guard here, a
        // late retry — say, after a transient Sentry/PostHog hiccup tipped
        // the function into the catch block AFTER an earlier run had
        // already marked the audit `completed` — would silently overwrite
        // the stable terminal state and leave the user staring at "failed"
        // on a successful audit.
        //
        // We restrict the update to in-flight + already-failed states:
        //  - `pending`     — only reachable if mark-extracting itself blew up
        //                    before it could flip the row.
        //  - `extracting`  — the common path: extract step threw.
        //  - `analyzing`   — persistence/rules step threw.
        //  - `failed`      — re-running the catch block on retry; idempotent
        //                    overwrite of an existing failure with this run's
        //                    `failure_reason` is fine.
        //
        // Any other state (`completed` in particular) is terminal and we
        // refuse to touch it. We log the divergence at debug level so we
        // can spot a runaway error path, but never throw — throwing here
        // would make Inngest retry the catch handler indefinitely.
        const allowedStatuses = [
          'pending',
          'extracting',
          'analyzing',
          'failed',
        ] as const;
        const { data: rows, error } = await supabase
          .from('audits')
          .update({
            status: 'failed',
            failure_reason: reason,
            updated_at: new Date().toISOString(),
          })
          .eq('id', auditId)
          .in('status', allowedStatuses as unknown as string[])
          .select('id');
        if (error) {
          // Don't shadow the original failure — just surface this too.
          throw new Error(
            `audits update (mark-failed) failed: ${error.message}`,
          );
        }
        const affected = (rows ?? []).length;
        if (affected === 0) {
          logger.warn(
            'processBill: mark-failed skipped — audit no longer in a failable state',
            {
              auditId,
            },
          );
          return { ok: true, affected, refunded: false };
        }

        // H3: refund the credit when the failure is system-side. The
        // `refund_failed_audit` RPC is idempotent — its WHERE clause
        // gates on `credit_consumed=true AND status='failed'`, so a
        // retry of this same catch block will find credit_consumed=false
        // and no-op without double-refunding.
        //
        // Subscription users have credit_consumed=false from creation
        // (per /api/audits insert), so the RPC naturally no-ops for them
        // too. We don't even need to gate at the call site.
        let refunded = false;
        if (!isUserFaultFailure(reason)) {
          const { data: refundOk, error: refundErr } = await supabase.rpc(
            'refund_failed_audit',
            {
              p_audit_id: auditId,
              p_user_id: userId,
            },
          );
          if (refundErr) {
            // Surface to Sentry but do not throw — failing the refund
            // must not bury the original audit failure. The orphan-
            // cleanup cron will not catch this (status is already
            // 'failed'), so the alert is the recovery signal.
            try {
              const Sentry = await import('@sentry/nextjs');
              Sentry.captureException(refundErr, {
                tags: { surface: 'process-bill.refund_failed_audit' },
                extra: { auditId, userId, reason },
              });
            } catch {
              // Sentry optional.
            }
          } else if (refundOk === true) {
            refunded = true;
            logger.info('processBill: refunded credit on system failure', {
              auditId,
              userId,
              reason,
            });
          }
        }
        return { ok: true, affected, refunded };
      });

      throw err;
    }
  },
);

// ───────────────────────────────────────────────────────────────────────────
// Persistence
// ───────────────────────────────────────────────────────────────────────────

/**
 * Deletes all child rows for the given audit (in dependency order) and
 * re-inserts them from the freshly extracted bill. Running this twice with
 * the same input produces the same end state — the property Inngest needs
 * for safe retries.
 */
async function persistBill(
  auditId: string,
  bill: ExtractedBill,
): Promise<PersistBillResult> {
  const supabase = getAdminClient();

  // Delete in dependency order. bill_features / bill_credits / bill_dpp_installments
  // all reference bill_lines or bill_accounts; bill_lines references bill_accounts.
  // Cascading FKs would handle this on accounts-delete, but being explicit here
  // means we don't rely on cascade configuration to be retry-safe.
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

  const accountInsertRows = bill.accounts.map((account) =>
    withGeneratedId(accountToRow(auditId, account)),
  );
  await insertRows('bill_accounts', accountInsertRows);
  const insertedAccounts = accountInsertRows.map((row) => row.id);

  // Build line rows for ALL accounts in one batch, remembering which line
  // belongs to which (accountIndex, lineIndex) pair so we can wire up
  // features/credits/dpp_installments after the insert.
  type LineInsertRow = ReturnType<typeof lineToRow> & { id: string };
  const allLineRows: LineInsertRow[] = [];
  const lineOrigin: Array<{ accountIndex: number; lineIndex: number }> = [];

  bill.accounts.forEach((account, accountIndex) => {
    const accountId = insertedAccounts[accountIndex];
    if (!accountId) {
      throw new Error(
        `internal: missing inserted account id at index ${accountIndex}`,
      );
    }
    account.lines.forEach((line, lineIndex) => {
      allLineRows.push(withGeneratedId(lineToRow(auditId, accountId, line)));
      lineOrigin.push({ accountIndex, lineIndex });
    });
  });

  await insertRows('bill_lines', allLineRows);
  const insertedLineIds = allLineRows.map((row) => row.id);

  // Now: features, credits (line + account-level), dpp_installments.
  type Row = Record<string, unknown>;
  const featureRows: Row[] = [];
  const creditRows: Row[] = [];
  const dppRows: Row[] = [];

  insertedLineIds.forEach((lineId, idx) => {
    const origin = lineOrigin[idx];
    if (!origin) return;
    const account = bill.accounts[origin.accountIndex];
    const line = account?.lines[origin.lineIndex];
    if (!line) return;

    for (const feature of line.features) {
      featureRows.push({
        line_id: lineId,
        audit_id: auditId,
        name: feature.name,
        category: feature.category,
        monthly_charge_cents: feature.monthly_cents,
      });
    }

    for (const credit of line.credits) {
      creditRows.push({
        line_id: lineId,
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
        line_id: lineId,
        audit_id: auditId,
        device_description: dpp.device,
        monthly_payment_cents: dpp.monthly_cents,
        remaining_payments: dpp.remaining_payments,
        total_payments: dpp.total_payments,
      });
    }
  });

  // Account-level credits (no line_id).
  bill.accounts.forEach((account, accountIndex) => {
    const accountId = insertedAccounts[accountIndex];
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
    const { error } = await supabase.from('bill_features').insert(featureRows);
    if (error) {
      throw new Error(`insert bill_features failed: ${error.message}`);
    }
  }
  if (creditRows.length > 0) {
    const { error } = await supabase.from('bill_credits').insert(creditRows);
    if (error) {
      throw new Error(`insert bill_credits failed: ${error.message}`);
    }
  }
  if (dppRows.length > 0) {
    const { error } = await supabase
      .from('bill_dpp_installments')
      .insert(dppRows);
    if (error) {
      throw new Error(`insert bill_dpp_installments failed: ${error.message}`);
    }
  }

  // Build the per-account nested line id list. Walk lineOrigin in-order.
  const lineIds: string[][] = bill.accounts.map((a) =>
    new Array<string>(a.lines.length),
  );
  insertedLineIds.forEach((id, idx) => {
    const origin = lineOrigin[idx];
    if (!origin) return;
    const bucket = lineIds[origin.accountIndex];
    if (!bucket) return;
    bucket[origin.lineIndex] = id;
  });

  return {
    accountIds: insertedAccounts,
    lineIds,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Findings persistence
// ───────────────────────────────────────────────────────────────────────────

/**
 * Idempotent: deletes any existing findings for the audit and inserts the
 * new batch. The rule contract is that `affected_line_indexes` are 0-based
 * positions inside the FLATTENED `bill.accounts[].lines[]` (per
 * src/rules/types.ts). We resolve them to UUIDs using the order produced by
 * `persist-bill`.
 */
async function persistFindings(
  auditId: string,
  findings: Finding[],
  ids: PersistBillResult,
): Promise<void> {
  const supabase = getAdminClient();

  // Always clear first so retries don't double-insert.
  const { error: delErr } = await supabase
    .from('findings')
    .delete()
    .eq('audit_id', auditId);
  if (delErr) {
    throw new Error(`delete findings failed: ${delErr.message}`);
  }

  if (findings.length === 0) return;

  // Flatten lineIds[accountIdx][lineIdx] in account-major order, matching the
  // flattened layout that rule authors index against.
  const flatLineIds: string[] = [];
  for (const bucket of ids.lineIds) {
    for (const id of bucket) {
      flatLineIds.push(id);
    }
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

function accountToRow(auditId: string, account: ExtractedAccount) {
  return {
    audit_id: auditId,
    account_number_masked: account.account_number_last4,
    account_label: account.label,
    total_charges_cents: account.total_charges_cents,
    taxes_fees_cents: account.taxes_fees_cents,
    raw: account as unknown as Record<string, unknown>,
  };
}

function lineToRow(
  auditId: string,
  accountId: string,
  line: ExtractedLine,
) {
  return {
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
  };
}

// ───────────────────────────────────────────────────────────────────────────
// (B1) Per-account → global line index translation
// ───────────────────────────────────────────────────────────────────────────

/**
 * Logger surface required by translateLineIndexes. Matches the subset of
 * Inngest's `logger` we actually use, so tests can pass a plain object.
 */
type IndexTranslationLogger = {
  warn: (message: string, ctx?: Record<string, unknown>) => void;
};

type IndexTranslationOptions = {
  auditId: string;
  warn: IndexTranslationLogger['warn'];
};

export type IndexTranslationStats = {
  /** Number of (finding, localIdx) pairs dropped because the local index was
   *  outside the account's line range. Each drop also emits a warn log. */
  droppedLineIndexes: number;
  /** Number of findings whose entire affected_line_indexes array was wiped
   *  due to a bad account index. Distinct from droppedLineIndexes. */
  findingsWithDroppedAccount: number;
};

/**
 * Translate each finding's `affected_line_indexes` from per-account-local
 * positions (what every rule under `src/rules/definitions` actually emits)
 * to globally-flat positions inside `bill.accounts.flatMap(a => a.lines)`
 * — the layout `persistFindings` expects when it indexes `flatLineIds`.
 *
 * This is the (B1) bug-class fix. The contract documented in
 * `src/rules/types.ts` says affected_line_indexes are "positions inside the
 * flattened ctx.bill.accounts[].lines[]", but every concrete rule emits
 * the inner-loop `lineIndex` from its `account.lines.forEach((line, lineIndex) => …)`
 * — i.e. local to the account. Without translation, on any multi-account
 * bill the wrong UUID gets stamped on findings.
 *
 * Returns a NEW array (does not mutate input findings). H5: also populates
 * an out-parameter with drop counts so the caller can surface aggregate
 * visibility (a finding that was dropped silently looks like a rule bug to
 * support — it produces a "Potential saving" report row with no affected
 * lines listed).
 */
export function translateLineIndexes(
  findings: Finding[],
  bill: ExtractedBill,
  opts: IndexTranslationOptions,
  stats?: IndexTranslationStats,
): Finding[] {
  const accountLineCounts = bill.accounts.map((a) => a.lines.length);
  const accountStartOffsets: number[] = [];
  let running = 0;
  for (const n of accountLineCounts) {
    accountStartOffsets.push(running);
    running += n;
  }
  const totalLineCount = running;

  return findings.map((f) => {
    if (f.affected_line_indexes.length === 0) {
      // No line indexes to translate — account indexes flow through.
      return f;
    }
    // M1: enforce single-account-per-finding when line indexes are
    // present. The rules contract is "all affected_line_indexes belong
    // to affected_account_indexes[0]"; if a rule ever emits multiple
    // account indexes alongside line indexes, the translation here would
    // silently misroute lines in accounts ≥ 1 against the first account's
    // offset. Refuse to translate and drop the line indexes so persistence
    // can't stamp the wrong UUIDs.
    if (f.affected_account_indexes.length > 1) {
      opts.warn(
        'processBill: finding has line indexes spanning multiple accounts — dropping line indexes',
        {
          auditId: opts.auditId,
          rule_id: f.rule_id,
          accountIndexes: f.affected_account_indexes,
        },
      );
      if (stats) stats.findingsWithDroppedAccount += 1;
      return {
        ...f,
        affected_line_indexes: [],
      };
    }
    const accountIdx = f.affected_account_indexes[0];
    if (typeof accountIdx !== 'number') {
      opts.warn(
        'processBill: finding has line indexes but no account index — dropping line indexes',
        { auditId: opts.auditId, rule_id: f.rule_id },
      );
      if (stats) stats.findingsWithDroppedAccount += 1;
      return { ...f, affected_line_indexes: [] };
    }
    if (accountIdx < 0 || accountIdx >= accountLineCounts.length) {
      opts.warn(
        'processBill: finding affected_account_indexes[0] out of range — dropping line indexes',
        {
          auditId: opts.auditId,
          rule_id: f.rule_id,
          accountIdx,
          accountCount: accountLineCounts.length,
        },
      );
      if (stats) stats.findingsWithDroppedAccount += 1;
      // L6: drop the bad account index too so persistFindings doesn't
      // resolve a UUID against a finding whose line indexes were wiped.
      return {
        ...f,
        affected_line_indexes: [],
        affected_account_indexes: [],
      };
    }
    const accountSize = accountLineCounts[accountIdx] ?? 0;
    const offset = accountStartOffsets[accountIdx] ?? 0;
    const globalIndexes: number[] = [];
    for (const localIdx of f.affected_line_indexes) {
      if (
        typeof localIdx !== 'number' ||
        localIdx < 0 ||
        localIdx >= accountSize
      ) {
        opts.warn(
          'processBill: finding has out-of-range per-account line index — dropping that index only',
          {
            auditId: opts.auditId,
            rule_id: f.rule_id,
            accountIdx,
            localIdx,
            accountSize,
          },
        );
        if (stats) stats.droppedLineIndexes += 1;
        continue;
      }
      const globalIdx = offset + localIdx;
      if (globalIdx >= totalLineCount) {
        // Should be unreachable given the size check above, but bail out
        // rather than emit a corrupt index.
        continue;
      }
      globalIndexes.push(globalIdx);
    }
    return { ...f, affected_line_indexes: globalIndexes };
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Test-only exports
//
// Inngest's `step.run` model makes the worker awkward to drive as a unit.
// Rather than ship a heavyweight Inngest test harness, we expose the few
// helpers that carry interesting branches so they can be exercised
// independently. NEVER import these from production code paths.
// ───────────────────────────────────────────────────────────────────────────
export const __testables = {
  translateLineIndexes,
  deriveFailureReason,
  withTimeout,
  ExtractionTimeoutError,
  EXTRACTION_TIMEOUT_MS,
  withGeneratedId,
  isUserFaultFailure,
};

function withGeneratedId<T extends Record<string, unknown>>(
  row: T,
): T & { id: string } {
  return { ...row, id: randomUUID() };
}

async function insertRows(
  table: 'bill_accounts' | 'bill_lines',
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  if (rows.length === 0) return;
  const supabase = getAdminClient();
  const { error } = await supabase.from(table).insert(rows);
  if (error) {
    throw new Error(`insert ${table} failed: ${error.message}`);
  }
}
