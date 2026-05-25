'use client';

import * as React from 'react';
import { toast } from 'sonner';

import type { FindingStatus } from '@/rules/types';

/**
 * Bulk-status toolbar. Mounted by `FindingsList` with the set of currently
 * selected finding ids; renders nothing when the selection is empty.
 *
 * Per the task spec, requests are issued SERIALLY (one at a time) against
 * the existing per-finding status route. The status route is rate-limited
 * at 60/min per user — running in parallel would burn that bucket on a
 * single bulk action.
 *
 * The progress toast updates as we go and is replaced with a final
 * success / partial-failure toast once all calls resolve.
 */

const BULK_ACTIONS: ReadonlyArray<{ status: FindingStatus; label: string }> = [
  { status: 'approved', label: 'approved' },
  { status: 'rejected', label: 'rejected' },
  { status: 'in_review', label: 'in review' },
];

export interface FindingsBulkToolbarProps {
  auditId: string;
  selectedIds: readonly string[];
  onClear: () => void;
  /**
   * Called after each successful status write so the parent can update
   * any per-finding local state it cares about (e.g. the rendered status
   * badge). Fired once per finding id, NOT once per bulk action.
   */
  onStatusApplied?: (findingId: string, status: FindingStatus) => void;
  /**
   * Parallel array of `{id, status}` for the currently selected findings.
   * Used by the "Generate dispute letter" affordance to filter the
   * selection down to the approved subset. Optional so the legacy
   * mark-as-X buttons keep working even if the parent hasn't been updated
   * yet.
   */
  selectedFindings?: readonly { id: string; status: FindingStatus }[];
}

export function FindingsBulkToolbar({
  auditId,
  selectedIds,
  onClear,
  onStatusApplied,
  selectedFindings,
}: FindingsBulkToolbarProps): React.JSX.Element | null {
  const [busy, setBusy] = React.useState(false);

  const count = selectedIds.length;
  if (count === 0) return null;

  // Compute the approved subset of the current selection for the dispute-
  // letter affordance. Only ids that are in BOTH selectedIds and
  // selectedFindings (with status === 'approved') count, so a stale parent
  // can never expose ids that aren't visually selected.
  const approvedSelected: string[] = (() => {
    if (!selectedFindings || selectedFindings.length === 0) return [];
    const selectedSet = new Set(selectedIds);
    const out: string[] = [];
    for (const f of selectedFindings) {
      if (selectedSet.has(f.id) && f.status === 'approved') out.push(f.id);
    }
    return out;
  })();

  const openDisputeLetter = (): void => {
    if (approvedSelected.length === 0) return;
    const params = new URLSearchParams({
      finding_ids: approvedSelected.join(','),
    });
    window.open(
      `/api/audits/${auditId}/dispute-letter.pdf?${params.toString()}`,
      '_blank',
      'noopener,noreferrer',
    );
  };

  const runBulk = async (status: FindingStatus): Promise<void> => {
    if (busy) return;
    setBusy(true);

    const total = selectedIds.length;
    // sonner returns a stable id for an updatable toast.
    const toastId = toast.loading(`Updating 0 of ${total}…`);

    let succeeded = 0;
    let failed = 0;

    for (let i = 0; i < selectedIds.length; i++) {
      const findingId = selectedIds[i];
      // noUncheckedIndexedAccess narrows; skip the (impossible) hole.
      if (!findingId) continue;
      try {
        const res = await fetch(
          `/api/audits/${auditId}/findings/${findingId}/status`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status }),
          },
        );
        if (res.ok) {
          succeeded += 1;
          onStatusApplied?.(findingId, status);
        } else {
          failed += 1;
        }
      } catch {
        failed += 1;
      }
      toast.loading(`Updating ${i + 1} of ${total}…`, { id: toastId });
    }

    if (failed === 0) {
      toast.success(`Updated ${succeeded} finding${succeeded === 1 ? '' : 's'}.`, {
        id: toastId,
      });
    } else if (succeeded === 0) {
      toast.error(`Could not update any of ${total} findings.`, { id: toastId });
    } else {
      toast.error(`Updated ${succeeded}; ${failed} failed.`, { id: toastId });
    }

    setBusy(false);
    onClear();
  };

  return (
    <div
      className="sticky top-2 z-20 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-900 bg-neutral-900 px-4 py-3 text-sm text-white shadow-lg"
      role="region"
      aria-label="Bulk actions"
    >
      <p className="font-medium">
        {count} selected
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {BULK_ACTIONS.map((action) => (
          <button
            key={action.status}
            type="button"
            onClick={() => {
              void runBulk(action.status);
            }}
            disabled={busy}
            className="rounded-md border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-neutral-700 disabled:cursor-wait disabled:opacity-60"
          >
            Mark {count} as {action.label}
          </button>
        ))}
        {approvedSelected.length > 0 ? (
          <button
            type="button"
            onClick={openDisputeLetter}
            disabled={busy}
            className="rounded-md border border-emerald-500 bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-500 disabled:cursor-wait disabled:opacity-60"
          >
            Generate dispute letter ({approvedSelected.length})
          </button>
        ) : null}
        <button
          type="button"
          onClick={onClear}
          disabled={busy}
          className="rounded-md px-2 py-1.5 text-xs font-medium text-neutral-300 hover:text-white disabled:opacity-60"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
