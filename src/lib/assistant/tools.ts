/**
 * Tool definitions for the CarrierAudit AI assistant.
 *
 * Each tool exposes a narrow slice of the user's audit data to the model so
 * the model can decide what to load (Anthropic tool-use pattern). Tools are
 * **scoped to the calling user** — every query filters by `userId`, never
 * by user input, and every result is funnelled through the user-scoped
 * Supabase SSR client so RLS is the second line of defense.
 *
 * PII discipline (CLAUDE.md §1#5):
 *   - mdn_last4 / account_last4 only — never full numbers.
 *   - We omit `user_label` from the line shape because it can contain
 *     subscriber names; tools that need a label fall back to first-initial
 *     + last-name reductions the extraction step already performs, but
 *     surface those only for explicit "show me which line" queries — not in
 *     bulk listings.
 *   - We do not expose user emails, raw account_number_masked beyond last-4,
 *     or any free-form `raw` jsonb payloads.
 *
 * Each tool is exported individually so it can be unit-tested in isolation
 * (see tests/assistant/tools.test.ts).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const AuditIdSchema = z.string().uuid();
const FindingIdSchema = z.string().uuid();
const StatusFilterSchema = z
  .enum(['new', 'in_review', 'approved', 'rejected', 'disputed', 'resolved'])
  .optional();
// Last-4 strings come straight from the bill — historically these are
// 4-character numeric strings, but suspended-line columns sometimes show
// fewer characters and synthetic accounts occasionally use alphanumerics.
// Be permissive at the schema level (1–4 chars) and let the data layer
// truncate to last-4 if the underlying value is longer.
const Last4Schema = z.string().min(1).max(4).optional();

export const ListAuditsInputSchema = z.object({});
export const GetAuditSummaryInputSchema = z.object({ audit_id: AuditIdSchema });
export const ListFindingsInputSchema = z.object({
  audit_id: AuditIdSchema,
  status_filter: StatusFilterSchema,
});
export const GetFindingInputSchema = z.object({ finding_id: FindingIdSchema });
export const GetAutopsyInputSchema = z.object({ audit_id: AuditIdSchema });
export const ListLinesInputSchema = z.object({
  audit_id: AuditIdSchema,
  account_last4: Last4Schema,
  // `has_feature` is a coarse filter against the bill_features.category enum:
  // 'insurance' | 'international' | 'cloud' | 'hotspot' | 'addon'. The
  // assistant model uses it for questions like "which lines have insurance".
  has_feature: z.enum(['insurance', 'international', 'cloud', 'hotspot', 'addon']).optional(),
});

// ---------------------------------------------------------------------------
// Tool definitions (JSON schemas the model sees)
// ---------------------------------------------------------------------------
//
// These are the public tool schemas passed to Anthropic's `tools` parameter.
// They must stay in lockstep with the Zod schemas above (the Zod schema
// validates what the model sent us; the JSON schema tells the model what's
// allowed). Keep both narrow.

export const ASSISTANT_TOOL_DEFINITIONS = [
  {
    name: 'list_audits',
    description:
      "List the user's audits, most-recent first. Returns id, status, carrier, billing period, total bill, and high-level finding counts. Call this first when you don't already know which audit the user is referring to.",
    input_schema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'get_audit_summary',
    description:
      'Get summary stats for a single audit: status, totals, account/line counts, savings estimates, finding counts. Use this when the user asks "tell me about audit X" or to confirm the audit exists before listing findings.',
    input_schema: {
      type: 'object' as const,
      properties: {
        audit_id: { type: 'string', description: 'The audit UUID.' },
      },
      required: ['audit_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_findings',
    description:
      'List savings findings for an audit. Each finding has a rule_id, severity, title, recommended action summary, and estimated monthly savings. Optionally filter by status (defaults to all).',
    input_schema: {
      type: 'object' as const,
      properties: {
        audit_id: { type: 'string', description: 'The audit UUID.' },
        status_filter: {
          type: 'string',
          enum: ['new', 'in_review', 'approved', 'rejected', 'disputed', 'resolved'],
          description: 'Optional finding-status filter.',
        },
      },
      required: ['audit_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_finding',
    description:
      'Get the full body of a single finding: description, recommended action, evidence summary, and the last-4 digits of the lines affected. Use this when the user asks "why did finding F flag" or wants more detail than the list view.',
    input_schema: {
      type: 'object' as const,
      properties: {
        finding_id: { type: 'string', description: 'The finding UUID.' },
      },
      required: ['finding_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_autopsy',
    description:
      'Get the most recent bill-comparison ("autopsy") that has this audit as the current side. Returns the executive summary, total change, and a list of categorized change drivers. Returns null if no comparison has been run for this audit.',
    input_schema: {
      type: 'object' as const,
      properties: {
        audit_id: { type: 'string', description: 'The audit UUID.' },
      },
      required: ['audit_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_lines',
    description:
      'List the lines on a bill. Returns mdn_last4, plan name, plan base cost, suspension state, and whether the line has any DPP installments. Optionally filter by account (last 4 digits) or by presence of a feature category (insurance/international/cloud/hotspot/addon).',
    input_schema: {
      type: 'object' as const,
      properties: {
        audit_id: { type: 'string', description: 'The audit UUID.' },
        account_last4: {
          type: 'string',
          description:
            'Optional: only return lines from the account whose number ends in these digits.',
        },
        has_feature: {
          type: 'string',
          enum: ['insurance', 'international', 'cloud', 'hotspot', 'addon'],
          description: 'Optional: only return lines that carry a feature in this category.',
        },
      },
      required: ['audit_id'],
      additionalProperties: false,
    },
  },
] as const;

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

export type AssistantSupabase = Pick<SupabaseClient, 'from'>;

export interface ToolContext {
  supabase: AssistantSupabase;
  userId: string;
}

/**
 * Cites collected across a single assistant turn. We surface these back to
 * the client so the UI can render chips and the user can click through to
 * the underlying audit/finding/comparison.
 */
export interface CitationCollector {
  auditIds: Set<string>;
  findingIds: Set<string>;
  comparisonIds: Set<string>;
}

export function newCitationCollector(): CitationCollector {
  return {
    auditIds: new Set<string>(),
    findingIds: new Set<string>(),
    comparisonIds: new Set<string>(),
  };
}

export interface CitationsPayload {
  audit_ids: string[];
  finding_ids: string[];
  comparison_ids: string[];
}

export function freezeCitations(c: CitationCollector): CitationsPayload {
  return {
    audit_ids: Array.from(c.auditIds),
    finding_ids: Array.from(c.findingIds),
    comparison_ids: Array.from(c.comparisonIds),
  };
}

// ---------------------------------------------------------------------------
// Individual tool implementations
// ---------------------------------------------------------------------------

interface AuditListRow {
  id: string;
  status: string | null;
  carrier: string | null;
  billing_period_start: string | null;
  billing_period_end: string | null;
  total_charges_cents: number | null;
  finding_count: number | null;
  high_severity_count: number | null;
  estimated_monthly_savings_cents: number | null;
  created_at: string;
}

export async function executeListAudits(
  _input: unknown,
  ctx: ToolContext,
  citations: CitationCollector,
): Promise<unknown> {
  ListAuditsInputSchema.parse(_input);
  const { data, error } = await ctx.supabase
    .from('audits')
    .select(
      'id,status,carrier,billing_period_start,billing_period_end,total_charges_cents,finding_count,high_severity_count,estimated_monthly_savings_cents,created_at',
    )
    .eq('user_id', ctx.userId)
    .order('created_at', { ascending: false })
    .limit(25);

  if (error) throw new Error(`list_audits failed: ${error.message}`);
  const rows = (data ?? []) as AuditListRow[];
  for (const row of rows) citations.auditIds.add(row.id);
  return { audits: rows };
}

interface AuditDetailRow {
  id: string;
  user_id: string;
  status: string | null;
  carrier: string | null;
  billing_period_start: string | null;
  billing_period_end: string | null;
  total_charges_cents: number | null;
  account_count: number | null;
  line_count: number | null;
  finding_count: number | null;
  high_severity_count: number | null;
  estimated_monthly_savings_cents: number | null;
  estimated_annual_savings_cents: number | null;
  created_at: string;
  completed_at: string | null;
}

export async function executeGetAuditSummary(
  rawInput: unknown,
  ctx: ToolContext,
  citations: CitationCollector,
): Promise<unknown> {
  const { audit_id } = GetAuditSummaryInputSchema.parse(rawInput);

  // Belt-and-suspenders ownership check in addition to RLS: we want the tool
  // to return a stable "not found" payload to the model when the audit isn't
  // the user's, rather than letting a future code change accidentally widen
  // the surface.
  const { data, error } = await ctx.supabase
    .from('audits')
    .select(
      'id,user_id,status,carrier,billing_period_start,billing_period_end,total_charges_cents,account_count,line_count,finding_count,high_severity_count,estimated_monthly_savings_cents,estimated_annual_savings_cents,created_at,completed_at',
    )
    .eq('id', audit_id)
    .eq('user_id', ctx.userId)
    .maybeSingle();

  if (error) throw new Error(`get_audit_summary failed: ${error.message}`);
  if (!data) return { audit: null, missing: 'audit not found' };

  const row = data as AuditDetailRow;
  citations.auditIds.add(row.id);
  // Strip user_id before returning to the model — it has no business in
  // assistant context and exposing it invites future bugs that key on it.
  const { user_id: _userId, ...summary } = row;
  return { audit: summary };
}

interface FindingRow {
  id: string;
  audit_id: string;
  rule_id: string;
  severity: string;
  title: string;
  recommended_action: string;
  estimated_monthly_savings_cents: number;
  confidence: number;
  status: string | null;
  created_at: string;
}

async function assertAuditOwnership(ctx: ToolContext, auditId: string): Promise<boolean> {
  const { data, error } = await ctx.supabase
    .from('audits')
    .select('id')
    .eq('id', auditId)
    .eq('user_id', ctx.userId)
    .maybeSingle();
  if (error) throw new Error(`ownership check failed: ${error.message}`);
  return Boolean(data);
}

export async function executeListFindings(
  rawInput: unknown,
  ctx: ToolContext,
  citations: CitationCollector,
): Promise<unknown> {
  const { audit_id, status_filter } = ListFindingsInputSchema.parse(rawInput);

  // The `findings` table doesn't have user_id directly; RLS joins via
  // audits.user_id. We still verify ownership in code so a stray
  // service-role helper doesn't accidentally widen the surface in the
  // future.
  const owns = await assertAuditOwnership(ctx, audit_id);
  if (!owns) return { audit_id, findings: [], missing: 'audit not found' };

  let query = ctx.supabase
    .from('findings')
    .select(
      'id,audit_id,rule_id,severity,title,recommended_action,estimated_monthly_savings_cents,confidence,status,created_at',
    )
    .eq('audit_id', audit_id)
    .order('estimated_monthly_savings_cents', { ascending: false });

  if (status_filter) {
    query = query.eq('status', status_filter);
  }

  const { data, error } = await query;
  if (error) throw new Error(`list_findings failed: ${error.message}`);
  const rows = (data ?? []) as FindingRow[];
  citations.auditIds.add(audit_id);
  for (const r of rows) citations.findingIds.add(r.id);
  return { audit_id, findings: rows };
}

interface FullFindingRow extends FindingRow {
  description: string;
  affected_line_ids: string[] | null;
  affected_account_ids: string[] | null;
  evidence: unknown;
}

interface LineLast4Row {
  id: string;
  mdn_masked: string | null;
}

interface AccountLast4Row {
  id: string;
  account_number_masked: string | null;
}

function takeLast4(value: string | null): string | null {
  if (!value) return null;
  // The bill_* tables store the masked form like "****4821" or "4821" —
  // normalise to the trailing 4 chars only. If it's shorter than 4, just
  // return as-is (already minimal).
  return value.length <= 4 ? value : value.slice(-4);
}

export async function executeGetFinding(
  rawInput: unknown,
  ctx: ToolContext,
  citations: CitationCollector,
): Promise<unknown> {
  const { finding_id } = GetFindingInputSchema.parse(rawInput);

  // 1. Load the finding (RLS scopes to user-owned audits).
  const { data: finding, error: findingError } = await ctx.supabase
    .from('findings')
    .select(
      'id,audit_id,rule_id,severity,title,description,recommended_action,estimated_monthly_savings_cents,confidence,status,created_at,affected_line_ids,affected_account_ids,evidence',
    )
    .eq('id', finding_id)
    .maybeSingle();

  if (findingError) {
    throw new Error(`get_finding failed: ${findingError.message}`);
  }
  if (!finding) return { finding: null, missing: 'finding not found' };

  const row = finding as FullFindingRow;

  // 2. Verify the audit the finding belongs to is the user's. RLS already
  //    does this, but mirror the pattern from share/route.ts so a future
  //    service-role refactor doesn't open a hole.
  const owns = await assertAuditOwnership(ctx, row.audit_id);
  if (!owns) return { finding: null, missing: 'finding not found' };

  // 3. Resolve affected line IDs to last-4 MDNs. We deliberately do NOT
  //    return the line UUIDs — the model has no use for them and they
  //    encourage joins we don't want to support yet.
  let affectedLineLast4: string[] = [];
  if (row.affected_line_ids && row.affected_line_ids.length > 0) {
    const { data: lines, error: linesError } = await ctx.supabase
      .from('bill_lines')
      .select('id,mdn_masked')
      .in('id', row.affected_line_ids)
      .eq('audit_id', row.audit_id);
    if (linesError) {
      throw new Error(`get_finding lines lookup failed: ${linesError.message}`);
    }
    affectedLineLast4 = ((lines ?? []) as LineLast4Row[])
      .map((l) => takeLast4(l.mdn_masked))
      .filter((v): v is string => v !== null);
  }

  let affectedAccountLast4: string[] = [];
  if (row.affected_account_ids && row.affected_account_ids.length > 0) {
    const { data: accounts, error: accountsError } = await ctx.supabase
      .from('bill_accounts')
      .select('id,account_number_masked')
      .in('id', row.affected_account_ids)
      .eq('audit_id', row.audit_id);
    if (accountsError) {
      throw new Error(`get_finding accounts lookup failed: ${accountsError.message}`);
    }
    affectedAccountLast4 = ((accounts ?? []) as AccountLast4Row[])
      .map((a) => takeLast4(a.account_number_masked))
      .filter((v): v is string => v !== null);
  }

  citations.auditIds.add(row.audit_id);
  citations.findingIds.add(row.id);

  // Strip the raw evidence jsonb and the UUID arrays. Evidence often
  // contains structured data that's safe but verbose; we surface a compact
  // shape instead.
  const {
    affected_line_ids: _lineIds,
    affected_account_ids: _accountIds,
    evidence: _evidence,
    ...rest
  } = row;

  return {
    finding: {
      ...rest,
      affected_line_last4: affectedLineLast4,
      affected_account_last4: affectedAccountLast4,
    },
  };
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
  created_at: string;
}

interface DriverRow {
  id: string;
  bill_comparison_id: string;
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
}

export async function executeGetAutopsy(
  rawInput: unknown,
  ctx: ToolContext,
  citations: CitationCollector,
): Promise<unknown> {
  const { audit_id } = GetAutopsyInputSchema.parse(rawInput);

  const owns = await assertAuditOwnership(ctx, audit_id);
  if (!owns) return { comparison: null, missing: 'audit not found' };

  const { data: compRow, error: compError } = await ctx.supabase
    .from('bill_comparisons')
    .select(
      'id,user_id,previous_audit_id,current_audit_id,previous_total_cents,current_total_cents,net_change_cents,percent_change_bps,disputable_cents,optimization_cents,unexplained_cents,executive_summary,created_at',
    )
    .eq('current_audit_id', audit_id)
    .eq('user_id', ctx.userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (compError) throw new Error(`get_autopsy failed: ${compError.message}`);
  if (!compRow) {
    return {
      comparison: null,
      missing: 'no comparison has been run for this audit yet',
    };
  }

  const comparison = compRow as ComparisonRow;

  const { data: drivers, error: driversError } = await ctx.supabase
    .from('bill_change_drivers')
    .select(
      'id,bill_comparison_id,category,title,summary,previous_cents,current_cents,difference_cents,affected_lines_count,confidence,is_disputable,is_optimization,is_unexplained,recommended_action',
    )
    .eq('bill_comparison_id', comparison.id)
    .order('difference_cents', { ascending: false });

  if (driversError) {
    throw new Error(`get_autopsy drivers lookup failed: ${driversError.message}`);
  }

  citations.auditIds.add(audit_id);
  citations.auditIds.add(comparison.previous_audit_id);
  citations.comparisonIds.add(comparison.id);

  const { user_id: _userId, ...comparisonSafe } = comparison;
  return {
    comparison: comparisonSafe,
    drivers: (drivers ?? []) as DriverRow[],
  };
}

interface LineRow {
  id: string;
  account_id: string;
  mdn_masked: string | null;
  plan_name: string | null;
  plan_base_cents: number | null;
  data_used_gb: number | null;
  voice_used_min: number | null;
  sms_used_count: number | null;
  is_suspended: boolean | null;
  is_active_dpp: boolean | null;
}

interface AccountIdLast4Row {
  id: string;
  account_number_masked: string | null;
}

interface FeatureLinkRow {
  line_id: string;
  category: string | null;
}

export async function executeListLines(
  rawInput: unknown,
  ctx: ToolContext,
  citations: CitationCollector,
): Promise<unknown> {
  const { audit_id, account_last4, has_feature } = ListLinesInputSchema.parse(rawInput);

  const owns = await assertAuditOwnership(ctx, audit_id);
  if (!owns) return { audit_id, lines: [], missing: 'audit not found' };

  // Resolve account-id → last4 once so we can both apply the optional
  // last4 filter and stamp account_last4 onto each returned line.
  const { data: accounts, error: accountsError } = await ctx.supabase
    .from('bill_accounts')
    .select('id,account_number_masked')
    .eq('audit_id', audit_id);
  if (accountsError) {
    throw new Error(`list_lines accounts lookup failed: ${accountsError.message}`);
  }
  const accountRows = (accounts ?? []) as AccountIdLast4Row[];
  const last4ByAccountId = new Map<string, string | null>();
  for (const a of accountRows) {
    last4ByAccountId.set(a.id, takeLast4(a.account_number_masked));
  }

  let accountIdFilter: string[] | null = null;
  if (account_last4) {
    accountIdFilter = accountRows
      .filter((a) => takeLast4(a.account_number_masked) === account_last4)
      .map((a) => a.id);
    if (accountIdFilter.length === 0) {
      return {
        audit_id,
        lines: [],
        missing: `no account on this audit ends in ${account_last4}`,
      };
    }
  }

  let lineQuery = ctx.supabase
    .from('bill_lines')
    .select(
      'id,account_id,mdn_masked,plan_name,plan_base_cents,data_used_gb,voice_used_min,sms_used_count,is_suspended,is_active_dpp',
    )
    .eq('audit_id', audit_id);

  if (accountIdFilter !== null) {
    lineQuery = lineQuery.in('account_id', accountIdFilter);
  }

  const { data: lineRows, error: lineError } = await lineQuery;
  if (lineError) throw new Error(`list_lines failed: ${lineError.message}`);
  let lines = (lineRows ?? []) as LineRow[];

  if (has_feature) {
    const { data: featureRows, error: featureError } = await ctx.supabase
      .from('bill_features')
      .select('line_id,category')
      .eq('audit_id', audit_id)
      .eq('category', has_feature);
    if (featureError) {
      throw new Error(`list_lines feature filter failed: ${featureError.message}`);
    }
    const featureLineIds = new Set(((featureRows ?? []) as FeatureLinkRow[]).map((f) => f.line_id));
    lines = lines.filter((l) => featureLineIds.has(l.id));
  }

  citations.auditIds.add(audit_id);

  return {
    audit_id,
    lines: lines.map((l) => ({
      mdn_last4: takeLast4(l.mdn_masked),
      account_last4: last4ByAccountId.get(l.account_id) ?? null,
      plan_name: l.plan_name,
      plan_base_cents: l.plan_base_cents,
      data_used_gb: l.data_used_gb,
      voice_used_min: l.voice_used_min,
      sms_used_count: l.sms_used_count,
      is_suspended: l.is_suspended ?? false,
      is_active_dpp: l.is_active_dpp ?? false,
    })),
  };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export type AssistantToolName = (typeof ASSISTANT_TOOL_DEFINITIONS)[number]['name'];

export async function executeAssistantTool(
  name: string,
  rawInput: unknown,
  ctx: ToolContext,
  citations: CitationCollector,
): Promise<unknown> {
  switch (name as AssistantToolName) {
    case 'list_audits':
      return executeListAudits(rawInput, ctx, citations);
    case 'get_audit_summary':
      return executeGetAuditSummary(rawInput, ctx, citations);
    case 'list_findings':
      return executeListFindings(rawInput, ctx, citations);
    case 'get_finding':
      return executeGetFinding(rawInput, ctx, citations);
    case 'get_autopsy':
      return executeGetAutopsy(rawInput, ctx, citations);
    case 'list_lines':
      return executeListLines(rawInput, ctx, citations);
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}
