'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { updateOutboundWebhookAction } from '@/app/(app)/settings/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface OutboundWebhookCardProps {
  initialUrl: string | null;
  initialSecret: string | null;
}

export function OutboundWebhookCard({
  initialUrl,
  initialSecret,
}: OutboundWebhookCardProps): React.JSX.Element {
  const [url, setUrl] = useState(initialUrl ?? '');
  const [secret, setSecret] = useState<string | null>(initialSecret);
  const [revealSecret, setRevealSecret] = useState(false);
  const [isPending, startTransition] = useTransition();

  function onSubmit(formData: FormData): void {
    const next = String(formData.get('outbound_webhook_url') ?? '').trim();
    startTransition(async () => {
      const result = await updateOutboundWebhookAction({
        outbound_webhook_url: next,
      });
      if (result.ok) {
        setSecret(result.secret);
        if (next === '') {
          toast.success('Webhook disabled.');
          setUrl('');
        } else {
          toast.success('Webhook saved.');
          setUrl(next);
          setRevealSecret(true);
        }
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
      toast.error('Could not copy.');
    }
  }

  return (
    <section className="space-y-4 rounded-xl border border-neutral-200 bg-white p-6 shadow-sm">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold text-neutral-900">
          Outbound webhook
        </h2>
        <p className="text-sm text-neutral-600">
          When an audit completes, we POST the report payload to this URL so
          your own automation can act on findings (open carrier tickets, file
          internal change requests, etc.). Each request is signed with HMAC-SHA256
          of the body using the secret below; the signature is sent in the
          <code className="mx-1 rounded bg-neutral-100 px-1 py-0.5 text-xs">
            X-CarrierAudit-Signature
          </code>
          header.
        </p>
      </header>

      <form action={onSubmit} className="space-y-4" data-netlify="false">
        <div className="space-y-1.5">
          <Label htmlFor="outbound_webhook_url">Webhook URL</Label>
          <Input
            id="outbound_webhook_url"
            name="outbound_webhook_url"
            type="url"
            placeholder="https://your-app.example.com/hooks/carrieraudit"
            defaultValue={url}
            maxLength={2048}
            inputMode="url"
            pattern="https://.*"
            aria-describedby="webhook-hint"
          />
          <p id="webhook-hint" className="text-xs text-neutral-500">
            Must start with https://. Leave blank and save to disable.
          </p>
        </div>

        <div className="flex justify-end gap-2">
          <Button type="submit" disabled={isPending}>
            {isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>

      {secret ? (
        <div className="space-y-2 border-t border-neutral-200 pt-4">
          <p className="text-sm font-medium text-neutral-900">Signing secret</p>
          <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-3 sm:flex-row sm:items-center sm:justify-between">
            <code className="break-all text-sm font-mono text-neutral-900">
              {revealSecret ? secret : '•'.repeat(Math.min(secret.length, 32))}
            </code>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setRevealSecret((v) => !v)}
              >
                {revealSecret ? 'Hide' : 'Reveal'}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void copy(secret)}
              >
                Copy
              </Button>
            </div>
          </div>
          <p className="text-xs text-neutral-500">
            Verify by computing
            <code className="mx-1 rounded bg-neutral-100 px-1 py-0.5 text-xs">
              hmac_sha256(body, secret)
            </code>
            and comparing to the header. The secret never appears in webhook
            payloads.
          </p>
        </div>
      ) : null}
    </section>
  );
}
