/**
 * Findings-over-time aggregator.
 *
 * Pure function — takes a list of completed audits (most recent first, as
 * the dashboard fetches them) plus a flat list of `(audit_id, severity)`
 * rows from the findings table, and returns one stack-column per audit for
 * the most recent N (default 6, oldest first so the chart reads left → right).
 *
 * The findings table only has one row per finding, so we count occurrences
 * here rather than relying on a denormalized per-severity column on audits
 * (only `high_severity_count` is currently denormalized — see migration 0001).
 *
 * Used by:
 *   - /src/app/(app)/dashboard/page.tsx → <FindingsOverTimeChart />
 */

export type Severity = 'high' | 'medium' | 'low' | 'info';

/** Display order for stack segments — bottom → top. Mirrors UI semantics. */
export const SEVERITY_ORDER: ReadonlyArray<Severity> = [
  'high',
  'medium',
  'low',
  'info',
];

export interface AuditMini {
  id: string;
  /** ISO timestamp — used for X-axis labels and ordering. */
  created_at: string;
}

export interface FindingMini {
  audit_id: string;
  /**
   * Severity from the findings table. Any value outside the known set is
   * ignored — defensive against future enum drift.
   */
  severity: string;
}

export interface TimeSeriesRow {
  audit_id: string;
  created_at: string;
  /** Counts keyed by severity. Every known severity is present (defaults 0). */
  counts: Record<Severity, number>;
  /** Sum across all four severities — convenience for y-scale callers. */
  total: number;
}

/** Default window size — 6 audits gives ~1 quarter of context without crowding. */
export const DEFAULT_WINDOW = 6;

function isSeverity(value: string): value is Severity {
  return (
    value === 'high' ||
    value === 'medium' ||
    value === 'low' ||
    value === 'info'
  );
}

/**
 * Aggregate findings by audit for the most recent `windowSize` audits.
 *
 * `audits` is expected to be ordered newest → oldest (matching the
 * dashboard's `.order('created_at', { ascending: false })`). The output is
 * reversed so the chart reads oldest → newest left-to-right.
 */
export function aggregateFindingsOverTime(
  audits: ReadonlyArray<AuditMini>,
  findings: ReadonlyArray<FindingMini>,
  windowSize: number = DEFAULT_WINDOW,
): TimeSeriesRow[] {
  const window = audits.slice(0, Math.max(0, windowSize));

  // Build a per-audit counter; ensures every audit gets a row even if no
  // findings exist for it (all-zero columns are still meaningful context).
  const byAudit = new Map<string, Record<Severity, number>>();
  for (const audit of window) {
    byAudit.set(audit.id, { high: 0, medium: 0, low: 0, info: 0 });
  }

  for (const finding of findings) {
    const counts = byAudit.get(finding.audit_id);
    if (!counts) continue;
    if (!isSeverity(finding.severity)) continue;
    counts[finding.severity] += 1;
  }

  const rows: TimeSeriesRow[] = window.map((audit) => {
    const counts = byAudit.get(audit.id) ?? {
      high: 0,
      medium: 0,
      low: 0,
      info: 0,
    };
    const total = counts.high + counts.medium + counts.low + counts.info;
    return {
      audit_id: audit.id,
      created_at: audit.created_at,
      counts,
      total,
    };
  });

  // Reverse so the chart reads left = oldest → right = newest.
  rows.reverse();

  return rows;
}
