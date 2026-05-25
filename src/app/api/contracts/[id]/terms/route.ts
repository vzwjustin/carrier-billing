import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';

import { ContractTermsSchema } from '@/contracts/schema';
import { logTrailEvent } from '@/lib/audit-trail/log';
import { getAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ParamsSchema = z.object({
  id: z.string().uuid(),
});

// `partial()` keeps every key optional so the UI can submit any subset of
// fields. The shapes themselves stay strict — nullable + bounded the same
// way `ContractTermsSchema` is.
const PatchBodySchema = ContractTermsSchema.partial();

/**
 * PATCH /api/contracts/[id]/terms
 *
 * Manual edit of any extracted contract term. Per-field validation matches
 * the extractor's own Zod schema so the DB write can never accept a shape
 * the rule layer cannot consume.
 *
 * Ownership is checked via the RLS-scoped server client first; the actual
 * write goes through the admin client so the RLS write policy on
 * `contract_terms` (which does an EXISTS subquery against `contracts.user_id`)
 * doesn't need to be relaxed for the partial-update case.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const params = await context.params;
  const parsedParams = ParamsSchema.safeParse(params);
  if (!parsedParams.success) {
    return NextResponse.json({ error: 'Invalid contract id.' }, { status: 400 });
  }
  const contractId = parsedParams.data.id;

  let bodyJson: unknown;
  try {
    bodyJson = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const parsedBody = PatchBodySchema.safeParse(bodyJson);
  if (!parsedBody.success) {
    const first = parsedBody.error.issues[0];
    return NextResponse.json(
      {
        error:
          first !== undefined
            ? `${first.path.join('.') || '<root>'}: ${first.message}`
            : 'Invalid request.',
      },
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

    // Ownership check via the RLS-scoped client — a contract owned by a
    // different user is not visible and yields a 404.
    const { data: contractRow, error: lookupErr } = await supabase
      .from('contracts')
      .select('id,user_id')
      .eq('id', contractId)
      .maybeSingle();
    if (lookupErr) {
      return NextResponse.json(
        { error: 'Failed to look up contract.' },
        { status: 500 },
      );
    }
    if (!contractRow) {
      return NextResponse.json({ error: 'Contract not found.' }, { status: 404 });
    }
    const row = contractRow as { id: string; user_id: string };
    if (row.user_id !== user.id) {
      return NextResponse.json({ error: 'Contract not found.' }, { status: 404 });
    }

    const patch = parsedBody.data;
    // Empty patch is a no-op — keep it cheap and surface 200.
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ ok: true, updated: 0 });
    }

    const admin = getAdminClient();

    // Does a contract_terms row already exist? If so, UPDATE; otherwise
    // INSERT a fresh row so the user can fill in terms even on a contract
    // that has not been parsed yet.
    const { data: existing, error: existsErr } = await admin
      .from('contract_terms')
      .select('id')
      .eq('contract_id', contractId)
      .maybeSingle();
    if (existsErr) {
      Sentry.captureException(existsErr, {
        tags: { surface: 'contracts.terms.patch.lookup' },
      });
      return NextResponse.json(
        { error: 'Failed to look up contract terms.' },
        { status: 500 },
      );
    }

    if (existing) {
      const { error: updErr } = await admin
        .from('contract_terms')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('contract_id', contractId);
      if (updErr) {
        return NextResponse.json(
          { error: 'Failed to update terms.' },
          { status: 500 },
        );
      }
    } else {
      const { error: insErr } = await admin
        .from('contract_terms')
        .insert({ contract_id: contractId, ...patch });
      if (insErr) {
        return NextResponse.json(
          { error: 'Failed to create terms.' },
          { status: 500 },
        );
      }
    }

    await logTrailEvent({ userId: user.id, eventType: 'contract_terms_edited', entityType: 'contract', entityId: contractId, metadata: { fields_updated: Object.keys(patch) }, actorEmail: user.email ?? null });

    return NextResponse.json({ ok: true });
  } catch (err) {
    Sentry.captureException(err, { tags: { surface: 'contracts.terms.patch' } });
    return NextResponse.json(
      { error: 'Internal server error.' },
      { status: 500 },
    );
  }
}
