import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';

import { inngest } from '@/inngest/client';
import { consumeRateLimit, rateLimitedResponse } from '@/lib/security/rate-limit';
import { getAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ParamsSchema = z.object({
  id: z.string().uuid(),
});

interface AuditRow {
  id: string;
  user_id: string;
  status: string;
  storage_path: string;
  retry_count: number;
}

function isAuditRow(value: unknown): value is AuditRow {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.user_id === 'string' &&
    typeof v.status === 'string' &&
    typeof v.storage_path === 'string' &&
    typeof v.retry_count === 'number'
  );
}

interface RetryCountRow {
  retry_count: number;
}

function isRetryCountRow(value: unknown): value is RetryCountRow {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.retry_count === 'number';
}

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const params = await context.params;
  const parsed = ParamsSchema.safeParse(params);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid audit id.' }, { status: 400 });
  }
  const auditId = parsed.data.id;

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    }

    const { data, error } = await supabase
      .from('audits')
      .select('id,user_id,status,storage_path,retry_count')
      .eq('id', auditId)
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: 'Failed to look up audit.' }, { status: 500 });
    }
    if (!data || !isAuditRow(data)) {
      return NextResponse.json({ error: 'Audit not found.' }, { status: 404 });
    }
    if (data.user_id !== user.id) {
      return NextResponse.json({ error: 'Audit not found.' }, { status: 404 });
    }
    if (data.status !== 'failed') {
      return NextResponse.json(
        { error: `Audit is not in a failed state (current: ${data.status}).` },
        { status: 409 },
      );
    }

    const limit = await consumeRateLimit({
      key: `audit-retry:${user.id}:${auditId}`,
      limit: 3,
      windowSeconds: 60 * 60,
    });
    if (!limit.ok) {
      return rateLimitedResponse(limit.resetAt);
    }

    // M-A3 — invalidate the cached PDF for this audit (if any) before resetting
    // state. A never-completed audit may not have a cached PDF; ignore the
    // result. A storage outage shouldn't block retry — capture and continue.
    const admin = getAdminClient();
    try {
      await admin.storage.from('reports').remove([`${auditId}.pdf`]);
    } catch (storageErr) {
      Sentry.captureException(storageErr, {
        tags: { surface: 'audits.retry.storage_invalidate' },
        extra: { auditId },
      });
    }

    // H7 — CAS-increment retry_count atomically. Concurrent retry attempts
    // can't both win this update because we filter on the previous count.
    // The new retry_count value anchors the Inngest idempotency key so
    // distinct retries get distinct keys, while a duplicated POST within the
    // same retry collapses onto one Inngest run.
    const nextRetryCount = data.retry_count + 1;
    const { data: updated, error: updateError } = await admin
      .from('audits')
      .update({
        status: 'pending',
        failure_reason: null,
        retry_count: nextRetryCount,
        updated_at: new Date().toISOString(),
      })
      .eq('id', auditId)
      .eq('status', 'failed')
      .eq('retry_count', data.retry_count)
      .select('retry_count');

    if (updateError) {
      return NextResponse.json({ error: 'Failed to reset audit.' }, { status: 500 });
    }

    // CAS lost — a concurrent retry already won. Don't double-enqueue.
    if (!updated || updated.length === 0) {
      return NextResponse.json(
        {
          error: 'retry_in_progress',
          message: 'Another retry attempt is already in progress for this audit.',
        },
        { status: 409 },
      );
    }

    const winningRow = updated[0];
    const retryCount = isRetryCountRow(winningRow) ? winningRow.retry_count : nextRetryCount;

    try {
      await inngest.send({
        id: `${auditId}-uploaded-retry-${retryCount}`,
        name: 'bill.uploaded',
        data: {
          auditId: data.id,
          userId: data.user_id,
          storagePath: data.storage_path,
        },
      });
    } catch (sendErr) {
      Sentry.captureException(sendErr, {
        tags: { surface: 'audits.retry.inngest_send' },
        extra: { auditId },
      });
      // Best-effort rollback: reset audit to failed but keep the incremented
      // retry_count so a remotely-accepted event id is never reused.
      try {
        await admin
          .from('audits')
          .update({
            status: 'failed',
            retry_count: nextRetryCount,
            updated_at: new Date().toISOString(),
          })
          .eq('id', auditId)
          .eq('status', 'pending')
          .eq('retry_count', nextRetryCount);
      } catch (rollbackErr) {
        Sentry.captureException(rollbackErr, {
          tags: { surface: 'audits.retry.rollback' },
          extra: { auditId },
        });
      }
      return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    Sentry.captureException(err, {
      tags: { surface: 'audits.retry.unknown' },
      extra: { auditId },
    });
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
