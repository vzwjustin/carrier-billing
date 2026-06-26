/**
 * POST /api/audits/csv — CSV upload-init parallel to /api/audits.
 *
 * Mirrors the PDF init route but with a much tighter file-size limit (5 MB
 * — far above any sane line-export CSV) and a stricter accepted-extension
 * list. Inserts the audit row with `source_format='csv'` so the rest of
 * the system can tell ingests apart without sniffing the filename.
 *
 * Unlike the PDF route, this route does NOT consume a credit at init.
 * Credit consumption happens at /process time, after the parser has had
 * a chance to validate the file produces a sensible bill — otherwise a
 * user with a single credit who picks the wrong mapping would lose it
 * with no audit to show for it.
 *
 * Returns: { auditId, uploadUrl, storagePath, token } on success.
 */

import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';

import { assertCanRunAudit } from '@/lib/access/gate';
import { consumeRateLimit, rateLimitedResponse } from '@/lib/security/rate-limit';
import { getAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 5 MB cap — CSV exports are line-oriented and tiny. The parser also
 *  caps cell count, but stopping at the upload edge avoids paying storage
 *  for a junk upload. */
const MAX_BYTES = 5 * 1024 * 1024;

const CreateCsvAuditSchema = z.object({
  filename: z.string().min(1, 'filename is required').max(255, 'filename is too long'),
  size_bytes: z.number().int().positive().max(MAX_BYTES, 'file is larger than 5 MB'),
});

const SAFE_FILENAME_RE = /[^A-Za-z0-9._-]+/g;

function isCsvFilename(name: string): boolean {
  return /\.csv$/i.test(name);
}

function safeFilename(input: string): string {
  const base = input.split(/[\\/]/).pop() ?? input;
  const cleaned = base.replace(SAFE_FILENAME_RE, '_');
  return cleaned.slice(0, 200) || 'bill.csv';
}

export async function POST(request: Request): Promise<Response> {
  let bodyJson: unknown;
  try {
    bodyJson = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const parsed = CreateCsvAuditSchema.safeParse(bodyJson);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json({ error: first?.message ?? 'Invalid request.' }, { status: 400 });
  }
  const { filename, size_bytes } = parsed.data;

  if (!isCsvFilename(filename)) {
    return NextResponse.json(
      { error: 'Only .csv files are accepted on this route.' },
      { status: 400 },
    );
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
      key: `audit-create-csv:${user.id}`,
      limit: 20,
      windowSeconds: 60 * 60,
    });
    if (!limit.ok) {
      return rateLimitedResponse(limit.resetAt);
    }

    // Plan gate. We don't consume a credit here — see file header.
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
      credit_consumed: false,
      storage_path: storagePath,
      original_filename: filename,
      file_size_bytes: size_bytes,
      source_format: 'csv',
    });
    if (insertError) {
      Sentry.captureException(insertError, {
        tags: { surface: 'audits.csv.create.insert' },
        extra: { userId: user.id, auditId },
      });
      return NextResponse.json({ error: 'Failed to create audit.' }, { status: 500 });
    }

    const SIGNED_UPLOAD_TTL_SECONDS = 60 * 15;
    const signedUploadOptions = {
      expiresIn: SIGNED_UPLOAD_TTL_SECONDS,
    } as unknown as { upsert: boolean };
    const { data: signed, error: signError } = await admin.storage
      .from('bills')
      .createSignedUploadUrl(storagePath, signedUploadOptions);

    if (signError || !signed) {
      try {
        await admin.from('audits').delete().eq('id', auditId);
      } catch (rollbackErr) {
        Sentry.captureException(rollbackErr, {
          tags: { surface: 'audits.csv.create.rollback_signed_url_orphan' },
          extra: { auditId, userId: user.id },
        });
      }
      return NextResponse.json({ error: 'Failed to create upload URL.' }, { status: 500 });
    }

    return NextResponse.json({
      auditId,
      uploadUrl: signed.signedUrl,
      storagePath,
      token: signed.token,
    });
  } catch (err) {
    Sentry.captureException(err, { tags: { surface: 'audits.csv.create' } });
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
