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
  // Inbound/outbound email envelope fields — these arrive on
  // inbound-webhook payloads and outbound-email logs and routinely contain
  // raw subscriber addresses, names embedded in display strings, and
  // bill subject lines.
  'from',
  'to',
  'recipient',
  'subject',
  'customer_email',
  'customerEmail',
  // Device identifiers — IMEIs and serial numbers are PII per FCC rules
  // and let an observer correlate a leaked log with a specific handset.
  'device_serial',
  'imei',
  // Stripe hosted-invoice URLs embed a long signed token that grants
  // anonymous read access to the invoice (recipient name, amount, line
  // items). Treat the URL itself as PII.
  'hosted_invoice_url',
]);

// Order matters: phones first (preserves digit run for matching), then emails,
// then residual long digit runs. The phone pattern accepts both bare 3-digit
// area codes (`555-123-4567`) and parens-wrapped (`(555) 123-4567`), with
// hyphens, dots, spaces, or no separator between the trailing groups.
const HYPHEN_PHONE = /(?:\(\d{3}\)|\d{3})[-.\s]?\d{3}[-.\s]?\d{4}/g;
const EMAIL = /[\w.+-]+@[\w.-]+\.\w+/g;
const SHARE_PATH_TOKEN = /\/share\/[A-Za-z0-9_-]{32}\b/g;
const TOKEN_QUERY_PARAM = /([?&](?:token|share_token)=)[A-Za-z0-9_-]{16,}/gi;
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
    .replace(SHARE_PATH_TOKEN, '/share/[REDACTED]')
    .replace(TOKEN_QUERY_PARAM, '$1[REDACTED]')
    .replace(EMAIL, '[email]')
    .replace(HYPHEN_PHONE, '[phone]')
    .replace(DIGIT_RUN, '[REDACTED]');
}
