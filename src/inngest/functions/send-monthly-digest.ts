import { randomBytes } from 'node:crypto';

import * as Sentry from '@sentry/nextjs';

import { inngest } from '../client';
import { env } from '@/env';
import { buildMonthlyDigest } from '@/email/monthly-digest';
import type {
  DigestAutopsy,
  DigestOpenFindingsBySeverity,
  DigestTopLine,
  MonthlyDigestProps,
} from '@/email/monthly-digest';
import { getResend } from '@/lib/resend/client';
import { FROM_ADDRESS } from '@/lib/resend/from';
import { getAdminClient } from '@/lib/supabase/admin';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * send-monthly-digest — recurring savings reminder.
 *
 * Trigger: Inngest cron `0 14 1 * *` (1st of each month, 14:00 UTC). Late
 * morning ET / pre-lunch PT — a deliberately gentle send window.
 *
 * Per-user pipeline (each user is its own `step.run`, so a single user
 * failing does not poison the whole cohort):
 *   1. Select profile cohort: has email, not opted-out, has >=1 completed
 *      audit, last digest > 25 days ago (or NULL).
 *   2. Aggregate from their data:
 *        - total spend across recent completed audits
 *        - latest autopsy (if any): net change, disputable, optimization
 *        - open findings (status IN ('new','in_review','approved')) by severity
 *        - sum of estimated_monthly_savings_cents on those findings
 *        - top 3 lines by waste (zero_usage / suspended / unused-hotspot rules)
 *   3. Ensure the user has a `digest_unsub_token` (24-byte base64url, 32 chars).
 *   4. Render via `buildMonthlyDigest` (pure builder in `@/email/monthly-digest`).
 *   5. Send via Resend.
 *   6. On success, update `profiles.digest_last_sent_at = now()`.
 *
 * Errors per-profile are captured to Sentry and swallowed — the cron keeps
 * going for the remaining cohort. Inngest itself retries the top-level cohort-
 * selection step if it fails (and only that step) once.
 *
 * Idempotency: the >25-day gate is the primary defense. The cron only runs
 * once a month, so a single retry hitting the same profile twice would still
 * be blocked at step 6 (the last-sent stamp is set BEFORE the next iteration
 * sees it on a retry).
 *
 * PII discipline (CLAUDE.md §1#9): logs only userId, counts, and the Resend
 * message id. Never the recipient email, never bill content.
 */

const ELIGIBILITY_WINDOW_DAYS = 25;
const MAX_RECIPIENTS = 5000;
const TOP_LINE_RULE_IDS = [
  'zero_usage_phone_line',
  'suspended_line_billed',
  'unused_mifi_or_jetpack_line',
] as const;
const OPEN_FINDING_STATUSES = ['new', 'in_review', 'approved'] as const;

type ProfileRow = {
  id: string;
  email: string | null;
  digest_opt_out: boolean | null;
  digest_last_sent_at: string | null;
  digest_unsub_token: string | null;
};

type AuditAggregateRow = {
  id: string;
  total_charges_cents: number | null;
  completed_at: string | null;
};

type FindingRow = {
  id: string;
  severity: string | null;
  status: string | null;
  rule_id: string | null;
  estimated_monthly_savings_cents: number | null;
  affected_line_ids: string[] | null;
};

type BillLineRow = {
  id: string;
  user_label: string | null;
  mdn_masked: string | null;
};

type BillComparisonRow = {
  net_change_cents: number | null;
  disputable_cents: number | null;
  optimization_cents: number | null;
  created_at: string | null;
};

export type DigestRecipient = {
  id: string;
  email: string;
  hasToken: boolean;
};

/**
 * Selects users who are eligible for a digest *right now*. Exported so the
 * top-level cohort step can call it under `step.run`.
 */
export async function selectDigestCohort(
  admin: SupabaseClient,
  now: Date = new Date(),
): Promise<DigestRecipient[]> {
  const cutoff = new Date(
    now.getTime() - ELIGIBILITY_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  // Step 1: profiles that are opted-in. Two passes are clearer than a
  // multi-table join through PostgREST.
  const { data: profiles, error: profilesErr } = await admin
    .from('profiles')
    .select('id, email, digest_opt_out, digest_last_sent_at, digest_unsub_token')
    .eq('digest_opt_out', false)
    .limit(MAX_RECIPIENTS);
  if (profilesErr) {
    throw new Error(`profiles select failed: ${profilesErr.message}`);
  }

  const candidates = ((profiles ?? []) as ProfileRow[]).filter((p) => {
    if (!p.email) return false;
    if (p.digest_opt_out === true) return false;
    if (p.digest_last_sent_at && p.digest_last_sent_at > cutoff) {
      return false;
    }
    return true;
  });

  if (candidates.length === 0) return [];

  // Step 2: of those, who has at least one completed audit? Single IN-query.
  const { data: completedAudits, error: completedErr } = await admin
    .from('audits')
    .select('user_id')
    .eq('status', 'completed')
    .in(
      'user_id',
      candidates.map((c) => c.id),
    );
  if (completedErr) {
    throw new Error(`audits select (completed cohort) failed: ${completedErr.message}`);
  }
  const completedSet = new Set(
    ((completedAudits ?? []) as { user_id: string }[]).map((r) => r.user_id),
  );

  return candidates
    .filter((p) => completedSet.has(p.id))
    .map((p) => ({
      id: p.id,
      email: p.email as string,
      hasToken: typeof p.digest_unsub_token === 'string' && p.digest_unsub_token.length > 0,
    }));
}

/**
 * Generate a 24-byte base64url unsubscribe token. 192 bits of entropy —
 * collisions are astronomically unlikely; the partial unique index in
 * migration 0028 belt-and-suspenders the property.
 */
export function generateUnsubToken(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * If the profile does not yet have a `digest_unsub_token`, generate one and
 * persist it via a CAS-style write (`is('digest_unsub_token', null)`) so a
 * concurrent caller can't clobber a freshly-set value. Returns the persisted
 * token in all cases.
 */
export async function ensureUnsubToken(
  admin: SupabaseClient,
  userId: string,
): Promise<string> {
  const { data, error } = await admin
    .from('profiles')
    .select('digest_unsub_token')
    .eq('id', userId)
    .maybeSingle();
  if (error) {
    throw new Error(`digest token read failed: ${error.message}`);
  }
  const existing = (data as { digest_unsub_token?: string | null } | null)?.digest_unsub_token;
  if (typeof existing === 'string' && existing.length > 0) {
    return existing;
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const fresh = generateUnsubToken();
    const { data: updated, error: writeErr } = await admin
      .from('profiles')
      .update({
        digest_unsub_token: fresh,
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId)
      .is('digest_unsub_token', null)
      .select('digest_unsub_token');

    if (writeErr) {
      const code = (writeErr as { code?: string }).code;
      if (code === '23505') {
        // Unique-index collision — try again with fresh entropy.
        continue;
      }
      throw new Error(`digest token write failed: ${writeErr.message}`);
    }

    const rows = (updated ?? []) as Array<{ digest_unsub_token?: string | null }>;
    if (rows.length === 1) return fresh;

    // CAS lost — re-read and return whoever won.
    const reread = await admin
      .from('profiles')
      .select('digest_unsub_token')
      .eq('id', userId)
      .maybeSingle();
    const persisted = (reread.data as { digest_unsub_token?: string | null } | null)
      ?.digest_unsub_token;
    if (typeof persisted === 'string' && persisted.length > 0) return persisted;
  }
  throw new Error('digest token write failed: too many collisions');
}

const MAX_RECENT_AUDITS = 6;

type AggregatedContext = {
  totalSpendCents: number;
  autopsy: DigestAutopsy | null;
  openFindingsBySeverity: DigestOpenFindingsBySeverity;
  totalRecoverableSavingsCents: number;
  topUnusedLines: DigestTopLine[];
};

/**
 * Pull together the per-user payload for the digest. Reads are intentionally
 * minimal and bounded — never more than `MAX_RECENT_AUDITS` audits, never
 * more than the open findings on those audits, never more than the lines
 * referenced by those findings.
 */
export async function aggregateDigestContext(
  admin: SupabaseClient,
  userId: string,
): Promise<AggregatedContext> {
  // ── recent completed audits (cap to MAX_RECENT_AUDITS so the digest reflects
  //    a recent rolling window, not the entire user history) ────────────────
  const { data: auditsData, error: auditsErr } = await admin
    .from('audits')
    .select('id, total_charges_cents, completed_at')
    .eq('user_id', userId)
    .eq('status', 'completed')
    .order('completed_at', { ascending: false })
    .limit(MAX_RECENT_AUDITS);
  if (auditsErr) {
    throw new Error(`audits aggregate select failed: ${auditsErr.message}`);
  }
  const audits = (auditsData ?? []) as AuditAggregateRow[];
  const auditIds = audits.map((a) => a.id);

  const totalSpendCents = audits.reduce(
    (acc, a) => acc + (a.total_charges_cents ?? 0),
    0,
  );

  // ── latest autopsy across those audits ──────────────────────────────────
  let autopsy: DigestAutopsy | null = null;
  if (auditIds.length > 0) {
    const { data: comparisonData, error: comparisonErr } = await admin
      .from('bill_comparisons')
      .select('net_change_cents, disputable_cents, optimization_cents, created_at')
      .eq('user_id', userId)
      .in('current_audit_id', auditIds)
      .order('created_at', { ascending: false })
      .limit(1);
    if (comparisonErr) {
      throw new Error(`bill_comparisons select failed: ${comparisonErr.message}`);
    }
    const latest = ((comparisonData ?? []) as BillComparisonRow[])[0];
    if (latest) {
      autopsy = {
        netChangeCents: latest.net_change_cents ?? 0,
        disputableCents: latest.disputable_cents ?? 0,
        optimizationCents: latest.optimization_cents ?? 0,
      };
    }
  }

  // ── open findings across the same audit set ─────────────────────────────
  const openFindingsBySeverity: DigestOpenFindingsBySeverity = {
    high: 0,
    medium: 0,
    low: 0,
  };
  let totalRecoverableSavingsCents = 0;
  let topUnusedLines: DigestTopLine[] = [];

  if (auditIds.length > 0) {
    const { data: findingsData, error: findingsErr } = await admin
      .from('findings')
      .select(
        'id, severity, status, rule_id, estimated_monthly_savings_cents, affected_line_ids',
      )
      .in('audit_id', auditIds)
      .in('status', OPEN_FINDING_STATUSES as unknown as string[]);
    if (findingsErr) {
      throw new Error(`findings select failed: ${findingsErr.message}`);
    }
    const findings = (findingsData ?? []) as FindingRow[];

    for (const f of findings) {
      const sev = f.severity;
      if (sev === 'high') openFindingsBySeverity.high += 1;
      else if (sev === 'medium') openFindingsBySeverity.medium += 1;
      else if (sev === 'low') openFindingsBySeverity.low += 1;
      totalRecoverableSavingsCents += f.estimated_monthly_savings_cents ?? 0;
    }

    // ── top unused lines ──────────────────────────────────────────────────
    // We collect per-line savings from findings whose rule_id is in the
    // "waste" set, then resolve labels via bill_lines.
    const lineSavingsCents = new Map<string, { ruleId: string; cents: number }>();
    for (const f of findings) {
      if (!f.rule_id) continue;
      if (!(TOP_LINE_RULE_IDS as readonly string[]).includes(f.rule_id)) continue;
      const ids = Array.isArray(f.affected_line_ids) ? f.affected_line_ids : [];
      if (ids.length === 0) continue;
      // Split the finding's monthly savings evenly across its affected lines.
      const perLineCents = Math.round(
        (f.estimated_monthly_savings_cents ?? 0) / ids.length,
      );
      for (const lineId of ids) {
        const prior = lineSavingsCents.get(lineId);
        if (!prior || perLineCents > prior.cents) {
          lineSavingsCents.set(lineId, { ruleId: f.rule_id, cents: perLineCents });
        }
      }
    }

    if (lineSavingsCents.size > 0) {
      const lineIds = Array.from(lineSavingsCents.keys());
      const { data: linesData, error: linesErr } = await admin
        .from('bill_lines')
        .select('id, user_label, mdn_masked')
        .in('id', lineIds);
      if (linesErr) {
        throw new Error(`bill_lines select failed: ${linesErr.message}`);
      }
      const lines = (linesData ?? []) as BillLineRow[];
      const lineMap = new Map(lines.map((l) => [l.id, l]));

      topUnusedLines = Array.from(lineSavingsCents.entries())
        .map(([lineId, { ruleId, cents }]) => {
          const line = lineMap.get(lineId);
          return {
            label: line?.user_label ?? null,
            mdnMaskedLast4: line?.mdn_masked ?? null,
            ruleId,
            estimatedMonthlySavingsCents: cents,
          } satisfies DigestTopLine;
        })
        .sort(
          (a, b) =>
            b.estimatedMonthlySavingsCents - a.estimatedMonthlySavingsCents,
        )
        .slice(0, 3);
    }
  }

  return {
    totalSpendCents,
    autopsy,
    openFindingsBySeverity,
    totalRecoverableSavingsCents,
    topUnusedLines,
  };
}

function periodLabelForNow(now: Date = new Date()): string {
  return now.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function buildUnsubscribeUrl(token: string): string {
  const base = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, '');
  return `${base}/api/email/unsubscribe?token=${encodeURIComponent(token)}`;
}

function buildDashboardUrl(): string {
  return env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, '');
}

export const sendMonthlyDigestFn = inngest.createFunction(
  { id: 'send-monthly-digest', retries: 1, concurrency: { limit: 1 } },
  { cron: '0 14 1 * *' },
  async ({ step, logger }) => {
    const cohort = (await step.run('select-cohort', async () => {
      const admin = getAdminClient();
      return await selectDigestCohort(admin);
    })) as DigestRecipient[];

    logger.info('sendMonthlyDigest: cohort selected', { count: cohort.length });

    const periodLabel = periodLabelForNow();
    const dashboardUrl = buildDashboardUrl();
    let sent = 0;
    let skipped = 0;
    let errored = 0;

    for (const recipient of cohort) {
      try {
        const result = (await step.run(`send-${recipient.id}`, async () => {
          const admin = getAdminClient();

          // ── re-check the gate inside the step so a race against another
          //    cron run (or a manual replay) cannot double-send ──────────────
          const { data: freshProfile, error: profileErr } = await admin
            .from('profiles')
            .select('digest_opt_out, digest_last_sent_at, email')
            .eq('id', recipient.id)
            .maybeSingle();
          if (profileErr) {
            throw new Error(`profile re-read failed: ${profileErr.message}`);
          }
          const fresh = (freshProfile ?? null) as {
            digest_opt_out: boolean | null;
            digest_last_sent_at: string | null;
            email: string | null;
          } | null;
          if (!fresh || fresh.digest_opt_out === true || !fresh.email) {
            return { status: 'skipped' as const, reason: 'opt-out-or-no-email' };
          }
          if (fresh.digest_last_sent_at) {
            const ts = Date.parse(fresh.digest_last_sent_at);
            if (
              !Number.isNaN(ts) &&
              Date.now() - ts < ELIGIBILITY_WINDOW_DAYS * 24 * 60 * 60 * 1000
            ) {
              return { status: 'skipped' as const, reason: 'within-window' };
            }
          }

          const token = await ensureUnsubToken(admin, recipient.id);
          const unsubscribeUrl = buildUnsubscribeUrl(token);
          const aggregated = await aggregateDigestContext(admin, recipient.id);

          const props: MonthlyDigestProps = {
            periodLabel,
            totalSpendCents: aggregated.totalSpendCents,
            autopsy: aggregated.autopsy,
            openFindingsBySeverity: aggregated.openFindingsBySeverity,
            totalRecoverableSavingsCents: aggregated.totalRecoverableSavingsCents,
            topUnusedLines: aggregated.topUnusedLines,
            dashboardUrl,
            unsubscribeUrl,
          };
          const rendered = buildMonthlyDigest(props);

          const resend = getResend();
          const response = await resend.emails.send({
            from: FROM_ADDRESS,
            to: fresh.email,
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text,
            headers: {
              // RFC 8058 one-click unsubscribe metadata. Gmail / Apple Mail
              // surface this header as a native button.
              'List-Unsubscribe': `<${unsubscribeUrl}>`,
              'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
            },
          });

          if (response.error) {
            const code =
              typeof (response.error as { name?: unknown }).name === 'string'
                ? (response.error as { name: string }).name
                : 'unknown';
            throw new Error(`resend send failed: ${code}`);
          }

          const messageId =
            response.data && typeof response.data.id === 'string'
              ? response.data.id
              : null;

          // Stamp last-sent BEFORE returning so a retry sees the latest
          // timestamp and short-circuits at the gate above.
          const { error: stampErr } = await admin
            .from('profiles')
            .update({
              digest_last_sent_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq('id', recipient.id);
          if (stampErr) {
            // The email is already out the door — surface to Sentry but
            // don't throw, as throwing would cause Inngest to retry the send.
            Sentry.captureException(
              new Error(`digest_last_sent_at stamp failed: ${stampErr.message}`),
              {
                tags: { surface: 'send-monthly-digest.stamp' },
                extra: { userId: recipient.id },
              },
            );
          }

          return { status: 'sent' as const, messageId };
        })) as
          | { status: 'sent'; messageId: string | null }
          | { status: 'skipped'; reason: string };

        if (result.status === 'sent') {
          sent += 1;
          logger.info('sendMonthlyDigest: sent', {
            userId: recipient.id,
            resendMessageId: result.messageId,
          });
        } else {
          skipped += 1;
          logger.info('sendMonthlyDigest: skipped', {
            userId: recipient.id,
            reason: result.reason,
          });
        }
      } catch (err) {
        errored += 1;
        Sentry.captureException(err, {
          tags: { surface: 'send-monthly-digest.per-user' },
          extra: { userId: recipient.id },
        });
        logger.error('sendMonthlyDigest: per-user error', {
          userId: recipient.id,
          message: err instanceof Error ? err.message : 'unknown',
        });
        // Continue the cohort.
      }
    }

    logger.info('sendMonthlyDigest: done', {
      cohort: cohort.length,
      sent,
      skipped,
      errored,
    });

    return { cohort: cohort.length, sent, skipped, errored };
  },
);
