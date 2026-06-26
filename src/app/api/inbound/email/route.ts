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
 *   1. Reject oversize payloads with a hard stream byte cap.
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
import { consumeAuditCreditForAudit } from '@/lib/access/decrement';
import { assertCanRunAudit } from '@/lib/access/gate';
import { parseInboundRecipient, verifyHmac } from '@/lib/inbound/token';
import { consumeRateLimit } from '@/lib/security/rate-limit';
import { getAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_PDF_BYTES = 25 * 1024 * 1024; // 25 MB — same cap as /api/audits
// Allow base64 overhead (~33%) plus JSON/headers slack on top of the PDF cap.
// Anything larger than this in raw bytes is rejected before we even read it.
const MAX_REQUEST_BYTES = 40 * 1024 * 1024;
const PDF_MAGIC = Buffer.from('%PDF', 'ascii');

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

async function readRawBodyWithLimit(request: Request, maxBytes: number): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return null;

  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks, total).toString('utf8');
}

function safeFilename(input: string): string {
  const base = input.split(/[\\/]/).pop() ?? input;
  const cleaned = base.replace(SAFE_FILENAME_RE, '_');
  return cleaned.slice(0, 200) || 'bill.pdf';
}

function isPdfAttachment(att: { content_type: string; filename: string }): boolean {
  if (att.content_type.toLowerCase() === 'application/pdf') return true;
  return att.filename.toLowerCase().endsWith('.pdf');
}

function decodeBase64Attachment(value: string): Buffer | null {
  const normalized = value.replace(/\s/g, '');
  if (normalized.length === 0) return Buffer.alloc(0);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return null;
  const remainder = normalized.length % 4;
  if (remainder === 1) return null;
  const padded = remainder === 0 ? normalized : `${normalized}${'='.repeat(4 - remainder)}`;
  return Buffer.from(padded, 'base64');
}

function hasPdfMagic(bytes: Buffer): boolean {
  return bytes.length >= PDF_MAGIC.length && bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);
}

/**
 * Stable dedupe hash over the *PDF content* (not the wrapping email payload).
 * Hashing the raw HTTP body would let a forger flip a whitespace byte to
 * bypass dedupe and re-upload the same bill repeatedly. The triple
 * `userId|pdfSha256|normalizedFilename` is what we actually want to be unique.
 */
function computeEventHash(userId: string, pdfBytes: Buffer, filename: string): string {
  const pdfSha256 = createHash('sha256').update(pdfBytes).digest('hex');
  const normalizedFilename = safeFilename(filename).toLowerCase();
  return createHash('sha256').update(`${userId}|${pdfSha256}|${normalizedFilename}`).digest('hex');
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'
  );
}

async function releaseDedupeClaim(eventHash: string): Promise<void> {
  try {
    const admin = getAdminClient();
    const { error } = await admin.from('inbound_email_events').delete().eq('event_hash', eventHash);
    if (error) {
      throw new Error(error.message);
    }
  } catch (err) {
    Sentry.captureException(err, {
      tags: { surface: 'inbound.email.dedupe_release' },
    });
  }
}

async function failPendingAuditAndRefundIfNeeded(
  admin: ReturnType<typeof getAdminClient>,
  {
    auditId,
    userId,
    reason,
  }: {
    auditId: string;
    userId: string;
    reason: string;
  },
): Promise<void> {
  const { error } = await admin.rpc('refund_orphan_audit', {
    p_audit_id: auditId,
    p_user_id: userId,
    p_reason: reason,
  });
  if (error) {
    throw new Error(`refund_orphan_audit failed: ${error.message}`);
  }
}

async function deleteAuditRowBestEffort(
  admin: ReturnType<typeof getAdminClient>,
  auditId: string,
  userId: string,
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

async function removeBillObjectBestEffort(
  admin: ReturnType<typeof getAdminClient>,
  storagePath: string,
  auditId: string,
  userId: string,
  surface: string,
): Promise<void> {
  try {
    const { error } = await admin.storage.from('bills').remove([storagePath]);
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

export async function POST(request: Request): Promise<Response> {
  const secret = env.INBOUND_EMAIL_SECRET;
  if (!secret) {
    // Feature not configured — refuse to process. Returning 503 is correct
    // here since the request itself is well-formed; the operator just hasn't
    // turned it on. Providers won't retry forever on 503 but they shouldn't
    // be sending us anything in this case anyway.
    return NextResponse.json({ error: 'inbound_disabled' }, { status: 503 });
  }

  // Bound the read before concatenating the request body. Content-Length is
  // checked as a cheap early reject, but the stream cap is authoritative.
  const contentLengthHeader = request.headers.get('content-length');
  if (!contentLengthHeader) {
    return NextResponse.json({ error: 'missing_content_length' }, { status: 411 });
  }
  const contentLength = Number(contentLengthHeader);
  if (!Number.isFinite(contentLength) || contentLength <= 0 || contentLength > MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: 'payload_too_large' }, { status: 413 });
  }

  const signature = request.headers.get('x-inbound-signature');
  if (!signature) {
    return NextResponse.json({ error: 'missing_signature' }, { status: 401 });
  }

  const raw = await readRawBodyWithLimit(request, MAX_REQUEST_BYTES);
  if (raw === null) {
    return NextResponse.json({ error: 'payload_too_large' }, { status: 413 });
  }

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
  let claimedDedupeHash: string | null = null;
  try {
    const recipient = parseInboundRecipient(parsed.data.to);
    if (!recipient) {
      Sentry.captureMessage('inbound: unparseable recipient', {
        level: 'warning',
      });
      return NextResponse.json({ ok: true, skipped: 'bad_recipient' });
    }

    const expectedDomain = env.INBOUND_EMAIL_DOMAIN?.toLowerCase();
    if (expectedDomain && recipient.domain !== expectedDomain) {
      Sentry.captureMessage('inbound: recipient domain mismatch', {
        level: 'warning',
      });
      return NextResponse.json({ ok: true, skipped: 'bad_recipient_domain' });
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

    // H-3: per-user rate limit on the inbound email path. The HTTP
    // POST /api/audits route is rate-limited at 20/hr/user; this surface
    // must mirror it so a subscription user (no per-audit credit cost)
    // can't be used as a vector to DOS the Inngest workers / burn LLM
    // credits by spamming the inbound provider.
    const limit = await consumeRateLimit({
      key: `inbound:${userId}`,
      limit: 20,
      windowSeconds: 60 * 60,
    });
    if (!limit.ok) {
      return NextResponse.json({ ok: true, skipped: 'rate_limited' });
    }

    // Find first PDF attachment. Carriers occasionally email a body-only
    // notification with the bill linked but not attached; skip those.
    const pdf = parsed.data.attachments.find(isPdfAttachment);
    if (!pdf) {
      Sentry.captureMessage('inbound: no PDF attachment', {
        level: 'info',
      });
      return NextResponse.json({ ok: true, skipped: 'no_pdf' });
    }

    const bytes = decodeBase64Attachment(pdf.content_base64);
    if (!bytes) {
      return NextResponse.json({ ok: true, skipped: 'invalid_attachment' });
    }
    if (bytes.length === 0) {
      return NextResponse.json({ ok: true, skipped: 'empty_attachment' });
    }
    if (bytes.length > MAX_PDF_BYTES) {
      return NextResponse.json({ ok: true, skipped: 'attachment_too_large' });
    }
    if (!hasPdfMagic(bytes)) {
      return NextResponse.json({ ok: true, skipped: 'non_pdf_attachment' });
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

    // L3: pre-generate the auditId so the dedupe row can be inserted with
    // its `audit_id` already populated. The previous flow inserted the
    // dedupe row with NULL `audit_id`, inserted the audit, then UPDATEd
    // the dedupe row — leaving a window where a concurrent duplicate
    // request found the dedupe row but couldn't observe the audit_id.
    //
    // Order:
    //   1. Insert the audits row (no storage yet — cheap to roll back).
    //   2. Insert the dedupe row WITH audit_id (FK valid). 23505 here
    //      means a concurrent duplicate beat us: roll back the audits row
    //      and short-circuit.
    //   3. Upload to storage.
    // Storage upload is last so a 23505 cannot orphan an object.
    const auditId = crypto.randomUUID();
    const cleanName = safeFilename(pdf.filename);
    const storagePath = `${userId}/${auditId}/${cleanName}`;

    const { error: insertErr } = await admin.from('audits').insert({
      id: auditId,
      user_id: userId,
      status: 'pending',
      credit_consumed: false,
      storage_path: storagePath,
      original_filename: pdf.filename,
      file_size_bytes: bytes.length,
    });
    if (insertErr) {
      throw new Error(`audit insert failed: ${insertErr.message}`);
    }

    const dedupeInsert = await admin.from('inbound_email_events').insert({
      event_hash: eventHash,
      user_id: userId,
      audit_id: auditId,
    });
    if (dedupeInsert.error) {
      if (isUniqueViolation(dedupeInsert.error)) {
        // Concurrent duplicate beat us. Roll back the audits row we just
        // created — no storage object exists yet so nothing else to clean.
        await deleteAuditRowBestEffort(
          admin,
          auditId,
          userId,
          'inbound.email.rollback_orphan_audit',
        );
        return NextResponse.json({ ok: true, deduped: true });
      }
      // Non-23505: roll back and surface to outer catch.
      await deleteAuditRowBestEffort(
        admin,
        auditId,
        userId,
        'inbound.email.rollback_dedupe_insert_failed',
      );
      throw new Error(`inbound dedupe insert failed: ${dedupeInsert.error.message}`);
    }

    claimedDedupeHash = eventHash;

    const { error: uploadErr } = await admin.storage.from('bills').upload(storagePath, bytes, {
      contentType: 'application/pdf',
      upsert: false,
    });
    if (uploadErr) {
      // Roll back audit row; releaseDedupeClaim in the outer catch frees
      // the dedupe row.
      await deleteAuditRowBestEffort(
        admin,
        auditId,
        userId,
        'inbound.email.rollback_storage_upload_failed',
      );
      throw new Error(`storage upload failed: ${uploadErr.message}`);
    }

    if (gate.reason === 'credit') {
      try {
        await consumeAuditCreditForAudit(userId, auditId);
      } catch (decErr) {
        // H4: distinguish definitive refusal (`no_credits` from the RPC,
        // meaning the user actually has 0 credits or the audit row is in
        // the wrong state) from transient errors (network drop between
        // RPC commit and client response). Only roll back / release the
        // dedupe claim for definitive refusal. Transient errors leave
        // the row pending so orphan-cleanup can refund if the RPC did
        // commit server-side.
        const isDefinitiveRefusal = decErr instanceof Error && decErr.message === 'no_credits';
        Sentry.captureException(decErr, {
          tags: {
            surface: 'inbound.email.decrement',
            transient: isDefinitiveRefusal ? 'false' : 'true',
          },
          extra: { userId, auditId },
        });
        if (isDefinitiveRefusal) {
          await deleteAuditRowBestEffort(
            admin,
            auditId,
            userId,
            'inbound.email.rollback_credit_race_audit',
          );
          await removeBillObjectBestEffort(
            admin,
            storagePath,
            auditId,
            userId,
            'inbound.email.rollback_credit_race_storage',
          );
          await releaseDedupeClaim(eventHash);
          claimedDedupeHash = null;
          return NextResponse.json({ ok: true, skipped: 'credit_race' });
        }
        // Transient / unknown: do not keep the dedupe claim without
        // dispatching work. Atomically fail the pending audit and refund if
        // the credit RPC committed, then remove storage and release the
        // content hash so the user can forward the same bill again.
        await failPendingAuditAndRefundIfNeeded(admin, {
          auditId,
          userId,
          reason: 'inbound-credit-decrement-failed',
        });
        await removeBillObjectBestEffort(
          admin,
          storagePath,
          auditId,
          userId,
          'inbound.email.rollback_decrement_transient_storage',
        );
        await releaseDedupeClaim(eventHash);
        claimedDedupeHash = null;
        return NextResponse.json({ ok: true, skipped: 'decrement_transient' });
      }
    }

    // H2: wrap inngest.send so a dispatch failure rolls back everything
    // we just created (audit row, storage object, decremented credit,
    // dedupe claim). Without this, a transient Inngest outage stranded
    // the user with a pending audit + a spent credit that orphan-cleanup
    // only refunds after 30 minutes (and only while the row stays
    // pending — it cannot recover post-extract).
    try {
      await inngest.send({
        id: `${auditId}-uploaded`,
        name: 'bill.uploaded',
        data: { auditId, userId, storagePath, retryCount: 0 },
      });
    } catch (sendErr) {
      // Roll back. Refund FIRST (while the audit row still exists) via the
      // idempotent, row-anchored refund_orphan_audit RPC — same pattern as the
      // decrement-transient path above. Doing this before the delete closes
      // the crash-window credit leak, and the RPC's (status='pending' AND
      // credit_consumed=true) gate makes a repeat call (request retry / the
      // orphan-cleanup cron) a no-op on the credit, so it can't double-refund.
      // Best-effort: never mask the original sendErr.
      if (gate.reason === 'credit') {
        try {
          await failPendingAuditAndRefundIfNeeded(admin, {
            auditId,
            userId,
            reason: 'inbound-dispatch-failed',
          });
        } catch (refundErr) {
          Sentry.captureException(refundErr, {
            tags: { surface: 'inbound.email.dispatch_refund' },
            extra: { userId, auditId },
          });
        }
      }
      await deleteAuditRowBestEffort(
        admin,
        auditId,
        userId,
        'inbound.email.rollback_dispatch_audit',
      );
      await removeBillObjectBestEffort(
        admin,
        storagePath,
        auditId,
        userId,
        'inbound.email.rollback_dispatch_storage',
      );
      // Free the dedupe claim so the user can re-forward the same bill.
      throw sendErr;
    }
    claimedDedupeHash = null;

    return NextResponse.json({ ok: true, auditId });
  } catch (err) {
    if (claimedDedupeHash) {
      await releaseDedupeClaim(claimedDedupeHash);
    }
    Sentry.captureException(err, { tags: { surface: 'inbound.email' } });
    // Still 200 so the provider doesn't retry. The orphan-audit cleanup cron
    // would catch any half-created rows.
    return NextResponse.json({ ok: true, skipped: 'internal_error' });
  }
}
