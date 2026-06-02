/**
 * GET /api/audits/[id]/dispute-letter.pdf?finding_ids=<csv-of-uuids>
 *
 * Renders a single multi-page formal dispute letter that bundles N
 * approved findings from one audit.
 *
 * Access model — **authed owner only**. Unlike `report.pdf` and
 * `findings.csv`, this surface deliberately has NO public share-token
 * fallback: a bulk dispute letter is sensitive operator collateral that
 * names the operator in its closing block and aggregates every credit ask
 * on the bill.
 *
 * Rate limit: 10 / 5 min per authed user (shared bucket with the rest of
 * the dispute-letter surface).
 *
 * Validation (in order):
 *  1. `id` is a UUID.
 *  2. `finding_ids` parses as a CSV of 1..50 UUIDs.
 *  3. The audit exists and is owned by the caller.
 *  4. The audit is `completed`.
 *  5. Every finding id resolves AND belongs to this audit AND has
 *     `status='approved'`. Any miss → 400 with the offending ids in the
 *     error body.
 *
 * Fires `logTrailEvent({eventType: 'dispute_packet_generated', ...})`
 * (best-effort) after a successful render. Trail row keys on the audit;
 * the metadata blob records the finding count + the total credit cents so
 * we can later analyse usage without re-loading the PDF.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import * as Sentry from '@sentry/nextjs';

import { buildBulkDisputeLetter, type BulkDisputeFindingInput } from '@/disputes/bulk-builder';
import type {
  DisputeAccountInput,
  DisputeFindingInput,
  DisputeLineInput,
} from '@/disputes/builder';
import { logTrailEvent } from '@/lib/audit-trail/log';
import { consumeRateLimit, rateLimitedResponse } from '@/lib/security/rate-limit';
import { getAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_FINDINGS_PER_LETTER = 50;

const ParamsSchema = z.object({ id: z.string().uuid() });

/**
 * Zod schema for the `finding_ids` query param. We split the CSV ourselves
 * (Zod doesn't model "CSV of UUIDs" cleanly) and then validate the parsed
 * array shape here so the route boundary stays the single source of truth
 * for the contract.
 */
const FindingIdsSchema = z
  .array(z.string().uuid())
  .min(1, 'finding_ids must contain at least one UUID.')
  .max(
    MAX_FINDINGS_PER_LETTER,
    `finding_ids may contain at most ${MAX_FINDINGS_PER_LETTER} UUIDs.`,
  );

const SeveritySchema = z.enum(['high', 'medium', 'low', 'info']);

const AuditRowSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  status: z.string(),
  carrier: z.string().nullable(),
  billing_period_start: z.string().nullable(),
  billing_period_end: z.string().nullable(),
});

const FindingRowSchema = z.object({
  id: z.string().uuid(),
  audit_id: z.string().uuid(),
  rule_id: z.string(),
  severity: SeveritySchema,
  status: z.string().nullable(),
  title: z.string(),
  description: z.string(),
  recommended_action: z.string(),
  estimated_monthly_savings_cents: z.number().int(),
  confidence: z.number(),
  affected_line_ids: z.array(z.string().uuid()).nullable(),
  affected_account_ids: z.array(z.string().uuid()).nullable(),
});

const LineRowSchema = z.object({
  id: z.string().uuid(),
  mdn_masked: z.string().nullable(),
  plan_name: z.string().nullable(),
});

const AccountRowSchema = z.object({
  id: z.string().uuid(),
  account_number_masked: z.string().nullable(),
  account_label: z.string().nullable(),
});

const AUDIT_COLUMNS = 'id,user_id,status,carrier,billing_period_start,billing_period_end';
const FINDING_COLUMNS =
  'id,audit_id,rule_id,severity,status,title,description,recommended_action,estimated_monthly_savings_cents,confidence,affected_line_ids,affected_account_ids';
const LINE_COLUMNS = 'id,mdn_masked,plan_name';
const ACCOUNT_COLUMNS = 'id,account_number_masked,account_label';

function pdfFilename(auditShortId: string): string {
  return `carrieraudit-dispute-letter-${auditShortId}.pdf`;
}

function parseFindingIdsParam(
  raw: string | null,
): { ok: true; ids: string[] } | { ok: false; status: number; error: string } {
  if (raw === null || raw.trim().length === 0) {
    return {
      ok: false,
      status: 400,
      error: 'finding_ids query parameter is required.',
    };
  }
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const parsed = FindingIdsSchema.safeParse(parts);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      status: 400,
      error: first?.message ?? 'Invalid finding_ids parameter.',
    };
  }
  // Dedupe while preserving order — a caller selecting the same finding
  // twice shouldn't double the credit total.
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of parsed.data) {
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return { ok: true, ids };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const rawParams = await context.params;
  const paramsParsed = ParamsSchema.safeParse(rawParams);
  if (!paramsParsed.success) {
    return NextResponse.json({ error: 'Invalid audit id.' }, { status: 400 });
  }
  const auditId = paramsParsed.data.id;

  const url = new URL(request.url);
  const idsResult = parseFindingIdsParam(url.searchParams.get('finding_ids'));
  if (!idsResult.ok) {
    return NextResponse.json({ error: idsResult.error }, { status: idsResult.status });
  }
  const findingIds = idsResult.ids;

  // ---- Auth + rate-limit -------------------------------------------------
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const limited = await consumeRateLimit({
    key: `dispute-letter-auth:${user.id}`,
    limit: 10,
    windowSeconds: 300,
  });
  if (!limited.ok) {
    return rateLimitedResponse(limited.resetAt);
  }

  // ---- Resolve + authorize the audit (RLS-scoped) -----------------------
  const { data: auditRaw, error: auditErr } = await supabase
    .from('audits')
    .select(AUDIT_COLUMNS)
    .eq('id', auditId)
    .maybeSingle();
  if (auditErr) {
    return NextResponse.json({ error: 'Failed to look up audit.' }, { status: 500 });
  }
  if (!auditRaw) {
    return NextResponse.json({ error: 'Audit not found.' }, { status: 404 });
  }
  const auditParsed = AuditRowSchema.safeParse(auditRaw);
  if (!auditParsed.success || auditParsed.data.user_id !== user.id) {
    return NextResponse.json({ error: 'Audit not found.' }, { status: 404 });
  }
  const audit = auditParsed.data;

  if (audit.status !== 'completed') {
    return NextResponse.json({ error: 'audit_not_completed' }, { status: 409 });
  }

  // ---- Load + validate the findings -------------------------------------
  // We use the admin client for the children fetches: ownership has already
  // been established above, and the bill_* tables join through audits.user_id
  // via RLS — the admin client gives us a single .in() without per-row
  // policy churn.
  const admin = getAdminClient();
  const { data: findingsRaw, error: findingsErr } = await admin
    .from('findings')
    .select(FINDING_COLUMNS)
    .eq('audit_id', auditId)
    .in('id', findingIds);
  if (findingsErr) {
    Sentry.captureException(findingsErr, {
      tags: { surface: 'dispute_letter.findings_lookup' },
      extra: { auditId },
    });
    return NextResponse.json({ error: 'Failed to load findings.' }, { status: 500 });
  }

  const validatedFindings: z.infer<typeof FindingRowSchema>[] = [];
  for (const row of findingsRaw ?? []) {
    const parsed = FindingRowSchema.safeParse(row);
    if (parsed.success) validatedFindings.push(parsed.data);
  }

  // Cross-check the resolved set against the requested ids — any id we
  // failed to load (wrong audit / nonexistent / shape-invalid) is reported
  // as a hard error rather than silently dropped.
  const resolvedIds = new Set(validatedFindings.map((f) => f.id));
  const missing = findingIds.filter((id) => !resolvedIds.has(id));
  if (missing.length > 0) {
    return NextResponse.json(
      {
        error: 'unknown_finding_ids',
        message: 'One or more finding_ids do not belong to this audit or do not exist.',
        finding_ids: missing,
      },
      { status: 400 },
    );
  }

  const notApproved = validatedFindings.filter((f) => f.status !== 'approved');
  if (notApproved.length > 0) {
    return NextResponse.json(
      {
        error: 'findings_not_approved',
        message: 'Every finding in a bulk dispute letter must be in status=approved.',
        finding_ids: notApproved.map((f) => f.id),
      },
      { status: 400 },
    );
  }

  // Re-order to match the caller's request order so the numbered list in
  // the letter follows the order the operator picked in the UI.
  const findingById = new Map(validatedFindings.map((f) => [f.id, f]));
  const orderedFindings = findingIds
    .map((id) => findingById.get(id))
    .filter((f): f is z.infer<typeof FindingRowSchema> => f !== undefined);

  // ---- Batched line + account fetch -------------------------------------
  const allLineIds = new Set<string>();
  const allAccountIds = new Set<string>();
  for (const f of orderedFindings) {
    for (const id of f.affected_line_ids ?? []) allLineIds.add(id);
    for (const id of f.affected_account_ids ?? []) allAccountIds.add(id);
  }

  const [linesRes, accountsRes] = await Promise.all([
    allLineIds.size === 0
      ? Promise.resolve({ data: [] as unknown[], error: null })
      : admin
          .from('bill_lines')
          .select(LINE_COLUMNS)
          .eq('audit_id', auditId)
          .in('id', Array.from(allLineIds)),
    allAccountIds.size === 0
      ? Promise.resolve({ data: [] as unknown[], error: null })
      : admin
          .from('bill_accounts')
          .select(ACCOUNT_COLUMNS)
          .eq('audit_id', auditId)
          .in('id', Array.from(allAccountIds)),
  ]);

  if (linesRes.error || accountsRes.error) {
    Sentry.captureException(linesRes.error ?? accountsRes.error, {
      tags: { surface: 'dispute_letter.children_lookup' },
      extra: { auditId },
    });
    return NextResponse.json({ error: 'Failed to load finding details.' }, { status: 500 });
  }

  const linesById = new Map<string, DisputeLineInput>();
  for (const row of linesRes.data ?? []) {
    const parsed = LineRowSchema.safeParse(row);
    if (parsed.success) linesById.set(parsed.data.id, parsed.data);
  }
  const accountsById = new Map<string, DisputeAccountInput>();
  for (const row of accountsRes.data ?? []) {
    const parsed = AccountRowSchema.safeParse(row);
    if (parsed.success) accountsById.set(parsed.data.id, parsed.data);
  }

  // ---- Operator display name (profiles.full_name) -----------------------
  // Read from RLS-scoped server client — the user's own profile is the
  // only row they can read here, which is exactly what we want.
  const { data: profileRow } = await supabase
    .from('profiles')
    .select('full_name')
    .eq('id', user.id)
    .maybeSingle();
  const operatorName =
    typeof (profileRow as { full_name?: unknown } | null)?.full_name === 'string'
      ? (profileRow as { full_name: string }).full_name
      : null;

  // ---- Shape + render ---------------------------------------------------
  const findingsForBuilder: BulkDisputeFindingInput[] = orderedFindings.map((f) => {
    const findingInput: DisputeFindingInput = {
      id: f.id,
      rule_id: f.rule_id,
      severity: f.severity,
      title: f.title,
      description: f.description,
      recommended_action: f.recommended_action,
      estimated_monthly_savings_cents: f.estimated_monthly_savings_cents,
      confidence: f.confidence,
      affected_line_ids: f.affected_line_ids,
      affected_account_ids: f.affected_account_ids,
    };
    const lines: DisputeLineInput[] = (f.affected_line_ids ?? [])
      .map((id) => linesById.get(id))
      .filter((l): l is DisputeLineInput => l !== undefined);
    const accounts: DisputeAccountInput[] = (f.affected_account_ids ?? [])
      .map((id) => accountsById.get(id))
      .filter((a): a is DisputeAccountInput => a !== undefined);
    return { finding: findingInput, lines, accounts };
  });

  const letter = buildBulkDisputeLetter({
    audit: {
      id: audit.id,
      carrier: audit.carrier,
      billing_period_start: audit.billing_period_start,
      billing_period_end: audit.billing_period_end,
    },
    operatorName,
    findings: findingsForBuilder,
    generatedAt: new Date(),
  });

  // Lazy-import the renderer so @react-pdf/renderer stays out of the cold
  // path until a letter is actually requested.
  const { renderBulkDisputePdf } = await import('@/disputes/pdf/bulk-render');
  const pdfBuffer = await renderBulkDisputePdf(letter);
  const pdfBytes = new Uint8Array(pdfBuffer.buffer, pdfBuffer.byteOffset, pdfBuffer.byteLength);
  const body = pdfBytes.buffer.slice(
    pdfBytes.byteOffset,
    pdfBytes.byteOffset + pdfBytes.byteLength,
  ) as ArrayBuffer;

  // Fire-and-forget audit trail — never let it block the response.
  void logTrailEvent({
    userId: user.id,
    eventType: 'dispute_packet_generated',
    entityType: 'audit',
    entityId: auditId,
    actorEmail: user.email ?? null,
    metadata: {
      kind: 'bulk_letter',
      finding_count: letter.items.length,
      total_credit_cents: letter.totalRequestedCreditCents,
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${pdfFilename(letter.auditShortId)}"`,
      'Cache-Control': 'private, max-age=0, must-revalidate',
      'Referrer-Policy': 'no-referrer',
    },
  });
}
