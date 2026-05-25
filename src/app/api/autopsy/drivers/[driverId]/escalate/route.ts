/**
 * POST /api/autopsy/drivers/[driverId]/escalate
 *
 * Convert a Bill Increase Autopsy change driver into a full audit finding.
 * The new finding is inserted into the `findings` table and the driver row
 * is stamped with `escalated_finding_id` so the UI can hide / link to it.
 *
 * Owner-only; rate limited; idempotent — if the driver already carries
 * an `escalated_finding_id` we return the existing id rather than creating
 * a duplicate.
 *
 * The escalated finding inherits:
 *   - severity: high if driver.is_disputable, medium otherwise
 *   - title:    driver.title
 *   - description: driver.summary
 *   - recommended_action: driver.recommended_action ?? a fallback
 *   - estimated_monthly_savings_cents: |driver.difference_cents| when the
 *     driver pushed the bill UP and is disputable; 0 otherwise (we
 *     don't claim savings for things that genuinely raised the bill
 *     unless we believe they're disputable).
 *   - confidence: driver.confidence
 *   - rule_id: "autopsy_escalated_<category>"
 *   - status:  new (operator triages from the findings list)
 *   - evidence: { autopsy_driver_id, category, comparison_id }
 *   - affected_line_ids / affected_account_ids: NULL — driver evidence
 *     keys lines by last4, not UUID, so we can't recover the FK chain.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import * as Sentry from '@sentry/nextjs';

import { inngest } from '@/inngest/client';
import { logTrailEvent } from '@/lib/audit-trail/log';
import { consumeRateLimit, rateLimitedResponse } from '@/lib/security/rate-limit';
import { getAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ParamsSchema = z.object({ driverId: z.string().uuid() });

interface DriverRow {
  id: string;
  bill_comparison_id: string;
  category: string;
  title: string;
  summary: string;
  difference_cents: number;
  confidence: number;
  is_disputable: boolean;
  recommended_action: string | null;
  escalated_finding_id: string | null;
  bill_comparisons: {
    user_id: string;
    current_audit_id: string;
  } | null;
}

export async function POST(
  _request: Request,
  context: { params: Promise<{ driverId: string }> },
): Promise<Response> {
  const params = await context.params;
  const parsed = ParamsSchema.safeParse(params);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid driver id.' }, { status: 400 });
  }
  const driverId = parsed.data.driverId;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const limited = await consumeRateLimit({
    key: `autopsy-escalate:${user.id}`,
    limit: 30,
    windowSeconds: 60,
  });
  if (!limited.ok) {
    return rateLimitedResponse(limited.resetAt);
  }

  // Load + ownership-check the driver. RLS join via user-scoped client.
  const { data: driver, error: driverErr } = await supabase
    .from('bill_change_drivers')
    .select(
      'id,bill_comparison_id,category,title,summary,difference_cents,confidence,is_disputable,recommended_action,escalated_finding_id,bill_comparisons!inner(user_id,current_audit_id)',
    )
    .eq('id', driverId)
    .maybeSingle<DriverRow>();
  if (driverErr || !driver) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }
  if (driver.bill_comparisons?.user_id !== user.id) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  // Idempotency: if already escalated, return the existing finding id.
  if (driver.escalated_finding_id) {
    return NextResponse.json({
      ok: true,
      findingId: driver.escalated_finding_id,
      alreadyEscalated: true,
    });
  }

  const auditId = driver.bill_comparisons.current_audit_id;
  const severity = driver.is_disputable ? 'high' : 'medium';
  // We only claim "savings" when (a) the driver pushed the bill up and
  // (b) it's flagged as disputable. Anything else = $0 — escalating is
  // about visibility, not about inventing recoverable savings.
  const savings =
    driver.is_disputable && driver.difference_cents > 0
      ? driver.difference_cents
      : 0;
  const ruleId = `autopsy_escalated_${driver.category}`;
  const action =
    driver.recommended_action ??
    'Review this change with your carrier rep and request remediation.';

  const admin = getAdminClient();

  // Create the finding first. We capture the id and only then stamp the
  // driver so a failure to insert the finding doesn't leave a stale ref.
  const { data: inserted, error: insertErr } = await admin
    .from('findings')
    .insert({
      audit_id: auditId,
      rule_id: ruleId,
      severity,
      title: driver.title,
      description: driver.summary,
      recommended_action: action,
      estimated_monthly_savings_cents: savings,
      confidence: driver.confidence,
      affected_line_ids: null,
      affected_account_ids: null,
      evidence: {
        autopsy_driver_id: driverId,
        category: driver.category,
        comparison_id: driver.bill_comparison_id,
      },
      status: 'new',
    })
    .select('id')
    .single();
  if (insertErr || !inserted) {
    Sentry.captureException(insertErr, {
      tags: { surface: 'autopsy.escalate.insert_finding' },
    });
    return NextResponse.json(
      { error: 'Failed to create finding.' },
      { status: 500 },
    );
  }

  const findingId: string = inserted.id;

  const { error: stampErr } = await admin
    .from('bill_change_drivers')
    .update({
      escalated_finding_id: findingId,
      escalated_at: new Date().toISOString(),
    })
    .eq('id', driverId);
  if (stampErr) {
    // Roll back the finding so we don't leave it orphaned.
    await admin.from('findings').delete().eq('id', findingId);
    Sentry.captureException(stampErr, {
      tags: { surface: 'autopsy.escalate.stamp_driver' },
    });
    return NextResponse.json(
      { error: 'Failed to link finding to driver.' },
      { status: 500 },
    );
  }

  // Bump the parent audit's finding_count + high_severity_count so the
  // dashboard tile reflects the escalation without a full re-aggregate.
  const { data: auditCounts } = await admin
    .from('audits')
    .select('finding_count,high_severity_count')
    .eq('id', auditId)
    .maybeSingle<{ finding_count: number | null; high_severity_count: number | null }>();
  if (auditCounts) {
    await admin
      .from('audits')
      .update({
        finding_count: (auditCounts.finding_count ?? 0) + 1,
        high_severity_count:
          (auditCounts.high_severity_count ?? 0) + (severity === 'high' ? 1 : 0),
      })
      .eq('id', auditId);
  }

  await logTrailEvent({ userId: user.id, eventType: 'finding_escalated', entityType: 'driver', entityId: driverId, metadata: { audit_id: auditId, finding_id: findingId, category: driver.category, comparison_id: driver.bill_comparison_id }, actorEmail: user.email ?? null });

  // Fire `finding.created` so the Slack dispatcher (and any future
  // listeners) can react. This route is the SINGLE starter emit site for
  // the event — we deliberately do NOT also fire from the rules-runner
  // persist path (process-bill.ts) or the CSV persist path because that
  // would multiply the surface area. The autopsy-escalate route is the
  // cleanest starting point because the user explicitly initiates the
  // action, so a one-message-per-click contract is intuitive.
  //
  // Best-effort: a Slack/Inngest hiccup must not block the response since
  // the finding row is already persisted.
  try {
    await inngest.send({
      id: `finding-created-${findingId}`,
      name: 'finding.created',
      data: {
        auditId,
        findingId,
        userId: user.id,
        severity,
        ruleId,
        // PII discipline: the autopsy LLM is prompted to keep driver
        // titles free of MDNs/account numbers. We forward the title only,
        // never the summary (which can carry richer context).
        title: driver.title,
        estimatedMonthlySavingsCents: savings,
      },
    });
  } catch (sendErr) {
    Sentry.captureException(sendErr, {
      tags: { surface: 'autopsy.escalate.event_send' },
      extra: { auditId, findingId },
    });
  }

  return NextResponse.json({ ok: true, findingId });
}
