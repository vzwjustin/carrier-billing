/**
 * Shared label + badge style table for `FindingStatus`. Kept in its own
 * module so both the server-rendered `FindingCard` and the client-side
 * `FindingStatusControl` can import without dragging the 'use client'
 * boundary into the card.
 */
import type { FindingStatus } from '@/rules/types';

export const FINDING_STATUS_VALUES: readonly FindingStatus[] = [
  'new',
  'in_review',
  'approved',
  'rejected',
  'disputed',
  'resolved',
];

export const FINDING_STATUS_LABEL: Record<FindingStatus, string> = {
  new: 'New',
  in_review: 'In review',
  approved: 'Approved',
  rejected: 'Rejected',
  disputed: 'Disputed',
  resolved: 'Resolved',
};

// Color-coding per task spec:
// - green   → approved / resolved (final positive states)
// - amber   → in_review (work in progress)
// - red     → disputed (escalated)
// - neutral → new / rejected
export const FINDING_STATUS_BADGE: Record<FindingStatus, string> = {
  new: 'bg-neutral-50 text-neutral-700 border-neutral-200',
  in_review: 'bg-amber-50 text-amber-700 border-amber-200',
  approved: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  rejected: 'bg-neutral-50 text-neutral-700 border-neutral-200',
  disputed: 'bg-red-50 text-red-700 border-red-200',
  resolved: 'bg-emerald-50 text-emerald-700 border-emerald-200',
};
