import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { inngest } from '@/inngest/client';
import { assertCanStartPendingAudit } from '@/lib/access/gate';
import { consumeRateLimit, rateLimitedResponse } from '@/lib/security/rate-limit';
import { scrubString } from '@/lib/observability/redact';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ParamsSchema = z.object({
  id: z.string().uuid(),
});

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

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

function getStorageObjectSize(value: unknown): number | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.size === 'number') return v.size;
  const metadata = v.metadata;
  if (typeof metadata === 'object' && metadata !== null) {
    const size = (metadata as Record<string, unknown>).size;
    if (typeof size === 'number') return size;
  }
  return null;
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
      // RLS should already have hidden this, but belt-and-suspenders.
      return NextResponse.json({ error: 'Audit not found.' }, { status: 404 });
    }
    if (data.status !== 'pending') {
      return NextResponse.json({ error: `Audit is already ${data.status}.` }, { status: 409 });
    }

    const rateLimit = await consumeRateLimit({
      key: `audit-start:${user.id}`,
      limit: 10,
      windowSeconds: 60 * 60,
    });
    if (!rateLimit.ok) {
      return rateLimitedResponse(rateLimit.resetAt);
    }

    const startGate = await assertCanStartPendingAudit(user.id);
    if (!startGate.ok) {
      return NextResponse.json(
        {
          error: 'subscription_past_due',
          message:
            'Your subscription is past due. Please update payment before starting this audit.',
        },
        { status: 402 },
      );
    }

    const info = await supabase.storage.from('bills').info(data.storage_path);
    if (info.error || !info.data) {
      return NextResponse.json({ error: 'upload_missing' }, { status: 409 });
    }
    const uploadedSize = getStorageObjectSize(info.data);
    if (uploadedSize === null) {
      return NextResponse.json(
        { error: 'Failed to verify upload.' },
        { status: 500 },
      );
    }
    if (uploadedSize > MAX_UPLOAD_BYTES) {
      return NextResponse.json({ error: 'upload_too_large' }, { status: 413 });
    }

    // B2 — idempotency key. Browser/proxy retries (or a duplicate /start POST)
    // must not enqueue the worker twice. Inngest dedupes events with the same
    // `id` for ~24h. First upload uses `${auditId}-uploaded`; retried audits
    // (retry_count > 0 after POST /retry) must use the retry-scoped key so a
    // second worker run is not collapsed onto the original upload event.
    const uploadEventId =
      data.retry_count === 0
        ? `${auditId}-uploaded`
        : `${auditId}-uploaded-retry-${data.retry_count}`;
    try {
      await inngest.send({
        id: uploadEventId,
        name: 'bill.uploaded',
        data: {
          auditId: data.id,
          userId: data.user_id,
          storagePath: data.storage_path,
          retryCount: data.retry_count,
        },
      });
    } catch (sendErr) {
      const safeMessage = scrubString(sendErr instanceof Error ? sendErr.message : String(sendErr));
      console.error('[audits.start] inngest.send failed:', safeMessage);
      Sentry.captureException(new Error(safeMessage), {
        tags: { surface: 'audits.start.inngest_send' },
        extra: { auditId },
      });
      return NextResponse.json(
        { error: 'Failed to enqueue background job. Is the Inngest dev server running?' },
        { status: 502 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    const safeMessage = scrubString(err instanceof Error ? err.message : String(err));
    console.error('[audits.start] unhandled error:', safeMessage);
    Sentry.captureException(new Error(safeMessage), {
      tags: { surface: 'audits.start' },
      extra: { auditId },
    });
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
