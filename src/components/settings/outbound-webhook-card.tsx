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
          internal change requests, etc.). Each request is signed with a
          timestamp + HMAC-SHA256 of
          <code className="mx-1 rounded bg-neutral-100 px-1 py-0.5 text-xs">
            {'`${timestamp}.${body}`'}
          </code>
          using the secret below. The signature is sent as
          <code className="mx-1 rounded bg-neutral-100 px-1 py-0.5 text-xs">
            X-CarrierAudit-Signature: t=&lt;ts&gt;,v1=&lt;hex&gt;
          </code>
          alongside
          <code className="mx-1 rounded bg-neutral-100 px-1 py-0.5 text-xs">
            X-CarrierAudit-Timestamp
          </code>
          . Reject requests whose timestamp is more than 5 minutes old to
          prevent replays.
        </p>
      </header>

      <form action={onSubmit} className="space-y-4">
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
            Parse the
            <code className="mx-1 rounded bg-neutral-100 px-1 py-0.5 text-xs">
              X-CarrierAudit-Signature
            </code>
            header into
            <code className="mx-1 rounded bg-neutral-100 px-1 py-0.5 text-xs">
              t=&lt;ts&gt;,v1=&lt;hex&gt;
            </code>
            , confirm
            <code className="mx-1 rounded bg-neutral-100 px-1 py-0.5 text-xs">
              ts
            </code>
            is within 5 minutes, then compute
            <code className="mx-1 rounded bg-neutral-100 px-1 py-0.5 text-xs">
              {'hmac_sha256(`${ts}.${body}`, secret)'}
            </code>
            and compare with a constant-time check. The secret never appears
            in webhook payloads.
          </p>
          <details className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-xs text-neutral-700">
            <summary className="cursor-pointer font-medium text-neutral-900">
              Verification snippets
            </summary>
            <div className="mt-2 space-y-3">
              <div>
                <p className="mb-1 font-medium">Node</p>
                <pre className="overflow-x-auto rounded bg-white p-2 font-mono text-[11px] leading-relaxed">{`const [tPart, vPart] = req.headers['x-carrieraudit-signature'].split(',');
const ts = tPart.split('=')[1];
const sig = vPart.split('=')[1];
if (Math.abs(Date.now()/1000 - Number(ts)) > 300) throw new Error('stale');
const expected = require('crypto')
  .createHmac('sha256', SECRET)
  .update(\`\${ts}.\${rawBody}\`)
  .digest('hex');
if (!require('crypto').timingSafeEqual(
  Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex')
)) throw new Error('bad sig');`}</pre>
              </div>
              <div>
                <p className="mb-1 font-medium">Python</p>
                <pre className="overflow-x-auto rounded bg-white p-2 font-mono text-[11px] leading-relaxed">{`import hmac, hashlib, time
parts = dict(p.split('=', 1) for p in request.headers['X-CarrierAudit-Signature'].split(','))
ts, sig = parts['t'], parts['v1']
if abs(time.time() - int(ts)) > 300: raise Exception('stale')
expected = hmac.new(SECRET.encode(), f"{ts}.{raw_body}".encode(), hashlib.sha256).hexdigest()
if not hmac.compare_digest(expected, sig): raise Exception('bad sig')`}</pre>
              </div>
            </div>
          </details>
        </div>
      ) : null}
    </section>
  );
}
