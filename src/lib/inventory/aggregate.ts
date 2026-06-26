/**
 * Wireless Inventory aggregator.
 *
 * Takes raw bill_line rows joined with their owning bill_account and parent
 * audit and rolls them up by `(account_last4, mdn_last4)` so that a wireless
 * line that appears on N completed audits aggregates to ONE inventory row.
 *
 * Pure / side-effect free / fully unit-testable. Pass in a deterministic
 * `today` only if a test needs to assert ordering — the aggregator itself
 * doesn't read the clock.
 *
 * PII discipline: this module only ever sees already-masked MDNs (last 4)
 * and last-4 account numbers from the DB. It MUST NOT log raw values; it
 * also MUST NOT widen the surface area (no full phone numbers, no labels
 * with potential PII bubbled through aggregation logic).
 */
export type DeviceType = 'phone' | 'tablet' | 'watch' | 'hotspot' | 'router' | 'other';

/**
 * Status of a line on the most-recent audit it appears on.
 * "unknown" is reserved for lines we genuinely cannot classify (no boolean
 * present). We treat null/undefined `is_suspended` as `active` to match the
 * dominant case — most carriers only emit the flag when true.
 */
export type LineStatus = 'active' | 'suspended';

/** Raw line shape coming back from the DB query. */
export interface InventoryLineInput {
  /** UUID of the parent audit (used only for de-duping audits in rollup). */
  audit_id: string;
  /** Last-4 masked account number from bill_accounts. May be null. */
  account_number_masked: string | null;
  /** Last-4 masked MDN. May be null if extractor failed to find one. */
  mdn_masked: string | null;
  /** Free-text device description from the bill. May be null. */
  device_description: string | null;
  /** Free-text plan name. May be null. */
  plan_name: string | null;
  /** Plan base in signed integer cents. May be null. */
  plan_base_cents: number | null;
  /** Suspension flag from the line row. Null/undef treated as active. */
  is_suspended: boolean | null;
  /** Parent audit's carrier slug. May be null on legacy rows. */
  carrier: string | null;
  /** Parent audit's billing period end (ISO date). May be null. */
  billing_period_end: string | null;
  /** Parent audit's completed_at (ISO timestamp). Used as recency tiebreak. */
  completed_at: string | null;
}

/** Rolled-up inventory row keyed by (account_last4, mdn_last4). */
export interface InventoryRow {
  /** URL-safe stable key: `{account_last4}/{mdn_last4}` (or sentinels). */
  lineKey: string;
  accountLast4: string;
  mdnLast4: string;
  /** Most-recent device description seen (across audits). */
  device: string | null;
  /** Most-recent plan name seen. */
  planName: string | null;
  /** Plan base from the most recent audit this line appeared on. */
  planBaseCents: number | null;
  /** Carrier from the most recent audit. */
  carrier: string | null;
  /** Most-recent billing_period_end (ISO date) — display as "last seen". */
  lastSeen: string | null;
  /** Status as of the most recent audit. */
  status: LineStatus;
  /** Number of distinct audits this line appeared on. */
  auditCount: number;
  /** Heuristic device classification. */
  deviceType: DeviceType;
}

/** History entry used by the per-line drill-down page. */
export interface InventoryHistoryEntry {
  auditId: string;
  billingPeriodEnd: string | null;
  completedAt: string | null;
  planName: string | null;
  planBaseCents: number | null;
  device: string | null;
  carrier: string | null;
  status: LineStatus;
}

const NO_ACCOUNT_SENTINEL = 'no-account';
const NO_MDN_SENTINEL = 'no-mdn';

// Device classification heuristics. Order matters: more specific patterns
// (watch, hotspot, router, tablet) must come BEFORE the catch-all phone
// pattern. Patterns are case-insensitive and word-boundaried where it makes
// sense to avoid false positives (e.g. "Pad" inside "Padfone").
const WATCH_REGEX = /\b(apple\s*watch|watch\s*ultra|galaxy\s*watch|gizmo\s*watch|smartwatch)\b/i;
const HOTSPOT_REGEX = /\b(jetpack|mifi|inseego|hotspot|mobile\s*hotspot|orbic\s*speed)\b/i;
const ROUTER_REGEX =
  /\b(cradlepoint|netgear\s*nighthawk\s*m|5g\s*router|lte\s*router|gateway|fwa)\b/i;
const TABLET_REGEX = /\b(ipad|galaxy\s*tab|tablet|surface\s*pro)\b/i;
const PHONE_REGEX =
  /\b(iphone|pixel|galaxy(?:\s*s|\s*note|\s*z|\s*a)?\d?|moto|oneplus|smartphone|phone)\b/i;

/**
 * Classify a free-text device description into one of the supported types.
 * Returns 'other' for anything we can't confidently bucket — UI should treat
 * 'other' as "unclassified" and let the filter expose it explicitly.
 */
export function classifyDevice(description: string | null | undefined): DeviceType {
  if (!description) return 'other';
  const text = description.toLowerCase();
  if (WATCH_REGEX.test(text)) return 'watch';
  if (HOTSPOT_REGEX.test(text)) return 'hotspot';
  if (ROUTER_REGEX.test(text)) return 'router';
  if (TABLET_REGEX.test(text)) return 'tablet';
  if (PHONE_REGEX.test(text)) return 'phone';
  return 'other';
}

/**
 * Build a URL-safe rollup key from masked account + MDN. Both sides are
 * already last-4 so we don't need to truncate. Sentinels stand in for nulls
 * so distinct null-bearing lines don't all collapse into one row.
 */
export function buildLineKey(
  accountMasked: string | null | undefined,
  mdnMasked: string | null | undefined,
): string {
  const acct = accountMasked && accountMasked.length > 0 ? accountMasked : NO_ACCOUNT_SENTINEL;
  const mdn = mdnMasked && mdnMasked.length > 0 ? mdnMasked : NO_MDN_SENTINEL;
  return `${acct}/${mdn}`;
}

/** Parse the URL `lineKey` segment back into its account/mdn components. */
export function parseLineKey(lineKey: string): { accountLast4: string; mdnLast4: string } | null {
  const idx = lineKey.indexOf('/');
  if (idx <= 0 || idx === lineKey.length - 1) return null;
  const accountLast4 = lineKey.slice(0, idx);
  const mdnLast4 = lineKey.slice(idx + 1);
  return { accountLast4, mdnLast4 };
}

/**
 * Recency comparator: prefer billing_period_end (DESC), break ties on
 * completed_at (DESC). Null dates sort last. Returns negative if `a` is more
 * recent than `b`, i.e. the natural Array#sort order to put most-recent first.
 */
function compareRecency(a: InventoryLineInput, b: InventoryLineInput): number {
  const aEnd = a.billing_period_end ? Date.parse(a.billing_period_end) : NaN;
  const bEnd = b.billing_period_end ? Date.parse(b.billing_period_end) : NaN;
  const aEndOk = !Number.isNaN(aEnd);
  const bEndOk = !Number.isNaN(bEnd);
  if (aEndOk && bEndOk && aEnd !== bEnd) return bEnd - aEnd;
  if (aEndOk && !bEndOk) return -1;
  if (!aEndOk && bEndOk) return 1;
  const aDone = a.completed_at ? Date.parse(a.completed_at) : NaN;
  const bDone = b.completed_at ? Date.parse(b.completed_at) : NaN;
  const aDoneOk = !Number.isNaN(aDone);
  const bDoneOk = !Number.isNaN(bDone);
  if (aDoneOk && bDoneOk) return bDone - aDone;
  if (aDoneOk && !bDoneOk) return -1;
  if (!aDoneOk && bDoneOk) return 1;
  return 0;
}

function statusFor(line: InventoryLineInput): LineStatus {
  return line.is_suspended === true ? 'suspended' : 'active';
}

/**
 * Roll raw bill_line rows up into one InventoryRow per (account_last4,
 * mdn_last4) tuple. Stable across re-runs given the same input set.
 */
export function aggregateInventory(lines: ReadonlyArray<InventoryLineInput>): InventoryRow[] {
  const groups = new Map<string, InventoryLineInput[]>();
  for (const line of lines) {
    const key = buildLineKey(line.account_number_masked, line.mdn_masked);
    const existing = groups.get(key);
    if (existing) {
      existing.push(line);
    } else {
      groups.set(key, [line]);
    }
  }

  const rows: InventoryRow[] = [];
  for (const [lineKey, members] of groups) {
    // Most-recent first.
    members.sort(compareRecency);
    const head = members[0];
    if (!head) continue; // Defensive; groups always have >=1 by construction.

    // Distinct audits — a line might appear twice on the same audit (multi
    // shared-data pool quirk); we count audits, not rows.
    const auditIds = new Set<string>();
    for (const m of members) auditIds.add(m.audit_id);

    const parsed = parseLineKey(lineKey);
    const accountLast4 = parsed?.accountLast4 ?? NO_ACCOUNT_SENTINEL;
    const mdnLast4 = parsed?.mdnLast4 ?? NO_MDN_SENTINEL;

    rows.push({
      lineKey,
      accountLast4,
      mdnLast4,
      device: head.device_description,
      planName: head.plan_name,
      planBaseCents: head.plan_base_cents,
      carrier: head.carrier,
      lastSeen: head.billing_period_end,
      status: statusFor(head),
      auditCount: auditIds.size,
      deviceType: classifyDevice(head.device_description),
    });
  }

  // Default sort: most-recently-seen first, then by mdn for stability.
  rows.sort((a, b) => {
    const aT = a.lastSeen ? Date.parse(a.lastSeen) : NaN;
    const bT = b.lastSeen ? Date.parse(b.lastSeen) : NaN;
    const aOk = !Number.isNaN(aT);
    const bOk = !Number.isNaN(bT);
    if (aOk && bOk && aT !== bT) return bT - aT;
    if (aOk && !bOk) return -1;
    if (!aOk && bOk) return 1;
    return a.lineKey.localeCompare(b.lineKey);
  });

  return rows;
}

/**
 * Aggregate counts for the top stat tiles on /inventory.
 */
export interface InventoryStats {
  totalLines: number;
  active: number;
  suspended: number;
  uniqueDevices: number;
}

export function summarizeInventory(rows: ReadonlyArray<InventoryRow>): InventoryStats {
  let active = 0;
  let suspended = 0;
  const devices = new Set<string>();
  for (const r of rows) {
    if (r.status === 'active') active += 1;
    else suspended += 1;
    if (r.device && r.device.trim().length > 0) {
      devices.add(r.device.trim().toLowerCase());
    }
  }
  return {
    totalLines: rows.length,
    active,
    suspended,
    uniqueDevices: devices.size,
  };
}

/**
 * Per-line history rows for the drill-down view, sorted most-recent first.
 */
export function lineHistory(lines: ReadonlyArray<InventoryLineInput>): InventoryHistoryEntry[] {
  const sorted = [...lines].sort(compareRecency);
  return sorted.map((line) => ({
    auditId: line.audit_id,
    billingPeriodEnd: line.billing_period_end,
    completedAt: line.completed_at,
    planName: line.plan_name,
    planBaseCents: line.plan_base_cents,
    device: line.device_description,
    carrier: line.carrier,
    status: statusFor(line),
  }));
}

export const __inventoryInternals = {
  NO_ACCOUNT_SENTINEL,
  NO_MDN_SENTINEL,
} as const;
