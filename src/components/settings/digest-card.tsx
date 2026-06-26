'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';

export interface DigestCardProps {
  initialOptOut: boolean;
}

export function DigestCard({ initialOptOut }: DigestCardProps): React.JSX.Element {
  const [optOut, setOptOut] = useState(initialOptOut);
  const [isPending, startTransition] = useTransition();

  function persist(nextOptOut: boolean): void {
    // Optimistic flip — revert on failure.
    setOptOut(nextOptOut);
    startTransition(async () => {
      try {
        const response = await fetch('/api/settings/digest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ opt_out: nextOptOut }),
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        toast.success(nextOptOut ? 'Monthly digest turned off.' : 'Monthly digest turned on.');
      } catch {
        // Revert the optimistic state.
        setOptOut(!nextOptOut);
        toast.error('Could not update preference. Please try again.');
      }
    });
  }

  return (
    <section className="space-y-4 rounded-xl border border-neutral-200 bg-white p-6 shadow-sm">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold text-neutral-900">Monthly digest</h2>
        <p className="text-sm text-neutral-600">
          On the 1st of each month, we&apos;ll email you a summary of what you&apos;re still leaving
          on the table: open findings, recoverable savings, and the lines worth attention first. You
          can unsubscribe from any digest with a single click — that just turns this toggle off.
        </p>
      </header>

      <div className="flex items-center justify-between rounded-lg border border-neutral-200 bg-neutral-50 p-4">
        <div>
          <p className="text-sm font-medium text-neutral-900">Send me the monthly digest</p>
          <p className="text-xs text-neutral-600">
            Status: <span className="font-medium">{optOut ? 'unsubscribed' : 'subscribed'}</span>
          </p>
        </div>
        <Button
          type="button"
          variant={optOut ? 'default' : 'outline'}
          disabled={isPending}
          onClick={() => persist(!optOut)}
        >
          {isPending ? 'Saving…' : optOut ? 'Subscribe' : 'Unsubscribe'}
        </Button>
      </div>
    </section>
  );
}
