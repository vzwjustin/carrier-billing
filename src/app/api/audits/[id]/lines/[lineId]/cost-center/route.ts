/**
 * POST /api/audits/[id]/lines/[lineId]/cost-center
 *
 * Set or clear a cost-center tag on a single bill_line. Authenticated owner
 * only — no share-token write path. Operators tag lines post-extraction; the
 * extractor never populates these columns.
 *
 * Body: `{ cost_center: string | null }` — null or empty string clears.
 * Max 80 chars, trimmed before persistence.
 */
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

const ParamsSchema = z.object({
  id: z.string().uuid(),
  lineId: z.string().uuid(),
});

// `cost_center` may be:
//   - a non-empty string (after trim) up to 80 chars → set
//   - an empty string (or null) → clear
// Trimming is applied as a transform so downstream code only sees the
// normalised value.
const BodySchema = z.object({
  cost_center: z
    .union([z.string().max(80), z.null()])
    .transform((v) => {
      if (v === null) return null;
      const trimmed = v.trim();
      return trimmed === '' ? null : trimmed;
    }),
});

interface AuditOwnerRow {
  id: string;
  user_id: string;
}

interface LineOwnershipRow {
  id: string;
  audit_id: string;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; lineId: string }> },
): Promise<Response> {
  const params = await context.params;
  const parsedParams = ParamsSchema.safeParse(params);
  if (!parsedParams.success) {
    return NextResponse.json(
      { error: 'Invalid audit or line id.' },
      { status: 400 },
    );
  }
  const { id: auditId, lineId } = parsedParams.data;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  const parsedBody = BodySchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: 'Invalid request body.' },
      { status: 400 },
    );
  }
  const { cost_center } = parsedBody.data;

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    }

    const limit = await consumeRateLimit({
      key: `cost-center-set:${user.id}`,
      limit: 60,
      windowSeconds: 60,
    });
    if (!limit.ok) {
      return rateLimitedResponse(limit.resetAt);
    }

    // Two-step ownership check using the user-scoped client so RLS is in
    // force: first confirm the audit belongs to the user, then confirm the
    // line belongs to the audit. RLS on bill_lines joins through audits, so
    // a missing audit also hides its lines — but we check explicitly to
    // distinguish 404-on-audit from 404-on-line and to mirror the pattern
    // in findings/[findingId]/status/route.ts.
    const { data: audit, error: auditErr } = await supabase
      .from('audits')
      .select('id,user_id')
      .eq('id', auditId)
      .maybeSingle<AuditOwnerRow>();
    if (auditErr) {
      return NextResponse.json(
        { error: 'Failed to look up audit.' },
        { status: 500 },
      );
    }
    if (!audit || audit.user_id !== user.id) {
      return NextResponse.json({ error: 'Audit not found.' }, { status: 404 });
    }

    const { data: line, error: lineErr } = await supabase
      .from('bill_lines')
      .select('id,audit_id')
      .eq('id', lineId)
      .eq('audit_id', auditId)
      .maybeSingle<LineOwnershipRow>();
    if (lineErr) {
      return NextResponse.json(
        { error: 'Failed to look up line.' },
        { status: 500 },
      );
    }
    if (!line) {
      return NextResponse.json({ error: 'Line not found.' }, { status: 404 });
    }

    const admin = getAdminClient();
    const { error: updateErr } = await admin
      .from('bill_lines')
      .update({
        cost_center,
        cost_center_updated_at: new Date().toISOString(),
      })
      .eq('id', lineId)
      .eq('audit_id', auditId);

    if (updateErr) {
      Sentry.captureException(updateErr, {
        tags: { surface: 'cost_center.update' },
        extra: { auditId, lineId },
      });
      return NextResponse.json(
        { error: 'Failed to update cost center.' },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    Sentry.captureException(err, {
      tags: { surface: 'cost_center.unknown' },
      extra: { auditId, lineId },
    });
    return NextResponse.json(
      { error: 'Internal server error.' },
      { status: 500 },
    );
  }
}
