import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';

import { assertCanRunAudit } from '@/lib/access/gate';
import { consumeAuditCreditForAudit } from '@/lib/access/decrement';
import { scrubString } from '@/lib/observability/redact';
import { logTrailEvent } from '@/lib/audit-trail/log';
import { consumeRateLimit, rateLimitedResponse } from '@/lib/security/rate-limit';
import { getAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB

const CreateAuditSchema = z.object({
  filename: z.string().min(1, 'filename is required').max(255, 'filename is too long'),
  fileSize: z.number().int().positive().max(MAX_BYTES, 'file is larger than 25 MB'),
});

const SAFE_FILENAME_RE = /[^A-Za-z0-9._-]+/g;

/** Extensions accepted at the upload route. EDI 811 files come in as plain
 *  ASCII; the worker also content-sniffs to guard against confused extensions. */
const ACCEPTED_EXTENSIONS = ['.pdf', '.edi', '.x12', '.811', '.txt'] as const;

async function refundConsumedCredit(
  admin: ReturnType<typeof getAdminClient>,
  userId: string,
  auditId: string,
  surface: string,
): Promise<void> {
  try {
    // Use the row-anchored, idempotent `refund_orphan_audit` RPC rather than a
    // bare `increment_audit_credits(+1)`. It flips `credit_consumed` true→false
    // AND increments the balance in one atomic statement, gated on
    // (status='pending' AND credit_consumed=true). That gate makes a second
    // call (e.g. the orphan-cleanup cron, or a request retry) a no-op on the
    // credit, so it can never double-refund — which is why the caller refunds
    // BEFORE deleting the row (the row must still exist for the RPC to match).
    const { error } = await admin.rpc('refund_orphan_audit', {
      p_audit_id: auditId,
      p_user_id: userId,
      p_reason: 'create_rollback',
    });
    if (error) {
      throw new Error(error.message);
    }
  } catch (err) {
    Sentry.captureException(err, {
      tags: { surface },
      extra: { userId, auditId },
    });
  }
}

async function deleteAuditRowBestEffort(
  admin: ReturnType<typeof getAdminClient>,
  userId: string,
  auditId: string,
  surface: string,
): Promise<void> {
  try {
    const { error } = await admin.from('audits').delete().eq('id', auditId);
    if (error) {
      throw new Error(error.message);
    }
  } catch (err) {
    Sentry.captureException(err, {
      tags: { surface },
      extra: { auditId, userId },
    });
  }
}

function isAcceptedFilename(filename: string): boolean {
  const lower = filename.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function safeFilename(input: string): string {
  // Strip any directory components and unsafe characters.
  const base = input.split(/[\\/]/).pop() ?? input;
  const cleaned = base.replace(SAFE_FILENAME_RE, '_');
  // Cap length so the path can't blow past Postgres limits.
  return cleaned.slice(0, 200) || 'bill.pdf';
}

export async function POST(request: Request): Promise<Response> {
  let bodyJson: unknown;
  try {
    bodyJson = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const parsed = CreateAuditSchema.safeParse(bodyJson);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json({ error: first?.message ?? 'Invalid request.' }, { status: 400 });
  }

  const { filename, fileSize } = parsed.data;

  if (!isAcceptedFilename(filename)) {
    return NextResponse.json({ error: 'Only PDF or EDI 811 files are accepted.' }, { status: 400 });
  }

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    }

    const limit = await consumeRateLimit({
      key: `audit-create:${user.id}`,
      limit: 20,
      windowSeconds: 60 * 60,
    });
    if (!limit.ok) {
      return rateLimitedResponse(limit.resetAt);
    }

    // Phase 4 access gate. Runs BEFORE we create the audit row so a user
    // without a plan or credits never gets a row at all.
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

    const auditId = crypto.randomUUID();
    const cleanName = safeFilename(filename);
    const storagePath = `${user.id}/${auditId}/${cleanName}`;
    const admin = getAdminClient();

    let creditConsumed = false;
    const auditRow: Record<string, unknown> = {
      id: auditId,
      user_id: user.id,
      status: 'pending',
      credit_consumed: false,
      storage_path: storagePath,
      original_filename: filename,
      file_size_bytes: fileSize,
    };
    let { error: insertError } = await admin.from('audits').insert(auditRow);

    // Dev-only safety: migration 0016 adds `audits.credit_consumed`. If that
    // migration hasn't been applied yet, PostgREST returns PGRST204 ("column
    // not found in schema cache") and Postgres direct returns 42703. Retry
    // once without the field so local dev can keep moving; production keeps
    // the strict error path so a real schema drift surfaces — unless the
    // operator opts in via ALLOW_PARTIAL_SCHEMA=1 (demo environments).
    const allowPartialSchema =
      process.env.NODE_ENV !== 'production' || process.env.ALLOW_PARTIAL_SCHEMA === '1';
    if (
      insertError &&
      allowPartialSchema &&
      String((insertError as { message?: string }).message ?? '').includes('credit_consumed') &&
      ((insertError as { code?: string }).code === '42703' ||
        (insertError as { code?: string }).code === 'PGRST204')
    ) {
      console.warn(
        '[audits.create] `audits.credit_consumed` column missing — retrying insert ' +
          'without it (dev only). Apply migration 0016 to restore strict mode.',
      );
      const { credit_consumed: _omit, ...withoutFlag } = auditRow;
      void _omit;
      const retry = await admin.from('audits').insert(withoutFlag);
      insertError = retry.error;
    }

    if (insertError) {
      console.error('[audits.create] insert failed:', {
        code: (insertError as { code?: string }).code,
        message: scrubString(
          (insertError as { message?: string }).message ?? 'unknown',
        ),
        details: scrubString(
          (insertError as { details?: string }).details ?? 'unknown',
        ),
      });
      return NextResponse.json({ error: 'Failed to create audit.' }, { status: 500 });
    }

    // H4: atomic-once decrement anchored to this audit row. The RPC flips
    // `audits.credit_consumed: false → true` AND decrements profiles in a
    // single statement. If the RPC committed server-side but the client
    // never saw the response, a retry finds credit_consumed=true and is
    // returned `idempotent=true` instead of throwing — no lost credits.
    //
    // The gate at L118 already approved the user, but the RPC is the
    // atomic source of truth — if a concurrent request drained credits
    // between the gate read and now, the RPC throws `no_credits` and we
    // roll back the audit row below.
    if (gate.reason === 'credit') {
      try {
        await consumeAuditCreditForAudit(user.id, auditId);
        creditConsumed = true;
      } catch (decrementErr) {
        const isDefinitiveRefusal =
          decrementErr instanceof Error &&
          decrementErr.message === 'no_credits';
        Sentry.captureException(decrementErr, {
          tags: {
            surface: 'audits.create.decrement',
            transient: isDefinitiveRefusal ? 'false' : 'true',
          },
          extra: { userId: user.id, auditId },
        });
        if (isDefinitiveRefusal) {
          // The RPC ran and definitively refused — user has 0 credits,
          // or audit row state was wrong. Roll back the audit row; no
          // credit was decremented so no refund is needed.
          await deleteAuditRowBestEffort(
            admin,
            user.id,
            auditId,
            'audits.create.rollback_orphan',
          );
        }
        // For transient errors (network drop between RPC commit and
        // response, PostgREST 5xx, etc.) we deliberately LEAVE the audit
        // row in place with status='pending'. If the RPC actually
        // committed server-side, `credit_consumed=true` will be set;
        // the orphan-cleanup cron sweeps such rows after 30 minutes and
        // refunds the credit. If the RPC failed before committing, the
        // row sits idle with `credit_consumed=false`, and orphan-
        // cleanup will also reap it (no refund path needed — credit
        // was never decremented). Either way, no credit is lost.
        return NextResponse.json(
          {
            error: 'no_plan',
            message: 'No active plan or audit credits.',
            upgrade_url: '/pricing',
          },
          { status: 402 },
        );
      }
    }

    // M-A2 — pin a 15-minute upload window. Long enough to absorb retries,
    // slow networks, and 25 MB uploads on consumer connections; short enough
    // that orphan rows from abandoned uploads don't pile up indefinitely.
    // The storage-js typings only expose `{ upsert }`, but the underlying
    // Storage REST endpoint accepts `expiresIn` (seconds) on the body — we
    // pass it via a typed cast so the explicit TTL travels to the server.
    const SIGNED_UPLOAD_TTL_SECONDS = 60 * 15;
    const signedUploadOptions = { expiresIn: SIGNED_UPLOAD_TTL_SECONDS } as unknown as {
      upsert: boolean;
    };
    const { data: signed, error: signError } = await admin.storage
      .from('bills')
      .createSignedUploadUrl(storagePath, signedUploadOptions);

    if (signError || !signed) {
      console.error('[audits.create] signed URL failed:', {
        code: (signError as { code?: string } | null)?.code,
        message: scrubString(
          (signError as { message?: string } | null)?.message ?? 'unknown',
        ),
        name: scrubString(
          (signError as { name?: string } | null)?.name ?? 'unknown',
        ),
      });
      // Refund FIRST, while the row still exists, so the idempotent
      // `refund_orphan_audit` RPC can match it (status='pending' AND
      // credit_consumed=true) and atomically flip the flag + restore the
      // credit. Doing this before the delete closes the crash-window leak:
      // previously a crash between delete and refund lost the credit, and
      // reordering naively with a bare increment would risk a double-refund
      // from the orphan-cleanup cron — the flag-gated RPC avoids both.
      // Subscription users never spent a credit, so nothing to refund there.
      if (creditConsumed) {
        await refundConsumedCredit(admin, user.id, auditId, 'audits.create.refund');
      }
      // Then clean up the orphaned row so the user can retry cleanly.
      // R2-F11 — best-effort delete surfaces failures in Sentry rather than
      // silently losing them. If this delete is the step that crashes, the row
      // lingers as status='failed' with credit_consumed=false, which the
      // orphan-cleanup cron ignores (it targets stale 'pending' rows) — no
      // leak, no double-refund.
      await deleteAuditRowBestEffort(
        admin,
        user.id,
        auditId,
        'audits.create.rollback_signed_url_orphan',
      );
      return NextResponse.json(
        { error: 'Failed to create upload URL.' },
        { status: 500 },
      );
    }

    await logTrailEvent({ userId: user.id, eventType: 'audit_uploaded', entityType: 'audit', entityId: auditId, metadata: { source: 'pdf', file_size_bytes: fileSize }, actorEmail: user.email ?? null });

    return NextResponse.json({
      auditId,
      uploadUrl: signed.signedUrl,
      storagePath,
      token: signed.token,
    });
  } catch (err) {
    console.error(
      '[audits.create] caught:',
      scrubString(err instanceof Error ? err.message : String(err)),
    );
    // L — surface unhandled errors instead of swallowing. Tag the surface so
    // /api/audits noise is filterable from the rest of the audits namespace.
    Sentry.captureException(err, { tags: { surface: 'audits.create' } });
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
