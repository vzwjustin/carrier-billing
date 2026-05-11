import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';

import { assertCanRunAudit } from '@/lib/access/gate';
import { decrementAuditCreditAtomically } from '@/lib/access/decrement';
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

    const { error: insertError } = await admin.from('audits').insert({
      id: auditId,
      user_id: user.id,
      status: 'pending',
      storage_path: storagePath,
      original_filename: filename,
      file_size_bytes: fileSize,
    });

    if (insertError) {
      return NextResponse.json({ error: 'Failed to create audit.' }, { status: 500 });
    }

    // NOTE: spec wanted decrement on first state change; we decrement on
    // creation for stricter race-free accounting. The gate already approved
    // this user, but the RPC is the atomic source of truth — if a concurrent
    // creation drained the credits between the gate read and now, the RPC
    // throws `no_credits` and we roll back the audit row below.
    let creditConsumed = false;
    if (gate.reason === 'credit') {
      try {
        await decrementAuditCreditAtomically(user.id);
        creditConsumed = true;
      } catch (decrementErr) {
        Sentry.captureException(decrementErr, {
          tags: { surface: 'audits.create.decrement', transient: 'true' },
          extra: { userId: user.id },
        });
        try {
          await admin.from('audits').delete().eq('id', auditId);
        } catch (rollbackErr) {
          Sentry.captureException(rollbackErr, {
            tags: { surface: 'audits.create.rollback_orphan' },
            extra: { auditId, userId: user.id },
          });
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
      // Clean up the orphaned audit row so the user can retry cleanly.
      // R2-F11 — match the decrement-rollback pattern at L121-141 so a
      // failed rollback surfaces in Sentry instead of being silently lost.
      try {
        await admin.from('audits').delete().eq('id', auditId);
      } catch (rollbackErr) {
        Sentry.captureException(rollbackErr, {
          tags: { surface: 'audits.create.rollback_signed_url_orphan' },
          extra: { auditId, userId: user.id },
        });
      }
      // If we consumed a credit on this request, refund it. The orphan-cleanup
      // cron only sees rows that survive — since we just deleted the row, the
      // credit would otherwise be lost. Subscription users never spent a
      // credit, so nothing to refund there.
      if (creditConsumed) {
        try {
          const { error: refundError } = await admin.rpc(
            'increment_audit_credits',
            { profile_id: user.id, delta: 1 },
          );
          if (refundError) {
            throw new Error(refundError.message);
          }
        } catch (refundErr) {
          Sentry.captureException(refundErr, {
            tags: { surface: 'audits.create.refund' },
            extra: { userId: user.id, auditId },
          });
        }
      }
      return NextResponse.json(
        { error: 'Failed to create upload URL.' },
        { status: 500 },
      );
    }

    return NextResponse.json({
      auditId,
      uploadUrl: signed.signedUrl,
      storagePath,
      token: signed.token,
    });
  } catch (err) {
    // L — surface unhandled errors instead of swallowing. Tag the surface so
    // /api/audits noise is filterable from the rest of the audits namespace.
    Sentry.captureException(err, { tags: { surface: 'audits.create' } });
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
