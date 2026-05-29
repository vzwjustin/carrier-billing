/**
 * Calendar-date formatting for ISO date strings stored in Postgres `date`
 * columns (billing periods). Date-only values like `2026-04-01` must not be
 * parsed with `new Date(iso)` — that treats them as UTC midnight and shifts
 * back a day when formatted in US local time.
 */

const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function formatIsoDateDisplay(value: string | null | undefined): string {
  if (!value) return '—';
  if (ISO_DATE_ONLY.test(value)) {
    const parts = value.split('-').map(Number);
    const y = parts[0]!;
    const m = parts[1]!;
    const day = parts[2]!;
    const dt = new Date(Date.UTC(y, m - 1, day));
    return dt.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function formatIsoDatePeriod(
  start: string | null,
  end: string | null,
): string {
  if (!start && !end) return '—';
  return `${formatIsoDateDisplay(start)} – ${formatIsoDateDisplay(end)}`;
}

/** ISO date (`2026-05-25`) from a `Date` in UTC — stable across server TZ. */
export function formatUtcYyyyMmDd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
