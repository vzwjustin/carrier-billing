'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { maskInboundWebhookToken } from '@/lib/inbound/webhook-token-shape';

export interface InboundWebhookCardProps {
  // The full plaintext token. Server may pass null if no token is provisioned.
  // The card masks all but the last 6 chars until the user clicks Reveal.
  initialToken: string | null;
}

type GenerateResponse =
  | { ok: true; token: string }
  | { ok: false; error: string };

type RevokeResponse = { ok: true } | { ok: false; error: string };

async function postAction(
  body: { action: 'generate' | 'revoke' },
): Promise<GenerateResponse | RevokeResponse> {
  const res = await fetch('/api/settings/inbound-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  // Parse defensively — a 500 with an HTML body would otherwise blow up here.
  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  if (!res.ok) {
    const message =
      (payload as { error?: string } | null)?.error ?? 'Request failed.';
    return { ok: false, error: message };
  }
  return payload as GenerateResponse | RevokeResponse;
}

export function InboundWebhookCard({
  initialToken,
}: InboundWebhookCardProps): React.JSX.Element {
  const [token, setToken] = useState<string | null>(initialToken);
  const [revealed, setRevealed] = useState(false);
  const [isPending, startTransition] = useTransition();

  function onGenerate(): void {
    startTransition(async () => {
      const result = await postAction({ action: 'generate' });
      if (!('ok' in result) || !result.ok) {
        toast.error(
          ('error' in result && result.error) || 'Could not generate token.',
        );
        return;
      }
      // Type narrowing: only the generate path returns a `token` field.
      if ('token' in result && typeof result.token === 'string') {
        setToken(result.token);
        setRevealed(true);
        toast.success(
          'Inbound token generated. Copy it now — you can reveal it again later.',
        );
      } else {
        toast.error('Server returned no token.');
      }
    });
  }

  function onRevoke(): void {
    if (!token) return;
    startTransition(async () => {
      const result = await postAction({ action: 'revoke' });
      if (!result.ok) {
        toast.error(result.error || 'Could not revoke token.');
        return;
      }
      setToken(null);
      setRevealed(false);
      toast.success('Inbound token revoked.');
    });
  }

  async function onCopy(): Promise<void> {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      toast.success('Copied.');
    } catch {
      toast.error('Could not copy. Long-press to copy manually.');
    }
  }

  const displayValue = token
    ? revealed
      ? token
      : maskInboundWebhookToken(token)
    : null;

  return (
    <section className="space-y-4 rounded-xl border border-neutral-200 bg-white p-6 shadow-sm">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold text-neutral-900">
          Inbound finding-status webhook
        </h2>
        <p className="text-sm text-neutral-600">
          Generate a token to let Slack, Linear, or any other tool POST a
          finding status change back into CarrierAudit. Send the token in the
          <code className="mx-1 rounded bg-neutral-100 px-1 py-0.5 text-xs">
            X-CarrierAudit-Token
          </code>
          header on
          <code className="mx-1 rounded bg-neutral-100 px-1 py-0.5 text-xs">
            POST /api/inbound/finding-status
          </code>
          .
        </p>
      </header>

      {displayValue ? (
        <div className="space-y-2">
          <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-3 sm:flex-row sm:items-center sm:justify-between">
            <code className="break-all text-sm font-mono text-neutral-900">
              {displayValue}
            </code>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setRevealed((v) => !v)}
                disabled={isPending}
              >
                {revealed ? 'Hide' : 'Reveal'}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void onCopy()}
                disabled={isPending}
              >
                Copy
              </Button>
            </div>
          </div>
          <p className="text-xs text-neutral-500">
            Anyone who holds this token can update findings on your account.
            Treat it like a password — rotate immediately if it leaks.
          </p>
        </div>
      ) : (
        <p className="text-sm text-neutral-700">
          You don&apos;t have an inbound token yet. Generate one to enable
          finding callbacks from external tools.
        </p>
      )}

      <div className="flex justify-end gap-2">
        {token ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onRevoke}
            disabled={isPending}
          >
            {isPending ? 'Working…' : 'Revoke'}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant={token ? 'outline' : 'default'}
          onClick={onGenerate}
          disabled={isPending}
        >
          {isPending
            ? 'Working…'
            : token
              ? 'Regenerate token'
              : 'Generate inbound token'}
        </Button>
      </div>
    </section>
  );
}
