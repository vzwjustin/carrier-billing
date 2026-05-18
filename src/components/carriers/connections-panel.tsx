'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import {
  connectCarrierAction,
  disconnectCarrierAction,
  syncCarrierAction,
  type CarrierActionResult,
} from '@/app/(app)/carriers/actions';
import { Button } from '@/components/ui/button';
import {
  CARRIERS,
  CARRIER_LABELS,
  type Carrier,
  type CarrierConnection,
} from '@/lib/carriers/types';
import { cn } from '@/lib/utils';

const STATUS_BADGE: Record<CarrierConnection['status'], string> = {
  connected:
    'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  disconnected:
    'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400',
  error: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
};

export interface ConnectionsPanelProps {
  initial: CarrierConnection[];
}

function formatDate(value: string | null): string {
  if (!value) return 'never';
  return new Date(value).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function ConnectionsPanel({
  initial,
}: ConnectionsPanelProps): React.JSX.Element {
  const byCarrier = new Map(initial.map((c) => [c.carrier, c]));
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<Carrier | null>(null);

  function run(
    carrier: Carrier,
    action: (input: unknown) => Promise<CarrierActionResult>,
    successMsg: string,
  ): void {
    setBusy(carrier);
    startTransition(async () => {
      const result = await action(carrier);
      if (result.ok) toast.success(successMsg);
      else toast.error(result.error);
      setBusy(null);
    });
  }

  return (
    <div className="space-y-3">
      {CARRIERS.map((carrier) => {
        const conn = byCarrier.get(carrier);
        const status = conn?.status ?? 'disconnected';
        const connected = status === 'connected';
        const isBusy = pending && busy === carrier;

        return (
          <div
            key={carrier}
            className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
          >
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="font-medium text-neutral-900 dark:text-neutral-100">
                  {CARRIER_LABELS[carrier]}
                </span>
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 text-xs font-medium capitalize',
                    STATUS_BADGE[status],
                  )}
                >
                  {status}
                </span>
              </div>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                {connected
                  ? `${conn?.accountLabel ?? 'account'} · last synced ${formatDate(
                      conn?.lastSyncedAt ?? null,
                    )}`
                  : conn?.lastError
                    ? conn.lastError
                    : 'Not connected'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {connected ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={isBusy}
                    onClick={() =>
                      run(carrier, syncCarrierAction, 'Sync complete.')
                    }
                  >
                    {isBusy ? 'Working…' : 'Sync'}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={isBusy}
                    onClick={() =>
                      run(
                        carrier,
                        disconnectCarrierAction,
                        'Disconnected.',
                      )
                    }
                  >
                    Disconnect
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  disabled={isBusy}
                  onClick={() =>
                    run(carrier, connectCarrierAction, 'Connected.')
                  }
                >
                  {isBusy ? 'Connecting…' : 'Connect'}
                </Button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
