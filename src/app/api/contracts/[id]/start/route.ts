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
}

function isContractRow(value: unknown): value is ContractRow {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.user_id === 'string' &&
    typeof v.status === 'string' &&
    typeof v.storage_path === 'string'
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
      .select('id,user_id,status,storage_path')
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

    // Re-extract path: if the contract was previously `parsed` or `failed`,
    // bump it back to `pending` so the worker's mark-extracting status guard
    // can flip it forward. Bounded to the user's own row by user_id eq.
    if (data.status !== 'pending') {
      const { error: resetErr } = await supabase
        .from('contracts')
        .update({
          status: 'pending',
          failure_reason: null,
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

    // Idempotency key: anchored to (contractId, status) so a re-extract
    // produces a fresh dedupe boundary. Inngest dedupes per `id`.
    await inngest.send({
      id: `${contractId}-uploaded-${Date.now()}`,
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
