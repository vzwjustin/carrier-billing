import * as React from 'react';

import type { Finding, Severity } from '@/rules/types';
import { formatCents } from '@/lib/utils';

const SEVERITY_BADGE: Record<Severity, string> = {
  high: 'bg-red-50 text-red-700 border-red-200',
  medium: 'bg-amber-50 text-amber-700 border-amber-200',
  low: 'bg-blue-50 text-blue-700 border-blue-200',
  info: 'bg-neutral-50 text-neutral-700 border-neutral-200',
};

const SEVERITY_LABEL: Record<Severity, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
};

function confidenceLabel(c: number): string {
  if (c < 0.5) return 'Speculative';
  if (c <= 0.8) return 'Likely';
  return 'High confidence';
}

export interface FindingCardProps {
  finding: Finding;
}

export function FindingCard({ finding }: FindingCardProps): React.JSX.Element {
  const monthly = finding.estimated_monthly_savings_cents;
  const showSavings = monthly > 0;
  const affectedLines = finding.affected_line_indexes.length;

  return (
    <article className="rounded-lg border border-neutral-200 bg-white p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${SEVERITY_BADGE[finding.severity]}`}
          >
            {SEVERITY_LABEL[finding.severity]}
          </span>
          <span className="inline-flex items-center rounded-md border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-xs font-medium text-neutral-600">
            {confidenceLabel(finding.confidence)}
          </span>
          {affectedLines > 0 ? (
            <span className="inline-flex items-center rounded-md border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-xs font-medium text-neutral-600">
              Affects {affectedLines} line{affectedLines === 1 ? '' : 's'}
            </span>
          ) : null}
        </div>

        {showSavings ? (
          <div className="text-right">
            <p className="text-xs font-medium uppercase tracking-wider text-emerald-700">
              Estimated savings
            </p>
            <p className="text-base font-semibold text-emerald-900">
              {formatCents(monthly)}
              <span className="ml-1 text-xs font-normal text-emerald-800">
                / month
              </span>
            </p>
          </div>
        ) : null}
      </div>

      <h3 className="mt-3 text-base font-semibold text-neutral-900">
        {finding.title}
      </h3>

      <p className="mt-2 text-sm leading-relaxed text-neutral-700">
        {finding.description}
      </p>

      <div className="mt-4 rounded-md border border-neutral-200 bg-neutral-50 p-3">
        <p className="text-xs font-medium uppercase tracking-wider text-neutral-600">
          Recommended action
        </p>
        <p className="mt-1 text-sm leading-relaxed text-neutral-800">
          {finding.recommended_action}
        </p>
      </div>
    </article>
  );
}
