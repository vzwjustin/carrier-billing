import * as React from 'react';

import type { Finding, Severity } from '@/rules/types';

import { FindingCard } from './finding-card';

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
}

export function FindingsList({
  findingsBySeverity,
  totalFindingCount,
  auditId,
  isPublic = false,
}: FindingsListProps): React.JSX.Element {
  if (totalFindingCount === 0) {
    return (
      <section className="rounded-lg border border-neutral-200 bg-white p-8 text-center">
        <p className="text-base font-medium text-neutral-900">
          No issues found — your bill looks clean.
        </p>
        <p className="mt-2 text-sm text-neutral-600">
          We did not detect any waste patterns in this billing period.
        </p>
      </section>
    );
  }

  return (
    <div className="space-y-8">
      {SEVERITY_ORDER.map((sev) => {
        const items = findingsBySeverity[sev] ?? [];
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
              {items.map((f, i) => (
                <FindingCard
                  key={`${sev}-${f.rule_id}-${i}`}
                  finding={f}
                  auditId={auditId}
                  isPublic={isPublic}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
