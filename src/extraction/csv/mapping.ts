/**
 * Column mapping for CSV bill imports.
 *
 * A CSV import is fundamentally a translation: each row maps to a single
 * `ExtractedLine`, and the user (with help from heuristics) decides which
 * source-CSV column feeds each canonical field.
 *
 * This file defines:
 *  - the canonical field set,
 *  - the `ColumnMapping` type (canonical field → CSV header name | null),
 *  - a heuristic auto-mapper that picks reasonable defaults from CSV
 *    headers (covers Verizon / AT&T / T-Mobile-style exports),
 *  - small helpers for the parser: last-4 extraction, money normalization,
 *    boolean coercion.
 *
 * PII discipline (CLAUDE.md §1#5): we NEVER log raw header strings or
 * cell values from this module. The auto-mapper returns header *names*
 * the parser uses to look up cells — those names come from the file and
 * may carry PII (rare, but a "Subscriber Name" column could).
 */

import { z } from 'zod';

/**
 * Canonical fields the CSV parser knows how to consume. Anything outside
 * this set is silently ignored — a CSV may include far more columns than
 * the schema cares about.
 *
 * Conventions:
 *  - `mdn_last4` / `account_number_last4`: parser extracts the last 4
 *    digits regardless of how the source formats the phone/account.
 *  - `*_cents`: stored as cents internally; parser converts dollar-string
 *    inputs (`$1,234.56` → `123_456`).
 *  - `data_used_gb`: float, parser strips a trailing `GB`/`MB` suffix.
 *  - `is_suspended`: boolean, parser coerces "yes/true/1/Y" → true.
 */
export const CANONICAL_FIELDS = [
  'mdn_last4',
  'user_label',
  'device',
  'plan_name',
  'plan_base_cents',
  'data_used_gb',
  'voice_used_min',
  'sms_used_count',
  'is_suspended',
  'account_number_last4',
  'account_label',
] as const;

export type CanonicalField = (typeof CANONICAL_FIELDS)[number];

/**
 * Map from canonical field id to a source-CSV header name. `null` means
 * the user (or auto-mapper) didn't find a column for that field. The
 * parser tolerates missing mappings — required fields fall back to nulls
 * or defaults per `ExtractedLineSchema`.
 */
export type ColumnMapping = Partial<Record<CanonicalField, string | null>>;

export const ColumnMappingSchema = z.object({
  mdn_last4: z.string().nullable().optional(),
  user_label: z.string().nullable().optional(),
  device: z.string().nullable().optional(),
  plan_name: z.string().nullable().optional(),
  plan_base_cents: z.string().nullable().optional(),
  data_used_gb: z.string().nullable().optional(),
  voice_used_min: z.string().nullable().optional(),
  sms_used_count: z.string().nullable().optional(),
  is_suspended: z.string().nullable().optional(),
  account_number_last4: z.string().nullable().optional(),
  account_label: z.string().nullable().optional(),
});

// ---------------------------------------------------------------------------
// Heuristic auto-mapper
// ---------------------------------------------------------------------------

/**
 * Ordered pattern lists per canonical field. The first regex that matches
 * a header (case-insensitive, trimmed) wins. Patterns favour the carrier
 * exports we've seen in production:
 *   Verizon  — "Wireless Number", "User Name", "Equipment", "Plan", "Data Usage (GB)"
 *   AT&T     — "Mobile Number", "User Description", "Device", "Plan Name", "Data Used"
 *   T-Mobile — "MSISDN" or "Phone Number", "User Name", "Device", "Rate Plan", "GB Used"
 *
 * Keep these patterns conservative — false positives in the auto-mapper
 * are visible to the user (they see the picked column in step 2 and can
 * override), but a wrong default is more annoying than no default.
 */
const HEURISTICS: Record<CanonicalField, RegExp[]> = {
  mdn_last4: [
    /\b(?:mdn|msisdn)\b/i,
    /\bwireless\s*number\b/i,
    /\bmobile\s*(?:number|phone)\b/i,
    /\bphone\s*number\b/i,
    /\bphone\b/i,
  ],
  user_label: [
    /\buser\s*(?:name|description|label)\b/i,
    /\bsubscriber\s*name\b/i,
    /\b(?:line|user)\s*label\b/i,
    /\bemployee\b/i,
    /\bdescription\b/i,
  ],
  device: [
    /\b(?:device|equipment|handset|model)\b/i,
  ],
  plan_name: [
    /\b(?:plan|rate\s*plan)\s*name\b/i,
    /\brate\s*plan\b/i,
    /\bplan\b/i,
  ],
  plan_base_cents: [
    /\b(?:monthly|recurring)\s*(?:plan\s*)?(?:charge|fee|rate)\b/i,
    /\bplan\s*(?:base|cost|charge|fee|rate|amount)\b/i,
    /\bmrc\b/i,
    /\bbase\s*(?:charge|fee|amount)\b/i,
  ],
  data_used_gb: [
    /\bdata\s*(?:used|usage)\b/i,
    /\b(?:gb|mb)\s*used\b/i,
    /\busage\s*\(\s*gb\s*\)/i,
    /\bdata\b/i,
  ],
  voice_used_min: [
    /\b(?:voice|minutes|talk)\s*(?:used|usage)?\b/i,
    /\bmin(?:ute)?s?\s*used\b/i,
  ],
  sms_used_count: [
    /\b(?:sms|text|message)s?\s*(?:used|count|sent)?\b/i,
  ],
  is_suspended: [
    /\bsuspend(?:ed)?\b/i,
    /\bline\s*status\b/i,
    /\bstatus\b/i,
  ],
  account_number_last4: [
    /\b(?:account|ban|foundation)\s*(?:number|#)?\b/i,
    /\baccount\b/i,
  ],
  account_label: [
    /\baccount\s*(?:name|label|description)\b/i,
    /\bfoundation\s*name\b/i,
  ],
};

/**
 * Pick a default mapping from a list of CSV headers. Each canonical field
 * gets the FIRST matching header (so order in `headers` matters when two
 * columns look equally plausible). A header is never reused across two
 * fields — once consumed, it's removed from the candidate pool. This keeps
 * obvious cases sane (e.g. a CSV with both "Plan" and "Plan Name" gives
 * plan_name=Plan Name, not plan_name=Plan).
 */
export function autoMap(headers: ReadonlyArray<string>): ColumnMapping {
  const remaining = new Set<string>(headers);
  const mapping: ColumnMapping = {};
  // Process in a stable order. More-specific fields first so they grab
  // their best-fit header before the looser ones (e.g. account_label
  // before account_number_last4 so "Account Name" doesn't get hijacked).
  const order: CanonicalField[] = [
    'mdn_last4',
    'account_number_last4',
    'account_label',
    'user_label',
    'device',
    'plan_base_cents',
    'plan_name',
    'data_used_gb',
    'voice_used_min',
    'sms_used_count',
    'is_suspended',
  ];
  for (const field of order) {
    const patterns = HEURISTICS[field];
    for (const pat of patterns) {
      const match = findFirstMatch(remaining, pat);
      if (match) {
        mapping[field] = match;
        remaining.delete(match);
        break;
      }
    }
  }
  return mapping;
}

function findFirstMatch(
  pool: ReadonlySet<string>,
  pattern: RegExp,
): string | null {
  for (const candidate of pool) {
    if (pattern.test(candidate.trim())) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Value helpers shared with the parser
// ---------------------------------------------------------------------------

/**
 * Extract the last 4 digits from a free-form phone or account number.
 * Returns `null` if the input has fewer than 4 digit characters.
 *
 * Handles common formats:
 *   "(555) 867-5309"   → "5309"
 *   "+1-555-867-5309"  → "5309"
 *   "5558675309"       → "5309"
 *   "555.867.5309"     → "5309"
 *   "Account # 12345"  → "2345"
 */
export function extractLast4(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const digits = raw.replace(/\D+/g, '');
  if (digits.length < 4) return null;
  return digits.slice(-4);
}

/**
 * Parse a money string into integer cents. Accepts:
 *   "$1,234.56"  →  123_456
 *   "1234.56"    →  123_456
 *   "1,234"      →  123_400
 *   "1234"       →  123_400
 *   "(12.34)"    → -1_234   (accounting negative, sometimes seen on credits)
 *   "-12.34"     →  -1_234
 *   ""           →  null
 *
 * Returns `null` on unparseable input. NEVER throws — the parser collects
 * many cells and a single bad value should drop the cell, not the row.
 */
export function parseMoneyToCents(
  raw: string | null | undefined,
): number | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Accounting-style negatives: "($12.34)" → -1234
  let sign = 1;
  let body = trimmed;
  if (/^\(.*\)$/.test(body)) {
    sign = -1;
    body = body.slice(1, -1).trim();
  }
  // Strip currency symbol and thousands separators.
  body = body.replace(/[$\s,]/g, '');
  if (body.startsWith('-')) {
    sign = sign * -1;
    body = body.slice(1);
  }
  if (body.startsWith('+')) {
    body = body.slice(1);
  }
  if (body.length === 0) return null;
  // Must look like a number (optional decimal).
  if (!/^\d+(?:\.\d+)?$/.test(body)) return null;
  const dollars = Number.parseFloat(body);
  if (!Number.isFinite(dollars)) return null;
  // Round to nearest cent and apply sign.
  return Math.round(dollars * 100) * sign;
}

/**
 * Parse a free-form usage cell into a non-negative float of gigabytes.
 * Strips a trailing `GB` / `MB` / `KB` suffix and converts as needed.
 * Returns `null` if the input is blank or unparseable.
 *
 *   "12.5 GB"  → 12.5
 *   "500 MB"   → 0.488...   (500 / 1024)
 *   "1,024"    → 1024       (treated as GB by default)
 */
export function parseGigabytes(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const unitMatch = trimmed.match(/^([\d.,]+)\s*(gb|mb|kb)?\s*$/i);
  if (!unitMatch) return null;
  const numericPart = unitMatch[1];
  const unit = unitMatch[2]?.toLowerCase() ?? 'gb';
  if (typeof numericPart !== 'string') return null;
  const num = Number.parseFloat(numericPart.replace(/,/g, ''));
  if (!Number.isFinite(num) || num < 0) return null;
  if (unit === 'mb') return num / 1024;
  if (unit === 'kb') return num / (1024 * 1024);
  return num;
}

/**
 * Parse a non-negative integer (minutes, message count, etc).
 * Strips commas. Returns `null` if blank or unparseable.
 */
export function parseNonNegInt(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const cleaned = trimmed.replace(/,/g, '');
  if (!/^\d+$/.test(cleaned)) return null;
  const n = Number.parseInt(cleaned, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

const TRUE_VALUES = new Set([
  'true',
  'yes',
  'y',
  '1',
  'suspended',
  'suspend',
  'inactive',
  'disabled',
]);
const FALSE_VALUES = new Set([
  'false',
  'no',
  'n',
  '0',
  'active',
  'enabled',
  '',
]);

/**
 * Parse a boolean-ish cell. Returns `false` for blank / unknown so the
 * schema's `is_suspended.default(false)` lines up with the column semantics
 * (most carriers omit the column entirely on active lines).
 */
export function parseBoolish(raw: string | null | undefined): boolean {
  if (raw === null || raw === undefined) return false;
  const lower = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(lower)) return true;
  if (FALSE_VALUES.has(lower)) return false;
  // Unknown → conservative default. Don't flag arbitrary text as suspended.
  return false;
}
