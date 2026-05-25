/**
 * CSV → ExtractedBill parser.
 *
 * Pure function: takes a CSV string and a column mapping, returns either
 * a parsed `ExtractedBill` or a structured error. NEVER throws on data
 * issues — malformed cells get nulled out, validation issues come back
 * as `{ ok: false, error }`.
 *
 * Design notes:
 *  - Inline RFC 4180 reader. We deliberately avoid `papaparse` / `csv-parse`
 *    per the task brief; a few dozen lines of state-machine code handle
 *    quoted commas + embedded newlines correctly.
 *  - Group rows by `account_number_last4` (extracted via `extractLast4`).
 *    If every row has a blank account-number column, the whole bill is one
 *    account with `account_number_last4: null`.
 *  - Hard cap on cell count (50K cells) to prevent OOM on a hostile input
 *    (e.g. a 10MB CSV with one giant row).
 *  - Always validates through `ExtractedBillSchema` — a successful return
 *    means the result is safe to feed to the rules engine.
 *
 * PII discipline: we never echo cell values in error messages. The error
 * string mentions row counts and column names only.
 */

import {
  ExtractedBillSchema,
  type ExtractedAccount,
  type ExtractedBill,
  type ExtractedLine,
} from '@/extraction/schema';
import { scrubString } from '@/lib/observability/redact';

import {
  extractLast4,
  parseBoolish,
  parseGigabytes,
  parseMoneyToCents,
  parseNonNegInt,
  type ColumnMapping,
} from './mapping';

/** Largest CSV we accept, in cells (rows × columns). Anything above this
 *  early-aborts so a hostile upload can't OOM the worker. */
export const MAX_CELLS = 50_000;

/** Largest single cell (in characters). Carrier CSVs occasionally embed
 *  long free-text notes; 4KB is well above any legitimate plan name. */
export const MAX_CELL_LENGTH = 4_000;

export type CsvParseOk = { ok: true; bill: ExtractedBill };
export type CsvParseErr = { ok: false; error: string };
export type CsvParseResult = CsvParseOk | CsvParseErr;

export type CsvParseOptions = {
  /** Override the billing period in the output. Defaults to "today's month"
   *  if not supplied — useful for tests and for CSVs that don't carry a
   *  period column. */
  billingPeriodStart?: string;
  billingPeriodEnd?: string;
};

export function parseCsvToBill(
  csvText: string,
  mapping: ColumnMapping,
  options: CsvParseOptions = {},
): CsvParseResult {
  // 0. Cheap size guards. A blank file is a legitimate error case; surface
  //    a clean message rather than crashing the schema validator below.
  if (typeof csvText !== 'string' || csvText.trim().length === 0) {
    return { ok: false, error: 'CSV is empty.' };
  }

  // 1. Parse rows. The reader is bounded internally (throws if it would
  //    exceed MAX_CELLS) so we don't need an outer try/catch for OOM, but
  //    a malformed-quote error still needs to land in the error payload.
  let rows: string[][];
  try {
    rows = parseCsvRows(csvText);
  } catch (err) {
    const safe = scrubString(err instanceof Error ? err.message : String(err));
    return { ok: false, error: `Could not parse CSV: ${safe}` };
  }

  if (rows.length < 2) {
    return {
      ok: false,
      error: 'CSV must have a header row and at least one data row.',
    };
  }

  const header = rows[0];
  if (!header || header.length === 0) {
    return { ok: false, error: 'CSV header row is empty.' };
  }

  // Build a header → column-index lookup so each row read is O(1).
  // Header names are matched case-insensitively after trimming — a user
  // who maps to "Wireless Number" should still match "wireless number".
  const headerIndex = new Map<string, number>();
  header.forEach((h, idx) => {
    const key = h.trim().toLowerCase();
    if (key.length > 0 && !headerIndex.has(key)) {
      headerIndex.set(key, idx);
    }
  });

  const dataRows = rows.slice(1).filter((r) => r.some((c) => c.trim().length > 0));
  if (dataRows.length === 0) {
    return { ok: false, error: 'CSV has no non-blank data rows.' };
  }

  // 2. Build per-row `ExtractedLine` plus the row's account grouping key.
  type ParsedRow = {
    accountKey: string | null;
    accountLabel: string | null;
    line: ExtractedLine;
  };
  const parsedRows: ParsedRow[] = [];
  for (const row of dataRows) {
    const getCell = (field: keyof ColumnMapping): string | null => {
      const headerName = mapping[field];
      if (typeof headerName !== 'string' || headerName.length === 0) return null;
      const colIdx = headerIndex.get(headerName.trim().toLowerCase());
      if (typeof colIdx !== 'number') return null;
      const cell = row[colIdx];
      if (typeof cell !== 'string') return null;
      const trimmed = cell.trim();
      return trimmed.length === 0 ? null : trimmed;
    };

    const accountKey = extractLast4(getCell('account_number_last4'));
    const accountLabel = getCell('account_label');
    const line: ExtractedLine = {
      mdn_last4: extractLast4(getCell('mdn_last4')),
      user_label: clampString(getCell('user_label'), 40),
      device: clampString(getCell('device'), 40),
      plan_name: clampString(getCell('plan_name'), 120),
      plan_base_cents: nonNegCentsFromMoney(getCell('plan_base_cents')),
      data_used_gb: parseGigabytes(getCell('data_used_gb')),
      voice_used_min: parseNonNegInt(getCell('voice_used_min')),
      sms_used_count: parseNonNegInt(getCell('sms_used_count')),
      is_suspended: parseBoolish(getCell('is_suspended')),
      features: [],
      credits: [],
      dpp_installments: [],
    };
    parsedRows.push({ accountKey, accountLabel, line });
  }

  // 3. Group into accounts. If every row has a null accountKey, the whole
  //    bill is one account with `account_number_last4: null`.
  const allKeysBlank = parsedRows.every((r) => r.accountKey === null);
  type Bucket = {
    key: string | null;
    label: string | null;
    lines: ExtractedLine[];
  };
  const buckets = new Map<string, Bucket>();
  // Use a sentinel for the null-key case so a Map can still hold it.
  const NULL_KEY = '__null__';
  for (const r of parsedRows) {
    const lookup = allKeysBlank ? NULL_KEY : (r.accountKey ?? NULL_KEY);
    let bucket = buckets.get(lookup);
    if (!bucket) {
      bucket = {
        key: allKeysBlank ? null : r.accountKey,
        label: r.accountLabel,
        lines: [],
      };
      buckets.set(lookup, bucket);
    } else if (bucket.label === null && r.accountLabel !== null) {
      bucket.label = r.accountLabel;
    }
    bucket.lines.push(r.line);
  }

  // 4. Build `ExtractedAccount` entries with summed plan_base_cents totals.
  //    Rules expect `total_charges_cents` per-account; we use the sum of
  //    line plan_base_cents (nulls treated as 0) as the best-effort total
  //    when no explicit account-total column was mapped.
  const accounts: ExtractedAccount[] = [];
  let billTotal = 0;
  for (const bucket of buckets.values()) {
    const accountTotal = bucket.lines.reduce<number>(
      (sum, l) => sum + (l.plan_base_cents ?? 0),
      0,
    );
    billTotal += accountTotal;
    const account: ExtractedAccount = {
      account_number_last4: bucket.key,
      label: clampString(bucket.label, 40),
      total_charges_cents: clampNonNegInt(accountTotal, 100_000_000),
      taxes_fees_cents: null,
      account_level_credits: [],
      lines: bucket.lines,
    };
    accounts.push(account);
  }

  // 5. Build the top-level bill and validate. The schema's `min(1)` on
  //    accounts is guaranteed by the dataRows-nonempty check above, but
  //    we still run validation so a downstream consumer never sees an
  //    invalid bill — and so the rest of the pipeline trusts the result.
  const today = new Date();
  const start = options.billingPeriodStart ?? firstOfMonth(today);
  const end = options.billingPeriodEnd ?? lastOfMonth(today);

  const draft: unknown = {
    carrier: 'unknown',
    billing_period_start: start,
    billing_period_end: end,
    total_charges_cents: clampNonNegInt(billTotal, 1_000_000_000),
    accounts,
    notes: ['Imported from CSV.'],
    confidence: 'low',
  };

  const parsed = ExtractedBillSchema.safeParse(draft);
  if (!parsed.success) {
    const summary = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    return {
      ok: false,
      error: `CSV did not produce a valid bill: ${summary}`,
    };
  }
  return { ok: true, bill: parsed.data };
}

// ---------------------------------------------------------------------------
// RFC 4180 reader (inline, dependency-free)
// ---------------------------------------------------------------------------

/**
 * Parse a CSV string into rows of cells. Honors quoted cells, embedded
 * newlines inside quotes, and escaped double-quotes (`""` → `"`). CRLF or
 * LF row terminators both work. Strips a UTF-8 BOM if present.
 *
 * Bounded by `MAX_CELLS` total cells and `MAX_CELL_LENGTH` per cell — both
 * limits throw a generic error when exceeded so the caller can surface a
 * PII-free message.
 */
export function parseCsvRows(input: string): string[][] {
  // Strip BOM.
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let cellCount = 0;

  const pushCell = (): void => {
    if (cell.length > MAX_CELL_LENGTH) {
      throw new Error(
        `cell exceeds maximum length of ${MAX_CELL_LENGTH} characters`,
      );
    }
    row.push(cell);
    cell = '';
    cellCount += 1;
    if (cellCount > MAX_CELLS) {
      throw new Error(
        `CSV exceeds maximum cell count of ${MAX_CELLS}`,
      );
    }
  };
  const pushRow = (): void => {
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (typeof ch !== 'string') continue;
    if (inQuotes) {
      if (ch === '"') {
        const next = text[i + 1];
        if (next === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      // Per RFC 4180 quotes only legally appear at the START of a cell.
      // Be permissive: if we see a quote mid-cell, enter quoted mode.
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      pushCell();
      continue;
    }
    if (ch === '\r') {
      // Handle CRLF — swallow the LF.
      pushCell();
      pushRow();
      const next = text[i + 1];
      if (next === '\n') i += 1;
      continue;
    }
    if (ch === '\n') {
      pushCell();
      pushRow();
      continue;
    }
    cell += ch;
  }

  // Flush the last cell + row if the file didn't end with a newline.
  // Edge case: a trailing newline produces an empty final row which we
  // don't want to keep — skip it.
  if (cell.length > 0 || row.length > 0) {
    pushCell();
    pushRow();
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Tiny utilities
// ---------------------------------------------------------------------------

function clampString(value: string | null, max: number): string | null {
  if (value === null) return null;
  return value.length > max ? value.slice(0, max) : value;
}

function clampNonNegInt(value: number, max: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  const intVal = Math.round(value);
  return intVal > max ? max : intVal;
}

/**
 * Parse money cell but clamp to non-negative cents for `plan_base_cents`.
 * Negative values (rare on plan-base columns) are dropped to null so the
 * `nonnegative()` constraint in the schema doesn't reject the whole bill.
 */
function nonNegCentsFromMoney(raw: string | null | undefined): number | null {
  const c = parseMoneyToCents(raw);
  if (c === null) return null;
  if (c < 0) return null;
  // Cap at the schema's plan_base_cents max (10M cents = $100k/mo).
  return Math.min(c, 10_000_000);
}

function firstOfMonth(d: Date): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
}

function lastOfMonth(d: Date): string {
  // The 0th day of next month == last day of current month.
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))
    .toISOString()
    .slice(0, 10);
}
