import * as React from 'react';

import type { Finding, FindingStatus, Severity } from '@/rules/types';
import { formatCents } from '@/lib/utils';
import {
  buildFindingViewModel,
  type FindingViewModel,
} from '@/reports/finding-view-model';

import { FindingStatusControl } from './finding-status-control';
import {
  FINDING_STATUS_BADGE,
  FINDING_STATUS_LABEL,
} from './finding-status-meta';

const SEVERITY_BADGE: Record<Severity, string> = {
  high: 'bg-red-50 text-red-700 border-red-200',
  medium: 'bg-amber-50 text-amber-700 border-amber-200',
  low: 'bg-blue-50 text-blue-700 border-blue-200',
  info: 'bg-neutral-50 text-neutral-700 border-neutral-200',
};

export interface FindingCardProps {
  finding: Finding;
  /**
   * Set when the card is rendered inside an owner-only audit page. Required
   * to render the interactive status control — without it (e.g. on
   * /share/[token]) the card shows the status badge read-only and omits
   * the dropdown.
   */
  auditId?: string;
  /**
   * True on the public share surface. When true the status badge renders
   * read-only and the dropdown is omitted. Defaults to false.
   */
  isPublic?: boolean;
}

export function FindingCard({
  finding,
  auditId,
  isPublic = false,
}: FindingCardProps): React.JSX.Element {
  const vm: FindingViewModel = buildFindingViewModel(finding);
  // Status defaults to 'new' for any finding loaded without a hydrated value.
  // The DB default already guarantees a value on persisted rows; this fallback
  // covers the pre-persisted (rules-engine-only) and missing-column cases.
  const status: FindingStatus = finding.status ?? 'new';

  return (
    <article className="rounded-lg border border-neutral-200 bg-white p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${SEVERITY_BADGE[vm.severity]}`}
          >
            {vm.severityLabel}
          </span>
          <span
            className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${FINDING_STATUS_BADGE[status]}`}
          >
            {FINDING_STATUS_LABEL[status]}
          </span>
          <span className="inline-flex items-center rounded-md border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-xs font-medium text-neutral-600">
            {vm.confidenceLabel}
          </span>
          {vm.affectedLineCount > 0 ? (
            <span className="inline-flex items-center rounded-md border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-xs font-medium text-neutral-600">
              Affects {vm.affectedLineCount} line
              {vm.affectedLineCount === 1 ? '' : 's'}
            </span>
          ) : null}
          {vm.affectedAccountCount > 0 ? (
            <span className="inline-flex items-center rounded-md border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-xs font-medium text-neutral-600">
              {vm.affectedAccountCount} account
              {vm.affectedAccountCount === 1 ? '' : 's'} affected
            </span>
          ) : null}
          <span className="inline-flex items-center rounded-md border border-neutral-200 bg-neutral-50 px-2 py-0.5 font-mono text-xs font-medium text-neutral-600">
            {vm.ruleId}
          </span>
          {/*
            Status dropdown only renders for the owner's view AND when the
            finding has a DB-assigned id. Public share = read-only badge above.
          */}
          {!isPublic && auditId && finding.id ? (
            <FindingStatusControl
              auditId={auditId}
              findingId={finding.id}
              initialStatus={status}
            />
          ) : null}
        </div>

        {vm.hasSavings ? (
          <div className="text-right">
            <p className="text-xs font-medium uppercase tracking-wider text-emerald-700">
              Estimated savings
            </p>
            <p className="text-base font-semibold text-emerald-900">
              {formatCents(vm.monthlySavingsCents)}
              <span className="ml-1 text-xs font-normal text-emerald-800">
                / month
              </span>
            </p>
          </div>
        ) : null}
      </div>

      <h3 className="mt-3 text-base font-semibold text-neutral-900">
        {vm.title}
      </h3>

      <p className="mt-2 text-sm leading-relaxed text-neutral-700">
        {vm.description}
      </p>

      <div className="mt-4 rounded-md border border-neutral-200 bg-neutral-50 p-3">
        <p className="text-xs font-medium uppercase tracking-wider text-neutral-600">
          Recommended action
        </p>
        <p className="mt-1 text-sm leading-relaxed text-neutral-800">
          {vm.recommendedAction}
        </p>
      </div>
    </article>
  );
}
