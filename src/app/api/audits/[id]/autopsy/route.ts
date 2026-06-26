/**
 * Bill Increase Autopsy — REST endpoints scoped to a single "current" audit.
 *
 *   POST /api/audits/[id]/autopsy
 *     Body: { previousAuditId: uuid }
 *     Runs the comparison engine between `id` (current) and `previousAuditId`
 *     (previous). Persists to bill_comparisons + bill_change_drivers. Idempotent.
 *
 *   GET  /api/audits/[id]/autopsy
 *     Returns the most recent comparison for which `id` is the CURRENT audit.
 *     404 if none exists. Used by the UI to render the autopsy page without
 *     re-running the engine.
 *
 * Auth: authenticated owner only. No public share-token surface for now —
 * the autopsy can leak business inventory shape via line counts and would
 * deserve its own share model.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import * as Sentry from '@sentry/nextjs';

import { compareBills } from '@/autopsy/compare';
import { ComparisonAlreadyRunningError, persistComparison } from '@/autopsy/persist';
import { reconstructExtractedBill } from '@/autopsy/reconstruct';
import { consumeRateLimit, rateLimitedResponse } from '@/lib/security/rate-limit';
import { getAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ParamsSchema = z.object({ id: z.string().uuid() });
const BodySchema = z.object({ previousAuditId: z.string().uuid() });

interface AuditOwnershipRow {
  id: string;
  user_id: string;
  status: string;
}

async function loadAuditOwned(auditId: string, userId: string): Promise<AuditOwnershipRow | null> {
  const admin = getAdminClient();
  const { data, error } = await admin
    .from('audits')
    .select('id,user_id,status')
    .eq('id', auditId)
    .maybeSingle<AuditOwnershipRow>();
  if (error || !data) return null;
  if (data.user_id !== userId) return null;
  return data;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const params = await context.params;
  const parsed = ParamsSchema.safeParse(params);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid audit id.' }, { status: 400 });
  }
  const currentAuditId = parsed.data.id;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  const bodyParsed = BodySchema.safeParse(body);
  if (!bodyParsed.success) {
    return NextResponse.json({ error: 'previousAuditId required (uuid).' }, { status: 400 });
  }
  const previousAuditId = bodyParsed.data.previousAuditId;

  if (previousAuditId === currentAuditId) {
    return NextResponse.json(
      { error: 'previous and current audit must be different.' },
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

  // The autopsy engine is expensive (two full bill reconstructions + a
  // diff). 10 runs / 5 min per user is plenty for legitimate use.
  const limited = await consumeRateLimit({
    key: `autopsy-run:${user.id}`,
    limit: 10,
    windowSeconds: 300,
  });
  if (!limited.ok) {
    return rateLimitedResponse(limited.resetAt);
  }

  const [currentAudit, previousAudit] = await Promise.all([
    loadAuditOwned(currentAuditId, user.id),
    loadAuditOwned(previousAuditId, user.id),
  ]);
  if (!currentAudit || !previousAudit) {
    return NextResponse.json({ error: 'Audit not found.' }, { status: 404 });
  }
  if (currentAudit.status !== 'completed' || previousAudit.status !== 'completed') {
    return NextResponse.json(
      { error: 'Both audits must be completed before comparison.' },
      { status: 409 },
    );
  }

  let previousBill, currentBill;
  try {
    [previousBill, currentBill] = await Promise.all([
      reconstructExtractedBill(previousAuditId),
      reconstructExtractedBill(currentAuditId),
    ]);
  } catch (err) {
    Sentry.captureException(err, {
      tags: { surface: 'autopsy.reconstruct' },
    });
    return NextResponse.json(
      { error: 'Failed to reconstruct one of the bills for comparison.' },
      { status: 500 },
    );
  }
  if (!previousBill || !currentBill) {
    return NextResponse.json(
      { error: 'Bill data is missing or incomplete for one of the audits.' },
      { status: 409 },
    );
  }

  const result = compareBills(previousBill, currentBill);

  try {
    const persisted = await persistComparison({
      userId: user.id,
      previousAuditId,
      currentAuditId,
      result,
    });
    return NextResponse.json({ comparisonId: persisted.id, result }, { status: 201 });
  } catch (err) {
    if (err instanceof ComparisonAlreadyRunningError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    Sentry.captureException(err, { tags: { surface: 'autopsy.persist' } });
    return NextResponse.json({ error: 'Failed to persist comparison.' }, { status: 500 });
  }
}

interface ComparisonRow {
  id: string;
  user_id: string;
  previous_audit_id: string;
  current_audit_id: string;
  previous_total_cents: number;
  current_total_cents: number;
  net_change_cents: number;
  percent_change_bps: number | null;
  disputable_cents: number;
  optimization_cents: number;
  unexplained_cents: number;
  executive_summary: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

interface DriverRow {
  id: string;
  category: string;
  title: string;
  summary: string;
  previous_cents: number;
  current_cents: number;
  difference_cents: number;
  affected_lines_count: number;
  confidence: number;
  is_disputable: boolean;
  is_optimization: boolean;
  is_unexplained: boolean;
  recommended_action: string | null;
  evidence: Record<string, unknown>;
  is_explained: boolean | null;
  escalated_finding_id: string | null;
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const params = await context.params;
  const parsed = ParamsSchema.safeParse(params);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid audit id.' }, { status: 400 });
  }
  const currentAuditId = parsed.data.id;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const admin = getAdminClient();
  const { data: comparison, error: cmpErr } = await admin
    .from('bill_comparisons')
    .select(
      'id,user_id,previous_audit_id,current_audit_id,previous_total_cents,current_total_cents,net_change_cents,percent_change_bps,disputable_cents,optimization_cents,unexplained_cents,executive_summary,metadata,created_at',
    )
    .eq('current_audit_id', currentAuditId)
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<ComparisonRow>();
  if (cmpErr) {
    return NextResponse.json({ error: 'Failed to load comparison.' }, { status: 500 });
  }
  if (!comparison) {
    return NextResponse.json({ error: 'No comparison found.' }, { status: 404 });
  }

  const { data: drivers, error: driversErr } = await admin
    .from('bill_change_drivers')
    .select(
      'id,category,title,summary,previous_cents,current_cents,difference_cents,affected_lines_count,confidence,is_disputable,is_optimization,is_unexplained,recommended_action,evidence,is_explained,escalated_finding_id',
    )
    .eq('bill_comparison_id', comparison.id);
  if (driversErr) {
    return NextResponse.json({ error: 'Failed to load change drivers.' }, { status: 500 });
  }
  // Sort by absolute impact desc, mirroring the engine's output ordering.
  const sortedDrivers = (drivers ?? [])
    .slice()
    .sort(
      (a: DriverRow, b: DriverRow) => Math.abs(b.difference_cents) - Math.abs(a.difference_cents),
    );

  return NextResponse.json({ comparison, drivers: sortedDrivers }, { status: 200 });
}
