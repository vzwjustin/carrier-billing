import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  consumeRateLimit,
  rateLimitedResponse,
} from '@/lib/security/rate-limit';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ParamsSchema = z.object({
  id: z.string().uuid(),
});

interface ContractStatusRow {
  user_id: string;
  status: string;
  carrier: string | null;
  ban_last4: string | null;
  effective_date: string | null;
  expiration_date: string | null;
  failure_reason: string | null;
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const params = await context.params;
  const parsed = ParamsSchema.safeParse(params);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid contract id.' }, { status: 400 });
  }

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    }

    const limited = await consumeRateLimit({
      key: `contract-status:${user.id}`,
      limit: 60,
      windowSeconds: 60,
    });
    if (!limited.ok) {
      return rateLimitedResponse(limited.resetAt);
    }

    const { data, error } = await supabase
      .from('contracts')
      .select(
        'user_id,status,carrier,ban_last4,effective_date,expiration_date,failure_reason',
      )
      .eq('id', parsed.data.id)
      .maybeSingle<ContractStatusRow>();

    if (error) {
      return NextResponse.json(
        { error: 'Failed to look up contract.' },
        { status: 500 },
      );
    }
    if (!data) {
      return NextResponse.json({ error: 'Contract not found.' }, { status: 404 });
    }
    if (data.user_id !== user.id) {
      return NextResponse.json({ error: 'Contract not found.' }, { status: 404 });
    }

    return NextResponse.json({
      status: data.status,
      carrier: data.carrier,
      ban_last4: data.ban_last4,
      effective_date: data.effective_date,
      expiration_date: data.expiration_date,
      failure_reason: data.failure_reason,
    });
  } catch {
    return NextResponse.json(
      { error: 'Internal server error.' },
      { status: 500 },
    );
  }
}
