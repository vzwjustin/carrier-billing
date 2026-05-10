/**
 * Inbound email webhook for forwarded carrier bills.
 *
 * Provider-agnostic: any inbound-email provider (Resend Inbound, Postmark
 * Inbound, SendGrid Inbound Parse, Cloudmailin) that can be configured to
 *
 *   1. POST a JSON body of shape:
 *      { to, from, subject, attachments: [{ filename, content_type, content_base64 }] }
 *   2. Sign the body with HMAC-SHA256 (hex) under the shared secret
 *      `INBOUND_EMAIL_SECRET`, sent as `X-Inbound-Signature: <hex>`
 *
 * …will work. We don't pull provider-specific event headers because the
 * payload shape is the only thing we depend on.
 *
 * Flow:
 *   1. Reject oversize payloads via Content-Length BEFORE reading the body.
 *   2. Verify signature (constant-time).
 *   3. Parse `to` → token → user via `profiles.inbound_email_token`.
 *   4. Run access gate (skip + log if user is past_due / out of credits —
 *      we don't 4xx the provider, just no-op).
 *   5. Decode the first PDF attachment.
 *   6. Insert dedupe row (sha256 over `${userId}|${pdfSha256}|${filename}`)
 *      BEFORE storage upload — flipping a whitespace byte in the email body
 *      should not bypass dedupe.
 *   7. Upload to Supabase Storage `bills/<userId>/<auditId>/<filename>`.
 *   8. Insert `audits` row + decrement credits (if applicable).
 *   9. Send `bill.uploaded` Inngest event with idempotency key
 *      `${auditId}-uploaded`. The existing pipeline takes over from there.
 *
 * Failure semantics: we always return 200 to the provider once the request
 * is authenticated, even if processing fails. Providers retry indefinitely
 * on 5xx, which would be worse than dropping a single email and surfacing
 * via Sentry.
 */
import { createHash } from 'node:crypto';

import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { env } from '@/env';
import { inngest } from '@/inngest/client';
import { decrementAuditCreditAtomically } from '@/lib/access/decrement';
import { assertCanRunAudit } from '@/lib/access/gate';
import { parseInboundRecipient, verifyHmac } from '@/lib/inbound/token';
import { getAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_PDF_BYTES = 25 * 1024 * 1024; // 25 MB — same cap as /api/audits
// Allow base64 overhead (~33%) plus JSON/headers slack on top of the PDF cap.
// Anything larger than this in raw bytes is rejected before we even read it.
const MAX_REQUEST_BYTES = 40 * 1024 * 1024;

const InboundAttachmentSchema = z.object({
  filename: z.string().min(1).max(255),
  content_type: z.string().min(1).max(255),
  content_base64: z.string().min(1),
});

const InboundEmailSchema = z.object({
  to: z.string().min(3).max(512),
  from: z.string().min(3).max(512).optional(),
  subject: z.string().max(998).optional(),
  attachments: z.array(InboundAttachmentSchema).max(10),
});

const SAFE_FILENAME_RE = /[^A-Za-z0-9._-]+/g;

function safeFilename(input: string): string {
  const base = input.split(/[\\/]/).pop() ?? input;
  const cleaned = base.replace(SAFE_FILENAME_RE, '_');
  return cleaned.slice(0, 200) || 'bill.pdf';
}

function isPdfAttachment(att: { content_type: string; filename: string }): boolean {
  if (att.content_type.toLowerCase() === 'application/pdf') return true;
  return att.filename.toLowerCase().endsWith('.pdf');
}

/**
 * Stable dedupe hash over the *PDF content* (not the wrapping email payload).
 * Hashing the raw HTTP body would let a forger flip a whitespace byte to
 * bypass dedupe and re-upload the same bill repeatedly. The triple
 * `userId|pdfSha256|normalizedFilename` is what we actually want to be unique.
 */
function computeEventHash(
  userId: string,
  pdfBytes: Buffer,
  filename: string,
): string {
  const pdfSha256 = createHash('sha256').update(pdfBytes).digest('hex');
  const normalizedFilename = safeFilename(filename).toLowerCase();
  return createHash('sha256')
    .update(`${userId}|${pdfSha256}|${normalizedFilename}`)
    .digest('hex');
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'
  );
}

export async function POST(request: Request): Promise<Response> {
  const secret = env.INBOUND_EMAIL_SECRET;
  if (!secret) {
    // Feature not configured — refuse to process. Returning 503 is correct
    // here since the request itself is well-formed; the operator just hasn't
    // turned it on. Providers won't retry forever on 503 but they shouldn't
    // be sending us anything in this case anyway.
    return NextResponse.json({ error: 'inbound_disabled' }, { status: 503 });
  }

  // Bound the read BEFORE pulling the body into memory. A multi-GB junk POST
  // could otherwise OOM us on a serverless runtime. Reject 411 if missing.
  const contentLengthHeader = request.headers.get('content-length');
  if (!contentLengthHeader) {
    return NextResponse.json({ error: 'missing_content_length' }, { status: 411 });
  }
  const contentLength = Number(contentLengthHeader);
  if (
    !Number.isFinite(contentLength) ||
    contentLength <= 0 ||
    contentLength > MAX_REQUEST_BYTES
  ) {
    return NextResponse.json({ error: 'payload_too_large' }, { status: 413 });
  }

  const signature = request.headers.get('x-inbound-signature');
  if (!signature) {
    return NextResponse.json({ error: 'missing_signature' }, { status: 401 });
  }

  // Read raw body so HMAC matches whatever the provider signed (re-stringifying
  // a parsed JSON would mutate whitespace and break the signature).
  const raw = await request.text();

  if (!verifyHmac(raw, signature, secret)) {
    return NextResponse.json({ error: 'invalid_signature' }, { status: 401 });
  }

  let bodyJson: unknown;
  try {
    bodyJson = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const parsed = InboundEmailSchema.safeParse(bodyJson);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Past this point we always 200 the provider. Errors go to Sentry; the
  // user sees nothing happen which is the correct UX (a malformed forwarded
  // email shouldn't loop forever in the provider's retry queue).
  // ─────────────────────────────────────────────────────────────────────────
  try {
    const recipient = parseInboundRecipient(parsed.data.to);
    if (!recipient) {
      Sentry.captureMessage('inbound: unparseable recipient', {
        level: 'warning',
      });
      return NextResponse.json({ ok: true, skipped: 'bad_recipient' });
    }

    const admin = getAdminClient();
    const { data: profile, error: profileErr } = await admin
      .from('profiles')
      .select('id')
      .eq('inbound_email_token', recipient.token)
      .maybeSingle();

    if (profileErr) {
      throw new Error(`profile lookup failed: ${profileErr.message}`);
    }
    if (!profile) {
      Sentry.captureMessage('inbound: token not found', {
        level: 'warning',
        extra: { tokenLength: recipient.token.length },
      });
      return NextResponse.json({ ok: true, skipped: 'unknown_token' });
    }
    const userId = (profile as { id: string }).id;

    // Find first PDF attachment. Carriers occasionally email a body-only
    // notification with the bill linked but not attached; skip those.
    const pdf = parsed.data.attachments.find(isPdfAttachment);
    if (!pdf) {
      Sentry.captureMessage('inbound: no PDF attachment', {
        level: 'info',
      });
      return NextResponse.json({ ok: true, skipped: 'no_pdf' });
    }

    const bytes = Buffer.from(pdf.content_base64, 'base64');
    if (bytes.length === 0) {
      return NextResponse.json({ ok: true, skipped: 'empty_attachment' });
    }
    if (bytes.length > MAX_PDF_BYTES) {
      return NextResponse.json({ ok: true, skipped: 'attachment_too_large' });
    }

    // Gate the user. past_due / no_plan → log + skip rather than ingest a
    // bill we can't audit.
    const gate = await assertCanRunAudit(userId);
    if (!gate.ok) {
      Sentry.captureMessage('inbound: gate denied', {
        level: 'info',
        extra: { reason: gate.reason },
      });
      return NextResponse.json({ ok: true, skipped: `gate_${gate.reason}` });
    }

    // Compute the dedupe key over the actual PDF bytes + user + filename.
    // Hashing the raw email body (previous behavior) was forgeable: any
    // whitespace flip changed the hash. The triple here is the real "same
    // bill?" question.
    const eventHash = computeEventHash(userId, bytes, pdf.filename);

    // Insert the dedupe row BEFORE storage upload so a duplicate forward
    // doesn't leave behind an orphaned object. On 23505 the row already
    // exists — short-circuit.
    const dedupeInsert = await admin.from('inbound_email_events').insert({
      event_hash: eventHash,
      user_id: userId,
    });
    if (dedupeInsert.error) {
      if (isUniqueViolation(dedupeInsert.error)) {
        return NextResponse.json({ ok: true, deduped: true });
      }
      throw new Error(`inbound dedupe insert failed: ${dedupeInsert.error.message}`);
    }

    const auditId = crypto.randomUUID();
    const cleanName = safeFilename(pdf.filename);
    const storagePath = `${userId}/${auditId}/${cleanName}`;

    const { error: uploadErr } = await admin.storage.from('bills').upload(storagePath, bytes, {
      contentType: 'application/pdf',
      upsert: false,
    });
    if (uploadErr) {
      throw new Error(`storage upload failed: ${uploadErr.message}`);
    }

    const { error: insertErr } = await admin.from('audits').insert({
      id: auditId,
      user_id: userId,
      status: 'pending',
      storage_path: storagePath,
      original_filename: pdf.filename,
      file_size_bytes: bytes.length,
    });
    if (insertErr) {
      // Roll back the storage upload so we don't leak orphaned objects.
      await admin.storage.from('bills').remove([storagePath]);
      throw new Error(`audit insert failed: ${insertErr.message}`);
    }

    const dedupeUpdate = await admin
      .from('inbound_email_events')
      .update({ audit_id: auditId })
      .eq('event_hash', eventHash);
    if (dedupeUpdate.error) {
      Sentry.captureException(dedupeUpdate.error, {
        tags: { surface: 'inbound.email.dedupe_update' },
        extra: { userId, auditId },
      });
    }

    if (gate.reason === 'credit') {
      try {
        await decrementAuditCreditAtomically(userId);
      } catch (decErr) {
        // Race lost: someone else drained credits between gate + decrement.
        // Roll the audit row back so the user can retry without waste.
        await admin.from('audits').delete().eq('id', auditId);
        await admin.storage.from('bills').remove([storagePath]);
        Sentry.captureException(decErr, {
          tags: { surface: 'inbound.email.decrement' },
          extra: { userId },
        });
        return NextResponse.json({ ok: true, skipped: 'credit_race' });
      }
    }

    await inngest.send({
      id: `${auditId}-uploaded`,
      name: 'bill.uploaded',
      data: { auditId, userId, storagePath },
    });

    return NextResponse.json({ ok: true, auditId });
  } catch (err) {
    Sentry.captureException(err, { tags: { surface: 'inbound.email' } });
    // Still 200 so the provider doesn't retry. The orphan-audit cleanup cron
    // would catch any half-created rows.
    return NextResponse.json({ ok: true, skipped: 'internal_error' });
  }
}
