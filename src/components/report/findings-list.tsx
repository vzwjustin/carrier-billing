'use client';

import { useSearchParams } from 'next/navigation';
import * as React from 'react';

import type { Finding, FindingStatus, Severity } from '@/rules/types';

import { FindingCard } from './finding-card';
import {
  applyFindingsFilter,
  bucketBySeverity,
  parseFilterState,
  type FindingMetaMap,
} from './finding-filter';
import { FindingsBulkToolbar } from './findings-bulk-toolbar';
import { FindingsFilterBar } from './findings-filter-bar';

const SEVERITY_ORDER: readonly Severity[] = ['high', 'medium', 'low', 'info'];

const SEVERITY_HEADING: Record<Severity, string> = {
  high: 'High severity',
  medium: 'Medium severity',
  low: 'Low severity',
  info: 'Informational',
};

export interface FindingsListProps {
  findingsBySeverity: Record<Severity, Finding[]>;
  totalFindingCount: number;
  /**
   * Owner-only audit id for the reviewer status control. Threaded down to
   * `FindingCard`; omit on the public share page.
   */
  auditId?: string;
  /** True on the public share surface — disables the status dropdown. */
  isPublic?: boolean;
  /**
   * Optional per-finding metadata keyed by `finding.id`. Used by the
   * "Recently updated" sort option. Missing entries sort last. Kept as a
   * separate map so the core `Finding` shape doesn't have to widen.
   */
  meta?: FindingMetaMap;
}

/**
 * Flatten the severity-bucketed input back into a single array — the order
 * inside each bucket already follows the builder's sort, so the flat shape
 * is fine as a starting point for the client-side filter pipeline.
 */
function flatten(
  bySeverity: Record<Severity, Finding[]>,
): Finding[] {
  const out: Finding[] = [];
  for (const sev of SEVERITY_ORDER) {
    const bucket = bySeverity[sev] ?? [];
    for (const f of bucket) out.push(f);
  }
  return out;
}

export function FindingsList({
  findingsBySeverity,
  totalFindingCount,
  auditId,
  isPublic = false,
  meta,
}: FindingsListProps): React.JSX.Element {
  const searchParams = useSearchParams();
  const filterState = React.useMemo(
    () => parseFilterState(searchParams),
    [searchParams],
  );

  const allFindings = React.useMemo(
    () => flatten(findingsBySeverity),
    [findingsBySeverity],
  );

  const filtered = React.useMemo(
    () => applyFindingsFilter(allFindings, filterState, meta ?? {}),
    [allFindings, filterState, meta],
  );

  // Local override map for status updates applied via the bulk toolbar so
  // the badge reflects the new status without waiting for a server refresh.
  // Keyed by finding.id; survives across filter changes since the underlying
  // data is unchanged.
  const [statusOverrides, setStatusOverrides] = React.useState<
    Readonly<Record<string, FindingStatus>>
  >({});

  // Selection state for the bulk toolbar. We only allow selecting findings
  // that have a DB id; pre-persisted rows have no id and aren't actionable.
  const [selectedIds, setSelectedIds] = React.useState<readonly string[]>(
    [],
  );

  const showSelection = !isPublic && Boolean(auditId);

  const handleToggleSelected = React.useCallback(
    (findingId: string, next: boolean) => {
      setSelectedIds((prev) => {
        const has = prev.includes(findingId);
        if (next === has) return prev;
        if (next) return [...prev, findingId];
        return prev.filter((id) => id !== findingId);
      });
    },
    [],
  );

  const handleClearSelection = React.useCallback(() => {
    setSelectedIds([]);
  }, []);

  const handleStatusApplied = React.useCallback(
    (findingId: string, status: FindingStatus) => {
      setStatusOverrides((prev) =>
        prev[findingId] === status ? prev : { ...prev, [findingId]: status },
      );
    },
    [],
  );

  // Apply overrides on the visible set so the badge + status dropdown
  // reflect the latest write without a router.refresh().
  const filteredWithOverrides = React.useMemo(() => {
    if (Object.keys(statusOverrides).length === 0) return filtered;
    return filtered.map((f) => {
      if (!f.id) return f;
      const override = statusOverrides[f.id];
      if (!override || override === f.status) return f;
      return { ...f, status: override };
    });
  }, [filtered, statusOverrides]);

  const visibleBySeverity = React.useMemo(
    () => bucketBySeverity(filteredWithOverrides),
    [filteredWithOverrides],
  );

  const visibleCount = filteredWithOverrides.length;

  return (
    <div className="space-y-4">
      <FindingsFilterBar
        totalFindingCount={totalFindingCount}
        visibleFindingCount={visibleCount}
      />

      {showSelection && auditId ? (
        <FindingsBulkToolbar
          auditId={auditId}
          selectedIds={selectedIds}
          onClear={handleClearSelection}
          onStatusApplied={handleStatusApplied}
        />
      ) : null}

      {totalFindingCount === 0 ? (
        <section className="rounded-lg border border-neutral-200 bg-white p-8 text-center">
          <p className="text-base font-medium text-neutral-900">
            No issues found — your bill looks clean.
          </p>
          <p className="mt-2 text-sm text-neutral-600">
            We did not detect any waste patterns in this billing period.
          </p>
        </section>
      ) : visibleCount === 0 ? (
        <section className="rounded-lg border border-neutral-200 bg-white p-8 text-center">
          <p className="text-base font-medium text-neutral-900">
            No findings match the current filters.
          </p>
          <p className="mt-2 text-sm text-neutral-600">
            Adjust the filter chips above or clear filters to see every finding.
          </p>
        </section>
      ) : (
        <div className="space-y-8">
          {SEVERITY_ORDER.map((sev) => {
            const items = visibleBySeverity[sev] ?? [];
            if (items.length === 0) return null;
            return (
              <section key={sev} className="space-y-3">
                <div className="flex items-baseline justify-between">
                  <h2 className="text-lg font-semibold tracking-tight text-neutral-900">
                    {SEVERITY_HEADING[sev]}
                  </h2>
                  <span className="text-xs font-medium text-neutral-500">
                    {items.length} finding{items.length === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="space-y-3">
                  {items.map((f, i) => {
                    const selected = Boolean(
                      f.id && selectedIds.includes(f.id),
                    );
                    return (
                      <FindingCard
                        key={`${sev}-${f.rule_id}-${f.id ?? i}`}
                        finding={f}
                        auditId={auditId}
                        isPublic={isPublic}
                        selected={selected}
                        onToggleSelected={
                          showSelection ? handleToggleSelected : undefined
                        }
                      />
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
