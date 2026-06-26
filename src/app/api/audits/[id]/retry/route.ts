import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';

import { inngest } from '@/inngest/client';
import { assertCanRunAudit } from '@/lib/access/gate';
import { consumeAuditCreditForAudit } from '@/lib/access/decrement';
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
  failure_reason: string | null;
  credit_consumed: boolean;
}

function isAuditRow(value: unknown): value is AuditRow {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.user_id === 'string' &&
    typeof v.status === 'string' &&
    typeof v.storage_path === 'string' &&
    typeof v.retry_count === 'number' &&
    (typeof v.failure_reason === 'string' || v.failure_reason === null) &&
    typeof v.credit_consumed === 'boolean'
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

async function rollbackPendingRetry(
  admin: ReturnType<typeof getAdminClient>,
  auditId: string,
  failureReason: string | null,
  originalRetryCount: number,
  pendingRetryCount: number,
): Promise<void> {
  const { error: rollbackError } = await admin
    .from('audits')
    .update({
      status: 'failed',
      failure_reason: failureReason,
      retry_count: pendingRetryCount,
      updated_at: new Date().toISOString(),
    })
    .eq('id', auditId)
    .eq('status', 'pending')
    .eq('retry_count', pendingRetryCount);
  if (rollbackError) {
    throw new Error(`Audit retry rollback failed: ${rollbackError.message}`);
  }
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
      .select('id,user_id,status,storage_path,retry_count,failure_reason,credit_consumed')
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

    // Pre-flight access when a system-side failure refunded the credit.
    // Actual consume happens AFTER the row flips to `pending` — the RPC
    // gates on status='pending'. User-fault failures keep credit_consumed=true
    // (free retry). Subscription users pass gate on `subscription`, not credit.
    let needsCreditReconsume = false;
    if (!data.credit_consumed) {
      const gate = await assertCanRunAudit(user.id);
      if (!gate.ok) {
        if (gate.reason === 'past_due') {
          return NextResponse.json(
            {
              error: 'subscription_past_due',
              message: 'Your subscription is past due. Please update payment to continue.',
            },
            { status: 402 },
          );
        }
        return NextResponse.json(
          {
            error: 'no_plan',
            message: 'No active plan or audit credits.',
            upgrade_url: '/pricing',
          },
          { status: 402 },
        );
      }
      needsCreditReconsume = gate.reason === 'credit';
    }

    const admin = getAdminClient();

    // M-A3 — invalidate the cached PDF for this audit (if any) before resetting
    // state. A never-completed audit may not have a cached PDF; ignore the
    // result. A storage outage shouldn't block retry — capture and continue.
    try {
      const { error: storageError } = await admin.storage
        .from('reports')
        .remove([`${auditId}.pdf`]);
      if (storageError) {
        Sentry.captureException(storageError, {
          tags: { surface: 'audits.retry.storage_invalidate' },
          extra: { auditId },
        });
      }
    } catch (storageErr) {
      Sentry.captureException(storageErr, {
        tags: { surface: 'audits.retry.storage_invalidate' },
        extra: { auditId },
      });
    }

    // H7 — CAS-increment retry_count atomically. Concurrent retry attempts
    // can't both win this update because we filter on the previous count.
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

    let creditReconsumed = false;
    if (needsCreditReconsume) {
      try {
        await consumeAuditCreditForAudit(user.id, auditId);
        creditReconsumed = true;
      } catch (decrementErr) {
        const isDefinitiveRefusal =
          decrementErr instanceof Error && decrementErr.message === 'no_credits';
        Sentry.captureException(decrementErr, {
          tags: {
            surface: 'audits.retry.decrement',
            transient: isDefinitiveRefusal ? 'false' : 'true',
          },
          extra: { userId: user.id, auditId },
        });
        try {
          await rollbackPendingRetry(
            admin,
            auditId,
            data.failure_reason,
            data.retry_count,
            nextRetryCount,
          );
        } catch (rollbackErr) {
          Sentry.captureException(rollbackErr, {
            tags: { surface: 'audits.retry.decrement_rollback' },
            extra: { auditId },
          });
        }
        if (isDefinitiveRefusal) {
          return NextResponse.json(
            {
              error: 'no_plan',
              message: 'No active plan or audit credits.',
              upgrade_url: '/pricing',
            },
            { status: 402 },
          );
        }
        return NextResponse.json(
          {
            error: 'credit_decrement_unavailable',
            message: 'Failed to reserve audit credit. Please try again.',
          },
          { status: 503 },
        );
      }
    }

    try {
      await inngest.send({
        id: `${auditId}-uploaded-retry-${retryCount}`,
        name: 'bill.uploaded',
        data: {
          auditId: data.id,
          userId: data.user_id,
          storagePath: data.storage_path,
          retryCount,
        },
      });
    } catch (sendErr) {
      Sentry.captureException(sendErr, {
        tags: { surface: 'audits.retry.inngest_send' },
        extra: { auditId },
      });
      try {
        await rollbackPendingRetry(
          admin,
          auditId,
          data.failure_reason,
          data.retry_count,
          nextRetryCount,
        );
        if (creditReconsumed) {
          const { error: refundErr } = await admin.rpc('refund_failed_audit', {
            p_audit_id: auditId,
            p_user_id: user.id,
          });
          if (refundErr) {
            Sentry.captureException(refundErr, {
              tags: { surface: 'audits.retry.refund_after_enqueue_fail' },
              extra: { auditId, userId: user.id },
            });
          }
        }
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
