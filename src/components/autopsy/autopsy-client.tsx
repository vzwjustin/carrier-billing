'use client';

/**
 * Bill Increase Autopsy — client UI.
 *
 * Two states:
 *   1. No comparison exists yet — show a picker for "previous audit" and a
 *      Run button. POST to /api/audits/[id]/autopsy.
 *   2. Comparison exists — show executive summary, totals, disputable /
 *      optimization / unexplained badges, then per-driver expandable cards.
 *
 * Driver cards: collapsed shows category badge + title + signed amount +
 * affected-line count. Expanded reveals summary, recommended action,
 * and per-line evidence rows.
 */

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { sanitizeUserLabel } from '@/extraction/schema';
import { formatIsoDatePeriod } from '@/lib/dates';
import { cn, formatCents } from '@/lib/utils';

interface AuditMini {
  id: string;
  carrier: string | null;
  billing_period_start: string | null;
  billing_period_end: string | null;
  total_charges_cents: number | null;
  original_filename: string;
}

interface CandidateAudit {
  id: string;
  billing_period_start: string | null;
  billing_period_end: string | null;
  total_charges_cents: number | null;
  carrier: string | null;
  original_filename: string;
}

interface ComparisonRow {
  id: string;
  previous_audit_id: string;
  current_audit_id: string;
  previous_total_cents: number;
  current_total_cents: number;
  net_change_cents: number;
  percent_change_bps: number | null;
  disputable_cents: number;
  optimization_cents: number;
  unexplained_cents: number;
  executive_summary: string;
  created_at: string;
}

interface DriverRow {
  id: string;
  category: string;
  title: string;
  summary: string;
  previous_cents: number;
  current_cents: number;
  difference_cents: number;
  affected_lines_count: number;
  confidence: number;
  is_disputable: boolean;
  is_optimization: boolean;
  is_unexplained: boolean;
  recommended_action: string | null;
  evidence: Record<string, unknown>;
  /** Migration 0026 — operator workflow on driver cards. */
  is_explained?: boolean | null;
  escalated_finding_id?: string | null;
}

interface EvidenceLine {
  account_last4: string | null;
  mdn_last4: string | null;
  user_label: string | null;
  previous_cents: number;
  current_cents: number;
  difference_cents: number;
  note?: string;
}

interface EvidenceAccount {
  account_last4: string | null;
  previous_cents: number;
  current_cents: number;
  difference_cents: number;
  note?: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  new_lines: 'New lines',
  removed_lines: 'Removed lines',
  plan_changes: 'Plan changes',
  device_installments_added: 'New device installments',
  device_installments_removed: 'Device installments ended',
  missing_credits: 'Missing credits',
  new_credits: 'New credits',
  credits_decreased: 'Credits decreased',
  credits_increased: 'Credits increased',
  one_time_charges: 'One-time charges',
  activation_fees: 'Activation / upgrade fees',
  insurance_changes: 'Insurance / protection',
  international_charges: 'International',
  roaming_charges: 'Roaming',
  overage_charges: 'Overage',
  taxes_fees_change: 'Taxes / fees',
  feature_addon_changes: 'Feature / add-on',
  suspended_line_still_billed: 'Suspended but billed',
  unexplained: 'Unexplained',
};

function signedCents(cents: number): string {
  if (cents === 0) return formatCents(0);
  const sign = cents > 0 ? '+' : '-';
  return `${sign}${formatCents(Math.abs(cents))}`;
}

function percentLabel(bps: number | null): string {
  if (bps === null) return 'new account';
  const pct = (bps / 100).toFixed(1);
  return `${bps >= 0 ? '+' : ''}${pct}%`;
}

export interface AutopsyClientProps {
  audit: AuditMini;
  candidates: CandidateAudit[];
  existing: ComparisonRow | null;
  drivers: DriverRow[];
}

export function AutopsyClient({
  audit,
  candidates,
  existing,
  drivers,
}: AutopsyClientProps): React.JSX.Element {
  const router = useRouter();
  const [selectedPrev, setSelectedPrev] = React.useState<string>(
    existing?.previous_audit_id ?? candidates[0]?.id ?? '',
  );
  const [isRunning, setIsRunning] = React.useState(false);

  const handleRun = React.useCallback(async () => {
    if (!selectedPrev) {
      toast.error('Pick a previous bill first.');
      return;
    }
    setIsRunning(true);
    try {
      const res = await fetch(`/api/audits/${audit.id}/autopsy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ previousAuditId: selectedPrev }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(body.error ?? 'Failed to run autopsy.');
        return;
      }
      toast.success('Autopsy complete.');
      router.refresh();
    } catch {
      toast.error('Failed to run autopsy.');
    } finally {
      setIsRunning(false);
    }
  }, [audit.id, router, selectedPrev]);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="space-y-2">
        <Link
          href={`/audits/${audit.id}`}
          className="text-xs font-medium uppercase tracking-wider text-neutral-500 hover:text-neutral-700"
        >
          ← Back to audit
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight text-neutral-900">
          Bill Increase Autopsy
        </h1>
        <p className="text-sm text-neutral-600">
          Current bill: <strong>{audit.original_filename}</strong> ·{' '}
          {formatIsoDatePeriod(audit.billing_period_start, audit.billing_period_end)} ·{' '}
          {audit.total_charges_cents !== null
            ? formatCents(audit.total_charges_cents)
            : '—'}
        </p>
      </header>

      <section className="rounded-lg border border-neutral-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-neutral-700">
          Compare against
        </h2>
        {candidates.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">
            You don&apos;t have another completed audit to compare against yet.
            Upload a second bill and run an audit on it.
          </p>
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <select
              className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-neutral-500 focus:outline-none"
              value={selectedPrev}
              onChange={(e) => setSelectedPrev(e.target.value)}
              disabled={isRunning}
            >
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {formatIsoDatePeriod(c.billing_period_start, c.billing_period_end)} ·{' '}
                  {c.total_charges_cents !== null
                    ? formatCents(c.total_charges_cents)
                    : '—'}
                  {' · '}
                  {c.original_filename}
                </option>
              ))}
            </select>
            <Button
              onClick={() => {
                void handleRun();
              }}
              disabled={isRunning || !selectedPrev}
            >
              {isRunning
                ? 'Running…'
                : existing
                  ? 'Re-run autopsy'
                  : 'Run autopsy'}
            </Button>
            {existing ? (
              <p className="text-xs text-neutral-500">
                Last run{' '}
                {new Date(existing.created_at).toLocaleString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </p>
            ) : null}
          </div>
        )}
      </section>

      {existing ? (
        <>
          <ExecutiveSummary comparison={existing} />
          <DriversList drivers={drivers} />
        </>
      ) : (
        <div className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 p-8 text-center">
          <p className="text-sm text-neutral-600">
            No autopsy has been run for this bill yet. Pick a previous bill
            above and click <strong>Run autopsy</strong>.
          </p>
        </div>
      )}
    </div>
  );
}

function ExecutiveSummary({
  comparison,
}: {
  comparison: ComparisonRow;
}): React.JSX.Element {
  const net = comparison.net_change_cents;
  const direction = net === 0 ? 'unchanged' : net > 0 ? 'increased' : 'decreased';
  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Bill change
          </p>
          <p
            className={cn(
              'mt-1 text-3xl font-semibold tabular-nums',
              direction === 'increased' && 'text-red-700',
              direction === 'decreased' && 'text-green-700',
              direction === 'unchanged' && 'text-neutral-700',
            )}
          >
            {signedCents(net)}{' '}
            <span className="text-base font-medium text-neutral-500">
              ({percentLabel(comparison.percent_change_bps)})
            </span>
          </p>
          <p className="mt-2 text-sm text-neutral-600">
            Previous total {formatCents(comparison.previous_total_cents)} →
            Current total {formatCents(comparison.current_total_cents)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <SummaryBadge
            label="Potentially disputable"
            cents={comparison.disputable_cents}
            tone="amber"
          />
          <SummaryBadge
            label="Optimization opportunity"
            cents={comparison.optimization_cents}
            tone="blue"
          />
          <SummaryBadge
            label="Unexplained"
            cents={comparison.unexplained_cents}
            tone="neutral"
          />
        </div>
      </div>
      <p className="mt-4 whitespace-pre-line text-sm leading-relaxed text-neutral-700">
        {comparison.executive_summary}
      </p>
    </section>
  );
}

function SummaryBadge({
  label,
  cents,
  tone,
}: {
  label: string;
  cents: number;
  tone: 'amber' | 'blue' | 'neutral';
}): React.JSX.Element {
  const toneClasses: Record<typeof tone, string> = {
    amber: 'border-amber-300 bg-amber-50 text-amber-900',
    blue: 'border-blue-300 bg-blue-50 text-blue-900',
    neutral: 'border-neutral-300 bg-neutral-50 text-neutral-700',
  };
  return (
    <div
      className={cn(
        'rounded-md border px-3 py-2 text-right shadow-sm',
        toneClasses[tone],
      )}
    >
      <p className="text-[10px] font-semibold uppercase tracking-wider">{label}</p>
      <p className="mt-0.5 text-base font-semibold tabular-nums">
        {formatCents(cents)}
      </p>
    </div>
  );
}

function DriversList({ drivers }: { drivers: DriverRow[] }): React.JSX.Element {
  if (drivers.length === 0) {
    return (
      <section className="rounded-lg border border-neutral-200 bg-white p-8 text-center">
        <p className="text-sm text-neutral-600">
          The bills are identical — no change drivers to attribute.
        </p>
      </section>
    );
  }
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold tracking-tight text-neutral-900">
        Change drivers
      </h2>
      <div className="space-y-2">
        {drivers.map((d) => (
          <DriverCard key={d.id} driver={d} />
        ))}
      </div>
    </section>
  );
}

function DriverCard({ driver }: { driver: DriverRow }): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  // Local optimistic state so action buttons reflect changes immediately
  // without a page round-trip. The router.refresh() on success keeps the
  // SSR cache in sync.
  const [isExplained, setIsExplained] = React.useState<boolean>(
    Boolean(driver.is_explained),
  );
  const [escalatedFindingId, setEscalatedFindingId] = React.useState<string | null>(
    driver.escalated_finding_id ?? null,
  );
  const [isWorking, setIsWorking] = React.useState(false);
  const diff = driver.difference_cents;

  const handleExplain = React.useCallback(
    async (next: boolean): Promise<void> => {
      setIsWorking(true);
      const previous = isExplained;
      setIsExplained(next); // optimistic
      try {
        const res = await fetch(
          `/api/autopsy/drivers/${driver.id}/explain`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ explained: next }),
          },
        );
        if (!res.ok) {
          setIsExplained(previous);
          toast.error(next ? 'Could not mark as explained.' : 'Could not undo.');
          return;
        }
        toast.success(next ? 'Marked as explained.' : 'Restored.');
        router.refresh();
      } catch {
        setIsExplained(previous);
        toast.error('Network error.');
      } finally {
        setIsWorking(false);
      }
    },
    [driver.id, isExplained, router],
  );

  const handleEscalate = React.useCallback(async (): Promise<void> => {
    setIsWorking(true);
    try {
      const res = await fetch(
        `/api/autopsy/drivers/${driver.id}/escalate`,
        { method: 'POST' },
      );
      if (!res.ok) {
        toast.error('Could not escalate to a finding.');
        return;
      }
      const body = (await res.json()) as { findingId?: string };
      if (body.findingId) {
        setEscalatedFindingId(body.findingId);
        toast.success('Escalated to a finding.');
        router.refresh();
      }
    } catch {
      toast.error('Network error.');
    } finally {
      setIsWorking(false);
    }
  }, [driver.id, router]);

  // Visual treatment: when handled, dim the card so the operator's eye
  // is drawn to the still-actionable ones.
  const handled = isExplained || escalatedFindingId !== null;

  return (
    <div
      className={cn(
        'rounded-lg border border-neutral-200 bg-white transition-opacity',
        handled && 'opacity-70',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-4 p-4 text-left"
      >
        <div className="flex flex-1 items-center gap-3">
          <CategoryBadge driver={driver} />
          <div>
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium text-neutral-900">
                {driver.title}
              </p>
              {isExplained ? (
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-800">
                  Explained
                </span>
              ) : null}
              {escalatedFindingId ? (
                <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-violet-800">
                  Escalated
                </span>
              ) : null}
            </div>
            <p className="mt-0.5 text-xs text-neutral-500">
              {driver.affected_lines_count > 0
                ? `${driver.affected_lines_count} line${driver.affected_lines_count === 1 ? '' : 's'} affected · `
                : ''}
              confidence {(driver.confidence * 100).toFixed(0)}%
            </p>
          </div>
        </div>
        <p
          className={cn(
            'text-base font-semibold tabular-nums',
            diff > 0 && 'text-red-700',
            diff < 0 && 'text-green-700',
            diff === 0 && 'text-neutral-500',
          )}
        >
          {signedCents(diff)}
        </p>
        <span className="text-neutral-400">{open ? '▾' : '▸'}</span>
      </button>
      {open ? (
        <DriverDetail
          driver={driver}
          isExplained={isExplained}
          escalatedFindingId={escalatedFindingId}
          isWorking={isWorking}
          onExplain={handleExplain}
          onEscalate={handleEscalate}
        />
      ) : null}
    </div>
  );
}

function CategoryBadge({ driver }: { driver: DriverRow }): React.JSX.Element {
  const label = CATEGORY_LABELS[driver.category] ?? driver.category;
  const tone = driver.is_disputable
    ? 'bg-amber-100 text-amber-800'
    : driver.is_optimization
      ? 'bg-blue-100 text-blue-800'
      : driver.is_unexplained
        ? 'bg-neutral-200 text-neutral-700'
        : 'bg-neutral-100 text-neutral-700';
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
        tone,
      )}
    >
      {label}
    </span>
  );
}

interface DriverDetailProps {
  driver: DriverRow;
  isExplained: boolean;
  escalatedFindingId: string | null;
  isWorking: boolean;
  onExplain: (next: boolean) => Promise<void>;
  onEscalate: () => Promise<void>;
}

function DriverDetail({
  driver,
  isExplained,
  escalatedFindingId,
  isWorking,
  onExplain,
  onEscalate,
}: DriverDetailProps): React.JSX.Element {
  const lines = (driver.evidence?.lines ?? []) as EvidenceLine[];
  const accounts = (driver.evidence?.accounts ?? []) as EvidenceAccount[];
  const notes = (driver.evidence?.notes ?? []) as string[];
  return (
    <div className="border-t border-neutral-200 px-4 py-4">
      <p className="text-sm leading-relaxed text-neutral-700">{driver.summary}</p>
      {driver.recommended_action ? (
        <div className="mt-3 rounded-md bg-neutral-50 p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
            Recommended action
          </p>
          <p className="mt-1 text-sm text-neutral-800">
            {driver.recommended_action}
          </p>
        </div>
      ) : null}
      {lines.length > 0 ? (
        <div className="mt-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
            Affected lines
          </p>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-neutral-500">
                  <th className="py-1 pr-3 font-medium">Line</th>
                  <th className="py-1 pr-3 font-medium">Previous</th>
                  <th className="py-1 pr-3 font-medium">Current</th>
                  <th className="py-1 pr-3 font-medium">Δ</th>
                  <th className="py-1 font-medium">Note</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((ln, i) => {
                  const safeUserLabel = sanitizeUserLabel(ln.user_label);
                  return (
                    <tr key={i} className="border-b border-neutral-100">
                      <td className="py-1 pr-3 font-mono text-neutral-700">
                        {ln.account_last4 ? `…${ln.account_last4}` : '—'}
                        {' / '}
                        {ln.mdn_last4 ? `*${ln.mdn_last4}` : '(no MDN)'}
                        {safeUserLabel ? (
                          <span className="ml-1 text-neutral-500">
                            ({safeUserLabel})
                          </span>
                        ) : null}
                      </td>
                      <td className="py-1 pr-3 tabular-nums text-neutral-700">
                        {formatCents(ln.previous_cents)}
                      </td>
                      <td className="py-1 pr-3 tabular-nums text-neutral-700">
                        {formatCents(ln.current_cents)}
                      </td>
                      <td className="py-1 pr-3 tabular-nums">
                        <span
                          className={cn(
                            ln.difference_cents > 0 && 'text-red-700',
                            ln.difference_cents < 0 && 'text-green-700',
                          )}
                        >
                          {signedCents(ln.difference_cents)}
                        </span>
                      </td>
                      <td className="py-1 text-neutral-600">{ln.note ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
      {accounts.length > 0 ? (
        <div className="mt-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
            Affected accounts
          </p>
          <ul className="mt-2 space-y-1">
            {accounts.map((a, i) => (
              <li key={i} className="text-xs text-neutral-700">
                Account {a.account_last4 ? `…${a.account_last4}` : '(no last 4)'} ·{' '}
                {formatCents(a.previous_cents)} → {formatCents(a.current_cents)} ·{' '}
                <span
                  className={cn(
                    a.difference_cents > 0 && 'text-red-700',
                    a.difference_cents < 0 && 'text-green-700',
                  )}
                >
                  {signedCents(a.difference_cents)}
                </span>
                {a.note ? <span className="text-neutral-500"> · {a.note}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {notes.length > 0 ? (
        <div className="mt-4 rounded-md border border-neutral-200 bg-neutral-50 p-3">
          {notes.map((n, i) => (
            <p key={i} className="text-xs text-neutral-600">
              {n}
            </p>
          ))}
        </div>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-neutral-200 pt-4">
        {escalatedFindingId ? (
          <span className="text-xs text-neutral-600">
            Escalated to a finding —{' '}
            <Link
              href={`/audits/${escalatedFindingId}`}
              className="font-medium text-violet-700 underline"
            >
              view
            </Link>
          </span>
        ) : (
          <Button
            variant="outline"
            onClick={() => {
              void onEscalate();
            }}
            disabled={isWorking || isExplained}
          >
            Escalate to finding
          </Button>
        )}
        {isExplained ? (
          <Button
            variant="ghost"
            onClick={() => {
              void onExplain(false);
            }}
            disabled={isWorking}
          >
            Undo &quot;explained&quot;
          </Button>
        ) : (
          <Button
            variant="ghost"
            onClick={() => {
              void onExplain(true);
            }}
            disabled={isWorking || escalatedFindingId !== null}
          >
            Mark as explained
          </Button>
        )}
      </div>
    </div>
  );
}
