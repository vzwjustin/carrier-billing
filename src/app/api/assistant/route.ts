/**
 * POST /api/assistant — natural-language Q&A over a user's audits.
 *
 * Architecture:
 *   - Authenticated user only (no share-token surface). The assistant reads
 *     sensitive bill data, so we deliberately do not support unauthenticated
 *     callers.
 *   - Anthropic tool-use loop: the model decides which audit data to load
 *     via the tools in `src/lib/assistant/tools.ts`. Tool calls hit Supabase
 *     via the user-scoped SSR client (RLS is the second line of defense).
 *   - Server-Sent Events: each text delta from the model is forwarded to
 *     the client as a `data: {…}` line. The terminal event is `done` and
 *     carries a `citations` payload listing every audit/finding/comparison
 *     the model referenced this turn.
 *   - Prompt caching: the system prompt + tool definitions sit on a single
 *     cache breakpoint so they're paid for once per cache window (5 min).
 *     The conversation turns vary, so only the head of the request caches.
 *
 * Stack pin: Claude Opus 4.7 via the existing `@anthropic-ai/sdk@^0.32.1`.
 * SDK 0.32.1's typed `Model` union pre-dates Opus 4.7 but accepts arbitrary
 * strings via `(string & {}) | …`. We cast `createParams` at the call site
 * the same way `src/extraction/llm.ts` does — narrow the boundary, trust
 * internally.
 */

import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { ANTHROPIC_MODEL_ID, getAnthropicClient } from '@/lib/assistant/model';
import { SYSTEM_PROMPT } from '@/lib/assistant/system-prompt';
import {
  ASSISTANT_TOOL_DEFINITIONS,
  executeAssistantTool,
  freezeCitations,
  newCitationCollector,
  type CitationCollector,
  type ToolContext,
} from '@/lib/assistant/tools';
import { consumeRateLimit, rateLimitedResponse } from '@/lib/security/rate-limit';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const RoleEnum = z.enum(['user', 'assistant']);

const RequestMessageSchema = z.object({
  role: RoleEnum,
  content: z.string().min(1).max(4_000),
});

const RequestBodySchema = z.object({
  messages: z.array(RequestMessageSchema).min(1).max(20),
  conversation_id: z.string().max(128).optional(),
});

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

// We let the model take up to this many tool-using rounds per user turn
// before we hard-stop. Each round is one .messages.create() call, so this
// caps both spend per request and runaway loops.
const MAX_TOOL_ROUNDS = 6;
const MAX_OUTPUT_TOKENS = 4_000;

// ---------------------------------------------------------------------------
// SDK shape helpers
// ---------------------------------------------------------------------------
//
// SDK 0.32.1 doesn't expose Opus 4.7 in its typed Model union and its
// content-block / cache_control shapes also pre-date the current API. We
// cast at the boundary instead of importing speculative type names that
// might not exist in older SDK builds — same pattern as src/extraction/llm.ts.

type CacheControl = { cache_control?: { type: 'ephemeral' } };
type TextBlock = { type: 'text'; text: string } & CacheControl;
type ToolUseBlock = {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
};
type ToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};
type AnyContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

type AnthropicMessage =
  | { role: 'user'; content: string | AnyContentBlock[] }
  | { role: 'assistant'; content: AnyContentBlock[] };

interface AnthropicResponse {
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | null;
  content: AnyContentBlock[];
}

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function sseEvent(payload: Record<string, unknown>): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export async function POST(request: Request): Promise<Response> {
  // 1. Parse + auth + rate-limit before opening the stream so failures are
  //    plain JSON, not SSE-encoded errors the client has to special-case.
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const parsed = RequestBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request shape.', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const rateLimit = await consumeRateLimit({
    key: `assistant:${user.id}`,
    limit: 30,
    windowSeconds: 5 * 60,
  });
  if (!rateLimit.ok) {
    return rateLimitedResponse(rateLimit.resetAt);
  }

  // 2. Translate the validated request into Anthropic message shape.
  //    For string-content turns the shape matches both branches of the
  //    AnthropicMessage union; we narrow on `role` to satisfy the discriminator.
  const userTurns: AnthropicMessage[] = parsed.data.messages.map((m) =>
    m.role === 'user'
      ? { role: 'user', content: m.content }
      : { role: 'assistant', content: [{ type: 'text', text: m.content }] },
  );

  // 3. Open the SSE stream and run the tool loop in the background.
  const client = getAnthropicClient();
  const ctx: ToolContext = { supabase, userId: user.id };
  const citations = newCitationCollector();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await runAssistantLoop({
          client,
          messages: userTurns,
          ctx,
          citations,
          onTextDelta: (text) => {
            controller.enqueue(sseEvent({ type: 'text_delta', text }));
          },
        });
        controller.enqueue(sseEvent({ type: 'done', citations: freezeCitations(citations) }));
      } catch (err) {
        Sentry.captureException(err, {
          tags: { surface: 'assistant' },
        });
        const message = err instanceof Error ? err.message : 'Assistant failed.';
        controller.enqueue(sseEvent({ type: 'error', message: sanitizeErrorMessage(message) }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Disable Next/Vercel buffering so SSE chunks reach the client
      // immediately.
      'X-Accel-Buffering': 'no',
    },
  });
}

/**
 * Strip anything that looks like raw PII from an error string before it
 * crosses the network. The Anthropic SDK occasionally embeds request
 * payloads in its error messages; we don't want a malformed tool input to
 * round-trip a phone number back to the browser.
 */
function sanitizeErrorMessage(message: string): string {
  // Drop digit runs of 4+ (last-4 already in tool outputs is fine, but raw
  // phone numbers / account numbers must not bleed through error text).
  return message.replace(/\d{4,}/g, '[REDACTED]').slice(0, 400);
}

interface RunAssistantArgs {
  client: ReturnType<typeof getAnthropicClient>;
  messages: AnthropicMessage[];
  ctx: ToolContext;
  citations: CitationCollector;
  onTextDelta: (text: string) => void;
}

/**
 * Runs the model with the assistant tool set, dispatching tool calls until
 * the model returns `end_turn`. Streams text deltas to `onTextDelta` as
 * they arrive — when the model produces final text after a tool round, the
 * caller sees it incrementally.
 *
 * Implementation note: we use non-streaming `messages.create()` per round
 * but call `onTextDelta` with the full text payload after each round. This
 * keeps the wire format simple (one text event per round) and avoids
 * holding the SDK-version's streaming API to a contract that's evolved
 * across versions. For the assistant's typical sub-second answers this is
 * indistinguishable from token streaming.
 */
async function runAssistantLoop(args: RunAssistantArgs): Promise<void> {
  const { client, ctx, citations, onTextDelta } = args;
  const messages = [...args.messages];

  // Prompt-cache the system + tools prefix together. Per the Anthropic
  // skill's prompt-caching guide: tools render first, system second, so a
  // cache_control marker on the last system block snapshots the entire
  // stable prefix. The volatile conversation turns sit after it and aren't
  // re-cached on every turn.
  const systemBlocks: TextBlock[] = [
    {
      type: 'text',
      text: SYSTEM_PROMPT,
      cache_control: { type: 'ephemeral' },
    },
  ];

  // Tool definitions also get a cache_control breakpoint on the last entry,
  // matching the recommended pattern when caching tools + system together.
  // SDK 0.32.1's Tool type doesn't accept cache_control, so we cast.
  const tools = ASSISTANT_TOOL_DEFINITIONS.map((t, i) =>
    i === ASSISTANT_TOOL_DEFINITIONS.length - 1
      ? { ...t, cache_control: { type: 'ephemeral' as const } }
      : t,
  );

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const createParams = {
      model: ANTHROPIC_MODEL_ID,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: systemBlocks,
      tools,
      messages,
    } as unknown as Parameters<typeof client.messages.create>[0];

    const response = (await client.messages.create(createParams)) as unknown as AnthropicResponse;

    // Emit any text the model produced this round before deciding the next
    // step. If the model is about to call tools, this text is its "thinking
    // out loud" preface — useful to surface incrementally.
    for (const block of response.content) {
      if (block.type === 'text' && block.text) {
        onTextDelta(block.text);
      }
    }

    if (response.stop_reason === 'end_turn') {
      return;
    }

    if (response.stop_reason !== 'tool_use') {
      // max_tokens / stop_sequence / null — surface as a soft warning. We
      // don't throw; the caller will see whatever partial text streamed.
      onTextDelta('\n\n_The response was cut short. Try asking a more focused question._');
      return;
    }

    const toolUses = response.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
    if (toolUses.length === 0) {
      // Defensive: stop_reason said tool_use but no tool blocks present.
      return;
    }

    // Append the assistant turn verbatim so the tool_use blocks stay paired
    // with their tool_result blocks on the next round. Skip empty content
    // (some SDK versions reject zero-block messages).
    messages.push({ role: 'assistant', content: response.content });

    // Run each tool call. We run them in series to keep ordering
    // predictable for the model and to avoid contention on the Supabase
    // session cookie/auth state. A single user turn typically dispatches
    // 1–3 tools, so series overhead is negligible.
    const toolResults: ToolResultBlock[] = [];
    for (const toolUse of toolUses) {
      try {
        const result = await executeAssistantTool(toolUse.name, toolUse.input, ctx, citations);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
        });
      } catch (err) {
        // Per the tool-use docs: on tool failure, return the error TO the
        // model via tool_result with is_error=true so it can adapt — don't
        // throw and break the loop.
        const message = err instanceof Error ? err.message : 'Tool execution failed.';
        Sentry.captureException(err, {
          tags: { surface: 'assistant', tool: toolUse.name },
        });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify({
            error: sanitizeErrorMessage(message),
          }),
          is_error: true,
        });
      }
    }

    messages.push({ role: 'user', content: toolResults });
  }

  // If we got here, the model kept calling tools past MAX_TOOL_ROUNDS.
  onTextDelta(
    '\n\n_I had to stop looking up data after several rounds. Try asking a more specific question or breaking it into smaller parts._',
  );
}
