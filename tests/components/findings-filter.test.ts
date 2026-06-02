import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SORT,
  EMPTY_FILTER_STATE,
  applyFindingsFilter,
  bucketBySeverity,
  isFilterActive,
  parseFilterState,
  serializeFilterState,
  sortFindings,
  type FindingMetaMap,
  type FindingsFilterState,
} from '@/components/report/finding-filter';
import type { Finding, FindingStatus, Severity } from '@/rules/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let nextId = 0;
function nextFindingId(): string {
  nextId += 1;
  return `00000000-0000-4000-8000-${nextId.toString().padStart(12, '0')}`;
}

interface MakeFindingOptions {
  id?: string | null;
  rule_id?: string;
  severity?: Severity;
  status?: FindingStatus;
  title?: string;
  savings?: number;
}

function makeFinding(opts: MakeFindingOptions = {}): Finding {
  const id = opts.id === null ? undefined : (opts.id ?? nextFindingId());
  return {
    id,
    rule_id: opts.rule_id ?? 'r_unspecified',
    severity: opts.severity ?? 'low',
    title: opts.title ?? 'Untitled finding',
    description: 'desc',
    recommended_action: 'do something',
    estimated_monthly_savings_cents: opts.savings ?? 0,
    confidence: 0.9,
    affected_line_indexes: [],
    affected_account_indexes: [],
    evidence: {},
    status: opts.status ?? 'new',
  };
}

function withState(partial: Partial<FindingsFilterState>): FindingsFilterState {
  return { ...EMPTY_FILTER_STATE, ...partial };
}

// ---------------------------------------------------------------------------
// parseFilterState
// ---------------------------------------------------------------------------

describe('parseFilterState', () => {
  it('returns empty defaults when params is null/undefined', () => {
    expect(parseFilterState(null)).toEqual(EMPTY_FILTER_STATE);
    expect(parseFilterState(undefined)).toEqual(EMPTY_FILTER_STATE);
  });

  it('returns empty defaults for an empty URLSearchParams', () => {
    expect(parseFilterState(new URLSearchParams())).toEqual(EMPTY_FILTER_STATE);
  });

  it('parses severities from a comma-separated string', () => {
    const params = new URLSearchParams('sev=high,medium');
    expect(parseFilterState(params).severities).toEqual(['high', 'medium']);
  });

  it('parses statuses from a comma-separated string', () => {
    const params = new URLSearchParams('status=new,in_review,approved');
    expect(parseFilterState(params).statuses).toEqual(['new', 'in_review', 'approved']);
  });

  it('drops unknown enum values silently', () => {
    const params = new URLSearchParams('sev=high,bogus,info&status=??,approved');
    const out = parseFilterState(params);
    expect(out.severities).toEqual(['high', 'info']);
    expect(out.statuses).toEqual(['approved']);
  });

  it('dedupes repeated enum values', () => {
    const params = new URLSearchParams('sev=high,high,medium,high');
    expect(parseFilterState(params).severities).toEqual(['high', 'medium']);
  });

  it('parses the free-text query', () => {
    const params = new URLSearchParams('q=expired%20promo');
    expect(parseFilterState(params).query).toBe('expired promo');
  });

  it('falls back to the default sort for unknown values', () => {
    const a = new URLSearchParams('sort=unknown');
    expect(parseFilterState(a).sort).toBe(DEFAULT_SORT);
    const b = new URLSearchParams('sort=severity');
    expect(parseFilterState(b).sort).toBe('severity');
  });
});

// ---------------------------------------------------------------------------
// serializeFilterState
// ---------------------------------------------------------------------------

describe('serializeFilterState', () => {
  it('omits empty defaults', () => {
    expect(serializeFilterState(EMPTY_FILTER_STATE)).toBe('');
  });

  it('round-trips through parseFilterState', () => {
    const state = withState({
      severities: ['high', 'medium'],
      statuses: ['approved', 'rejected'],
      query: 'pooled data',
      sort: 'severity',
    });
    const qs = serializeFilterState(state);
    const round = parseFilterState(new URLSearchParams(qs));
    expect(round).toEqual(state);
  });

  it('omits the default sort but keeps a non-default sort', () => {
    expect(serializeFilterState(withState({ sort: DEFAULT_SORT }))).toBe('');
    expect(serializeFilterState(withState({ sort: 'updated' }))).toContain('sort=updated');
  });
});

// ---------------------------------------------------------------------------
// isFilterActive
// ---------------------------------------------------------------------------

describe('isFilterActive', () => {
  it('is false for the empty/default state', () => {
    expect(isFilterActive(EMPTY_FILTER_STATE)).toBe(false);
  });

  it('is true when any chip / query / non-default sort is set', () => {
    expect(isFilterActive(withState({ severities: ['high'] }))).toBe(true);
    expect(isFilterActive(withState({ statuses: ['approved'] }))).toBe(true);
    expect(isFilterActive(withState({ query: 'foo' }))).toBe(true);
    expect(isFilterActive(withState({ sort: 'severity' }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// applyFindingsFilter — combinations
// ---------------------------------------------------------------------------

describe('applyFindingsFilter', () => {
  function makeCorpus(): Finding[] {
    return [
      makeFinding({
        rule_id: 'r_high_a',
        severity: 'high',
        status: 'approved',
        title: 'Roaming overages',
        savings: 5000,
      }),
      makeFinding({
        rule_id: 'r_high_b',
        severity: 'high',
        status: 'new',
        title: 'Expired promo credit',
        savings: 3000,
      }),
      makeFinding({
        rule_id: 'r_medium_a',
        severity: 'medium',
        status: 'rejected',
        title: 'Pooled data underuse',
        savings: 1500,
      }),
      makeFinding({
        rule_id: 'r_low_a',
        severity: 'low',
        status: 'in_review',
        title: 'Unused premium feature',
        savings: 200,
      }),
      makeFinding({
        rule_id: 'r_info_a',
        severity: 'info',
        status: 'disputed',
        title: 'Bill structure note',
        savings: 0,
      }),
    ];
  }

  it('returns all findings under the empty state', () => {
    const corpus = makeCorpus();
    expect(applyFindingsFilter(corpus, EMPTY_FILTER_STATE)).toHaveLength(corpus.length);
  });

  it('filters by severity (OR within the chip group)', () => {
    const corpus = makeCorpus();
    const out = applyFindingsFilter(corpus, withState({ severities: ['high', 'medium'] }));
    expect(out.map((f) => f.severity)).toEqual(['high', 'high', 'medium']);
  });

  it('filters by status (OR within the chip group)', () => {
    const corpus = makeCorpus();
    const out = applyFindingsFilter(corpus, withState({ statuses: ['new', 'in_review'] }));
    expect(out.map((f) => f.status)).toEqual(['new', 'in_review']);
  });

  it('combines severity AND status as an intersection', () => {
    const corpus = makeCorpus();
    const out = applyFindingsFilter(corpus, withState({ severities: ['high'], statuses: ['new'] }));
    expect(out).toHaveLength(1);
    expect(out[0]?.rule_id).toBe('r_high_b');
  });

  it('treats missing status as "new" when filtering', () => {
    const corpus: Finding[] = [makeFinding({ rule_id: 'r_no_status', severity: 'low' })];
    // Strip the status to mimic a pre-persisted Finding.
    delete (corpus[0] as { status?: FindingStatus }).status;
    expect(applyFindingsFilter(corpus, withState({ statuses: ['new'] }))).toHaveLength(1);
    expect(applyFindingsFilter(corpus, withState({ statuses: ['approved'] }))).toHaveLength(0);
  });

  it('matches the query against title (case-insensitive)', () => {
    const corpus = makeCorpus();
    const out = applyFindingsFilter(corpus, withState({ query: 'PROMO' }));
    expect(out.map((f) => f.rule_id)).toEqual(['r_high_b']);
  });

  it('matches the query against rule_id (case-insensitive)', () => {
    const corpus = makeCorpus();
    const out = applyFindingsFilter(corpus, withState({ query: 'medium_A' }));
    expect(out.map((f) => f.rule_id)).toEqual(['r_medium_a']);
  });

  it('combines query with severity/status filters', () => {
    const corpus = makeCorpus();
    const out = applyFindingsFilter(
      corpus,
      withState({
        severities: ['high'],
        statuses: ['new'],
        query: 'expired',
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.rule_id).toBe('r_high_b');
  });

  it('returns an empty array when nothing matches', () => {
    const corpus = makeCorpus();
    const out = applyFindingsFilter(
      corpus,
      withState({ severities: ['high'], statuses: ['resolved'] }),
    );
    expect(out).toHaveLength(0);
  });

  it('does not mutate its inputs', () => {
    const corpus = makeCorpus();
    const snapshot = corpus.map((f) => ({ ...f }));
    applyFindingsFilter(corpus, withState({ severities: ['high'] }));
    expect(corpus).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// sortFindings
// ---------------------------------------------------------------------------

describe('sortFindings', () => {
  it('sorts by savings descending by default', () => {
    const a = makeFinding({ savings: 100, title: 'b' });
    const b = makeFinding({ savings: 500, title: 'a' });
    const c = makeFinding({ savings: 300, title: 'c' });
    const out = sortFindings([a, b, c], 'savings');
    expect(out.map((f) => f.estimated_monthly_savings_cents)).toEqual([500, 300, 100]);
  });

  it('sorts by severity rank then by savings', () => {
    const items = [
      makeFinding({ severity: 'info', savings: 10000, title: 'a' }),
      makeFinding({ severity: 'high', savings: 100, title: 'b' }),
      makeFinding({ severity: 'medium', savings: 50, title: 'c' }),
      makeFinding({ severity: 'high', savings: 200, title: 'd' }),
    ];
    const out = sortFindings(items, 'severity');
    expect(out.map((f) => f.severity)).toEqual(['high', 'high', 'medium', 'info']);
    // Same severity falls back to savings desc:
    expect(out[0]?.estimated_monthly_savings_cents).toBe(200);
    expect(out[1]?.estimated_monthly_savings_cents).toBe(100);
  });

  it('sorts by recently-updated using the meta map; nulls sort last', () => {
    const a = makeFinding({ title: 'a' });
    const b = makeFinding({ title: 'b' });
    const c = makeFinding({ title: 'c', id: null });
    const meta: FindingMetaMap = {
      [a.id as string]: { updatedAt: '2024-01-01T00:00:00Z' },
      [b.id as string]: { updatedAt: '2024-06-01T00:00:00Z' },
    };
    const out = sortFindings([a, b, c], 'updated', meta);
    expect(out.map((f) => f.title)).toEqual(['b', 'a', 'c']);
  });

  it('does not mutate its inputs', () => {
    const items = [makeFinding({ savings: 100 }), makeFinding({ savings: 500 })];
    const before = [...items];
    sortFindings(items, 'savings');
    expect(items).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// bucketBySeverity
// ---------------------------------------------------------------------------

describe('bucketBySeverity', () => {
  it('groups findings into severity buckets in order', () => {
    const items = [
      makeFinding({ severity: 'medium' }),
      makeFinding({ severity: 'high' }),
      makeFinding({ severity: 'high' }),
      makeFinding({ severity: 'info' }),
    ];
    const out = bucketBySeverity(items);
    expect(out.high).toHaveLength(2);
    expect(out.medium).toHaveLength(1);
    expect(out.low).toHaveLength(0);
    expect(out.info).toHaveLength(1);
  });

  it('always returns every bucket key, even when empty', () => {
    const out = bucketBySeverity([]);
    expect(Object.keys(out).sort()).toEqual(['high', 'info', 'low', 'medium']);
    expect(out.high).toEqual([]);
  });
});
