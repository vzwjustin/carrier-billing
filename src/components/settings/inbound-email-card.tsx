'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { rotateInboundTokenAction } from '@/app/(app)/settings/actions';
import { Button } from '@/components/ui/button';

export interface InboundEmailCardProps {
  domain: string | null;
  initialToken: string | null;
}

function makeAddress(domain: string, token: string): string {
  return `bills+${token}@${domain}`;
}

export function InboundEmailCard({
  domain,
  initialToken,
}: InboundEmailCardProps): React.JSX.Element {
  const [token, setToken] = useState<string | null>(initialToken);
  const [isPending, startTransition] = useTransition();

  function rotate(): void {
    startTransition(async () => {
      const result = await rotateInboundTokenAction();
      if (result.ok) {
        setToken(result.token);
        toast.success('New forwarding address generated.');
      } else {
        toast.error(result.error);
      }
    });
  }

  async function copy(value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      toast.success('Copied.');
    } catch {
      toast.error('Could not copy. Long-press to copy manually.');
    }
  }

  if (!domain) {
    return (
      <section className="space-y-2 rounded-xl border border-neutral-200 bg-white p-6 shadow-sm">
        <header className="space-y-1">
          <h2 className="text-lg font-semibold text-neutral-900">
            Forward bills by email
          </h2>
        </header>
        <p className="text-sm text-neutral-600">
          Email ingest is not yet enabled on this deployment. Set
          <code className="mx-1 rounded bg-neutral-100 px-1 py-0.5 text-xs">
            INBOUND_EMAIL_DOMAIN
          </code>
          and
          <code className="mx-1 rounded bg-neutral-100 px-1 py-0.5 text-xs">
            INBOUND_EMAIL_SECRET
          </code>
          to turn it on.
        </p>
      </section>
    );
  }

  const address = token ? makeAddress(domain, token) : null;

  return (
    <section className="space-y-4 rounded-xl border border-neutral-200 bg-white p-6 shadow-sm">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold text-neutral-900">
          Forward bills by email
        </h2>
        <p className="text-sm text-neutral-600">
          Forward your monthly carrier bill PDF to the address below and
          we&apos;ll start an audit automatically. Each ingest still uses one
          credit (or your unlimited subscription).
        </p>
      </header>

      {address ? (
        <div className="space-y-2">
          <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-3 sm:flex-row sm:items-center sm:justify-between">
            <code className="break-all text-sm font-mono text-neutral-900">
              {address}
            </code>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void copy(address)}
              >
                Copy
              </Button>
            </div>
          </div>
          <p className="text-xs text-neutral-500">
            Anyone who knows this address can submit a bill audit on your
            account. Treat it like a secret.
          </p>
        </div>
      ) : (
        <p className="text-sm text-neutral-700">
          You don&apos;t have a forwarding address yet. Generate one to get
          started.
        </p>
      )}

      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          variant={address ? 'outline' : 'default'}
          onClick={rotate}
          disabled={isPending}
        >
          {isPending
            ? 'Working…'
            : address
              ? 'Rotate address'
              : 'Generate address'}
        </Button>
      </div>
    </section>
  );
}
