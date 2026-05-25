/**
 * POST /api/autopsy/drivers/[driverId]/explain
 *
 * Mark a Bill Increase Autopsy change driver as "explained" (reviewed,
 * no further action). Owner-only — verified by joining through
 * bill_comparisons.user_id. Toggle-style: body.explained=false clears.
 *
 * Idempotent: re-marking already-explained is a 200 no-op.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import * as Sentry from '@sentry/nextjs';

import { logTrailEvent } from '@/lib/audit-trail/log';
import { consumeRateLimit, rateLimitedResponse } from '@/lib/security/rate-limit';
import { getAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ParamsSchema = z.object({ driverId: z.string().uuid() });
const BodySchema = z.object({ explained: z.boolean() });

interface DriverOwnershipRow {
  id: string;
  bill_comparison_id: string;
  bill_comparisons: { user_id: string } | null;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ driverId: string }> },
): Promise<Response> {
  const params = await context.params;
  const parsed = ParamsSchema.safeParse(params);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid driver id.' }, { status: 400 });
  }
  const driverId = parsed.data.driverId;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  const bodyParsed = BodySchema.safeParse(body);
  if (!bodyParsed.success) {
    return NextResponse.json(
      { error: 'Body must be { explained: boolean }' },
      { status: 400 },
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const limited = await consumeRateLimit({
    key: `autopsy-explain:${user.id}`,
    limit: 60,
    windowSeconds: 60,
  });
  if (!limited.ok) {
    return rateLimitedResponse(limited.resetAt);
  }

  // Ownership check via the user-scoped client + RLS join.
  const { data: ownership, error: ownershipErr } = await supabase
    .from('bill_change_drivers')
    .select('id,bill_comparison_id,bill_comparisons!inner(user_id)')
    .eq('id', driverId)
    .maybeSingle<DriverOwnershipRow>();
  if (ownershipErr || !ownership) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }
  if (ownership.bill_comparisons?.user_id !== user.id) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  const admin = getAdminClient();
  const { error: updateErr } = await admin
    .from('bill_change_drivers')
    .update({
      is_explained: bodyParsed.data.explained,
      explained_at: bodyParsed.data.explained ? new Date().toISOString() : null,
      explained_by: bodyParsed.data.explained ? user.id : null,
    })
    .eq('id', driverId);
  if (updateErr) {
    Sentry.captureException(updateErr, {
      tags: { surface: 'autopsy.driver.explain' },
    });
    return NextResponse.json(
      { error: 'Failed to update driver.' },
      { status: 500 },
    );
  }

  await logTrailEvent({ userId: user.id, eventType: 'driver_marked_explained', entityType: 'driver', entityId: driverId, metadata: { comparison_id: ownership.bill_comparison_id, explained: bodyParsed.data.explained }, actorEmail: user.email ?? null });

  return NextResponse.json({ ok: true });
}
