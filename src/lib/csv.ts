/**
 * Minimal RFC 4180–compliant CSV helpers.
 *
 * Quotes a value when it contains a comma, double-quote, CR, LF, or leading/
 * trailing whitespace. Inside a quoted value, embedded double-quotes are
 * escaped by doubling. CRLF is used as the row terminator (per RFC 4180) so
 * Excel on Windows opens the output without prompting.
 *
 * Cell guard against CSV injection: a leading `=`, `+`, `-`, `@`, tab, or CR
 * is prefixed with a single apostrophe so spreadsheet apps treat the cell as
 * text rather than a formula. The apostrophe is stripped by Excel on display.
 * Numbers and booleans bypass the guard (the prefix would corrupt them) and
 * are stringified via `String(value)`.
 */
const FORMULA_PREFIX_RE = /^[=+\-@\t\r]/;
const NEEDS_QUOTING_RE = /[",\r\n]|^\s|\s$/;

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  let s = typeof value === 'string' ? value : JSON.stringify(value);
  if (FORMULA_PREFIX_RE.test(s)) {
    s = `'${s}`;
  }
  if (NEEDS_QUOTING_RE.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function csvRow(cells: ReadonlyArray<unknown>): string {
  return cells.map(csvCell).join(',');
}

export function toCsv(
  header: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
): string {
  const lines = [csvRow(header), ...rows.map(csvRow)];
  return lines.join('\r\n');
}
