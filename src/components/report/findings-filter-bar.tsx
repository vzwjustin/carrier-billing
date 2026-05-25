'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';

import type { FindingStatus, Severity } from '@/rules/types';
import { cn } from '@/lib/utils';

import {
  DEFAULT_SORT,
  EMPTY_FILTER_STATE,
  SEVERITY_VALUES,
  SORT_VALUES,
  type FindingsFilterState,
  type SortKey,
  isFilterActive,
  parseFilterState,
  serializeFilterState,
} from './finding-filter';
import {
  FINDING_STATUS_LABEL,
  FINDING_STATUS_VALUES,
} from './finding-status-meta';

const SEVERITY_LABEL: Record<Severity, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
};

const SORT_LABEL: Record<SortKey, string> = {
  savings: 'Savings desc',
  severity: 'Severity',
  updated: 'Recently updated',
};

// Inactive chip vs. active chip — kept inline so we don't grow another
// variant module. Matches the neutral/dark accent used by `Button`.
const CHIP_BASE =
  'inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-1';
const CHIP_ACTIVE = 'border-neutral-900 bg-neutral-900 text-white';
const CHIP_INACTIVE =
  'border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-100';

interface ChipProps {
  label: string;
  selected: boolean;
  onToggle: () => void;
}

function Chip({ label, selected, onToggle }: ChipProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={selected}
      className={cn(CHIP_BASE, selected ? CHIP_ACTIVE : CHIP_INACTIVE)}
    >
      {label}
    </button>
  );
}

function toggleSeverity(
  list: readonly Severity[],
  value: Severity,
): Severity[] {
  return list.includes(value)
    ? list.filter((v) => v !== value)
    : [...list, value];
}

function toggleStatus(
  list: readonly FindingStatus[],
  value: FindingStatus,
): FindingStatus[] {
  return list.includes(value)
    ? list.filter((v) => v !== value)
    : [...list, value];
}

export interface FindingsFilterBarProps {
  /** Total findings *before* filtering — for the "Showing X of Y" line. */
  totalFindingCount: number;
  /** Visible findings *after* filtering — populated by the parent. */
  visibleFindingCount: number;
}

export function FindingsFilterBar({
  totalFindingCount,
  visibleFindingCount,
}: FindingsFilterBarProps): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const state = React.useMemo<FindingsFilterState>(
    () => parseFilterState(searchParams),
    [searchParams],
  );

  // The `q` input is debounced into the URL so each keystroke doesn't
  // pollute history. Local state mirrors the URL; the debounce flushes
  // after the user pauses typing.
  const [queryDraft, setQueryDraft] = React.useState(state.query);
  React.useEffect(() => {
    setQueryDraft(state.query);
  }, [state.query]);

  const pushState = React.useCallback(
    (next: FindingsFilterState) => {
      const qs = serializeFilterState(next);
      const target = qs.length > 0 ? `${pathname}?${qs}` : pathname;
      // `scroll: false` so toggling a chip doesn't yank the page to the top.
      router.replace(target, { scroll: false });
    },
    [pathname, router],
  );

  const onToggleSeverity = React.useCallback(
    (sev: Severity) => {
      pushState({ ...state, severities: toggleSeverity(state.severities, sev) });
    },
    [pushState, state],
  );

  const onToggleStatus = React.useCallback(
    (status: FindingStatus) => {
      pushState({ ...state, statuses: toggleStatus(state.statuses, status) });
    },
    [pushState, state],
  );

  const onChangeSort = React.useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      const v = event.target.value;
      const sort: SortKey = (SORT_VALUES as readonly string[]).includes(v)
        ? (v as SortKey)
        : DEFAULT_SORT;
      pushState({ ...state, sort });
    },
    [pushState, state],
  );

  // 250ms debounce — typical for filter inputs. Resets on each keystroke
  // so we only push once the user settles.
  React.useEffect(() => {
    if (queryDraft === state.query) return;
    const t = setTimeout(() => {
      pushState({ ...state, query: queryDraft });
    }, 250);
    return () => clearTimeout(t);
  }, [queryDraft, pushState, state]);

  const onClear = React.useCallback(() => {
    setQueryDraft('');
    pushState(EMPTY_FILTER_STATE);
  }, [pushState]);

  const showStat = totalFindingCount > 0;
  const isFiltering =
    visibleFindingCount !== totalFindingCount || isFilterActive(state);

  return (
    <div className="space-y-3 rounded-lg border border-neutral-200 bg-white p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Severity
          </span>
          {SEVERITY_VALUES.map((sev) => (
            <Chip
              key={sev}
              label={SEVERITY_LABEL[sev]}
              selected={state.severities.includes(sev)}
              onToggle={() => onToggleSeverity(sev)}
            />
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          Status
        </span>
        {FINDING_STATUS_VALUES.map((status) => (
          <Chip
            key={status}
            label={FINDING_STATUS_LABEL[status]}
            selected={state.statuses.includes(status)}
            onToggle={() => onToggleStatus(status)}
          />
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex flex-1 min-w-[200px] items-center gap-2 text-xs text-neutral-600">
          <span className="sr-only">Search findings</span>
          <input
            type="search"
            value={queryDraft}
            onChange={(event) => setQueryDraft(event.target.value)}
            placeholder="Search title or rule id…"
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500"
            aria-label="Search findings"
          />
        </label>
        <label className="flex items-center gap-2 text-xs text-neutral-600">
          <span className="font-medium uppercase tracking-wider text-neutral-500">
            Sort
          </span>
          <select
            value={state.sort}
            onChange={onChangeSort}
            className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm font-medium text-neutral-700 shadow-sm focus:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500"
            aria-label="Sort findings"
          >
            {SORT_VALUES.map((s) => (
              <option key={s} value={s}>
                {SORT_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        {isFilterActive(state) ? (
          <button
            type="button"
            onClick={onClear}
            className="text-xs font-medium text-neutral-600 underline-offset-2 hover:text-neutral-900 hover:underline"
          >
            Clear filters
          </button>
        ) : null}
      </div>

      {showStat ? (
        <p
          className="text-xs text-neutral-500"
          aria-live="polite"
          aria-atomic="true"
        >
          {isFiltering
            ? `Showing ${visibleFindingCount} of ${totalFindingCount} findings`
            : `${totalFindingCount} finding${totalFindingCount === 1 ? '' : 's'}`}
        </p>
      ) : null}
    </div>
  );
}
