import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';

import { FINDING_STATUS_VALUES } from '@/components/report/finding-status-meta';
import { inngest } from '@/inngest/client';
import { logTrailEvent } from '@/lib/audit-trail/log';
import { consumeRateLimit, rateLimitedResponse } from '@/lib/security/rate-limit';
import { getAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import type { FindingStatus } from '@/rules/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Reviewer workflow status set. Mirrors the CHECK constraint in
// supabase/migrations/0023_finding_status_workflow.sql — if you add a status
// here you MUST add it there too. The canonical list lives in
// `@/components/report/finding-status-meta`; route files in Next.js only
// allow documented Route exports, so we narrow to a tuple type locally here.
const STATUS_ENUM = FINDING_STATUS_VALUES as readonly [FindingStatus, ...FindingStatus[]];

const ParamsSchema = z.object({
  id: z.string().uuid(),
  findingId: z.string().uuid(),
});

// `note` is capped at 500 chars per the task spec. Empty string normalises to
// null on write so we don't pollute the DB with empty review notes.
const BodySchema = z.object({
  status: z.enum(STATUS_ENUM),
  note: z.string().max(500).optional(),
});

interface FindingOwnershipRow {
  id: string;
  audit_id: string;
  status: FindingStatus;
  audits: { id: string; user_id: string } | null;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; findingId: string }> },
): Promise<Response> {
  const params = await context.params;
  const parsedParams = ParamsSchema.safeParse(params);
  if (!parsedParams.success) {
    return NextResponse.json({ error: 'Invalid audit or finding id.' }, { status: 400 });
  }
  const { id: auditId, findingId } = parsedParams.data;

  // Body parse. We accept any -> any transition (operators sometimes need to
  // undo a wrongly-applied status). Liberal transitions are documented at
  // module scope; the Zod schema is the only gate on the value set.
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  const parsedBody = BodySchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }
  const { status, note } = parsedBody.data;

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    }

    // Confirm the finding belongs to the audit AND the audit belongs to the
    // user. RLS hides findings that aren't reachable via the user's audits,
    // but we still belt-and-suspenders both joins below — matches the
    // pattern in share/route.ts and retry/route.ts.
    // Select `status` too so we can include the previous value in the
    // `finding.status_changed` event payload below — useful for receivers
    // that want to surface the transition (e.g. "approved → resolved").
    const { data: finding, error: fetchError } = await supabase
      .from('findings')
      .select('id,audit_id,status,audits!inner(id,user_id)')
      .eq('id', findingId)
      .eq('audit_id', auditId)
      .maybeSingle<FindingOwnershipRow>();

    if (fetchError) {
      return NextResponse.json({ error: 'Failed to look up finding.' }, { status: 500 });
    }
    if (!finding) {
      return NextResponse.json({ error: 'Finding not found.' }, { status: 404 });
    }
    if (!finding.audits || finding.audits.user_id !== user.id) {
      // RLS should have hidden this, but verify explicitly so a future
      // service-role-leaning change can't open a hole.
      return NextResponse.json({ error: 'Finding not found.' }, { status: 404 });
    }

    const limit = await consumeRateLimit({
      key: `finding-status:${user.id}`,
      limit: 60,
      windowSeconds: 60,
    });
    if (!limit.ok) {
      return rateLimitedResponse(limit.resetAt);
    }

    // Liberal transitions: any -> any. Operators sometimes need to undo a
    // wrongly-applied status (e.g. accidentally approved -> back to in_review).
    // The Zod enum is the only value gate; we do NOT enforce a state machine
    // here. The DB CHECK constraint (migration 0023) is the last line of
    // defense.
    const admin = getAdminClient();
    const { error: updateError } = await admin
      .from('findings')
      .update({
        status,
        status_updated_at: new Date().toISOString(),
        status_updated_by: user.id,
        review_note: note ?? null,
      })
      .eq('id', findingId)
      .eq('audit_id', auditId);

    if (updateError) {
      // PII: never echo review_note back through error logging. The DB error
      // surface here is the update statement metadata only.
      Sentry.captureException(updateError, {
        tags: { surface: 'finding_status.update' },
        extra: { auditId, findingId, status },
      });
      return NextResponse.json({ error: 'Failed to update finding.' }, { status: 500 });
    }

    // Fire `finding.status_changed` so any outbound webhook fires + so future
    // event consumers (Slack/Linear/etc.) can subscribe. Failure here MUST NOT
    // fail the response — the DB update already succeeded and the webhook
    // dispatch is best-effort.
    //
    // #10: the key must NOT include Date.now() — that made every call a unique
    // id, so Inngest never deduped and a double-submit (double-click, proxy
    // retry, React StrictMode double-fire) dispatched the outbound webhook
    // twice. The (findingId, status) tuple is the logical transition; identical
    // concurrent submits now collapse to one. (Trade-off: an intentional
    // re-transition to the same status within Inngest's ~24h window is also
    // deduped — acceptable; we don't want to spam the webhook on rapid toggles.)
    try {
      await inngest.send({
        id: `finding-${findingId}-${status}`,
        name: 'finding.status_changed',
        data: {
          auditId,
          findingId,
          status,
          previousStatus: finding.status ?? null,
          userId: user.id,
        },
      });
    } catch (sendErr) {
      Sentry.captureException(sendErr, {
        tags: { surface: 'finding_status.event_send' },
        extra: { auditId, findingId, status },
      });
    }

    await logTrailEvent({
      userId: user.id,
      eventType: 'finding_status_changed',
      entityType: 'finding',
      entityId: findingId,
      metadata: { audit_id: auditId, status, previous_status: finding.status ?? null },
      actorEmail: user.email ?? null,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    Sentry.captureException(err, {
      tags: { surface: 'finding_status.unknown' },
      extra: { auditId, findingId },
    });
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
