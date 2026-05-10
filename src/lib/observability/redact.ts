/**
 * PII redactor used at every logging boundary (Sentry beforeSend, Inngest
 * failure_reason, ad-hoc logger.error). Per CLAUDE.md §1#5 the system must
 * never persist employee names, full phone numbers, account numbers, email
 * addresses, or raw bill body in logs.
 *
 * Redaction policy:
 *  - Drop top-level keys named `raw`, `text`, `content`, `received` (these
 *    have historically held verbatim model output / pre-validation parsed
 *    bill JSON).
 *  - Drop bill-body keys that carry subscriber PII directly: `user_label`
 *    (X12 REF*EM populates it with subscriber names verbatim), `mdn`,
 *    `phone_number`, `account_number`, `email`. The per-line *_last4
 *    variants stay (already bounded by schema).
 *  - For every other string-valued field, apply pattern scrubbers:
 *      • email addresses → `[email]`
 *      • hyphenated/dotted/spaced 10-digit phone numbers → `[phone]`
 *      • residual digit runs of 4+ characters → `[REDACTED]`
 *  - Nested objects/arrays are walked recursively. Functions, symbols, and
 *    other non-serializable values are dropped to avoid surprises.
 *
 * Returns a *new* object — never mutates the input.
 */

const REDACTED_KEYS = new Set([
  // Verbatim payload fields.
  'raw',
  'text',
  'content',
  'received',
  // Bill-body keys carrying PII directly.
  'user_label',
  'mdn',
  'phone_number',
  'account_number',
  'email',
]);

// Order matters: phones first (preserves digit run for matching), then emails,
// then residual long digit runs.
const HYPHEN_PHONE = /\d{3}[-.\s]\d{3}[-.\s]\d{4}/g;
const EMAIL = /[\w.+-]+@[\w.-]+\.\w+/g;
const DIGIT_RUN = /\d{4,}/g;

const MAX_DEPTH = 6;
const MAX_STRING_LENGTH = 500;

export function redactDetails(details: unknown): unknown {
  return redactValue(details, 0);
}

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

export function scrubString(value: string): string {
  // Cap length so a leaked verbatim model dump can never blow up logs.
  const truncated =
    value.length > MAX_STRING_LENGTH
      ? value.slice(0, MAX_STRING_LENGTH) + '…'
      : value;
  return truncated
    .replace(EMAIL, '[email]')
    .replace(HYPHEN_PHONE, '[phone]')
    .replace(DIGIT_RUN, '[REDACTED]');
}
