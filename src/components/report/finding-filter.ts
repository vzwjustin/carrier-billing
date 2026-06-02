/**
 * Pure filter + sort + URL-state helpers for the findings list. No React,
 * no DOM, no `fetch` — kept this way so the unit tests can exercise every
 * combination without mounting components.
 *
 * URL search-param schema (used by `findings-filter-bar.tsx`):
 *   - `sev=high,medium`            comma-separated `Severity` values
 *   - `status=new,in_review`       comma-separated `FindingStatus` values
 *   - `q=<text>`                   free-text query, case-insensitive over
 *                                  `title` + `rule_id`
 *   - `sort=savings|severity|updated`  defaults to `savings`
 *
 * Unknown / malformed values are dropped silently so a hand-edited URL
 * never throws — the worst case is the filter quietly resets to the default.
 */
import type { Finding, FindingStatus, Severity } from '@/rules/types';

import { FINDING_STATUS_VALUES } from './finding-status-meta';

export const SEVERITY_VALUES: readonly Severity[] = ['high', 'medium', 'low', 'info'];

export const SORT_VALUES = ['savings', 'severity', 'updated'] as const;
export type SortKey = (typeof SORT_VALUES)[number];

export const DEFAULT_SORT: SortKey = 'savings';

const SEVERITY_RANK: Record<Severity, number> = {
  high: 0,
  medium: 1,
  low: 2,
  info: 3,
};

export interface FindingsFilterState {
  severities: readonly Severity[];
  statuses: readonly FindingStatus[];
  query: string;
  sort: SortKey;
}

export const EMPTY_FILTER_STATE: FindingsFilterState = {
  severities: [],
  statuses: [],
  query: '',
  sort: DEFAULT_SORT,
};

/**
 * Optional metadata that improves sorting + search but isn't part of the
 * core `Finding` shape. Threaded in as a parallel map keyed by `finding.id`
 * so we never have to widen `Finding` itself (and so server-rendered
 * snapshots stay unchanged for pre-persisted findings).
 */
export interface FindingMeta {
  /** ISO timestamp; used by `sort=updated`. Missing values sort last. */
  updatedAt?: string | null;
}

export type FindingMetaMap = Readonly<Record<string, FindingMeta>>;

function isSeverity(v: string): v is Severity {
  return (SEVERITY_VALUES as readonly string[]).includes(v);
}

function isStatus(v: string): v is FindingStatus {
  return (FINDING_STATUS_VALUES as readonly string[]).includes(v);
}

function isSortKey(v: string): v is SortKey {
  return (SORT_VALUES as readonly string[]).includes(v);
}

function dedupe<T>(values: readonly T[]): T[] {
  const out: T[] = [];
  const seen = new Set<T>();
  for (const v of values) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * Parse a comma-separated string like "high,medium" against an allow-list,
 * dropping unknown / empty entries. Returns an empty array on `null`.
 */
function parseCsvEnum<T extends string>(raw: string | null, guard: (v: string) => v is T): T[] {
  if (!raw) return [];
  return dedupe(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s): s is T => s.length > 0 && guard(s)),
  );
}

/**
 * Parser is tolerant: hand-edited URLs never throw, they degrade to the
 * defaults. The caller (`useSearchParams`) hands us a `URLSearchParams`
 * which we read keys off of.
 */
export function parseFilterState(params: URLSearchParams | null | undefined): FindingsFilterState {
  if (!params) return EMPTY_FILTER_STATE;
  const severities = parseCsvEnum(params.get('sev'), isSeverity);
  const statuses = parseCsvEnum(params.get('status'), isStatus);
  const query = (params.get('q') ?? '').trim();
  const rawSort = params.get('sort');
  const sort: SortKey = rawSort && isSortKey(rawSort) ? rawSort : DEFAULT_SORT;
  return { severities, statuses, query, sort };
}

/**
 * Serialise back into a search string. Defaults (empty arrays / default
 * sort / empty query) are omitted to keep URLs short.
 */
export function serializeFilterState(state: FindingsFilterState): string {
  const params = new URLSearchParams();
  if (state.severities.length > 0) {
    params.set('sev', state.severities.join(','));
  }
  if (state.statuses.length > 0) {
    params.set('status', state.statuses.join(','));
  }
  if (state.query.length > 0) {
    params.set('q', state.query);
  }
  if (state.sort !== DEFAULT_SORT) {
    params.set('sort', state.sort);
  }
  return params.toString();
}

export function isFilterActive(state: FindingsFilterState): boolean {
  return (
    state.severities.length > 0 ||
    state.statuses.length > 0 ||
    state.query.length > 0 ||
    state.sort !== DEFAULT_SORT
  );
}

function matchesQuery(finding: Finding, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  const haystack = `${finding.title.toLowerCase()} ${finding.rule_id.toLowerCase()}`;
  return haystack.includes(needle);
}

/**
 * Pure filter + sort pipeline. Inputs are not mutated; output is a new
 * array. Designed to run client-side on the already-loaded payload so the
 * filter bar never hits the DB.
 */
export function applyFindingsFilter(
  findings: readonly Finding[],
  state: FindingsFilterState,
  meta: FindingMetaMap = {},
): Finding[] {
  const sevSet = new Set<Severity>(state.severities);
  const statusSet = new Set<FindingStatus>(state.statuses);

  const filtered = findings.filter((f) => {
    if (sevSet.size > 0 && !sevSet.has(f.severity)) return false;
    if (statusSet.size > 0) {
      const status: FindingStatus = f.status ?? 'new';
      if (!statusSet.has(status)) return false;
    }
    if (!matchesQuery(f, state.query)) return false;
    return true;
  });

  return sortFindings(filtered, state.sort, meta);
}

function metaUpdatedAt(finding: Finding, meta: FindingMetaMap): number | null {
  if (!finding.id) return null;
  const m = meta[finding.id];
  if (!m?.updatedAt) return null;
  const ts = Date.parse(m.updatedAt);
  return Number.isNaN(ts) ? null : ts;
}

export function sortFindings(
  findings: readonly Finding[],
  sort: SortKey,
  meta: FindingMetaMap = {},
): Finding[] {
  const copy = [...findings];
  switch (sort) {
    case 'savings':
      copy.sort((a, b) => {
        if (b.estimated_monthly_savings_cents !== a.estimated_monthly_savings_cents) {
          return b.estimated_monthly_savings_cents - a.estimated_monthly_savings_cents;
        }
        return a.title.localeCompare(b.title);
      });
      return copy;
    case 'severity':
      copy.sort((a, b) => {
        const ra = SEVERITY_RANK[a.severity];
        const rb = SEVERITY_RANK[b.severity];
        if (ra !== rb) return ra - rb;
        if (b.estimated_monthly_savings_cents !== a.estimated_monthly_savings_cents) {
          return b.estimated_monthly_savings_cents - a.estimated_monthly_savings_cents;
        }
        return a.title.localeCompare(b.title);
      });
      return copy;
    case 'updated':
      copy.sort((a, b) => {
        const ua = metaUpdatedAt(a, meta);
        const ub = metaUpdatedAt(b, meta);
        // Most-recent first; nulls sort last.
        if (ua === ub) return a.title.localeCompare(b.title);
        if (ua === null) return 1;
        if (ub === null) return -1;
        return ub - ua;
      });
      return copy;
  }
}

/**
 * Re-bucket a flat list back into the severity-keyed shape `FindingsList`
 * already renders. Buckets are always present (empty array if none).
 */
export function bucketBySeverity(findings: readonly Finding[]): Record<Severity, Finding[]> {
  const buckets: Record<Severity, Finding[]> = {
    high: [],
    medium: [],
    low: [],
    info: [],
  };
  for (const f of findings) {
    buckets[f.severity].push(f);
  }
  return buckets;
}
