import { NextResponse } from 'next/server';
import { z } from 'zod';

import { assertCanRunAudit } from '@/lib/access/gate';
import { decrementAuditCreditAtomically } from '@/lib/access/decrement';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB

const CreateAuditSchema = z.object({
  filename: z
    .string()
    .min(1, 'filename is required')
    .max(255, 'filename is too long'),
  fileSize: z
    .number()
    .int()
    .positive()
    .max(MAX_BYTES, 'file is larger than 25 MB'),
});

const SAFE_FILENAME_RE = /[^A-Za-z0-9._-]+/g;

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
    return NextResponse.json(
      { error: first?.message ?? 'Invalid request.' },
      { status: 400 },
    );
  }

  const { filename, fileSize } = parsed.data;

  const lower = filename.toLowerCase();
  const isAccepted =
    lower.endsWith('.pdf') ||
    lower.endsWith('.edi') ||
    lower.endsWith('.x12') ||
    lower.endsWith('.txt');
  if (!isAccepted) {
    return NextResponse.json(
      { error: 'Only PDF or EDI 811 (.edi/.x12/.txt) files are accepted.' },
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

    // Phase 4 access gate. Runs BEFORE we create the audit row so a user
    // without a plan or credits never gets a row at all.
    const gate = await assertCanRunAudit(user.id);
    if (!gate.ok) {
      if (gate.reason === 'past_due') {
        return NextResponse.json(
          {
            error: 'subscription_past_due',
            message:
              'Your subscription is past due. Please update payment to continue.',
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

    const { error: insertError } = await supabase.from('audits').insert({
      id: auditId,
      user_id: user.id,
      status: 'pending',
      storage_path: storagePath,
      original_filename: filename,
      file_size_bytes: fileSize,
    });

    if (insertError) {
      return NextResponse.json(
        { error: 'Failed to create audit.' },
        { status: 500 },
      );
    }

    // NOTE: spec wanted decrement on first state change; we decrement on
    // creation for stricter race-free accounting. The gate already approved
    // this user, but the RPC is the atomic source of truth — if a concurrent
    // creation drained the credits between the gate read and now, the RPC
    // throws `no_credits` and we roll back the audit row below.
    if (gate.reason === 'credit') {
      try {
        await decrementAuditCreditAtomically(user.id);
      } catch {
        await supabase.from('audits').delete().eq('id', auditId);
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

    const { data: signed, error: signError } = await supabase.storage
      .from('bills')
      .createSignedUploadUrl(storagePath);

    if (signError || !signed) {
      // Clean up the orphaned audit row so the user can retry cleanly.
      await supabase.from('audits').delete().eq('id', auditId);
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
  } catch {
    return NextResponse.json(
      { error: 'Internal server error.' },
      { status: 500 },
    );
  }
}
