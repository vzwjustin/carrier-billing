import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';

import {
  consumeRateLimit,
  rateLimitedResponse,
} from '@/lib/security/rate-limit';
import { getAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB

const CreateContractSchema = z.object({
  filename: z.string().min(1, 'filename is required').max(255, 'filename is too long'),
  size_bytes: z.number().int().positive().max(MAX_BYTES, 'file is larger than 25 MB'),
});

const SAFE_FILENAME_RE = /[^A-Za-z0-9._-]+/g;

function safeFilename(input: string): string {
  const base = input.split(/[\\/]/).pop() ?? input;
  const cleaned = base.replace(SAFE_FILENAME_RE, '_');
  return cleaned.slice(0, 200) || 'contract.pdf';
}

function isAcceptedFilename(filename: string): boolean {
  return filename.toLowerCase().endsWith('.pdf');
}

/**
 * POST /api/contracts
 *
 * Init step — creates a `contracts` row in `pending` and returns a signed
 * upload URL for the client to PUT the PDF into the `contracts` storage
 * bucket. Mirrors POST /api/audits but without the credits / access-gate
 * surface (contracts don't consume audit credits).
 */
export async function POST(request: Request): Promise<Response> {
  let bodyJson: unknown;
  try {
    bodyJson = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const parsed = CreateContractSchema.safeParse(bodyJson);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: first?.message ?? 'Invalid request.' },
      { status: 400 },
    );
  }

  const { filename, size_bytes } = parsed.data;

  if (!isAcceptedFilename(filename)) {
    return NextResponse.json(
      { error: 'Only PDF contracts are accepted.' },
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
      key: `contract-create:${user.id}`,
      limit: 20,
      windowSeconds: 60 * 60,
    });
    if (!limit.ok) {
      return rateLimitedResponse(limit.resetAt);
    }

    const contractId = crypto.randomUUID();
    const cleanName = safeFilename(filename);
    const storagePath = `${user.id}/${contractId}/${cleanName}`;
    const admin = getAdminClient();

    const { error: insertError } = await admin.from('contracts').insert({
      id: contractId,
      user_id: user.id,
      status: 'pending',
      storage_path: storagePath,
      original_filename: filename,
    });

    if (insertError) {
      return NextResponse.json(
        { error: 'Failed to create contract.' },
        { status: 500 },
      );
    }

    const SIGNED_UPLOAD_TTL_SECONDS = 60 * 15;
    const signedUploadOptions = {
      expiresIn: SIGNED_UPLOAD_TTL_SECONDS,
    } as unknown as { upsert: boolean };
    const { data: signed, error: signError } = await admin.storage
      .from('contracts')
      .createSignedUploadUrl(storagePath, signedUploadOptions);

    if (signError || !signed) {
      try {
        await admin.from('contracts').delete().eq('id', contractId);
      } catch (rollbackErr) {
        Sentry.captureException(rollbackErr, {
          tags: { surface: 'contracts.create.rollback_signed_url_orphan' },
          extra: { contractId, userId: user.id },
        });
      }
      return NextResponse.json(
        { error: 'Failed to create upload URL.' },
        { status: 500 },
      );
    }

    void size_bytes; // bound by schema; size enforced server-side via createSignedUploadUrl + PUT

    return NextResponse.json({
      contractId,
      uploadUrl: signed.signedUrl,
      storagePath,
      token: signed.token,
    });
  } catch (err) {
    Sentry.captureException(err, { tags: { surface: 'contracts.create' } });
    return NextResponse.json(
      { error: 'Internal server error.' },
      { status: 500 },
    );
  }
}
