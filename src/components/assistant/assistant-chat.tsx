'use client';

/**
 * AssistantChat — full-page chat UI for the AI analyst.
 *
 * State is client-only by design (MVP). Refreshing the page clears the
 * conversation; the assistant has no persistence layer yet. If we add
 * conversation history later, it slots in at the `messages` state and the
 * POST body.
 *
 * Streaming: the route emits SSE with three event types:
 *   {type:'text_delta', text}    — append to the in-progress assistant turn
 *   {type:'done', citations:{…}} — terminal; freeze the assistant turn
 *   {type:'error', message}      — terminal; surface via sonner toast
 */

import * as React from 'react';
import Link from 'next/link';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface Citations {
  audit_ids: string[];
  finding_ids: string[];
  comparison_ids: string[];
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: Citations;
  isStreaming?: boolean;
}

const EXAMPLE_QUESTIONS = [
  'Why did my bill increase last month?',
  'Which lines have no usage but are still being billed?',
  'What are the highest-savings findings on my most recent audit?',
  'Which lines have insurance add-ons?',
  'Are any of my promo credits about to expire?',
] as const;

function nextId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function emptyCitations(c?: Citations): boolean {
  if (!c) return true;
  return (
    c.audit_ids.length === 0 &&
    c.finding_ids.length === 0 &&
    c.comparison_ids.length === 0
  );
}

export function AssistantChat() {
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [input, setInput] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const transcriptRef = React.useRef<HTMLDivElement | null>(null);

  // Auto-scroll to the bottom whenever new content arrives.
  React.useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = React.useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;

      const userMessage: ChatMessage = {
        id: nextId(),
        role: 'user',
        content: trimmed,
      };
      const assistantId = nextId();
      const placeholder: ChatMessage = {
        id: assistantId,
        role: 'assistant',
        content: '',
        isStreaming: true,
      };

      // Snapshot the outgoing payload BEFORE adding the placeholder — the
      // server doesn't need to see its own pending response.
      const outgoing = [...messages, userMessage].map((m) => ({
        role: m.role,
        content: m.content,
      }));

      setMessages((prev) => [...prev, userMessage, placeholder]);
      setInput('');
      setBusy(true);

      try {
        const res = await fetch('/api/assistant', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: outgoing }),
        });

        if (!res.ok || !res.body) {
          const errorBody = await res.text().catch(() => '');
          throw new Error(
            errorBody || `Assistant request failed (${res.status}).`,
          );
        }

        await consumeStream(res.body, {
          onDelta: (text) => {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, content: m.content + text }
                  : m,
              ),
            );
          },
          onDone: (citations) => {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, citations, isStreaming: false }
                  : m,
              ),
            );
          },
          onError: (message) => {
            throw new Error(message);
          },
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Something went wrong.';
        toast.error(message);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  isStreaming: false,
                  content:
                    m.content ||
                    'Sorry — something went wrong. Try again in a moment.',
                }
              : m,
          ),
        );
      } finally {
        setBusy(false);
      }
    },
    [busy, messages],
  );

  const onSubmit = React.useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void send(input);
    },
    [send, input],
  );

  const onReset = React.useCallback(() => {
    if (busy) return;
    setMessages([]);
    setInput('');
  }, [busy]);

  const showEmptyState = messages.length === 0;

  return (
    <div className="flex h-[calc(100vh-14rem)] min-h-[480px] flex-col rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <div
        ref={transcriptRef}
        className="flex-1 overflow-y-auto px-4 py-4"
        aria-live="polite"
      >
        {showEmptyState ? (
          <EmptyState onPick={(q) => void send(q)} disabled={busy} />
        ) : (
          <div className="flex flex-col gap-4">
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} />
            ))}
          </div>
        )}
      </div>
      <form
        onSubmit={onSubmit}
        className="flex items-center gap-2 border-t border-neutral-200 bg-neutral-50 px-3 py-3 dark:border-neutral-800 dark:bg-neutral-950"
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about your audits…"
          disabled={busy}
          maxLength={4000}
          className="flex-1 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none disabled:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
        />
        <Button type="submit" disabled={busy || input.trim().length === 0}>
          {busy ? 'Thinking…' : 'Send'}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onReset}
          disabled={busy || messages.length === 0}
        >
          New conversation
        </Button>
      </form>
    </div>
  );
}

function EmptyState({
  onPick,
  disabled,
}: {
  onPick: (q: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
      <div>
        <p className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
          What would you like to know?
        </p>
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
          The assistant answers from your audits, findings, and bill
          comparisons — nothing else.
        </p>
      </div>
      <ul className="flex w-full max-w-md flex-col gap-2">
        {EXAMPLE_QUESTIONS.map((q) => (
          <li key={q}>
            <button
              type="button"
              onClick={() => onPick(q)}
              disabled={disabled}
              className="w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-left text-sm text-neutral-700 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              {q}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={cn('flex w-full', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-lg px-3 py-2 text-sm',
          isUser
            ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
            : 'bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100',
        )}
      >
        <div className="whitespace-pre-wrap break-words">
          {message.content}
          {message.isStreaming && message.content.length === 0 ? (
            <span className="inline-block animate-pulse text-neutral-400">
              …
            </span>
          ) : null}
        </div>
        {!isUser && !message.isStreaming && !emptyCitations(message.citations) ? (
          <CitationChips citations={message.citations!} />
        ) : null}
      </div>
    </div>
  );
}

function CitationChips({ citations }: { citations: Citations }) {
  const chips: React.ReactNode[] = [];
  for (const id of citations.audit_ids) {
    chips.push(
      <Link
        key={`audit-${id}`}
        href={`/audits/${id}`}
        className="rounded-full bg-neutral-200 px-2 py-0.5 text-[11px] font-medium text-neutral-700 hover:bg-neutral-300 dark:bg-neutral-700 dark:text-neutral-200"
      >
        audit {id.slice(0, 8)}
      </Link>,
    );
  }
  for (const id of citations.finding_ids) {
    chips.push(
      <span
        key={`finding-${id}`}
        className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800"
      >
        finding {id.slice(0, 8)}
      </span>,
    );
  }
  for (const id of citations.comparison_ids) {
    chips.push(
      <span
        key={`comparison-${id}`}
        className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-800"
      >
        comparison {id.slice(0, 8)}
      </span>,
    );
  }
  if (chips.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5 border-t border-neutral-200 pt-2 dark:border-neutral-700">
      <span className="text-[11px] uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
        Sources
      </span>
      {chips}
    </div>
  );
}

interface StreamHandlers {
  onDelta: (text: string) => void;
  onDone: (citations: Citations) => void;
  onError: (message: string) => void;
}

/**
 * Consume an SSE stream from /api/assistant. The route only ever emits a
 * `data: ` payload (no event names, no comments) so the parser is simple:
 * split by `\n\n`, take the JSON after the `data: ` prefix.
 */
async function consumeStream(
  body: ReadableStream<Uint8Array>,
  handlers: StreamHandlers,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const line = rawEvent.startsWith('data: ')
        ? rawEvent.slice(6)
        : rawEvent;
      if (line.length > 0) {
        try {
          const payload = JSON.parse(line) as
            | { type: 'text_delta'; text: string }
            | { type: 'done'; citations: Citations }
            | { type: 'error'; message: string };
          if (payload.type === 'text_delta') handlers.onDelta(payload.text);
          else if (payload.type === 'done') handlers.onDone(payload.citations);
          else if (payload.type === 'error') handlers.onError(payload.message);
        } catch {
          // ignore unparseable frames; the next boundary will resume
        }
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
}
