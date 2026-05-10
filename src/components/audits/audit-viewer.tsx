'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { ReportView } from '@/components/audits/report-view';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { ReportData } from '@/reports/types';
import { cn, formatCents } from '@/lib/utils';

const POLL_MS = 2000;
const ACTIVE_STATUSES = new Set(['pending', 'extracting', 'analyzing']);

const STEPS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'pending', label: 'Queued' },
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
  report?: ReportData;
}

export function AuditViewer({ auditId, initial, report }: AuditViewerProps): React.JSX.Element {
  const router = useRouter();
  const [data, setData] = React.useState<AuditStatusPayload>(initial);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshRequested, setRefreshRequested] = React.useState(false);

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

  React.useEffect(() => {
    if (data.status !== 'completed' || report || refreshRequested) return;
    setRefreshRequested(true);
    router.refresh();
  }, [data.status, refreshRequested, report, router]);

  if (data.status === 'failed') {
    return (
      <FailedView
        auditId={auditId}
        failureReason={data.failure_reason}
        onRetry={() => {
          // Reset local state to 'pending' so the polling loop kicks in again.
          setData((prev) => ({
            ...prev,
            status: 'pending',
            failure_reason: null,
            currentStep: 'Restarting…',
            progress: 5,
          }));
          setError(null);
        }}
      />
    );
  }

  // When the audit is completed and we have a built report, render the
  // full Phase 3 report viewer instead of the in-flight progress UI.
  if (data.status === 'completed' && report) {
    return <ReportView report={report} />;
  }

  const showSummary = ['analyzing', 'completed'].includes(data.status);
  const inFlight = ACTIVE_STATUSES.has(data.status);

  return (
    <div className="space-y-6">
      <Stepper status={data.status} />

      <div className="rounded-lg border border-neutral-200 bg-white p-6">
        <p className="text-sm text-neutral-500">Current step</p>
        <p className="text-lg font-medium text-neutral-900">{data.currentStep}</p>
        {data.status === 'pending' ? (
          <p className="mt-2 text-xs text-neutral-500">Waiting for upload to finish.</p>
        ) : null}
        <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-neutral-100">
          <div
            className="h-full bg-neutral-900 transition-all"
            style={{ width: `${Math.min(100, Math.max(0, data.progress))}%` }}
          />
        </div>
        {error ? <p className="mt-3 text-xs text-red-600">{error}</p> : null}
      </div>

      {inFlight ? (
        <div
          className="space-y-3 rounded-lg border border-neutral-200 bg-white p-6"
          aria-label="Loading audit results"
        >
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-10 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
          <div className="grid grid-cols-2 gap-3 pt-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        </div>
      ) : null}

      {showSummary ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <SummaryCard
            label="Carrier"
            value={data.carrier ? (CARRIER_LABELS[data.carrier] ?? data.carrier) : '—'}
          />
          <SummaryCard
            label="Billing period"
            value={formatPeriod(data.billing_period_start, data.billing_period_end)}
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
            value={data.total_charges_cents !== null ? formatCents(data.total_charges_cents) : '—'}
          />
        </div>
      ) : null}

      {data.status === 'completed' ? <SavingsSummary data={data} /> : null}
    </div>
  );
}

function SavingsSummary({ data }: { data: AuditStatusPayload }): React.JSX.Element {
  const monthly = data.estimated_monthly_savings_cents ?? 0;
  const annual = data.estimated_annual_savings_cents ?? monthly * 12;
  const findingCount = data.finding_count ?? 0;
  const highSeverityCount = data.high_severity_count ?? 0;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-6">
        <p className="text-xs tracking-wide text-emerald-700 uppercase">Estimated savings</p>
        <div className="mt-2 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <p className="text-3xl font-semibold text-emerald-900">
              {formatCents(monthly)}
              <span className="ml-1 text-sm font-normal text-emerald-800">/ month</span>
            </p>
          </div>
          <div>
            <p className="text-3xl font-semibold text-emerald-900">
              {formatCents(annual)}
              <span className="ml-1 text-sm font-normal text-emerald-800">/ year</span>
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <SummaryCard label="Findings" value={String(findingCount)} />
        <SummaryCard label="High severity" value={String(highSeverityCount)} />
      </div>
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
                className={cn('h-px flex-1', completed ? 'bg-neutral-900' : 'bg-neutral-200')}
                aria-hidden
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4">
      <p className="text-xs tracking-wide text-neutral-500 uppercase">{label}</p>
      <p className="mt-1 text-base font-medium text-neutral-900">{value}</p>
    </div>
  );
}

interface FailedViewProps {
  auditId: string;
  failureReason: string | null;
  onRetry: () => void;
}

function FailedView({ auditId, failureReason, onRetry }: FailedViewProps): React.JSX.Element {
  const [retrying, setRetrying] = React.useState(false);

  const handleRetry = React.useCallback(async () => {
    setRetrying(true);
    try {
      const res = await fetch(`/api/audits/${auditId}/retry`, {
        method: 'POST',
      });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        const message =
          typeof body === 'object' &&
          body !== null &&
          'error' in body &&
          typeof (body as { error: unknown }).error === 'string'
            ? (body as { error: string }).error
            : 'Could not retry audit.';
        toast.error(message);
        return;
      }
      toast.success('Retrying audit');
      onRetry();
    } catch {
      toast.error('Could not retry audit.');
    } finally {
      setRetrying(false);
    }
  }, [auditId, onRetry]);

  return (
    <div className="space-y-6">
      <Stepper status="failed" />
      <div className="rounded-lg border border-red-200 bg-red-50 p-6">
        <h2 className="text-base font-medium text-red-900">We couldn&apos;t finish this audit</h2>
        <p className="mt-1 text-sm text-red-800">
          {failureReason ?? 'Something went wrong while processing the bill.'}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            onClick={() => {
              void handleRetry();
            }}
            disabled={retrying}
          >
            {retrying ? 'Retrying…' : 'Retry'}
          </Button>
          <Link href="/audits/new">
            <Button variant="outline">Upload another bill</Button>
          </Link>
          <Link href="/audits">
            <Button variant="outline">Back to audits</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
