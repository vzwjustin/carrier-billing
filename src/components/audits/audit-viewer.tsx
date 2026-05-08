'use client';

import Link from 'next/link';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { cn, formatCents } from '@/lib/utils';

const POLL_MS = 2000;
const ACTIVE_STATUSES = new Set(['pending', 'extracting', 'analyzing']);

const STEPS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'pending', label: 'Uploading' },
  { key: 'extracting', label: 'Extracting' },
  { key: 'analyzing', label: 'Analyzing' },
  { key: 'completed', label: 'Done' },
];

const CARRIER_LABELS: Record<string, string> = {
  verizon: 'Verizon',
  att: 'AT&T',
  tmobile: 'T-Mobile',
  unknown: 'Unknown',
};

export interface AuditStatusPayload {
  status: string;
  progress: number;
  currentStep: string;
  carrier: string | null;
  line_count: number | null;
  account_count: number | null;
  total_charges_cents: number | null;
  billing_period_start: string | null;
  billing_period_end: string | null;
  estimated_monthly_savings_cents: number | null;
  estimated_annual_savings_cents: number | null;
  finding_count: number | null;
  high_severity_count: number | null;
  failure_reason: string | null;
}

function isStatusPayload(value: unknown): value is AuditStatusPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.status === 'string' &&
    typeof v.progress === 'number' &&
    typeof v.currentStep === 'string'
  );
}

function statusIndex(status: string): number {
  if (status === 'failed') return -1;
  if (status === 'completed') return 3;
  if (status === 'analyzing') return 2;
  if (status === 'extracting') return 1;
  return 0;
}

function formatPeriod(start: string | null, end: string | null): string {
  if (!start || !end) return '—';
  const fmt = (s: string) =>
    new Date(s).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  return `${fmt(start)} – ${fmt(end)}`;
}

export interface AuditViewerProps {
  auditId: string;
  initial: AuditStatusPayload;
}

export function AuditViewer({
  auditId,
  initial,
}: AuditViewerProps): React.JSX.Element {
  const [data, setData] = React.useState<AuditStatusPayload>(initial);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!ACTIVE_STATUSES.has(data.status)) return;

    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/audits/${auditId}/status`, {
          cache: 'no-store',
        });
        if (!res.ok) {
          if (!cancelled) setError('Failed to refresh status.');
          return;
        }
        const body: unknown = await res.json();
        if (!isStatusPayload(body)) return;
        if (!cancelled) {
          setData(body);
          setError(null);
        }
      } catch {
        if (!cancelled) setError('Failed to refresh status.');
      }
    };

    const interval = setInterval(tick, POLL_MS);
    // Fire one immediately so we don't wait the full POLL_MS on first mount.
    void tick();

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [auditId, data.status]);

  if (data.status === 'failed') {
    return (
      <div className="space-y-6">
        <Stepper status={data.status} />
        <div className="rounded-lg border border-red-200 bg-red-50 p-6">
          <h2 className="text-base font-medium text-red-900">
            We couldn&apos;t finish this audit
          </h2>
          <p className="mt-1 text-sm text-red-800">
            {data.failure_reason ??
              'Something went wrong while processing the bill.'}
          </p>
          <div className="mt-4 flex gap-2">
            <Link href="/audits/new">
              <Button>Upload another bill</Button>
            </Link>
            <Link href="/audits">
              <Button variant="outline">Back to audits</Button>
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const showSummary = ['analyzing', 'completed'].includes(data.status);

  return (
    <div className="space-y-6">
      <Stepper status={data.status} />

      <div className="rounded-lg border border-neutral-200 bg-white p-6">
        <p className="text-sm text-neutral-500">Current step</p>
        <p className="text-lg font-medium text-neutral-900">{data.currentStep}</p>
        <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-neutral-100">
          <div
            className="h-full bg-neutral-900 transition-all"
            style={{ width: `${Math.min(100, Math.max(0, data.progress))}%` }}
          />
        </div>
        {error ? (
          <p className="mt-3 text-xs text-red-600">{error}</p>
        ) : null}
      </div>

      {showSummary ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <SummaryCard
            label="Carrier"
            value={
              data.carrier
                ? CARRIER_LABELS[data.carrier] ?? data.carrier
                : '—'
            }
          />
          <SummaryCard
            label="Billing period"
            value={formatPeriod(
              data.billing_period_start,
              data.billing_period_end,
            )}
          />
          <SummaryCard
            label="Accounts"
            value={data.account_count !== null ? String(data.account_count) : '—'}
          />
          <SummaryCard
            label="Lines"
            value={data.line_count !== null ? String(data.line_count) : '—'}
          />
          <SummaryCard
            label="Total charges"
            value={
              data.total_charges_cents !== null
                ? formatCents(data.total_charges_cents)
                : '—'
            }
          />
        </div>
      ) : null}

      {data.status === 'completed' ? (
        <div className="rounded-lg border border-dashed border-neutral-300 bg-white p-6">
          <h2 className="text-base font-medium text-neutral-900">Findings</h2>
          <p className="mt-1 text-sm text-neutral-500">
            Findings coming in Phase 3.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function Stepper({ status }: { status: string }): React.JSX.Element {
  const activeIndex = statusIndex(status);
  return (
    <ol className="flex items-center gap-2">
      {STEPS.map((step, idx) => {
        const completed = idx < activeIndex;
        const current = idx === activeIndex;
        return (
          <li key={step.key} className="flex flex-1 items-center gap-2">
            <span
              className={cn(
                'flex h-7 w-7 flex-none items-center justify-center rounded-full text-xs font-medium',
                completed
                  ? 'bg-neutral-900 text-white'
                  : current
                    ? 'bg-neutral-900 text-white'
                    : 'bg-neutral-200 text-neutral-600',
              )}
            >
              {idx + 1}
            </span>
            <span
              className={cn(
                'text-xs sm:text-sm',
                current
                  ? 'font-medium text-neutral-900'
                  : completed
                    ? 'text-neutral-700'
                    : 'text-neutral-500',
              )}
            >
              {step.label}
            </span>
            {idx < STEPS.length - 1 ? (
              <span
                className={cn(
                  'h-px flex-1',
                  completed ? 'bg-neutral-900' : 'bg-neutral-200',
                )}
                aria-hidden
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function SummaryCard({
  label,
  value,
}: {
  label: string;
  value: string;
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4">
      <p className="text-xs uppercase tracking-wide text-neutral-500">{label}</p>
      <p className="mt-1 text-base font-medium text-neutral-900">{value}</p>
    </div>
  );
}
