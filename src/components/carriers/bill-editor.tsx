'use client';

import { useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';

import {
  createBillAction,
  deleteBillAction,
  saveBillAction,
} from '@/app/(app)/carriers/bills/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { billTotals, type CarrierBill, type LineItem } from '@/lib/carriers/bill-schema';
import { optimizeBill, type OptimizationResult } from '@/lib/carriers/optimize';
import { CARRIERS, CARRIER_LABELS, type Carrier } from '@/lib/carriers/types';
import { cn, formatCents } from '@/lib/utils';

function dollarsToCents(value: string): number {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
}

function centsToDollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

function newLineItem(): LineItem {
  return {
    id: crypto.randomUUID(),
    description: '',
    monthlyCents: 0,
    optimizedCents: 0,
  };
}

function toCsv(bill: CarrierBill): string {
  const header = 'Description,Current,Optimized,Savings';
  const rows = bill.lineItems.map((li) => {
    const desc = `"${li.description.replace(/"/g, '""')}"`;
    return [
      desc,
      centsToDollars(li.monthlyCents),
      centsToDollars(li.optimizedCents),
      centsToDollars(li.monthlyCents - li.optimizedCents),
    ].join(',');
  });
  return [header, ...rows].join('\n');
}

export interface BillEditorProps {
  initial: CarrierBill[];
}

export function BillEditor({ initial }: BillEditorProps): React.JSX.Element {
  const [bills, setBills] = useState<CarrierBill[]>(initial);
  const [selectedId, setSelectedId] = useState<string | null>(initial[0]?.id ?? null);
  const [newCarrier, setNewCarrier] = useState<Carrier>('verizon');
  const [newLabel, setNewLabel] = useState('');
  const [pending, startTransition] = useTransition();
  const [analysis, setAnalysis] = useState<OptimizationResult | null>(null);
  const [rev, setRev] = useState(0);

  const selected = bills.find((b) => b.id === selectedId) ?? null;
  const totals = useMemo(() => billTotals(selected?.lineItems ?? []), [selected]);
  const savingsPct =
    totals.currentCents > 0 ? Math.round((totals.savingsCents / totals.currentCents) * 100) : 0;

  function patchSelected(mutate: (b: CarrierBill) => CarrierBill): void {
    setBills((prev) => prev.map((b) => (b.id === selectedId ? mutate(b) : b)));
  }

  function onCreate(): void {
    const label = newLabel.trim();
    if (!label) {
      toast.error('Enter a bill name.');
      return;
    }
    startTransition(async () => {
      const result = await createBillAction({ carrier: newCarrier, label });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      const created: CarrierBill = {
        id: result.id,
        carrier: newCarrier,
        label,
        lineItems: [],
        updatedAt: new Date().toISOString(),
      };
      setBills((prev) => [created, ...prev]);
      setSelectedId(created.id);
      setNewLabel('');
      toast.success('Bill created.');
    });
  }

  function onSave(): void {
    if (!selected) return;
    startTransition(async () => {
      const result = await saveBillAction({
        id: selected.id,
        label: selected.label,
        lineItems: selected.lineItems,
      });
      if (result.ok) toast.success('Bill saved.');
      else toast.error(result.error);
    });
  }

  function onDelete(): void {
    if (!selected) return;
    const id = selected.id;
    startTransition(async () => {
      const result = await deleteBillAction(id);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setBills((prev) => prev.filter((b) => b.id !== id));
      setSelectedId((cur) => (cur === id ? null : cur));
      toast.success('Bill deleted.');
    });
  }

  function onAnalyze(): void {
    if (!selected) return;
    setAnalysis(optimizeBill(selected.carrier, selected.lineItems));
  }

  function applySuggestions(): void {
    if (!selected || !analysis) return;
    const map = new Map(analysis.suggestions.map((s) => [s.lineItemId, s.suggestedCents]));
    patchSelected((b) => ({
      ...b,
      lineItems: b.lineItems.map((x) =>
        map.has(x.id) ? { ...x, optimizedCents: map.get(x.id) as number } : x,
      ),
    }));
    setAnalysis(null);
    setRev((r) => r + 1);
    toast.success('Suggestions applied. Review, then Save to persist.');
  }

  function onExport(): void {
    if (!selected) return;
    const blob = new Blob([toCsv(selected)], {
      type: 'text/csv;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${selected.label.replace(/[^\w.-]+/g, '_')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
      <aside className="space-y-4">
        <div className="space-y-2 rounded-xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-xs font-semibold tracking-wide text-neutral-500 uppercase dark:text-neutral-400">
            New bill
          </p>
          <select
            aria-label="Carrier"
            value={newCarrier}
            onChange={(e) => setNewCarrier(e.target.value as Carrier)}
            className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
          >
            {CARRIERS.map((c) => (
              <option key={c} value={c}>
                {CARRIER_LABELS[c]}
              </option>
            ))}
          </select>
          <Input
            aria-label="Bill name"
            placeholder="Bill name"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
          />
          <Button type="button" size="sm" className="w-full" disabled={pending} onClick={onCreate}>
            Create
          </Button>
        </div>
        <nav className="space-y-1" aria-label="Bills">
          {bills.length === 0 ? (
            <p className="px-2 text-sm text-neutral-500 dark:text-neutral-400">No bills yet.</p>
          ) : (
            bills.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => setSelectedId(b.id)}
                className={cn(
                  'block w-full rounded-md px-3 py-2 text-left text-sm',
                  b.id === selectedId
                    ? 'bg-neutral-900 text-white dark:bg-white dark:text-neutral-900'
                    : 'text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800',
                )}
              >
                <span className="block truncate font-medium">{b.label}</span>
                <span className="block text-xs opacity-70">{CARRIER_LABELS[b.carrier]}</span>
              </button>
            ))
          )}
        </nav>
      </aside>

      {selected ? (
        <section className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Input
              aria-label="Bill label"
              value={selected.label}
              onChange={(e) => patchSelected((b) => ({ ...b, label: e.target.value }))}
              className="max-w-xs font-medium"
            />
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={onAnalyze}>
                Analyze &amp; optimize
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={onExport}>
                Export CSV
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={onDelete}
              >
                Delete
              </Button>
              <Button type="button" size="sm" disabled={pending} onClick={onSave}>
                Save
              </Button>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="Current / mo" value={formatCents(totals.currentCents)} />
            <Stat label="Optimized / mo" value={formatCents(totals.optimizedCents)} />
            <Stat
              label={`Savings / mo (${savingsPct}%)`}
              value={formatCents(totals.savingsCents)}
              accent
            />
          </div>

          <ComparisonBar
            currentCents={totals.currentCents}
            optimizedCents={totals.optimizedCents}
          />

          {analysis ? (
            <AnalysisPanel
              result={analysis}
              lineItems={selected.lineItems}
              onApply={applySuggestions}
              onDismiss={() => setAnalysis(null)}
            />
          ) : null}

          <div className="overflow-hidden rounded-xl border border-neutral-200 dark:border-neutral-800">
            <table className="w-full text-sm">
              <thead className="bg-neutral-50 text-left text-xs tracking-wide text-neutral-500 uppercase dark:bg-neutral-900 dark:text-neutral-400">
                <tr>
                  <th className="px-3 py-2 font-medium">Description</th>
                  <th className="px-3 py-2 font-medium">Current $</th>
                  <th className="px-3 py-2 font-medium">Optimized $</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody key={rev}>
                {selected.lineItems.map((li) => (
                  <tr key={li.id} className="border-t border-neutral-200 dark:border-neutral-800">
                    <td className="px-3 py-2">
                      <Input
                        aria-label="Description"
                        value={li.description}
                        onChange={(e) =>
                          patchSelected((b) => ({
                            ...b,
                            lineItems: b.lineItems.map((x) =>
                              x.id === li.id ? { ...x, description: e.target.value } : x,
                            ),
                          }))
                        }
                      />
                    </td>
                    <td className="px-3 py-2">
                      <Input
                        aria-label="Current dollars"
                        type="number"
                        min="0"
                        step="0.01"
                        defaultValue={centsToDollars(li.monthlyCents)}
                        onChange={(e) =>
                          patchSelected((b) => ({
                            ...b,
                            lineItems: b.lineItems.map((x) =>
                              x.id === li.id
                                ? {
                                    ...x,
                                    monthlyCents: dollarsToCents(e.target.value),
                                  }
                                : x,
                            ),
                          }))
                        }
                        className="w-28"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <Input
                        aria-label="Optimized dollars"
                        type="number"
                        min="0"
                        step="0.01"
                        defaultValue={centsToDollars(li.optimizedCents)}
                        onChange={(e) =>
                          patchSelected((b) => ({
                            ...b,
                            lineItems: b.lineItems.map((x) =>
                              x.id === li.id
                                ? {
                                    ...x,
                                    optimizedCents: dollarsToCents(e.target.value),
                                  }
                                : x,
                            ),
                          }))
                        }
                        className="w-28"
                      />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        aria-label="Remove line"
                        onClick={() =>
                          patchSelected((b) => ({
                            ...b,
                            lineItems: b.lineItems.filter((x) => x.id !== li.id),
                          }))
                        }
                        className="text-xs text-red-600 hover:underline dark:text-red-400"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
                {selected.lineItems.length === 0 ? (
                  <tr>
                    <td
                      colSpan={4}
                      className="px-3 py-6 text-center text-sm text-neutral-500 dark:text-neutral-400"
                    >
                      No line items. Add one below.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              patchSelected((b) => ({
                ...b,
                lineItems: [...b.lineItems, newLineItem()],
              }))
            }
          >
            Add line item
          </Button>
        </section>
      ) : (
        <section className="flex items-center justify-center rounded-xl border border-dashed border-neutral-300 p-12 text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
          Select or create a bill to start editing.
        </section>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}): React.JSX.Element {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
      <p className="text-xs text-neutral-500 dark:text-neutral-400">{label}</p>
      <p
        className={cn(
          'mt-1 text-xl font-semibold tabular-nums',
          accent
            ? 'text-emerald-600 dark:text-emerald-400'
            : 'text-neutral-900 dark:text-neutral-100',
        )}
      >
        {value}
      </p>
    </div>
  );
}

function ComparisonBar({
  currentCents,
  optimizedCents,
}: {
  currentCents: number;
  optimizedCents: number;
}): React.JSX.Element {
  const max = Math.max(currentCents, optimizedCents, 1);
  const curPct = Math.round((currentCents / max) * 100);
  const optPct = Math.round((optimizedCents / max) * 100);
  return (
    <div className="space-y-2 rounded-xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex items-center gap-3">
        <span className="w-20 shrink-0 text-xs text-neutral-500 dark:text-neutral-400">
          Current
        </span>
        <div className="h-3 flex-1 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
          <div
            className="h-full rounded-full bg-neutral-400 dark:bg-neutral-500"
            style={{ width: `${curPct}%` }}
          />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <span className="w-20 shrink-0 text-xs text-neutral-500 dark:text-neutral-400">
          Optimized
        </span>
        <div className="h-3 flex-1 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
          <div className="h-full rounded-full bg-emerald-500" style={{ width: `${optPct}%` }} />
        </div>
      </div>
    </div>
  );
}

const SEVERITY_BADGE: Record<string, string> = {
  high: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  medium: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  low: 'bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300',
};

function AnalysisPanel({
  result,
  lineItems,
  onApply,
  onDismiss,
}: {
  result: OptimizationResult;
  lineItems: LineItem[];
  onApply: () => void;
  onDismiss: () => void;
}): React.JSX.Element {
  const descById = new Map(lineItems.map((li) => [li.id, li.description]));
  const errorCount = result.issues.filter((i) => i.level === 'error').length;

  return (
    <section className="space-y-4 rounded-xl border border-emerald-300 bg-emerald-50 p-5 dark:border-emerald-900/60 dark:bg-emerald-950/30">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            Optimization preview
          </h3>
          <p className="text-xs text-neutral-600 dark:text-neutral-400">
            Projected savings:{' '}
            <span className="font-semibold text-emerald-700 dark:text-emerald-400">
              {formatCents(result.projectedSavingsCents)}/mo
            </span>{' '}
            · {result.suggestions.length} suggestion
            {result.suggestions.length === 1 ? '' : 's'}
          </p>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={result.suggestions.length === 0}
            onClick={onApply}
          >
            Apply suggestions
          </Button>
        </div>
      </div>

      {result.issues.length > 0 ? (
        <ul className="space-y-1 text-xs">
          {result.issues.map((iss, idx) => (
            <li
              key={`${iss.ruleId}-${idx}`}
              className={
                iss.level === 'error'
                  ? 'text-red-700 dark:text-red-400'
                  : 'text-amber-700 dark:text-amber-400'
              }
            >
              {iss.level === 'error' ? '✗' : '⚠'} {iss.message}
            </li>
          ))}
        </ul>
      ) : null}

      {result.suggestions.length === 0 ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          No optimization opportunities found.
        </p>
      ) : (
        <ul className="space-y-2">
          {result.suggestions.map((s, idx) => (
            <li
              key={`${s.ruleId}-${s.lineItemId}-${idx}`}
              className="rounded-lg border border-neutral-200 bg-white p-3 text-sm dark:border-neutral-800 dark:bg-neutral-900"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-neutral-900 dark:text-neutral-100">
                  {descById.get(s.lineItemId) ?? 'Line item'}
                </span>
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 text-xs font-medium capitalize',
                    SEVERITY_BADGE[s.severity],
                  )}
                >
                  {s.severity}
                </span>
              </div>
              <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">{s.rationale}</p>
              <p className="mt-1 text-xs text-neutral-700 tabular-nums dark:text-neutral-300">
                {formatCents(s.currentCents)} →{' '}
                <span className="font-semibold text-emerald-700 dark:text-emerald-400">
                  {formatCents(s.suggestedCents)}
                </span>
              </p>
            </li>
          ))}
        </ul>
      )}

      {errorCount > 0 ? (
        <p className="text-xs text-red-700 dark:text-red-400">
          Resolve {errorCount} validation error
          {errorCount === 1 ? '' : 's'} before relying on these numbers.
        </p>
      ) : null}
    </section>
  );
}
