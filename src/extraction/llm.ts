import Anthropic from '@anthropic-ai/sdk';
import { env } from '@/env';
import { ExtractedBillSchema, type ExtractedBill } from '@/extraction/schema';

/**
 * Lazy singleton Anthropic client. Constructing eagerly at module load would
 * crash any environment without `ANTHROPIC_API_KEY` set (e.g. unrelated unit
 * tests, build-time evaluation). Mirrors the stripe client pattern.
 */
let cached: Anthropic | null = null;
function getClient(): Anthropic {
  if (cached) return cached;
  cached = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return cached;
}

const SYSTEM_PROMPT = `You are a senior telecom billing analyst with 15 years of experience auditing US business wireless bills from Verizon, AT&T, and T-Mobile.

Your job: extract a complete, normalized representation of the uploaded business wireless bill into strict JSON matching the schema provided.

CRITICAL RULES:
1. Output ONLY a single JSON object. No prose, no markdown, no code fences.
2. All money values are integer cents. $43.99 → 4399. Never use floats for money.
3. Phone numbers and account numbers: capture ONLY the last 4 digits, in a string field. Never output full PII.
4. Dates: ISO 8601 (YYYY-MM-DD).
5. Credits: monthly_cents is the SIGNED amount as it appears on the bill. A $10/mo discount line item shows as -1000.
6. If a value is genuinely not present, use null. Do not guess. Do not invent.
7. Suspended lines: still extract them; set is_suspended: true. Their plan_base_cents is the amount still being billed (often $0, sometimes not).
8. Multi-account bills: each account in the "accounts" array. Account-level credits go in account_level_credits.
9. Device Payment Plan (DPP / Equipment Installment Plan / Next Up): each device installment is a separate dpp_installments entry on the line. monthly_cents is the installment amount. If the bill shows "X of Y" (e.g., "12 of 36"), set remaining_payments = Y - X and total_payments = Y.
10. Features classification:
    - insurance: anything named like "Mobile Protect", "Asurion", "Total Mobile Protection", "Protection<360>", "Wireless Phone Protection", "AppleCare"
    - international: "TravelPass", "International Plan", "Global Plus", "International Roaming"
    - cloud: "Verizon Cloud", "AT&T Photo Storage", "Microsoft 365 add-on through carrier"
    - hotspot: "Mobile Hotspot Premium", extra hotspot data
    - addon: anything else recurring (premium voicemail, content streaming bundle, etc.)
    - other: only if you cannot classify
11. Plans: capture the exact plan name as printed. Common Verizon Business: "Business Unlimited Pro 2.0", "Business Unlimited Plus 2.0", "Business Unlimited Start 2.0". Common AT&T Business: "Business Unlimited Premium", "Business Unlimited Performance", "Business Unlimited Starter". Common T-Mobile for Business: "Business Unlimited Ultimate", "Business Unlimited Advanced", "Business Unlimited Select".
12. Notes array: include observations that don't fit the schema but might matter — e.g., "Bill includes prior balance", "Two pages appear to be missing", "Several lines have promo credits expiring next month".

CARRIER DETECTION: Set carrier based on the bill header. If ambiguous, set "unknown".

If the document is not a US business wireless bill, output: {"error": "not_a_wireless_bill"} and stop.`;

const USER_PROMPT = `Extract the bill into JSON matching this schema:

{
  "carrier": "verizon" | "att" | "tmobile" | "unknown",
  "billing_period_start": "YYYY-MM-DD",
  "billing_period_end": "YYYY-MM-DD",
  "total_charges_cents": integer,
  "accounts": [
    {
      "account_number_last4": "1234" | null,
      "label": "string or null",
      "total_charges_cents": integer,
      "taxes_fees_cents": integer | null,
      "account_level_credits": [
        { "name": "string", "monthly_cents": integer, "expires_on": "YYYY-MM-DD" | null, "is_promo": boolean }
      ],
      "lines": [
        {
          "mdn_last4": "1234" | null,
          "user_label": "string or null",
          "device": "string or null",
          "plan_name": "string or null",
          "plan_base_cents": integer | null,
          "data_used_gb": number | null,
          "voice_used_min": integer | null,
          "sms_used_count": integer | null,
          "is_suspended": boolean,
          "features": [{ "name": "string", "category": "insurance|international|cloud|hotspot|addon|other", "monthly_cents": integer }],
          "credits": [{ "name": "string", "monthly_cents": integer, "expires_on": "YYYY-MM-DD" | null, "is_promo": boolean }],
          "dpp_installments": [{ "device": "string", "monthly_cents": integer, "remaining_payments": integer | null, "total_payments": integer | null }]
        }
      ]
    }
  ],
  "notes": ["observations"]
}

Output the JSON only.`;

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 16_000;

export class ExtractionError extends Error {
  public readonly details?: unknown;
  constructor(message: string, details?: unknown) {
    super(message);
    this.name = 'ExtractionError';
    this.details = details;
  }
}

/**
 * Strip raw-bill-content fields from an ExtractionError.details payload before
 * it crosses a logging boundary. Per CLAUDE.md §1#9, logs must never carry
 * employee names, phone numbers, account numbers, or any extracted bill body.
 *
 * Redaction policy:
 *  - Drop top-level keys named `raw`, `text`, `content` (these have historically
 *    held verbatim model output / pre-validation parsed bill JSON).
 *  - For every other string-valued field, replace digit runs of 4+ characters
 *    with `[REDACTED]` so any leaked phone tail / account tail / dollar figure
 *    is scrubbed in case a future call site stuffs them into a different key.
 *  - Nested objects/arrays are walked recursively. Functions and class
 *    instances are dropped to avoid serialization surprises.
 *
 * Validation issue arrays from zod are preserved structurally (path + message
 * + code) but their `.received` / raw values are scrubbed via the same string
 * scrubber, since those echo the offending input.
 *
 * Returns a *new* object — never mutates the input.
 */
export function redactDetails(details: unknown): unknown {
  return redactValue(details, 0);
}

const REDACTED_KEYS = new Set(['raw', 'text', 'content', 'received']);
const DIGIT_RUN = /\d{4,}/g;
// Maximum recursion depth — defensive guard against pathological cycles.
const MAX_DEPTH = 6;

function redactValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return '[REDACTED]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (REDACTED_KEYS.has(key)) {
        out[key] = '[REDACTED]';
        continue;
      }
      out[key] = redactValue(child, depth + 1);
    }
    return out;
  }
  // Functions, symbols, etc. — drop them.
  return undefined;
}

function scrubString(value: string): string {
  // Only scrub strings that look like they could carry bill content. Cap the
  // length we keep so a leaked verbatim model dump can never blow up logs.
  const truncated = value.length > 500 ? value.slice(0, 500) + '…' : value;
  return truncated.replace(DIGIT_RUN, '[REDACTED]');
}

type DocumentBlock = {
  type: 'document';
  source: { type: 'base64'; media_type: 'application/pdf'; data: string };
};
type TextBlock = { type: 'text'; text: string };
type UserContent = Array<DocumentBlock | TextBlock>;

type Message =
  | { role: 'user'; content: UserContent }
  | { role: 'assistant'; content: string };

/**
 * Extract a normalized bill JSON from a PDF buffer using Claude with native
 * PDF input. Implements the §7 retry pattern: on a schema validation failure,
 * we make one more attempt with the bad output echoed back and a corrective
 * user turn appended. `not_a_wireless_bill` is NOT retried.
 */
export async function extractBill(pdfBuffer: Buffer): Promise<ExtractedBill> {
  const base64 = pdfBuffer.toString('base64');

  const initialMessages: Message[] = [
    {
      role: 'user',
      content: [
        {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: base64,
          },
        },
        { type: 'text', text: USER_PROMPT },
      ],
    },
  ];

  // First attempt.
  const firstRaw = await callModel(initialMessages);
  const firstResult = tryParseAndValidate(firstRaw);
  if (firstResult.kind === 'ok') return firstResult.bill;
  if (firstResult.kind === 'not_a_bill') {
    throw new ExtractionError('Not a wireless bill', firstResult.parsed);
  }

  // Retry once with the prior assistant turn echoed and a corrective user turn.
  const retryMessages: Message[] = [
    ...initialMessages,
    { role: 'assistant', content: firstRaw },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Your previous response failed validation: ${firstResult.reason}. Output corrected JSON only.`,
        },
      ],
    },
  ];

  const retryRaw = await callModel(retryMessages);
  const retryResult = tryParseAndValidate(retryRaw);
  if (retryResult.kind === 'ok') return retryResult.bill;
  if (retryResult.kind === 'not_a_bill') {
    throw new ExtractionError('Not a wireless bill', retryResult.parsed);
  }
  throw retryResult.error;
}

async function callModel(messages: Message[]): Promise<string> {
  const client = getClient();
  // The SDK's typed `messages.create` is happy to accept these block shapes,
  // but the union types vary by SDK version — cast at the boundary only.
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: messages as unknown as Parameters<
      typeof client.messages.create
    >[0]['messages'],
  });

  const textBlock = response.content.find(
    (b: { type: string }) => b.type === 'text',
  );
  if (!textBlock || textBlock.type !== 'text') {
    throw new ExtractionError('LLM returned no text content', {
      content: response.content,
    });
  }
  return (textBlock as { type: 'text'; text: string }).text;
}

type ParseResult =
  | { kind: 'ok'; bill: ExtractedBill }
  | { kind: 'not_a_bill'; parsed: unknown }
  | { kind: 'error'; error: ExtractionError; reason: string };

function tryParseAndValidate(raw: string): ParseResult {
  const trimmed = raw.trim();
  // Strip accidental code fences just in case.
  const jsonText = trimmed
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    const error = new ExtractionError('LLM returned non-JSON', {
      raw: jsonText.slice(0, 1000),
    });
    return { kind: 'error', error, reason: 'response was not valid JSON' };
  }

  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    'error' in parsed &&
    (parsed as { error: unknown }).error === 'not_a_wireless_bill'
  ) {
    return { kind: 'not_a_bill', parsed };
  }

  const result = ExtractedBillSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues;
    const reason = issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    const error = new ExtractionError('Schema validation failed', {
      issues,
      raw: parsed,
    });
    return { kind: 'error', error, reason };
  }
  return { kind: 'ok', bill: result.data };
}
