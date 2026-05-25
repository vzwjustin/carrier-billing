/**
 * Anthropic client + model constants for the AI assistant.
 *
 * Kept separate from `src/extraction/llm.ts` (which pins Sonnet 4.6 for bill
 * extraction) because the assistant intentionally uses Opus 4.7 — the
 * highest-intelligence model — for natural-language Q&A over a user's audit
 * data. The two surfaces have very different latency/cost profiles and
 * shouldn't share configuration.
 *
 * The model ID is the literal string accepted by the API; SDK 0.32.1's typed
 * `Model` union predates Opus 4.7 but the underlying type is
 * `(string & {}) | …` so any string is accepted at the type level. We cast
 * at the call site, matching the pattern in extraction/llm.ts.
 */

import Anthropic from '@anthropic-ai/sdk';

import { env } from '@/env';

export const ANTHROPIC_MODEL_ID = 'claude-opus-4-7';

// Lazy singleton — constructing eagerly at module load would crash tests and
// any other environment without `ANTHROPIC_API_KEY` set. Mirrors the pattern
// in `src/extraction/llm.ts` and `src/lib/stripe/client.ts`.
let cached: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (cached) return cached;
  cached = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return cached;
}

// Test-only escape hatch so unit tests can inject a fake client without
// constructing a real SDK instance. Not exported from a public barrel.
export function __setAnthropicClientForTests(client: Anthropic | null): void {
  cached = client;
}
