import { NextResponse } from 'next/server';
import { z } from 'zod';

import { inngest } from '@/inngest/client';
import { getAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ParamsSchema = z.object({
  id: z.string().uuid(),
});

interface AuditRow {
  id: string;
  user_id: string;
  status: string;
  storage_path: string;
}

function isAuditRow(value: unknown): value is AuditRow {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.user_id === 'string' &&
    typeof v.status === 'string' &&
    typeof v.storage_path === 'string'
  );
}

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const params = await context.params;
  const parsed = ParamsSchema.safeParse(params);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid audit id.' }, { status: 400 });
  }
  const auditId = parsed.data.id;

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    }

    const { data, error } = await supabase
      .from('audits')
      .select('id,user_id,status,storage_path')
      .eq('id', auditId)
      .maybeSingle();

    if (error) {
      return NextResponse.json(
        { error: 'Failed to look up audit.' },
        { status: 500 },
      );
    }
    if (!data || !isAuditRow(data)) {
      return NextResponse.json({ error: 'Audit not found.' }, { status: 404 });
    }
    if (data.user_id !== user.id) {
      return NextResponse.json({ error: 'Audit not found.' }, { status: 404 });
    }
    if (data.status !== 'failed') {
      return NextResponse.json(
        { error: `Audit is not in a failed state (current: ${data.status}).` },
        { status: 409 },
      );
    }

    // Reset the audit row using the service-role client so we don't have to
    // write a separate RLS update policy for failure_reason. The user's
    // ownership has already been verified above.
    const admin = getAdminClient();
    const { error: updateError } = await admin
      .from('audits')
      .update({
        status: 'pending',
        failure_reason: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', auditId);

    if (updateError) {
      return NextResponse.json(
        { error: 'Failed to reset audit.' },
        { status: 500 },
      );
    }

    await inngest.send({
      id: `${auditId}-uploaded-retry-${Date.now()}`,
      name: 'bill.uploaded',
      data: {
        auditId: data.id,
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
