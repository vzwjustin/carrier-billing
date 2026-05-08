'use client';

import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';

type PortalResponse = { url?: string; error?: string };

export function ManageSubscriptionButton(): React.ReactElement {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onClick(): void {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch('/api/stripe/portal', { method: 'POST' });
        const data = (await res.json().catch(() => ({}))) as PortalResponse;
        if (!res.ok || !data.url) {
          setError(
            data.error ??
              'Could not open the billing portal. Please try again.',
          );
          return;
        }
        window.location.href = data.url;
      } catch {
        setError('Network error. Please try again.');
      }
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <Button onClick={onClick} disabled={isPending}>
        {isPending ? 'Opening portal...' : 'Manage subscription'}
      </Button>
      {error ? (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}
