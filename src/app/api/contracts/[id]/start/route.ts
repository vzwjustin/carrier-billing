import { NextResponse } from 'next/server';
import { z } from 'zod';

import { inngest } from '@/inngest/client';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ParamsSchema = z.object({
  id: z.string().uuid(),
});

interface ContractRow {
  id: string;
  user_id: string;
  status: string;
  storage_path: string;
  extract_attempt: number;
}

function isContractRow(value: unknown): value is ContractRow {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.user_id === 'string' &&
    typeof v.status === 'string' &&
    typeof v.storage_path === 'string' &&
    typeof v.extract_attempt === 'number'
  );
}

const RESTARTABLE_STATUSES = new Set(['pending', 'parsed', 'failed']);

/**
 * POST /api/contracts/[id]/start
 *
 * Kicks off (or re-runs) the extractor for a contract. Unlike audits we
 * allow re-running on `parsed`/`failed` contracts too — the re-extract
 * button on the detail page calls into here and the worker's mark-extracting
 * step flips back to `extracting`.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const params = await context.params;
  const parsed = ParamsSchema.safeParse(params);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid contract id.' }, { status: 400 });
  }
  const contractId = parsed.data.id;

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    }

    const { data, error } = await supabase
      .from('contracts')
      .select('id,user_id,status,storage_path,extract_attempt')
      .eq('id', contractId)
      .maybeSingle();

    if (error) {
      return NextResponse.json(
        { error: 'Failed to look up contract.' },
        { status: 500 },
      );
    }
    if (!data || !isContractRow(data)) {
      return NextResponse.json({ error: 'Contract not found.' }, { status: 404 });
    }
    if (data.user_id !== user.id) {
      return NextResponse.json({ error: 'Contract not found.' }, { status: 404 });
    }
    if (data.status === 'extracting') {
      return NextResponse.json(
        { error: 'Contract is already being processed.' },
        { status: 409 },
      );
    }
    if (!RESTARTABLE_STATUSES.has(data.status)) {
      return NextResponse.json(
        { error: `Contract is in unexpected state: ${data.status}.` },
        { status: 409 },
      );
    }

    // #14: the idempotency key is anchored to a per-contract attempt counter,
    // NOT Date.now() (which made every call a unique id, so Inngest never
    // deduped concurrent /start clicks). For a re-extract we advance the
    // counter; the initial start uses the current value. Concurrent
    // double-clicks read the same counter → same key → Inngest collapses them,
    // while a genuine later re-extract advances the counter → not deduped.
    let attempt = data.extract_attempt;
    if (data.status !== 'pending') {
      attempt = data.extract_attempt + 1;
      const { error: resetErr } = await supabase
        .from('contracts')
        .update({
          status: 'pending',
          failure_reason: null,
          extract_attempt: attempt,
          updated_at: new Date().toISOString(),
        })
        .eq('id', contractId)
        .eq('user_id', user.id);
      if (resetErr) {
        return NextResponse.json(
          { error: 'Failed to reset contract status.' },
          { status: 500 },
        );
      }
    }

    await inngest.send({
      id: `${contractId}-uploaded-${attempt}`,
      name: 'contract.uploaded',
      data: {
        contractId: data.id,
        userId: data.user_id,
        storagePath: data.storage_path,
      },
    });

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      { error: 'Internal server error.' },
      { status: 500 },
    );
  }
}
