/**
 * Server-only loader for the dispute packet.
 *
 * Shared by `dispute.pdf` and `dispute.eml` routes — both surfaces need the
 * exact same auth + DB shape, and duplicating ~150 LOC of Supabase queries
 * across two route files would invite drift. Per CLAUDE.md §1#7 ("no
 * premature abstraction") this is the second call site for the same code;
 * the third would still be the same code, so a shared loader is warranted.
 *
 * Returns a discriminated union so callers can map outcomes to the right
 * HTTP status without re-implementing the lookup logic.
 */
import 'server-only';
import { z } from 'zod';
import * as Sentry from '@sentry/nextjs';

import {
  buildDisputePacket,
  type DisputeAccountInput,
  type DisputeAuditInput,
  type DisputeFindingInput,
  type DisputeLineInput,
  type DisputePacket,
} from '@/disputes/builder';
import {
  consumeRateLimit,
  rateLimitedResponse,
} from '@/lib/security/rate-limit';
import { isShareTokenExpired } from '@/lib/share-token';
import { hashTokenForAnalytics } from '@/lib/analytics/hash';
import { getAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

/** Zod schema for route params — matches the existing report.pdf shape. */
export const DisputeParamsSchema = z.object({
  id: z.string().uuid(),
  findingId: z.string().uuid(),
});

/**
 * Zod schemas for the rows we pull out of Supabase. Cheaper than trusting the
 * inferred any-coerced shape; mirrors the discipline in process-bill.ts.
 */
const SeveritySchema = z.enum(['high', 'medium', 'low', 'info']);

const AuditRowSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  status: z.string(),
  carrier: z.string().nullable(),
  billing_period_start: z.string().nullable(),
  billing_period_end: z.string().nullable(),
  share_token: z.string().nullable(),
  share_token_expires_at: z.string().nullable(),
});

const FindingRowSchema = z.object({
  id: z.string().uuid(),
  audit_id: z.string().uuid(),
  rule_id: z.string(),
  severity: SeveritySchema,
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

const AUDIT_COLUMNS =
  'id,user_id,status,carrier,billing_period_start,billing_period_end,share_token,share_token_expires_at';
const FINDING_COLUMNS =
  'id,audit_id,rule_id,severity,title,description,recommended_action,estimated_monthly_savings_cents,confidence,affected_line_ids,affected_account_ids';
const LINE_COLUMNS = 'id,mdn_masked,plan_name';
const ACCOUNT_COLUMNS = 'id,account_number_masked,account_label';

export type LoadOutcome =
  | { kind: 'ok'; packet: DisputePacket }
  | { kind: 'response'; response: Response };

function notFound(): Response {
  return new Response('Not found.', { status: 404 });
}

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Resolve the request to a fully-built `DisputePacket` or a ready-to-return
 * Response. The route wrappers add format-specific headers around the bytes.
 */
export async function loadDisputePacket(
  request: Request,
  rawParams: { id: string; findingId: string },
  surface: 'pdf' | 'eml',
): Promise<LoadOutcome> {
  const parsed = DisputeParamsSchema.safeParse(rawParams);
  if (!parsed.success) {
    return { kind: 'response', response: jsonError(400, 'Invalid id.') };
  }
  const { id: auditId, findingId } = parsed.data;

  const url = new URL(request.url);
  const rawToken = url.searchParams.get('token');
  const token =
    rawToken && /^[A-Za-z0-9_-]{32}$/.test(rawToken) ? rawToken : null;
  if (rawToken && !token) {
    return { kind: 'response', response: notFound() };
  }

  // ---- Resolve & authorize the audit ------------------------------------
  let auditRow: z.infer<typeof AuditRowSchema> | null = null;

  if (token) {
    const limited = await consumeRateLimit({
      key: `dispute-${surface}-public:${hashTokenForAnalytics(token)}`,
      limit: 10,
      windowSeconds: 300,
    });
    if (!limited.ok) {
      return { kind: 'response', response: rateLimitedResponse(limited.resetAt) };
    }
    const admin = getAdminClient();
    const { data, error } = await admin
      .from('audits')
      .select(AUDIT_COLUMNS)
      .eq('id', auditId)
      .eq('share_token', token)
      .maybeSingle();
    if (error || !data) {
      // Collapse all failure modes to 404 to avoid differential leaks.
      return { kind: 'response', response: notFound() };
    }
    const validated = AuditRowSchema.safeParse(data);
    if (!validated.success) {
      return { kind: 'response', response: notFound() };
    }
    auditRow = validated.data;
    if (isShareTokenExpired(auditRow.share_token_expires_at)) {
      return { kind: 'response', response: notFound() };
    }
  } else {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return { kind: 'response', response: jsonError(401, 'Unauthorized.') };
    }
    const limited = await consumeRateLimit({
      key: `dispute-${surface}-auth:${user.id}`,
      limit: 20,
      windowSeconds: 300,
    });
    if (!limited.ok) {
      return { kind: 'response', response: rateLimitedResponse(limited.resetAt) };
    }
    const { data, error } = await supabase
      .from('audits')
      .select(AUDIT_COLUMNS)
      .eq('id', auditId)
      .maybeSingle();
    if (error) {
      return {
        kind: 'response',
        response: jsonError(500, 'Failed to look up audit.'),
      };
    }
    if (!data) {
      return { kind: 'response', response: jsonError(404, 'Audit not found.') };
    }
    const validated = AuditRowSchema.safeParse(data);
    if (!validated.success || validated.data.user_id !== user.id) {
      return { kind: 'response', response: jsonError(404, 'Audit not found.') };
    }
    auditRow = validated.data;
  }

  if (auditRow.status !== 'completed') {
    return {
      kind: 'response',
      response: jsonError(409, 'audit_not_completed'),
    };
  }

  // ---- Load the finding (must belong to this audit) ---------------------
  const admin = getAdminClient();
  const { data: findingRaw, error: findingErr } = await admin
    .from('findings')
    .select(FINDING_COLUMNS)
    .eq('id', findingId)
    .eq('audit_id', auditId)
    .maybeSingle();
  if (findingErr) {
    Sentry.captureException(findingErr, {
      tags: { surface: `dispute.${surface}.finding_lookup` },
      extra: { auditId, findingId },
    });
    return {
      kind: 'response',
      response: jsonError(500, 'Failed to load finding.'),
    };
  }
  if (!findingRaw) {
    return { kind: 'response', response: notFound() };
  }
  const findingParsed = FindingRowSchema.safeParse(findingRaw);
  if (!findingParsed.success) {
    Sentry.captureMessage('dispute.finding.shape_invalid', {
      level: 'warning',
      extra: { auditId, findingId },
    });
    return {
      kind: 'response',
      response: jsonError(500, 'Failed to load finding.'),
    };
  }
  const finding = findingParsed.data;

  // ---- Load affected lines + accounts -----------------------------------
  const lineIds = finding.affected_line_ids ?? [];
  const accountIds = finding.affected_account_ids ?? [];

  const [linesRes, accountsRes] = await Promise.all([
    lineIds.length === 0
      ? Promise.resolve({ data: [] as unknown[], error: null })
      : admin
          .from('bill_lines')
          .select(LINE_COLUMNS)
          .eq('audit_id', auditId)
          .in('id', lineIds)
          .order('id', { ascending: true }),
    accountIds.length === 0
      ? Promise.resolve({ data: [] as unknown[], error: null })
      : admin
          .from('bill_accounts')
          .select(ACCOUNT_COLUMNS)
          .eq('audit_id', auditId)
          .in('id', accountIds)
          .order('id', { ascending: true }),
  ]);

  if (linesRes.error || accountsRes.error) {
    Sentry.captureException(linesRes.error ?? accountsRes.error, {
      tags: { surface: `dispute.${surface}.children_lookup` },
      extra: { auditId, findingId },
    });
    return {
      kind: 'response',
      response: jsonError(500, 'Failed to load finding details.'),
    };
  }

  const lines: DisputeLineInput[] = (linesRes.data ?? [])
    .map((row) => {
      const r = LineRowSchema.safeParse(row);
      return r.success ? r.data : null;
    })
    .filter((r): r is DisputeLineInput => r !== null);

  const accounts: DisputeAccountInput[] = (accountsRes.data ?? [])
    .map((row) => {
      const r = AccountRowSchema.safeParse(row);
      return r.success ? r.data : null;
    })
    .filter((r): r is DisputeAccountInput => r !== null);

  const audit: DisputeAuditInput = {
    id: auditRow.id,
    carrier: auditRow.carrier,
    billing_period_start: auditRow.billing_period_start,
    billing_period_end: auditRow.billing_period_end,
  };

  const findingForBuilder: DisputeFindingInput = {
    id: finding.id,
    rule_id: finding.rule_id,
    severity: finding.severity,
    title: finding.title,
    description: finding.description,
    recommended_action: finding.recommended_action,
    estimated_monthly_savings_cents: finding.estimated_monthly_savings_cents,
    confidence: finding.confidence,
    affected_line_ids: finding.affected_line_ids,
    affected_account_ids: finding.affected_account_ids,
  };

  const packet = buildDisputePacket({
    audit,
    finding: findingForBuilder,
    lines,
    accounts,
    generatedAt: new Date(),
  });

  return { kind: 'ok', packet };
}
