'use client';

import * as React from 'react';
import { toast } from 'sonner';

import type { FindingStatus } from '@/rules/types';

import { FINDING_STATUS_LABEL, FINDING_STATUS_VALUES } from './finding-status-meta';

export interface FindingStatusControlProps {
  auditId: string;
  findingId: string;
  initialStatus: FindingStatus;
}

export function FindingStatusControl({
  auditId,
  findingId,
  initialStatus,
}: FindingStatusControlProps): React.JSX.Element {
  const [status, setStatus] = React.useState<FindingStatus>(initialStatus);
  const [isSaving, setIsSaving] = React.useState(false);

  const handleChange = React.useCallback(
    async (event: React.ChangeEvent<HTMLSelectElement>): Promise<void> => {
      const next = event.target.value as FindingStatus;
      if (next === status) return;

      const previous = status;
      // Optimistic update — flip immediately, roll back on failure. Keeps
      // the dropdown responsive while the POST is in flight.
      setStatus(next);
      setIsSaving(true);
      try {
        const res = await fetch(`/api/audits/${auditId}/findings/${findingId}/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: next }),
        });
        if (!res.ok) {
          setStatus(previous);
          toast.error('Could not update finding status.');
          return;
        }
        toast.success(`Marked as ${FINDING_STATUS_LABEL[next]}.`);
      } catch {
        setStatus(previous);
        toast.error('Could not update finding status.');
      } finally {
        setIsSaving(false);
      }
    },
    [auditId, findingId, status],
  );

  return (
    <label className="inline-flex items-center gap-1 text-xs text-neutral-600">
      <span className="sr-only">Reviewer status</span>
      <select
        value={status}
        onChange={(event) => {
          void handleChange(event);
        }}
        disabled={isSaving}
        className="rounded-md border border-neutral-200 bg-white px-1.5 py-0.5 text-xs font-medium text-neutral-700 shadow-sm focus:border-neutral-400 focus:ring-1 focus:ring-neutral-400 focus:outline-none disabled:cursor-wait disabled:opacity-60"
        aria-label="Reviewer status"
      >
        {FINDING_STATUS_VALUES.map((s) => (
          <option key={s} value={s}>
            {FINDING_STATUS_LABEL[s]}
          </option>
        ))}
      </select>
    </label>
  );
}
