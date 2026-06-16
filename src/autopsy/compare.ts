/**
 * Bill Increase Autopsy — comparison engine.
 *
 * Pure transformation: (previous: ExtractedBill, current: ExtractedBill)
 *   → AutopsyResult.
 *
 * No I/O. No `new Date()`. No env reads. Safe to unit-test directly and
 * safe to call from either the API route or a future Inngest worker.
 *
 * Matching strategy:
 *   1. Accounts are matched by `account_number_last4`. If both bills have
 *      only one account each with null last4, we match them positionally.
 *   2. Lines within a matched account are matched by `mdn_last4`. Lines
 *      whose `mdn_last4` is null are matched positionally against the
 *      remaining unmatched lines — extraction occasionally drops MDNs.
 *   3. For each matched line we diff plan base, credits (by name), DPP
 *      installments (by device name), and features (by name).
 *
 * Categorization follows the SignalAudit spec's "Bill Increase Autopsy
 * rules" verbatim. When we can't confidently classify a residual the
 * difference goes into `unexplained` rather than being attributed.
 *
 * NEVER invent a cause. The engine reports residuals (account total minus
 * sum of line-level differences, and bill total minus sum of all driver
 * differences) as explicit `unexplained` drivers so the operator sees the
 * gap rather than a false attribution.
 */

import type {
  ExtractedAccount,
  ExtractedBill,
  ExtractedCredit,
  ExtractedFeature,
  ExtractedLine,
} from '@/extraction/schema';
import { sanitizeUserLabel } from '@/extraction/schema';

import type { AutopsyResult, ChangeCategory, ChangeDriver, ChangeDriverEvidence } from './types';

const ENGINE_VERSION = 'autopsy-v1';

// ──────────────────────────────────────────────────────────────────────────
// Matching helpers
// ──────────────────────────────────────────────────────────────────────────

interface AccountPair {
  previous: ExtractedAccount | null;
  current: ExtractedAccount | null;
}

interface LinePair {
  account_last4: string | null;
  previous: ExtractedLine | null;
  current: ExtractedLine | null;
}

function matchAccounts(previous: ExtractedBill, current: ExtractedBill): AccountPair[] {
  const pairs: AccountPair[] = [];
  const prevByLast4 = new Map<string, ExtractedAccount>();
  const prevUnkeyed: ExtractedAccount[] = [];

  for (const acc of previous.accounts) {
    if (acc.account_number_last4) {
      prevByLast4.set(acc.account_number_last4, acc);
    } else {
      prevUnkeyed.push(acc);
    }
  }

  const usedUnkeyed = new Set<number>();
  let unkeyedIndex = 0;

  for (const acc of current.accounts) {
    if (acc.account_number_last4 && prevByLast4.has(acc.account_number_last4)) {
      pairs.push({
        previous: prevByLast4.get(acc.account_number_last4)!,
        current: acc,
      });
      prevByLast4.delete(acc.account_number_last4);
    } else if (acc.account_number_last4) {
      pairs.push({ previous: null, current: acc });
    } else if (unkeyedIndex < prevUnkeyed.length) {
      pairs.push({ previous: prevUnkeyed[unkeyedIndex] ?? null, current: acc });
      usedUnkeyed.add(unkeyedIndex);
      unkeyedIndex += 1;
    } else {
      pairs.push({ previous: null, current: acc });
    }
  }

  // Previous-only accounts (removed entirely)
  for (const acc of prevByLast4.values()) {
    pairs.push({ previous: acc, current: null });
  }
  for (let i = unkeyedIndex; i < prevUnkeyed.length; i += 1) {
    pairs.push({ previous: prevUnkeyed[i] ?? null, current: null });
  }

  return pairs;
}

function matchLinesWithinAccount(pair: AccountPair): LinePair[] {
  const last4 = pair.current?.account_number_last4 ?? pair.previous?.account_number_last4 ?? null;
  const out: LinePair[] = [];

  const prevByMdn = new Map<string, ExtractedLine>();
  const prevUnkeyed: ExtractedLine[] = [];

  for (const line of pair.previous?.lines ?? []) {
    if (line.mdn_last4) prevByMdn.set(line.mdn_last4, line);
    else prevUnkeyed.push(line);
  }

  let unkeyedIndex = 0;
  for (const line of pair.current?.lines ?? []) {
    if (line.mdn_last4 && prevByMdn.has(line.mdn_last4)) {
      out.push({
        account_last4: last4,
        previous: prevByMdn.get(line.mdn_last4)!,
        current: line,
      });
      prevByMdn.delete(line.mdn_last4);
    } else if (line.mdn_last4) {
      out.push({ account_last4: last4, previous: null, current: line });
    } else if (unkeyedIndex < prevUnkeyed.length) {
      out.push({
        account_last4: last4,
        previous: prevUnkeyed[unkeyedIndex] ?? null,
        current: line,
      });
      unkeyedIndex += 1;
    } else {
      out.push({ account_last4: last4, previous: null, current: line });
    }
  }

  // Previous-only lines (removed)
  for (const line of prevByMdn.values()) {
    out.push({ account_last4: last4, previous: line, current: null });
  }
  for (let i = unkeyedIndex; i < prevUnkeyed.length; i += 1) {
    out.push({ account_last4: last4, previous: prevUnkeyed[i] ?? null, current: null });
  }

  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Per-line numerics
// ──────────────────────────────────────────────────────────────────────────

function sumFeatures(line: ExtractedLine | null): number {
  if (!line) return 0;
  return line.features.reduce((s, f) => s + f.monthly_cents, 0);
}

function sumCredits(line: ExtractedLine | null): number {
  if (!line) return 0;
  // Credits are signed-negative in the schema; we sum them as-is.
  return line.credits.reduce((s, c) => s + c.monthly_cents, 0);
}

function sumDpp(line: ExtractedLine | null): number {
  if (!line) return 0;
  return line.dpp_installments.reduce((s, d) => s + d.monthly_cents, 0);
}

function planBase(line: ExtractedLine | null): number {
  if (!line) return 0;
  return line.plan_base_cents ?? 0;
}

// ──────────────────────────────────────────────────────────────────────────
// Feature-name classification
// ──────────────────────────────────────────────────────────────────────────

const INSURANCE_RE = /\b(insurance|protect|wpp|asurion|verizon\s*protect)\b/i;
const INTERNATIONAL_RE = /\binternational|travel(?:pass)?|globe|world\b/i;
const ROAMING_RE = /\broaming\b/i;
const OVERAGE_RE = /\bovera?ge|excess\s*usage\b/i;
const ACTIVATION_RE = /\b(activation|upgrade)\s*fee\b/i;

function featureClass(name: string): ChangeCategory | null {
  if (INSURANCE_RE.test(name)) return 'insurance_changes';
  if (INTERNATIONAL_RE.test(name)) return 'international_charges';
  if (ROAMING_RE.test(name)) return 'roaming_charges';
  if (OVERAGE_RE.test(name)) return 'overage_charges';
  if (ACTIVATION_RE.test(name)) return 'activation_fees';
  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// Driver accumulation
// ──────────────────────────────────────────────────────────────────────────

interface DriverAccumulator {
  category: ChangeCategory;
  previous_cents: number;
  current_cents: number;
  affected_lines: Set<string>;
  lines: NonNullable<ChangeDriverEvidence['lines']>;
  accounts: NonNullable<ChangeDriverEvidence['accounts']>;
  notes: string[];
}

function makeAcc(category: ChangeCategory): DriverAccumulator {
  return {
    category,
    previous_cents: 0,
    current_cents: 0,
    affected_lines: new Set(),
    lines: [],
    accounts: [],
    notes: [],
  };
}

function lineKey(account_last4: string | null, mdn_last4: string | null): string {
  return `${account_last4 ?? '∅'}/${mdn_last4 ?? '∅'}`;
}

function recordLine(
  acc: DriverAccumulator,
  account_last4: string | null,
  line: ExtractedLine | null,
  other: ExtractedLine | null,
  previous_cents: number,
  current_cents: number,
  note?: string,
): void {
  const mdn = line?.mdn_last4 ?? other?.mdn_last4 ?? null;
  acc.affected_lines.add(lineKey(account_last4, mdn));
  acc.previous_cents += previous_cents;
  acc.current_cents += current_cents;
  acc.lines.push({
    account_last4,
    mdn_last4: mdn,
    user_label: sanitizeUserLabel(line?.user_label ?? other?.user_label ?? null),
    previous_cents,
    current_cents,
    difference_cents: current_cents - previous_cents,
    ...(note ? { note } : {}),
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Categorization
// ──────────────────────────────────────────────────────────────────────────

interface DriverCtx {
  byCategory: Map<ChangeCategory, DriverAccumulator>;
}

function getAcc(ctx: DriverCtx, category: ChangeCategory): DriverAccumulator {
  let acc = ctx.byCategory.get(category);
  if (!acc) {
    acc = makeAcc(category);
    ctx.byCategory.set(category, acc);
  }
  return acc;
}

function diffPlanAndDpp(ctx: DriverCtx, pair: LinePair): void {
  const prevPlan = planBase(pair.previous);
  const currPlan = planBase(pair.current);
  if (prevPlan !== currPlan && pair.previous && pair.current) {
    recordLine(
      getAcc(ctx, 'plan_changes'),
      pair.account_last4,
      pair.current,
      pair.previous,
      prevPlan,
      currPlan,
      planChangeNote(pair.previous, pair.current),
    );
  }

  const prevDpp = sumDpp(pair.previous);
  const currDpp = sumDpp(pair.current);
  if (currDpp > prevDpp) {
    recordLine(
      getAcc(ctx, 'device_installments_added'),
      pair.account_last4,
      pair.current,
      pair.previous,
      prevDpp,
      currDpp,
      dppDeltaNote(pair.previous, pair.current),
    );
  } else if (currDpp < prevDpp) {
    recordLine(
      getAcc(ctx, 'device_installments_removed'),
      pair.account_last4,
      pair.previous,
      pair.current,
      prevDpp,
      currDpp,
      dppDeltaNote(pair.previous, pair.current),
    );
  }
}

function planChangeNote(prev: ExtractedLine, curr: ExtractedLine): string {
  const prevName = prev.plan_name ?? 'unknown plan';
  const currName = curr.plan_name ?? 'unknown plan';
  if (prevName !== currName) return `Plan changed: ${prevName} → ${currName}`;
  return 'Plan base charge changed (same plan name)';
}

function dppDeltaNote(prev: ExtractedLine | null, curr: ExtractedLine | null): string {
  const prevDevices = new Set((prev?.dpp_installments ?? []).map((d) => d.device));
  const currDevices = new Set((curr?.dpp_installments ?? []).map((d) => d.device));

  const added: string[] = [];
  for (const d of currDevices) {
    if (!prevDevices.has(d)) added.push(d);
  }

  const removed: string[] = [];
  for (const d of prevDevices) {
    if (!currDevices.has(d)) removed.push(d);
  }

  if (added.length && removed.length) {
    return `Devices changed: removed ${removed.join(', ')}, added ${added.join(', ')}`;
  }
  if (added.length) return `New device installment: ${added.join(', ')}`;
  if (removed.length) return `Device installment ended: ${removed.join(', ')}`;
  return 'Installment amount changed';
}

function diffCredits(ctx: DriverCtx, pair: LinePair): void {
  const prevCredits = new Map<string, ExtractedCredit>();
  for (const c of pair.previous?.credits ?? []) prevCredits.set(c.name, c);
  const currCredits = new Map<string, ExtractedCredit>();
  for (const c of pair.current?.credits ?? []) currCredits.set(c.name, c);

  const names = new Set([...prevCredits.keys(), ...currCredits.keys()]);
  for (const name of names) {
    const prev = prevCredits.get(name);
    const curr = currCredits.get(name);
    const prevAmt = prev?.monthly_cents ?? 0;
    const currAmt = curr?.monthly_cents ?? 0;
    if (prev && !curr) {
      // Credit disappeared. Negative cents went from -X to 0 → bill goes UP by |X|.
      recordLine(
        getAcc(ctx, 'missing_credits'),
        pair.account_last4,
        pair.current,
        pair.previous,
        prevAmt,
        0,
        `Promo credit "${name}" (${formatCentsSigned(prevAmt)}/mo) is no longer on the bill`,
      );
    } else if (!prev && curr) {
      recordLine(
        getAcc(ctx, 'new_credits'),
        pair.account_last4,
        pair.current,
        pair.previous,
        0,
        currAmt,
        `New promo credit "${name}" (${formatCentsSigned(currAmt)}/mo) appeared`,
      );
    } else if (prev && curr && prevAmt !== currAmt) {
      // Both present, amount changed. Credits are negative; "smaller" credit
      // (closer to 0) means the bill went up.
      if (currAmt > prevAmt) {
        recordLine(
          getAcc(ctx, 'credits_decreased'),
          pair.account_last4,
          pair.current,
          pair.previous,
          prevAmt,
          currAmt,
          `Credit "${name}" shrank from ${formatCentsSigned(prevAmt)} to ${formatCentsSigned(currAmt)}`,
        );
      } else {
        recordLine(
          getAcc(ctx, 'credits_increased'),
          pair.account_last4,
          pair.current,
          pair.previous,
          prevAmt,
          currAmt,
          `Credit "${name}" grew from ${formatCentsSigned(prevAmt)} to ${formatCentsSigned(currAmt)}`,
        );
      }
    }
  }
}

function diffFeatures(ctx: DriverCtx, pair: LinePair): void {
  // Aggregate features by name then categorize.
  const prevFeatures = new Map<string, ExtractedFeature>();
  for (const f of pair.previous?.features ?? []) prevFeatures.set(f.name, f);
  const currFeatures = new Map<string, ExtractedFeature>();
  for (const f of pair.current?.features ?? []) currFeatures.set(f.name, f);

  const names = new Set([...prevFeatures.keys(), ...currFeatures.keys()]);
  for (const name of names) {
    const prev = prevFeatures.get(name);
    const curr = currFeatures.get(name);
    const prevAmt = prev?.monthly_cents ?? 0;
    const currAmt = curr?.monthly_cents ?? 0;
    if (prevAmt === currAmt) continue;

    const klass = featureClass(name) ?? 'feature_addon_changes';
    const note = describeFeatureChange(name, prev, curr);
    recordLine(
      getAcc(ctx, klass),
      pair.account_last4,
      pair.current,
      pair.previous,
      prevAmt,
      currAmt,
      note,
    );
  }
}

function describeFeatureChange(
  name: string,
  prev: ExtractedFeature | undefined,
  curr: ExtractedFeature | undefined,
): string {
  if (prev && !curr) return `Feature "${name}" removed`;
  if (!prev && curr) return `New feature "${name}"`;
  return `Feature "${name}" amount changed`;
}

// ──────────────────────────────────────────────────────────────────────────
// Bill-level totals: new/removed lines, suspended-still-billed, taxes/fees
// ──────────────────────────────────────────────────────────────────────────

function lineCharge(line: ExtractedLine | null): number {
  if (!line) return 0;
  return planBase(line) + sumFeatures(line) + sumCredits(line) + sumDpp(line);
}

function handleAddedOrRemovedLines(ctx: DriverCtx, pair: LinePair): boolean {
  if (pair.previous && !pair.current) {
    const prevCharge = lineCharge(pair.previous);
    recordLine(
      getAcc(ctx, 'removed_lines'),
      pair.account_last4,
      pair.previous,
      null,
      prevCharge,
      0,
      `Line ${pair.previous.mdn_last4 ? `*${pair.previous.mdn_last4}` : '(no MDN)'} no longer on bill`,
    );
    return true;
  }
  if (!pair.previous && pair.current) {
    const currCharge = lineCharge(pair.current);
    recordLine(
      getAcc(ctx, 'new_lines'),
      pair.account_last4,
      null,
      pair.current,
      0,
      currCharge,
      `New line ${pair.current.mdn_last4 ? `*${pair.current.mdn_last4}` : '(no MDN)'} appeared`,
    );
    return true;
  }
  return false;
}

function handleSuspendedStillBilled(ctx: DriverCtx, pair: LinePair): void {
  // The product spec calls out the case of a line being suspended on the
  // current bill but still carrying a non-zero plan charge as its own
  // bucket in the autopsy (separate from new/removed lines).
  if (!pair.current?.is_suspended) return;
  const currPlan = planBase(pair.current);
  if (currPlan <= 0) return;
  recordLine(
    getAcc(ctx, 'suspended_line_still_billed'),
    pair.account_last4,
    pair.current,
    pair.previous,
    pair.previous?.is_suspended ? planBase(pair.previous) : 0,
    currPlan,
    'Line marked suspended on current bill but still being charged plan fee',
  );
}

function diffTaxesAndFees(ctx: DriverCtx, prevBill: ExtractedBill, currBill: ExtractedBill): void {
  // Account-level taxes/fees delta. Engine note: we record one entry per
  // account so the operator can see WHICH BAN's taxes moved.
  const matched = matchAccounts(prevBill, currBill);
  for (const pair of matched) {
    const prevT = pair.previous?.taxes_fees_cents ?? 0;
    const currT = pair.current?.taxes_fees_cents ?? 0;
    if (prevT === currT) continue;
    const last4 = pair.current?.account_number_last4 ?? pair.previous?.account_number_last4 ?? null;
    const acc = getAcc(ctx, 'taxes_fees_change');
    acc.previous_cents += prevT;
    acc.current_cents += currT;
    acc.accounts.push({
      account_last4: last4,
      previous_cents: prevT,
      current_cents: currT,
      difference_cents: currT - prevT,
    });
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Driver shaping (accumulator → ChangeDriver) — titles, summaries, flags
// ──────────────────────────────────────────────────────────────────────────

interface CategoryShape {
  /** Builds title + summary; receives delta in cents (signed). */
  titleFor(delta: number, lineCount: number, acc: DriverAccumulator): string;
  summaryFor(delta: number, lineCount: number, acc: DriverAccumulator): string;
  recommendedAction: string | null;
  is_disputable: boolean;
  is_optimization: boolean;
  is_unexplained: boolean;
  confidence: number;
}

const SHAPES: Record<ChangeCategory, CategoryShape> = {
  new_lines: {
    titleFor: (d, n) => `${n} new line${n === 1 ? '' : 's'} added`,
    summaryFor: (d, n) =>
      `${n} new wireless line${n === 1 ? '' : 's'} on the current bill added ${formatCentsSigned(d)}/mo.`,
    recommendedAction:
      "Confirm each new line was approved by an authorized requester. If any weren't, ask the carrier to deactivate and credit back.",
    is_disputable: false,
    is_optimization: false,
    is_unexplained: false,
    confidence: 0.9,
  },
  removed_lines: {
    titleFor: (d, n) => `${n} line${n === 1 ? '' : 's'} removed`,
    summaryFor: (d, n) =>
      `${n} line${n === 1 ? '' : 's'} from the previous bill dropped off, lowering the bill by ${formatCentsSigned(d)}/mo.`,
    recommendedAction: null,
    is_disputable: false,
    is_optimization: false,
    is_unexplained: false,
    confidence: 0.95,
  },
  plan_changes: {
    titleFor: (d, n) => `${n} line${n === 1 ? '' : 's'} changed plan (${signedFormatted(d)}/mo)`,
    summaryFor: (d, n) =>
      `${n} line${n === 1 ? '' : 's'} moved to a different plan tier or rate, ${
        d >= 0 ? 'adding' : 'removing'
      } ${formatCentsSigned(Math.abs(d))}/mo.`,
    recommendedAction:
      'Verify each plan change was intentional and that the new rate matches your contract.',
    is_disputable: false,
    is_optimization: false,
    is_unexplained: false,
    confidence: 0.85,
  },
  device_installments_added: {
    titleFor: (d, n) =>
      `New device installments on ${n} line${n === 1 ? '' : 's'} (+${formatCentsSigned(d)}/mo)`,
    summaryFor: (d, n) =>
      `${n} line${n === 1 ? '' : 's'} started a new device payment agreement this cycle, adding ${formatCentsSigned(d)}/mo.`,
    recommendedAction:
      'Confirm each new device installment maps to an approved equipment order and includes any promo trade-in credits negotiated up front.',
    is_disputable: false,
    is_optimization: false,
    is_unexplained: false,
    confidence: 0.9,
  },
  device_installments_removed: {
    titleFor: (d, n) =>
      `Device installments ended on ${n} line${n === 1 ? '' : 's'} (${formatCentsSigned(d)}/mo)`,
    summaryFor: (d, n) =>
      `${n} line${n === 1 ? '' : 's'} finished paying off devices this cycle, lowering the bill by ${formatCentsSigned(Math.abs(d))}/mo.`,
    recommendedAction: null,
    is_disputable: false,
    is_optimization: false,
    is_unexplained: false,
    confidence: 0.95,
  },
  missing_credits: {
    titleFor: (d, n) =>
      `${n} line${n === 1 ? '' : 's'} lost a recurring credit (+${formatCentsSigned(d)}/mo)`,
    summaryFor: (d, n) =>
      `${n} line${n === 1 ? '' : 's'} had a promotional credit drop off this cycle without a matching device payoff, disconnect, or plan change, adding ${formatCentsSigned(d)}/mo to the bill. This is the most common disputable pattern.`,
    recommendedAction:
      'Open a carrier dispute requesting restoration of the credit going forward and a back-credit for the current cycle.',
    is_disputable: true,
    is_optimization: false,
    is_unexplained: false,
    confidence: 0.85,
  },
  new_credits: {
    titleFor: (d, n) =>
      `${n} line${n === 1 ? '' : 's'} gained a new credit (${formatCentsSigned(d)}/mo)`,
    summaryFor: (d, n) =>
      `${n} line${n === 1 ? '' : 's'} picked up a new recurring credit this cycle, lowering the bill by ${formatCentsSigned(Math.abs(d))}/mo.`,
    recommendedAction: null,
    is_disputable: false,
    is_optimization: false,
    is_unexplained: false,
    confidence: 0.9,
  },
  credits_decreased: {
    titleFor: (d, n) => `${n} credit${n === 1 ? '' : 's'} shrank (+${formatCentsSigned(d)}/mo)`,
    summaryFor: (d, n) =>
      `${n} recurring credit${n === 1 ? '' : 's'} were smaller this cycle than last, adding ${formatCentsSigned(d)}/mo.`,
    recommendedAction:
      'Verify the credit terms in your carrier order or contract. If the reduction is unexplained, dispute for back-credit.',
    is_disputable: true,
    is_optimization: false,
    is_unexplained: false,
    confidence: 0.7,
  },
  credits_increased: {
    titleFor: (d, n) => `${n} credit${n === 1 ? '' : 's'} grew (${formatCentsSigned(d)}/mo)`,
    summaryFor: (d, n) =>
      `${n} recurring credit${n === 1 ? '' : 's'} got larger this cycle, lowering the bill by ${formatCentsSigned(Math.abs(d))}/mo.`,
    recommendedAction: null,
    is_disputable: false,
    is_optimization: false,
    is_unexplained: false,
    confidence: 0.9,
  },
  one_time_charges: {
    titleFor: (d) => `One-time charges (+${formatCentsSigned(d)})`,
    summaryFor: (d) =>
      `One-time charges this cycle totaled ${formatCentsSigned(d)}. Confirm they were authorized.`,
    recommendedAction: 'Cross-check each one-time charge against your approval log.',
    is_disputable: false,
    is_optimization: false,
    is_unexplained: false,
    confidence: 0.7,
  },
  activation_fees: {
    titleFor: (d, n) =>
      `Activation / upgrade fees on ${n} line${n === 1 ? '' : 's'} (+${formatCentsSigned(d)})`,
    summaryFor: (d, n) =>
      `${n} line${n === 1 ? '' : 's'} were billed activation or upgrade fees totaling ${formatCentsSigned(d)}. Some carrier contracts waive these for business accounts.`,
    recommendedAction:
      'Check your contract for an activation-fee waiver. If present, dispute the fees and request a credit.',
    is_disputable: true,
    is_optimization: false,
    is_unexplained: false,
    confidence: 0.7,
  },
  insurance_changes: {
    titleFor: (d, n) =>
      `${n} insurance/protection feature change${n === 1 ? '' : 's'} (${signedFormatted(d)}/mo)`,
    summaryFor: (d, n) =>
      `${n} line${n === 1 ? '' : 's'} had insurance/protection features added, removed, or repriced this cycle (${signedFormatted(d)}/mo).`,
    recommendedAction:
      "Verify each insurance line item — many corporate-owned fleets self-insure and shouldn't carry carrier device protection.",
    is_disputable: false,
    is_optimization: true,
    is_unexplained: false,
    confidence: 0.7,
  },
  international_charges: {
    titleFor: (d, n) =>
      `International features changed on ${n} line${n === 1 ? '' : 's'} (${signedFormatted(d)}/mo)`,
    summaryFor: (d, n) =>
      `${n} line${n === 1 ? '' : 's'} had international add-ons added, removed, or repriced (${signedFormatted(d)}/mo).`,
    recommendedAction:
      'If a TravelPass / international plan was added without a corresponding trip, ask the carrier to remove and back-credit.',
    is_disputable: false,
    is_optimization: true,
    is_unexplained: false,
    confidence: 0.7,
  },
  roaming_charges: {
    titleFor: (d) => `Roaming charges (${signedFormatted(d)})`,
    summaryFor: (d) =>
      `Roaming charges this cycle came to ${formatCentsSigned(Math.abs(d))} more than last cycle.`,
    recommendedAction:
      'For frequent travelers, evaluate a recurring international package — it usually undercuts per-minute roaming after 2–3 cycles.',
    is_disputable: false,
    is_optimization: true,
    is_unexplained: false,
    confidence: 0.75,
  },
  overage_charges: {
    titleFor: (d) => `Overage charges (${signedFormatted(d)})`,
    summaryFor: (d) => `Overage charges grew by ${formatCentsSigned(Math.abs(d))} this cycle.`,
    recommendedAction:
      "Review the affected lines' usage. A plan-tier change or pooled-data plan usually pays back within 1–2 cycles when overages recur.",
    is_disputable: false,
    is_optimization: true,
    is_unexplained: false,
    confidence: 0.8,
  },
  taxes_fees_change: {
    titleFor: (d) => `Taxes, surcharges, and admin fees changed (${signedFormatted(d)})`,
    summaryFor: (d) =>
      `Taxes, surcharges, and regulatory/admin fees ${
        d >= 0 ? 'rose' : 'dropped'
      } by ${formatCentsSigned(Math.abs(d))} this cycle.`,
    recommendedAction:
      'Tax/fee shifts are usually driven by underlying charges. If the change is disproportionate to the base bill change, escalate to your carrier rep.',
    is_disputable: false,
    is_optimization: false,
    is_unexplained: false,
    confidence: 0.8,
  },
  feature_addon_changes: {
    titleFor: (d, n) =>
      `${n} feature/add-on change${n === 1 ? '' : 's'} (${signedFormatted(d)}/mo)`,
    summaryFor: (d, n) =>
      `${n} line${n === 1 ? '' : 's'} had non-protection, non-international features added, removed, or repriced (${signedFormatted(d)}/mo).`,
    recommendedAction:
      'Confirm each add-on is still needed; carrier reps sometimes attach SOCs at activation that the customer never asked for.',
    is_disputable: false,
    is_optimization: true,
    is_unexplained: false,
    confidence: 0.7,
  },
  suspended_line_still_billed: {
    titleFor: (d, n) =>
      `${n} suspended line${n === 1 ? '' : 's'} still being billed (+${formatCentsSigned(d)}/mo)`,
    summaryFor: (d, n) =>
      `${n} line${n === 1 ? '' : 's'} are marked suspended on the current bill but are still being charged a plan fee, totaling ${formatCentsSigned(d)}/mo.`,
    recommendedAction:
      'Dispute the suspended-line plan charges and request the carrier move them to the no-cost / vacation suspension tier.',
    is_disputable: true,
    is_optimization: false,
    is_unexplained: false,
    confidence: 0.95,
  },
  unexplained: {
    titleFor: (d) => `Unexplained change (${signedFormatted(d)})`,
    summaryFor: (d) =>
      `${formatCentsSigned(
        Math.abs(d),
      )} of the bill change could not be categorized confidently. This usually means the prior or current bill is missing detail rows we need to attribute the difference — review the source charge rows below.`,
    recommendedAction:
      'Manually review the unattributed amount. If the bill PDF is missing line-item detail, ask the carrier for a detail-level export and re-run the comparison.',
    is_disputable: false,
    is_optimization: false,
    is_unexplained: true,
    confidence: 0.5,
  },
};

// ──────────────────────────────────────────────────────────────────────────
// Formatting helpers
// ──────────────────────────────────────────────────────────────────────────

function formatCentsSigned(cents: number): string {
  const dollars = (Math.abs(cents) / 100).toFixed(2);
  return `$${dollars}`;
}

function signedFormatted(cents: number): string {
  if (cents >= 0) return `+${formatCentsSigned(cents)}`;
  return `-${formatCentsSigned(Math.abs(cents))}`;
}

function billTotalCents(bill: ExtractedBill): number {
  return bill.total_charges_cents;
}

// ──────────────────────────────────────────────────────────────────────────
// Public entry point
// ──────────────────────────────────────────────────────────────────────────

export function compareBills(previous: ExtractedBill, current: ExtractedBill): AutopsyResult {
  const ctx: DriverCtx = { byCategory: new Map() };

  for (const accountPair of matchAccounts(previous, current)) {
    const linePairs = matchLinesWithinAccount(accountPair);
    for (const pair of linePairs) {
      if (handleAddedOrRemovedLines(ctx, pair)) continue;
      // Both sides present from here on.
      diffPlanAndDpp(ctx, pair);
      diffCredits(ctx, pair);
      diffFeatures(ctx, pair);
      handleSuspendedStillBilled(ctx, pair);
    }
  }
  diffTaxesAndFees(ctx, previous, current);

  const drivers: ChangeDriver[] = [];
  let driversSum = 0;
  for (const [category, acc] of ctx.byCategory) {
    const delta = acc.current_cents - acc.previous_cents;
    if (delta === 0 && category !== 'unexplained') continue;
    const shape = SHAPES[category];
    const evidence: ChangeDriverEvidence = {};
    if (acc.lines.length) evidence.lines = acc.lines;
    if (acc.accounts.length) evidence.accounts = acc.accounts;
    if (acc.notes.length) evidence.notes = acc.notes;
    drivers.push({
      category,
      title: shape.titleFor(delta, acc.affected_lines.size || acc.accounts.length, acc),
      summary: shape.summaryFor(delta, acc.affected_lines.size || acc.accounts.length, acc),
      previous_cents: acc.previous_cents,
      current_cents: acc.current_cents,
      difference_cents: delta,
      affected_lines_count: acc.affected_lines.size,
      confidence: shape.confidence,
      is_disputable: shape.is_disputable,
      is_optimization: shape.is_optimization,
      is_unexplained: shape.is_unexplained,
      recommended_action: shape.recommendedAction,
      evidence,
    });
    driversSum += delta;
  }

  const prevTotal = billTotalCents(previous);
  const currTotal = billTotalCents(current);
  const netChange = currTotal - prevTotal;
  const residual = netChange - driversSum;
  if (residual !== 0) {
    // Emit an explicit unexplained driver carrying the residual rather than
    // attributing it. Spec: NEVER invent a cause.
    const shape = SHAPES.unexplained;
    drivers.push({
      category: 'unexplained',
      title: shape.titleFor(residual, 0, makeAcc('unexplained')),
      summary: shape.summaryFor(residual, 0, makeAcc('unexplained')),
      previous_cents: 0,
      current_cents: 0,
      difference_cents: residual,
      affected_lines_count: 0,
      confidence: shape.confidence,
      is_disputable: false,
      is_optimization: false,
      is_unexplained: true,
      recommended_action: shape.recommendedAction,
      evidence: {
        notes: [
          `Bill total moved by ${signedFormatted(netChange)} but categorized drivers explain only ${signedFormatted(driversSum)}. Residual = ${signedFormatted(residual)}.`,
        ],
      },
    });
  }

  // Sort by absolute impact descending so the most material drivers
  // surface first in any UI that iterates the array in order.
  drivers.sort((a, b) => Math.abs(b.difference_cents) - Math.abs(a.difference_cents));

  let disputable = 0;
  let optimization = 0;
  let unexplained = 0;

  for (const d of drivers) {
    if (d.is_disputable && d.difference_cents > 0) {
      disputable += d.difference_cents;
    }
    if (d.is_optimization && d.difference_cents > 0) {
      optimization += d.difference_cents;
    }
    if (d.is_unexplained) {
      unexplained += Math.abs(d.difference_cents);
    }
  }

  const drivers_by_category: Partial<Record<ChangeCategory, number>> = {};
  for (const d of drivers) {
    drivers_by_category[d.category] = (drivers_by_category[d.category] ?? 0) + 1;
  }

  return {
    previous_total_cents: prevTotal,
    current_total_cents: currTotal,
    net_change_cents: netChange,
    percent_change_bps: prevTotal === 0 ? null : Math.round((netChange / prevTotal) * 10_000),
    disputable_cents: disputable,
    optimization_cents: optimization,
    unexplained_cents: unexplained,
    executive_summary: buildExecutiveSummary({
      prevTotal,
      currTotal,
      netChange,
      drivers,
      disputable,
    }),
    drivers,
    metadata: {
      engine_version: ENGINE_VERSION,
      drivers_by_category,
      drivers_sum_cents: driversSum,
    },
  };
}

function buildExecutiveSummary(input: {
  prevTotal: number;
  currTotal: number;
  netChange: number;
  drivers: ChangeDriver[];
  disputable: number;
}): string {
  const { netChange, drivers, disputable } = input;
  if (netChange === 0 && drivers.length === 0) {
    return 'The total bill is unchanged from the previous period.';
  }
  const direction = netChange === 0 ? 'unchanged' : netChange > 0 ? 'increased' : 'decreased';
  const magnitude = formatCentsSigned(Math.abs(netChange));
  const topDrivers = [];
  for (const d of drivers) {
    if (d.difference_cents !== 0) {
      topDrivers.push(`- ${signedFormatted(d.difference_cents)} from ${d.title}`);
      if (topDrivers.length >= 5) break;
    }
  }
  const top = topDrivers.join('\n');
  const disputeLine =
    disputable > 0
      ? `\n\nWe found ${formatCentsSigned(disputable)} that appears potentially disputable.`
      : '';
  return `The bill ${direction}${
    direction === 'unchanged' ? '' : ` by ${magnitude}`
  } compared with the previous period.\n\nTop drivers:\n${top}${disputeLine}`;
}
