import * as React from 'react';

import type { Finding, FindingStatus, Severity } from '@/rules/types';
import { formatCents } from '@/lib/utils';
import { buildFindingViewModel, type FindingViewModel } from '@/reports/finding-view-model';

import { FindingStatusControl } from './finding-status-control';
import { FINDING_STATUS_BADGE, FINDING_STATUS_LABEL } from './finding-status-meta';

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
  /**
   * Selection state for the bulk-status toolbar. Only rendered when all
   * three of `!isPublic`, `auditId`, and `finding.id` are set AND the
   * parent threads `onToggleSelected` through (i.e. the parent opted into
   * selection mode). Keeping it opt-in lets the same card render on
   * surfaces (like the PDF) that have no notion of selection.
   */
  selected?: boolean;
  onToggleSelected?: (findingId: string, next: boolean) => void;
}

export function FindingCard({
  finding,
  auditId,
  isPublic = false,
  selected = false,
  onToggleSelected,
}: FindingCardProps): React.JSX.Element {
  const vm: FindingViewModel = buildFindingViewModel(finding);
  // Status defaults to 'new' for any finding loaded without a hydrated value.
  // The DB default already guarantees a value on persisted rows; this fallback
  // covers the pre-persisted (rules-engine-only) and missing-column cases.
  const status: FindingStatus = finding.status ?? 'new';
  const showCheckbox =
    !isPublic && Boolean(auditId) && Boolean(finding.id) && Boolean(onToggleSelected);

  return (
    <article
      className={
        selected
          ? 'rounded-lg border border-neutral-900 bg-white p-5 ring-1 ring-neutral-900 sm:p-6'
          : 'rounded-lg border border-neutral-200 bg-white p-5 sm:p-6'
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {showCheckbox && finding.id ? (
            <label className="inline-flex cursor-pointer items-center">
              <span className="sr-only">Select finding for bulk action</span>
              <input
                type="checkbox"
                checked={selected}
                onChange={(event) => {
                  onToggleSelected?.(finding.id as string, event.target.checked);
                }}
                className="h-4 w-4 rounded border-neutral-300 text-neutral-900 focus:ring-neutral-500"
                aria-label="Select finding"
              />
            </label>
          ) : null}
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
            <FindingStatusControl auditId={auditId} findingId={finding.id} initialStatus={status} />
          ) : null}
        </div>

        {vm.hasSavings ? (
          <div className="text-right">
            <p className="text-xs font-medium tracking-wider text-emerald-700 uppercase">
              Estimated savings
            </p>
            <p className="text-base font-semibold text-emerald-900">
              {formatCents(vm.monthlySavingsCents)}
              <span className="ml-1 text-xs font-normal text-emerald-800">/ month</span>
            </p>
          </div>
        ) : null}
      </div>

      <h3 className="mt-3 text-base font-semibold text-neutral-900">{vm.title}</h3>

      <p className="mt-2 text-sm leading-relaxed text-neutral-700">{vm.description}</p>

      <div className="mt-4 rounded-md border border-neutral-200 bg-neutral-50 p-3">
        <p className="text-xs font-medium tracking-wider text-neutral-600 uppercase">
          Recommended action
        </p>
        <p className="mt-1 text-sm leading-relaxed text-neutral-800">{vm.recommendedAction}</p>
      </div>
    </article>
  );
}
