'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';

export interface RetryButtonProps {
  auditId: string;
}

/**
 * Admin-side retry trigger. POSTs to the existing
 * `/api/audits/[id]/retry` endpoint. The endpoint enforces audit ownership
 * (user_id === auth.uid), so this button only succeeds when an admin is
 * viewing their own failed audit; otherwise it surfaces the 404 / 409.
 * The button intentionally does not bypass that ownership check — the
 * triage page is read-mostly with a retry affordance for self-owned rows.
 */
export function RetryButton({ auditId }: RetryButtonProps): React.JSX.Element {
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();

  function onClick(): void {
    startTransition(async () => {
      try {
        const res = await fetch(`/api/audits/${auditId}/retry`, {
          method: 'POST',
        });
        if (res.ok) {
          setDone(true);
          toast.success('Retry queued.');
          return;
        }
        let message = `Retry failed (${res.status}).`;
        try {
          const body = (await res.json()) as { error?: string };
          if (typeof body.error === 'string' && body.error.length > 0) {
            message = body.error;
          }
        } catch {
          // ignore parse error; keep generic message
        }
        toast.error(message);
      } catch {
        toast.error('Network error — could not queue retry.');
      }
    });
  }

  return (
    <Button type="button" variant="outline" size="sm" disabled={pending || done} onClick={onClick}>
      {done ? 'Queued' : pending ? 'Retrying…' : 'Retry'}
    </Button>
  );
}
