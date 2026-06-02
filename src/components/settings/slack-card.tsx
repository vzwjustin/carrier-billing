'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface SlackCardProps {
  initialWebhookUrl: string | null;
  initialNotifyOnHighFinding: boolean;
  initialNotifyOnAutopsy: boolean;
}

interface SaveResponse {
  ok: boolean;
  error?: string;
  has_webhook?: boolean;
}

interface TestResponse {
  ok: boolean;
  error?: string;
}

async function postSettings(body: {
  webhook_url: string | null;
  notify_on_high_finding: boolean;
  notify_on_autopsy: boolean;
}): Promise<SaveResponse> {
  const res = await fetch('/api/settings/slack', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  if (!res.ok) {
    return {
      ok: false,
      error: (payload as { error?: string } | null)?.error ?? 'Could not save.',
    };
  }
  return payload as SaveResponse;
}

async function postTest(): Promise<TestResponse> {
  const res = await fetch('/api/settings/slack/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  if (!res.ok) {
    return {
      ok: false,
      error: (payload as { error?: string } | null)?.error ?? 'Test failed.',
    };
  }
  return payload as TestResponse;
}

/**
 * Mirrors the inbound webhook card's click-to-reveal pattern: once saved,
 * the webhook URL is masked (`https://hooks.slack.com/services/•••`) until
 * the user clicks Reveal. The plaintext is held in component state from
 * the initial server render — no extra round-trip needed.
 */
function maskSlackUrl(url: string): string {
  // Slack hooks look like `https://hooks.slack.com/services/T0.../B0.../<secret>`.
  // Strip the secret tail so a shoulder-surfer can confirm the URL is saved
  // without exposing the credential.
  const prefix = url.slice(0, 'https://hooks.slack.com/services/'.length);
  if (prefix.startsWith('https://hooks.slack.com/services/')) {
    return `${prefix}•••`;
  }
  // Fall back to a generic mask for any non-standard hook path.
  return `https://hooks.slack.com/•••`;
}

export function SlackCard({
  initialWebhookUrl,
  initialNotifyOnHighFinding,
  initialNotifyOnAutopsy,
}: SlackCardProps): React.JSX.Element {
  const [webhookUrl, setWebhookUrl] = useState<string | null>(initialWebhookUrl);
  const [draftUrl, setDraftUrl] = useState<string>(initialWebhookUrl ?? '');
  const [notifyHighFinding, setNotifyHighFinding] = useState(initialNotifyOnHighFinding);
  const [notifyAutopsy, setNotifyAutopsy] = useState(initialNotifyOnAutopsy);
  const [revealed, setRevealed] = useState(false);
  const [isSaving, startSaveTransition] = useTransition();
  const [isTesting, startTestTransition] = useTransition();

  function onSave(): void {
    const next = draftUrl.trim();
    startSaveTransition(async () => {
      const result = await postSettings({
        webhook_url: next === '' ? null : next,
        notify_on_high_finding: notifyHighFinding,
        notify_on_autopsy: notifyAutopsy,
      });
      if (!result.ok) {
        toast.error(result.error ?? 'Could not save.');
        return;
      }
      if (next === '') {
        toast.success('Slack integration disabled.');
        setWebhookUrl(null);
        setRevealed(false);
      } else {
        toast.success('Slack settings saved.');
        setWebhookUrl(next);
        setRevealed(false);
      }
    });
  }

  function onClear(): void {
    setDraftUrl('');
    startSaveTransition(async () => {
      const result = await postSettings({
        webhook_url: null,
        notify_on_high_finding: notifyHighFinding,
        notify_on_autopsy: notifyAutopsy,
      });
      if (!result.ok) {
        toast.error(result.error ?? 'Could not clear.');
        return;
      }
      setWebhookUrl(null);
      setRevealed(false);
      toast.success('Slack integration disabled.');
    });
  }

  function onTest(): void {
    startTestTransition(async () => {
      const result = await postTest();
      if (!result.ok) {
        toast.error(result.error ?? 'Test failed.');
        return;
      }
      toast.success('Test message sent — check your Slack channel.');
    });
  }

  const hasSavedUrl = webhookUrl !== null && webhookUrl.length > 0;
  const displayedUrl = hasSavedUrl ? (revealed ? webhookUrl : maskSlackUrl(webhookUrl)) : null;

  return (
    <section className="space-y-4 rounded-xl border border-neutral-200 bg-white p-6 shadow-sm">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold text-neutral-900">Slack notifications</h2>
        <p className="text-sm text-neutral-600">
          Paste an{' '}
          <a
            href="https://api.slack.com/messaging/webhooks"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-neutral-900"
          >
            Slack incoming-webhook URL
          </a>{' '}
          to receive a message when a high-severity finding is created or a bill-increase autopsy
          lands with disputable charges. The payload contains counts and finding titles only — never
          line-item data, account numbers, or phone numbers.
        </p>
      </header>

      {hasSavedUrl && displayedUrl ? (
        <div className="space-y-2">
          <p className="text-sm font-medium text-neutral-900">Saved webhook</p>
          <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-3 sm:flex-row sm:items-center sm:justify-between">
            <code className="font-mono text-sm break-all text-neutral-900">{displayedUrl}</code>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setRevealed((v) => !v)}
                disabled={isSaving || isTesting}
              >
                {revealed ? 'Hide' : 'Reveal'}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="space-y-1.5">
        <Label htmlFor="slack_webhook_url">Webhook URL</Label>
        <Input
          id="slack_webhook_url"
          name="slack_webhook_url"
          type="url"
          placeholder="https://hooks.slack.com/services/T.../B.../..."
          value={draftUrl}
          onChange={(e) => setDraftUrl(e.target.value)}
          maxLength={2048}
          inputMode="url"
          pattern="https://hooks\.slack\.com/.*"
          autoComplete="off"
          aria-describedby="slack-hint"
          disabled={isSaving}
        />
        <p id="slack-hint" className="text-xs text-neutral-500">
          Must start with{' '}
          <code className="rounded bg-neutral-100 px-1 py-0.5">https://hooks.slack.com/</code>.
          Leave blank and save to disable.
        </p>
      </div>

      <fieldset className="space-y-2 rounded-lg border border-neutral-200 bg-neutral-50 p-4">
        <legend className="px-1 text-sm font-medium text-neutral-900">Notify me when…</legend>
        <label className="flex items-start gap-2 text-sm text-neutral-800">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded border-neutral-300"
            checked={notifyHighFinding}
            onChange={(e) => setNotifyHighFinding(e.target.checked)}
            disabled={isSaving}
          />
          <span>
            A <span className="font-medium">high-severity finding</span> is created (e.g. an
            escalated autopsy driver flagged as disputable).
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm text-neutral-800">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded border-neutral-300"
            checked={notifyAutopsy}
            onChange={(e) => setNotifyAutopsy(e.target.checked)}
            disabled={isSaving}
          />
          <span>
            A <span className="font-medium">bill-increase autopsy</span> lands with at least $0.01
            of disputable charges.
          </span>
        </label>
      </fieldset>

      <div className="flex flex-wrap justify-end gap-2">
        {hasSavedUrl ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onTest}
            disabled={isSaving || isTesting}
          >
            {isTesting ? 'Sending…' : 'Test notification'}
          </Button>
        ) : null}
        {hasSavedUrl ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onClear}
            disabled={isSaving || isTesting}
          >
            {isSaving ? 'Working…' : 'Clear'}
          </Button>
        ) : null}
        <Button type="button" size="sm" onClick={onSave} disabled={isSaving}>
          {isSaving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </section>
  );
}
