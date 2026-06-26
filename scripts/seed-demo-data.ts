/**
 * scripts/seed-demo-data.ts
 *
 * One-shot demo-data seeder for CarrierAudit. Populates a Supabase instance
 * with a profile, two completed audits (March 2026 + April 2026), 3 billing
 * accounts per audit, ~85 wireless lines, realistic features/credits/DPP
 * installments, runs the rules engine, and runs the Bill Increase Autopsy
 * across the pair.
 *
 * Usage:
 *   pnpm exec tsx scripts/seed-demo-data.ts
 *
 * Idempotency: every run first deletes existing rows for the demo user
 * (a stable, well-known UUID) and re-creates them. Running twice produces
 * the same end state.
 *
 * Required env (read from process.env; load via a `.env.local` shell shim
 * or `pnpm dlx dotenv-cli -e .env.local pnpm exec tsx scripts/seed-demo-data.ts`):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * NEVER point this at production. The script writes a known UUID and
 * deletes existing rows for that UUID first.
 */

import { randomUUID } from 'node:crypto';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import {
  ExtractedBillSchema,
  type ExtractedAccount,
  type ExtractedBill,
  type ExtractedCredit,
  type ExtractedDpp,
  type ExtractedFeature,
  type ExtractedLine,
} from '@/extraction/schema';
import { runRules } from '@/rules/runner';
import type { Finding } from '@/rules/types';
import { compareBills } from '@/autopsy/compare';
import { persistComparison } from '@/autopsy/persist';

// ---------------------------------------------------------------------------
// Stable demo identifiers
// ---------------------------------------------------------------------------

const DEMO_USER_ID = '00000000-0000-0000-0000-0000000d3000';
const DEMO_USER_EMAIL = 'demo@carrieraudit.local';
const DEMO_USER_FULL_NAME = 'Demo Operator';
const DEMO_USER_COMPANY = 'Acme Industries (Demo)';
const DEMO_PASSWORD = 'demo-password-do-not-reuse';

// Engineered delta target: +$843 between March and April.
// All math below is exposed in cents so totals are explicit.
const TARGET_DELTA_CENTS = 84_300;

// Account BAN last4s and labels (per task spec).
const ACCOUNTS: Array<{ last4: string; label: string; lineCount: number }> = [
  { last4: '7281', label: 'HQ Operations', lineCount: 30 },
  { last4: '4419', label: 'Field Sales', lineCount: 30 },
  { last4: '9930', label: 'Warehouse', lineCount: 25 },
];

const COST_CENTERS = [
  'CC-100-Executive',
  'CC-200-Engineering',
  'CC-300-Sales',
  'CC-400-Support',
  'CC-500-Operations',
  'CC-600-Logistics',
];

// ---------------------------------------------------------------------------
// Tiny seeded PRNG so the line layout is deterministic across runs without
// needing to pin every value by hand.
// ---------------------------------------------------------------------------

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    // Mulberry32 — fast, deterministic, no deps.
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, options: readonly T[]): T {
  if (options.length === 0) {
    throw new Error('pick: empty options');
  }
  const idx = Math.floor(rng() * options.length);
  // noUncheckedIndexedAccess: narrow the result.
  const out = options[idx % options.length];
  if (out === undefined) {
    // Should be unreachable given length > 0.
    throw new Error('pick: undefined element');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Device + plan catalog (purely fixture data)
// ---------------------------------------------------------------------------

type DeviceKind = 'smartphone' | 'tablet' | 'watch' | 'hotspot' | 'router';

const SMARTPHONES = [
  'iPhone 15',
  'iPhone 15 Pro',
  'iPhone 16',
  'iPhone 16 Pro',
  'Galaxy S24',
  'Galaxy S25',
  'Pixel 8',
] as const;
const TABLETS = ['iPad 10', 'iPad Air'] as const;
const WATCHES = ['Apple Watch SE', 'Apple Watch S9'] as const;
const HOTSPOTS = ['Jetpack MiFi 8800L', 'Inseego MiFi X PRO'] as const;
const ROUTERS = ['Cradlepoint IBR900'] as const;

const SMARTPHONE_PLAN = 'Business Unlimited Pro 2.0';
const SMARTPHONE_PLAN_BASE_CENTS = 4_500; // $45/mo
const TABLET_PLAN = 'Business Unlimited Tablet';
const TABLET_PLAN_BASE_CENTS = 2_000; // $20/mo
const WATCH_PLAN = 'Business Number Share Wearable';
const WATCH_PLAN_BASE_CENTS = 1_000; // $10/mo
const HOTSPOT_PLAN = 'Business Pro 100GB Hotspot';
const HOTSPOT_PLAN_BASE_CENTS = 6_000; // $60/mo
const ROUTER_PLAN = 'Business Internet Backup';
const ROUTER_PLAN_BASE_CENTS = 9_000; // $90/mo

const INSURANCE_FEATURE_CENTS = 1_700; // $17/mo Verizon Protect
// International feature amounts vary across the 3 engineered additions
// (see `internationalAmountForIndex` below). No single constant fits.

// ---------------------------------------------------------------------------
// Line generator — builds the same line shape for March + April bills, then
// mutates per-line for the April variant to engineer the target delta.
// ---------------------------------------------------------------------------

interface SeedLine {
  /** Position inside the account's `lines[]` array. Stable across periods. */
  index: number;
  kind: DeviceKind;
  device: string;
  mdn_last4: string;
  cost_center: string;
  /** Per-line user label — synthetic, never PII. */
  label: string;
}

function makeMdnLast4(rng: () => number): string {
  return String(Math.floor(rng() * 10000)).padStart(4, '0');
}

function buildSeedLines(accountIndex: number, count: number): SeedLine[] {
  // Seed deterministically off the account index so reruns are stable.
  const rng = makeRng(0xdeadbeef + accountIndex * 7919);
  const lines: SeedLine[] = [];

  // First, ensure each account has a sane mix.
  // ~75% smartphones, ~10% tablets, ~6% watches, ~6% hotspots, ~3% routers.
  // For 30 lines: ~22 phones, 3 tablets, 2 watches, 2 hotspots, 1 router.
  const kinds: DeviceKind[] = [];
  const smartphoneCount = Math.round(count * 0.75);
  const tabletCount = Math.max(2, Math.round(count * 0.1));
  const watchCount = Math.max(1, Math.round(count * 0.06));
  const hotspotCount = Math.max(1, Math.round(count * 0.06));
  // Whatever's left → routers (at least 1).
  let consumed = smartphoneCount + tabletCount + watchCount + hotspotCount;
  if (consumed > count) {
    consumed = count;
  }
  const routerCount = Math.max(1, count - consumed);

  for (let i = 0; i < smartphoneCount; i += 1) kinds.push('smartphone');
  for (let i = 0; i < tabletCount; i += 1) kinds.push('tablet');
  for (let i = 0; i < watchCount; i += 1) kinds.push('watch');
  for (let i = 0; i < hotspotCount; i += 1) kinds.push('hotspot');
  for (let i = 0; i < routerCount; i += 1) kinds.push('router');
  // Trim to exact count (rounding can over/under).
  while (kinds.length > count) kinds.pop();
  while (kinds.length < count) kinds.push('smartphone');

  for (let i = 0; i < count; i += 1) {
    const kind = kinds[i] ?? 'smartphone';
    let device: string;
    switch (kind) {
      case 'smartphone':
        device = pick(rng, SMARTPHONES);
        break;
      case 'tablet':
        device = pick(rng, TABLETS);
        break;
      case 'watch':
        device = pick(rng, WATCHES);
        break;
      case 'hotspot':
        device = pick(rng, HOTSPOTS);
        break;
      case 'router':
        device = pick(rng, ROUTERS);
        break;
    }
    lines.push({
      index: i,
      kind,
      device,
      mdn_last4: makeMdnLast4(rng),
      cost_center: pick(rng, COST_CENTERS),
      // Synthetic labels — never real names. The PII redaction transform in
      // ExtractedLineSchema will scrub anything that looks like a full name.
      label: `Asset ${String(i + 1).padStart(3, '0')}`,
    });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Per-period bill builders
// ---------------------------------------------------------------------------

function planBaseFor(kind: DeviceKind): number {
  switch (kind) {
    case 'smartphone':
      return SMARTPHONE_PLAN_BASE_CENTS;
    case 'tablet':
      return TABLET_PLAN_BASE_CENTS;
    case 'watch':
      return WATCH_PLAN_BASE_CENTS;
    case 'hotspot':
      return HOTSPOT_PLAN_BASE_CENTS;
    case 'router':
      return ROUTER_PLAN_BASE_CENTS;
  }
}

function planNameFor(kind: DeviceKind): string {
  switch (kind) {
    case 'smartphone':
      return SMARTPHONE_PLAN;
    case 'tablet':
      return TABLET_PLAN;
    case 'watch':
      return WATCH_PLAN;
    case 'hotspot':
      return HOTSPOT_PLAN;
    case 'router':
      return ROUTER_PLAN;
  }
}

/**
 * Build a base line (March layout). The April variant is derived from this
 * with explicit mutations applied to engineer the autopsy delta.
 */
function buildMarchLine(
  seed: SeedLine,
  /** Whether to attach the standing -$20/mo promo credit that April will lose. */
  attachStandingPromo: boolean,
  /** Optional pre-existing DPP installment (already partway through term). */
  existingDpp: ExtractedDpp | null,
  /** Optional pre-existing insurance feature. */
  insurance: boolean,
  /** Pre-existing additional features. */
  extraFeatures: ExtractedFeature[],
  /** Pre-existing additional credits. */
  extraCredits: ExtractedCredit[],
  override?: Partial<ExtractedLine>,
): ExtractedLine {
  const planBase = planBaseFor(seed.kind);
  const features: ExtractedFeature[] = [...extraFeatures];
  if (insurance) {
    features.push({
      name: 'Verizon Protect',
      category: 'insurance',
      monthly_cents: INSURANCE_FEATURE_CENTS,
    });
  }
  const credits: ExtractedCredit[] = [...extraCredits];
  if (attachStandingPromo) {
    credits.push({
      name: 'Smartphone Promo Credit',
      monthly_cents: -2_000, // $20/mo
      expires_on: null,
      is_promo: true,
    });
  }
  const dpp: ExtractedDpp[] = existingDpp ? [existingDpp] : [];

  // Per-kind usage shapes (loose realism — totals not asserted).
  let data_used_gb: number;
  let voice_used_min: number;
  let sms_used_count: number;
  switch (seed.kind) {
    case 'smartphone':
      data_used_gb = 12.5;
      voice_used_min = 220;
      sms_used_count = 350;
      break;
    case 'tablet':
      data_used_gb = 4.2;
      voice_used_min = 0;
      sms_used_count = 0;
      break;
    case 'watch':
      data_used_gb = 0.1;
      voice_used_min = 15;
      sms_used_count = 20;
      break;
    case 'hotspot':
      data_used_gb = 18.4;
      voice_used_min = 0;
      sms_used_count = 0;
      break;
    case 'router':
      data_used_gb = 35.7;
      voice_used_min = 0;
      sms_used_count = 0;
      break;
  }

  return {
    mdn_last4: seed.mdn_last4,
    user_label: seed.label,
    device: seed.device,
    plan_name: planNameFor(seed.kind),
    plan_base_cents: planBase,
    data_used_gb,
    voice_used_min,
    sms_used_count,
    is_suspended: false,
    features,
    credits,
    dpp_installments: dpp,
    ...override,
  };
}

/**
 * Engineered delta map per account. Each account contributes a known piece
 * of the total +$843 delta. Numbers are explicit so the math is auditable.
 */
interface AccountPlan {
  last4: string;
  label: string;
  lineCount: number;
  /** Line indexes within this account that will receive a NEW DPP in April. */
  newDppIndexes: number[];
  /** Line indexes that LOSE the standing promo credit going from March → April. */
  promoDropIndexes: number[];
  /** Line indexes that GAIN an international feature in April. */
  internationalIndexes: number[];
  /** Number of new smartphone lines to APPEND to this account in April. */
  newSmartphoneCount: number;
  /** Account-level tax/fee increase in cents (April - March). 0 = no change. */
  taxFeeIncrease: number;
  /** Suspend this line index in April (still billed plan charge). null = none. */
  suspendIndex: number | null;
}

const ACCOUNT_PLANS: AccountPlan[] = [
  {
    last4: '7281',
    label: 'HQ Operations',
    lineCount: 30,
    newDppIndexes: [0, 1, 2], // 3 new DPP @ $39 = +$117
    promoDropIndexes: [5, 6, 7, 8], // 4 promo drops @ $20 = +$80
    internationalIndexes: [10], // 1 international @ $50 = +$50
    newSmartphoneCount: 1,
    taxFeeIncrease: 4_000, // +$40/mo
    suspendIndex: 12, // active → suspended, plan charge still on bill
  },
  {
    last4: '4419',
    label: 'Field Sales',
    lineCount: 30,
    newDppIndexes: [0, 1, 2], // 3 new DPP @ $39 = +$117
    promoDropIndexes: [5, 6, 7, 8], // 4 promo drops @ $20 = +$80
    internationalIndexes: [11, 13], // 2 international @ $48 = +$96
    newSmartphoneCount: 1,
    taxFeeIncrease: 2_700, // +$27/mo
    suspendIndex: null,
  },
  {
    last4: '9930',
    label: 'Warehouse',
    lineCount: 25,
    newDppIndexes: [0, 1], // 2 new DPP @ $39 = +$78
    promoDropIndexes: [5, 6, 7], // 3 promo drops @ $20 = +$60
    internationalIndexes: [], // none
    newSmartphoneCount: 0,
    taxFeeIncrease: 0,
    suspendIndex: null,
  },
];

// Engineered totals (sanity-checkable):
//   8 new DPP × 3900 = 31_200  ($312/mo)
//   11 promo drops × 2000 = 22_000  ($220/mo)
//   3 international × (5000+4800+4800) = 14_600  ($146/mo) — choose 5000 + 4800 + 4800
//   2 new smartphone lines: plan(4500) + 0 features + 0 credits + 0 DPP = 9_000 = $90/mo
//   account-level taxes: 4000 + 2700 = 6_700  ($67/mo)
//   suspended line: +0 to net bill total (plan was already in March)
// -----------------------------------------------------------------
//   Subtotal = 31_200 + 22_000 + 14_600 + 9_000 + 6_700 = 83_500  ($835/mo)
// We then bump the period 2 unexplained noise by a fixed 800 cents per
// April account total to hit exactly +843 (8.00 / period spread across the
// three accounts). The autopsy engine attributes that to an `unexplained`
// driver, which is the honest behavior the spec wants on a real bill.

const ENGINEERED_NOISE_PER_ACCOUNT_CENTS = 267; // 267 * 3 = 801 → +$8.01

function internationalAmountForIndex(idx: number): number {
  // 50, 48, 48 to total 146 cents-dollars.
  if (idx === 0) return 5_000;
  return 4_800;
}

// ---------------------------------------------------------------------------
// Account assembly (March + April)
// ---------------------------------------------------------------------------

interface PeriodAccountBuild {
  account: ExtractedAccount;
}

function buildMarchAccount(plan: AccountPlan): PeriodAccountBuild {
  const seeds = buildSeedLines(
    ACCOUNTS.findIndex((a) => a.last4 === plan.last4),
    plan.lineCount,
  );
  const lines: ExtractedLine[] = seeds.map((seed) => {
    // Attach the standing promo credit to indexes that will lose it next cycle.
    const attachStandingPromo = plan.promoDropIndexes.includes(seed.index);

    // A handful of phones come with a pre-existing DPP (mid-term, won't be
    // touched by April mutations — adds bill realism for rules to chew on).
    let existingDpp: ExtractedDpp | null = null;
    if (seed.kind === 'smartphone' && seed.index >= 15 && seed.index < 19) {
      existingDpp = {
        device: seed.device,
        monthly_cents: 3_333, // $33.33/mo (24-mo of ~$800)
        remaining_payments: 12,
        total_payments: 24,
      };
    }
    // Demo "1 device with completed DPP (remaining=0)" — attach a completed
    // DPP on a smartphone (different per account, but only ONE TOTAL across
    // all accounts). We put it on HQ Operations index 20.
    if (plan.last4 === '7281' && seed.kind === 'smartphone' && seed.index === 20) {
      existingDpp = {
        device: seed.device,
        monthly_cents: 3_333,
        remaining_payments: 0,
        total_payments: 36,
      };
    }

    // Multiple smartphones get carrier insurance on corporate-owned devices.
    // "Insurance on corporate-owned devices" is exactly the orphan-insurance
    // rule's territory.
    const insurance = seed.kind === 'smartphone' && seed.index >= 21 && seed.index < 25;

    // Tablets: two of them get zero usage to trigger the tablet rule.
    let override: Partial<ExtractedLine> | undefined;
    if (seed.kind === 'tablet' && (seed.index % 7 === 0 || seed.index === 5)) {
      override = { data_used_gb: 0 };
    }

    return buildMarchLine(seed, attachStandingPromo, existingDpp, insurance, [], [], override);
  });

  // Period-1 total: sum every per-line contribution + taxes/fees.
  const taxesFees = 3_500_00; // $3500/mo baseline taxes/surcharges per account
  const lineSum = lines.reduce((s, l) => s + lineCharge(l), 0);
  const accountTotal = lineSum + taxesFees;

  return {
    account: {
      account_number_last4: plan.last4,
      label: plan.label,
      total_charges_cents: accountTotal,
      taxes_fees_cents: taxesFees,
      account_level_credits: [],
      lines,
    },
  };
}

function buildAprilAccount(plan: AccountPlan): PeriodAccountBuild {
  const march = buildMarchAccount(plan).account;

  // Clone every March line and mutate per the engineered delta plan.
  const lines: ExtractedLine[] = march.lines.map((mLine, idx) => {
    // Defensive clone — never mutate March's structures.
    const cloned: ExtractedLine = structuredClone(mLine);

    // 1) Promo drop (recurring credit goes away).
    if (plan.promoDropIndexes.includes(idx)) {
      cloned.credits = cloned.credits.filter((c) => c.name !== 'Smartphone Promo Credit');
    }

    // 2) New DPP installment in April.
    if (plan.newDppIndexes.includes(idx)) {
      // Even if the line already had a mid-term DPP, an additional device
      // installment on the same line is a thing carriers do (BYOD upgrade).
      cloned.dpp_installments = [
        ...cloned.dpp_installments,
        {
          device: cloned.device ?? 'iPhone 16',
          monthly_cents: 3_900, // $39/mo — chosen so 8 × $39 = $312.
          remaining_payments: 36,
          total_payments: 36,
        },
      ];
    }

    // 3) International feature gain.
    if (plan.internationalIndexes.includes(idx)) {
      const order = plan.internationalIndexes.indexOf(idx);
      cloned.features = [
        ...cloned.features,
        {
          name: 'TravelPass International Monthly',
          category: 'international',
          monthly_cents: internationalAmountForIndex(
            // Distribute the 5000/4800/4800 split deterministically over the
            // 3 internationals across all accounts. Track via a module-level
            // counter using `internationalCounter` below.
            internationalCounter++,
          ),
        },
      ];
      void order;
    }

    // 4) Suspended-line still billed (active → suspended, plan charge stays).
    if (plan.suspendIndex !== null && idx === plan.suspendIndex) {
      cloned.is_suspended = true;
      // plan_base_cents intentionally LEFT unchanged — the disputable pattern.
    }

    return cloned;
  });

  // 5) New smartphone lines (appended).
  for (let i = 0; i < plan.newSmartphoneCount; i += 1) {
    const newSeed: SeedLine = {
      index: lines.length,
      kind: 'smartphone',
      device: 'iPhone 16',
      mdn_last4: String(7000 + i + plan.lineCount).padStart(4, '0'),
      cost_center: 'CC-300-Sales',
      label: `Asset NEW-${i + 1}`,
    };
    // Brand-new line: bare plan, no features, no credits, no DPP.
    lines.push(buildMarchLine(newSeed, false, null, false, [], [], {}));
  }

  // Engineered noise — a small per-account fixed bump that becomes part of
  // the bill's grand total. The autopsy attributes it to "unexplained" since
  // no underlying line item changed; this is intentional and matches what a
  // real bill summary often does. Used to tune the headline delta to exactly
  // $843 instead of $835.
  const noise = ENGINEERED_NOISE_PER_ACCOUNT_CENTS;

  const lineSum = lines.reduce((s, l) => s + lineCharge(l), 0);
  const taxesFees = march.taxes_fees_cents! + plan.taxFeeIncrease;
  const accountTotal = lineSum + taxesFees + noise;

  return {
    account: {
      account_number_last4: plan.last4,
      label: plan.label,
      total_charges_cents: accountTotal,
      taxes_fees_cents: taxesFees,
      account_level_credits: [],
      lines,
    },
  };
}

// Mirrors compare.ts:lineCharge so we can compute per-account totals locally
// without importing a non-exported helper.
function lineCharge(line: ExtractedLine): number {
  const planBase = line.plan_base_cents ?? 0;
  const features = line.features.reduce((s, f) => s + f.monthly_cents, 0);
  const credits = line.credits.reduce((s, c) => s + c.monthly_cents, 0);
  const dpp = line.dpp_installments.reduce((s, d) => s + d.monthly_cents, 0);
  return planBase + features + credits + dpp;
}

// Tracks the per-international-feature amount across accounts so we can hit
// $50 + $48 + $48 = $146 deterministically. Reset before each bill build.
let internationalCounter = 0;

function buildBill(period: 'march' | 'april'): ExtractedBill {
  internationalCounter = 0;
  const accounts = ACCOUNT_PLANS.map((plan) =>
    period === 'march' ? buildMarchAccount(plan).account : buildAprilAccount(plan).account,
  );
  const total = accounts.reduce((s, a) => s + a.total_charges_cents, 0);
  const start = period === 'march' ? '2026-03-01' : '2026-04-01';
  const end = period === 'march' ? '2026-03-31' : '2026-04-30';
  const bill: ExtractedBill = {
    carrier: 'verizon',
    billing_period_start: start,
    billing_period_end: end,
    total_charges_cents: total,
    accounts,
    notes: [],
  };
  // Validate before persisting — same contract the worker enforces.
  return ExtractedBillSchema.parse(bill);
}

// ---------------------------------------------------------------------------
// Supabase admin client (constructed inline so we can validate env first)
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.length === 0) {
    throw new Error(
      `Missing required env var ${name}. Run with SKIP_ENV_VALIDATION=1 (if needed) ` +
        `and ensure NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set in ` +
        `your shell or .env.local. Example:\n\n` +
        `  pnpm dlx dotenv-cli -e .env.local pnpm exec tsx scripts/seed-demo-data.ts\n`,
    );
  }
  return value;
}

function buildAdminClient(): SupabaseClient {
  const url = requireEnv('NEXT_PUBLIC_SUPABASE_URL');
  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, serviceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}

// ---------------------------------------------------------------------------
// Demo user setup (auth.users + profiles)
// ---------------------------------------------------------------------------

async function ensureDemoUser(admin: SupabaseClient): Promise<void> {
  // 1) Is there already an auth user at the demo UUID?
  const { data: byId, error: byIdErr } = await admin.auth.admin.getUserById(DEMO_USER_ID);
  if (byIdErr && byIdErr.status !== 404) {
    throw new Error(`auth.admin.getUserById failed: ${byIdErr.message} (status ${byIdErr.status})`);
  }

  // 2) If absent at the UUID, is there a stale user at the demo email under a
  //    different id? If so, delete it so the email is free for re-insertion.
  //    listUsers doesn't take a server-side email filter; paginate small.
  if (!byId?.user) {
    let page = 1;
    let foundStale = false;
    while (!foundStale && page <= 5) {
      const { data: list, error: listErr } = await admin.auth.admin.listUsers({
        page,
        perPage: 200,
      });
      if (listErr) {
        throw new Error(`auth.admin.listUsers failed: ${listErr.message}`);
      }
      for (const u of list?.users ?? []) {
        if (u.email === DEMO_USER_EMAIL && u.id !== DEMO_USER_ID) {
          const { error: delErr } = await admin.auth.admin.deleteUser(u.id);
          if (delErr) {
            throw new Error(`auth.admin.deleteUser failed for stale demo user: ${delErr.message}`);
          }
          foundStale = true;
          break;
        }
      }
      if ((list?.users?.length ?? 0) < 200) break;
      page += 1;
    }

    // 3) Create the auth user with the stable demo id. Supabase GoTrue
    //    accepts an `id` field on the createUser body; the supabase-auth-js
    //    type doesn't expose it, so we cast through a widened shape.
    type CreateUserAttrs = Parameters<typeof admin.auth.admin.createUser>[0] & {
      id?: string;
    };
    const attrs: CreateUserAttrs = {
      email: DEMO_USER_EMAIL,
      password: DEMO_PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: DEMO_USER_FULL_NAME },
      id: DEMO_USER_ID,
    };
    const { data: created, error: createErr } = await admin.auth.admin.createUser(attrs);
    if (createErr) {
      throw new Error(
        `auth.admin.createUser failed: ${createErr.message} (status ${createErr.status})`,
      );
    }
    // Defensive: if the GoTrue version on the other side ignored our `id`
    // override, the demo profile UUID won't match and downstream inserts
    // would FK-fail. Detect + report instead of corrupting the demo data.
    if (created?.user && created.user.id !== DEMO_USER_ID) {
      throw new Error(
        `auth.admin.createUser ignored the demo id override (server returned ${created.user.id}). ` +
          `Your Supabase GoTrue version may be too old to accept an id field. ` +
          `Either upgrade Supabase or change DEMO_USER_ID in this script to match.`,
      );
    }
  }

  // 4) The on_auth_user_created trigger inserts a profile row on insert.
  //    Upsert it so reruns always end up with the labeled company + credits.
  const { error: upsertErr } = await admin.from('profiles').upsert(
    {
      id: DEMO_USER_ID,
      email: DEMO_USER_EMAIL,
      full_name: DEMO_USER_FULL_NAME,
      company_name: DEMO_USER_COMPANY,
      // Healthy credit balance so the demo user can run more audits via UI
      // without hitting the access gate.
      audit_credits: 10,
    },
    { onConflict: 'id' },
  );
  if (upsertErr) {
    throw new Error(`profiles upsert failed: ${upsertErr.message}`);
  }
}

// ---------------------------------------------------------------------------
// Idempotent cleanup of prior demo rows
// ---------------------------------------------------------------------------

async function deletePriorDemoData(admin: SupabaseClient): Promise<void> {
  // Cascade through audits.id → bill_* and findings via FK ON DELETE CASCADE.
  // bill_comparisons cascades from audits as well.
  const { data: priorAudits, error: selErr } = await admin
    .from('audits')
    .select('id')
    .eq('user_id', DEMO_USER_ID);
  if (selErr) {
    throw new Error(`select audits failed: ${selErr.message}`);
  }
  if (priorAudits && priorAudits.length > 0) {
    const ids = priorAudits.map((r: { id: string }) => r.id);
    // Explicitly clear comparisons first since they reference TWO audits.
    const { error: cmpErr } = await admin
      .from('bill_comparisons')
      .delete()
      .or(ids.map((id) => `previous_audit_id.eq.${id},current_audit_id.eq.${id}`).join(','));
    if (cmpErr) {
      throw new Error(`delete bill_comparisons failed: ${cmpErr.message}`);
    }
    const { error: delErr } = await admin.from('audits').delete().in('id', ids);
    if (delErr) {
      throw new Error(`delete audits failed: ${delErr.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Audit + bill persistence (mirrors process-bill.ts persistBill but reused
// inline so the script stays self-contained and doesn't import from the
// inngest worker module — that module pulls in the full Inngest client).
// ---------------------------------------------------------------------------

interface PersistedAudit {
  auditId: string;
  accountIds: string[];
  /** lineIds[accountIdx][lineIdx] → uuid */
  lineIds: string[][];
  bill: ExtractedBill;
}

async function insertAuditAndBill(
  admin: SupabaseClient,
  bill: ExtractedBill,
  filename: string,
): Promise<PersistedAudit> {
  const lineCount = bill.accounts.reduce((s, a) => s + a.lines.length, 0);

  const auditId = randomUUID();
  const { error: auditErr } = await admin.from('audits').insert({
    id: auditId,
    user_id: DEMO_USER_ID,
    status: 'completed',
    carrier: bill.carrier,
    storage_path: `bills/${DEMO_USER_ID}/${auditId}.pdf`,
    original_filename: filename,
    file_size_bytes: 1_200_000,
    page_count: 32,
    billing_period_start: bill.billing_period_start,
    billing_period_end: bill.billing_period_end,
    total_charges_cents: bill.total_charges_cents,
    account_count: bill.accounts.length,
    line_count: lineCount,
    completed_at: new Date().toISOString(),
  });
  if (auditErr) {
    throw new Error(`insert audits failed: ${auditErr.message}`);
  }

  // bill_accounts
  const accountInsertRows = bill.accounts.map((a) => ({
    id: randomUUID(),
    audit_id: auditId,
    account_number_masked: a.account_number_last4,
    account_label: a.label,
    total_charges_cents: a.total_charges_cents,
    taxes_fees_cents: a.taxes_fees_cents,
    raw: a as unknown as Record<string, unknown>,
  }));
  const { error: accErr } = await admin.from('bill_accounts').insert(accountInsertRows);
  if (accErr) {
    throw new Error(`insert bill_accounts failed: ${accErr.message}`);
  }
  const accountIds = accountInsertRows.map((r) => r.id);

  // bill_lines (with cost_center stashed in raw)
  type LineRow = {
    id: string;
    audit_id: string;
    account_id: string;
    mdn_masked: string | null;
    user_label: string | null;
    device_description: string | null;
    plan_name: string | null;
    plan_base_cents: number | null;
    data_used_gb: number | null;
    voice_used_min: number | null;
    sms_used_count: number | null;
    is_suspended: boolean;
    is_active_dpp: boolean;
    raw: Record<string, unknown>;
  };
  const lineRows: LineRow[] = [];
  const lineIds: string[][] = bill.accounts.map(() => []);
  bill.accounts.forEach((account, accountIdx) => {
    const accountId = accountIds[accountIdx];
    if (!accountId) {
      throw new Error(`internal: missing account id at ${accountIdx}`);
    }
    // Re-derive seeds so we can stamp cost_center onto raw.
    const seeds = buildSeedLines(accountIdx, account.lines.length);
    account.lines.forEach((line, lineIdx) => {
      const seed = seeds[lineIdx];
      const cost_center = seed?.cost_center ?? 'CC-100-Executive';
      const id = randomUUID();
      lineRows.push({
        id,
        audit_id: auditId,
        account_id: accountId,
        mdn_masked: line.mdn_last4,
        user_label: line.user_label,
        device_description: line.device,
        plan_name: line.plan_name,
        plan_base_cents: line.plan_base_cents,
        data_used_gb: line.data_used_gb,
        voice_used_min: line.voice_used_min,
        sms_used_count: line.sms_used_count,
        is_suspended: line.is_suspended,
        is_active_dpp: line.dpp_installments.length > 0,
        raw: {
          ...(line as unknown as Record<string, unknown>),
          // Stash the fixture-only cost-center on the raw jsonb — no schema
          // change required, available to the UI via `bill_lines.raw->>cost_center`.
          cost_center,
        },
      });
      const bucket = lineIds[accountIdx];
      if (bucket) bucket.push(id);
    });
  });
  if (lineRows.length > 0) {
    const { error: lnErr } = await admin.from('bill_lines').insert(lineRows);
    if (lnErr) {
      throw new Error(`insert bill_lines failed: ${lnErr.message}`);
    }
  }

  // bill_features
  type FeatureRow = {
    line_id: string;
    audit_id: string;
    name: string;
    category: string;
    monthly_charge_cents: number;
  };
  const featureRows: FeatureRow[] = [];
  // bill_credits
  type CreditRow = {
    line_id: string | null;
    account_id: string | null;
    audit_id: string;
    name: string;
    monthly_amount_cents: number;
    expires_on: string | null;
    is_promo: boolean;
  };
  const creditRows: CreditRow[] = [];
  // bill_dpp_installments
  type DppRow = {
    line_id: string;
    audit_id: string;
    device_description: string;
    monthly_payment_cents: number;
    remaining_payments: number | null;
    total_payments: number | null;
  };
  const dppRows: DppRow[] = [];

  bill.accounts.forEach((account, accountIdx) => {
    account.lines.forEach((line, lineIdx) => {
      const bucket = lineIds[accountIdx];
      const lineId = bucket?.[lineIdx];
      if (!lineId) return;
      for (const f of line.features) {
        featureRows.push({
          line_id: lineId,
          audit_id: auditId,
          name: f.name,
          category: f.category,
          monthly_charge_cents: f.monthly_cents,
        });
      }
      for (const c of line.credits) {
        creditRows.push({
          line_id: lineId,
          account_id: null,
          audit_id: auditId,
          name: c.name,
          monthly_amount_cents: c.monthly_cents,
          expires_on: c.expires_on,
          is_promo: c.is_promo,
        });
      }
      for (const d of line.dpp_installments) {
        dppRows.push({
          line_id: lineId,
          audit_id: auditId,
          device_description: d.device,
          monthly_payment_cents: d.monthly_cents,
          remaining_payments: d.remaining_payments,
          total_payments: d.total_payments,
        });
      }
    });
    // Account-level credits.
    const accountId = accountIds[accountIdx];
    if (!accountId) return;
    for (const c of account.account_level_credits) {
      creditRows.push({
        line_id: null,
        account_id: accountId,
        audit_id: auditId,
        name: c.name,
        monthly_amount_cents: c.monthly_cents,
        expires_on: c.expires_on,
        is_promo: c.is_promo,
      });
    }
  });

  if (featureRows.length > 0) {
    const { error } = await admin.from('bill_features').insert(featureRows);
    if (error) throw new Error(`insert bill_features failed: ${error.message}`);
  }
  if (creditRows.length > 0) {
    const { error } = await admin.from('bill_credits').insert(creditRows);
    if (error) throw new Error(`insert bill_credits failed: ${error.message}`);
  }
  if (dppRows.length > 0) {
    const { error } = await admin.from('bill_dpp_installments').insert(dppRows);
    if (error) throw new Error(`insert bill_dpp_installments failed: ${error.message}`);
  }

  return { auditId, accountIds, lineIds, bill };
}

// ---------------------------------------------------------------------------
// Findings persistence — re-uses the same per-account → global index
// translation contract as process-bill.ts. Inlined to avoid pulling the
// Inngest worker module into this script.
// ---------------------------------------------------------------------------

function translateFindingLineIndexes(findings: Finding[], bill: ExtractedBill): Finding[] {
  const lineCounts = bill.accounts.map((a) => a.lines.length);
  const offsets: number[] = [];
  let running = 0;
  for (const n of lineCounts) {
    offsets.push(running);
    running += n;
  }
  return findings.map((f) => {
    if (f.affected_line_indexes.length === 0) return f;
    const accountIdx = f.affected_account_indexes[0];
    if (typeof accountIdx !== 'number') {
      return { ...f, affected_line_indexes: [] };
    }
    if (accountIdx < 0 || accountIdx >= lineCounts.length) {
      return { ...f, affected_line_indexes: [], affected_account_indexes: [] };
    }
    const size = lineCounts[accountIdx] ?? 0;
    const offset = offsets[accountIdx] ?? 0;
    const translated: number[] = [];
    for (const idx of f.affected_line_indexes) {
      if (typeof idx === 'number' && idx >= 0 && idx < size) {
        translated.push(offset + idx);
      }
    }
    return { ...f, affected_line_indexes: translated };
  });
}

async function persistFindingsForAudit(
  admin: SupabaseClient,
  persisted: PersistedAudit,
  findings: Finding[],
): Promise<number> {
  if (findings.length === 0) return 0;
  const flatLineIds: string[] = [];
  for (const bucket of persisted.lineIds) {
    for (const id of bucket) flatLineIds.push(id);
  }
  const rows = findings.map((f) => {
    const lineUuids: string[] = [];
    for (const idx of f.affected_line_indexes) {
      const id = flatLineIds[idx];
      if (typeof id === 'string') lineUuids.push(id);
    }
    const accountUuids: string[] = [];
    for (const idx of f.affected_account_indexes) {
      const id = persisted.accountIds[idx];
      if (typeof id === 'string') accountUuids.push(id);
    }
    return {
      audit_id: persisted.auditId,
      rule_id: f.rule_id,
      severity: f.severity,
      title: f.title,
      description: f.description,
      recommended_action: f.recommended_action,
      estimated_monthly_savings_cents: f.estimated_monthly_savings_cents,
      confidence: f.confidence,
      affected_line_ids: lineUuids,
      affected_account_ids: accountUuids,
      evidence: f.evidence,
    };
  });
  const { error } = await admin.from('findings').insert(rows);
  if (error) throw new Error(`insert findings failed: ${error.message}`);
  return rows.length;
}

async function updateAuditSavingsRollup(
  admin: SupabaseClient,
  auditId: string,
  findings: Finding[],
): Promise<void> {
  const monthly = findings.reduce((s, f) => s + f.estimated_monthly_savings_cents, 0);
  const high = findings.filter((f) => f.severity === 'high').length;
  const { error } = await admin
    .from('audits')
    .update({
      estimated_monthly_savings_cents: monthly,
      estimated_annual_savings_cents: monthly * 12,
      finding_count: findings.length,
      high_severity_count: high,
    })
    .eq('id', auditId);
  if (error) throw new Error(`update audits rollup failed: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Validate env before touching anything.
  requireEnv('NEXT_PUBLIC_SUPABASE_URL');
  requireEnv('SUPABASE_SERVICE_ROLE_KEY');

  const admin = buildAdminClient();

  console.log(`[seed] demo user id: ${DEMO_USER_ID}`);

  // 1) Demo user + profile (idempotent).
  await ensureDemoUser(admin);
  console.log('[seed] ensured demo user + profile');

  // 2) Wipe prior demo audits + cascaded child rows.
  await deletePriorDemoData(admin);
  console.log('[seed] cleared prior demo data');

  // 3) Build deterministic March + April bills.
  const marchBill = buildBill('march');
  const aprilBill = buildBill('april');
  console.log(
    `[seed] march total = $${(marchBill.total_charges_cents / 100).toFixed(2)}, ` +
      `april total = $${(aprilBill.total_charges_cents / 100).toFixed(2)}, ` +
      `delta = $${((aprilBill.total_charges_cents - marchBill.total_charges_cents) / 100).toFixed(2)}`,
  );

  // 4) Persist both audits.
  const marchPersisted = await insertAuditAndBill(
    admin,
    marchBill,
    'verizon-business-march-2026.pdf',
  );
  const aprilPersisted = await insertAuditAndBill(
    admin,
    aprilBill,
    'verizon-business-april-2026.pdf',
  );
  console.log(
    `[seed] persisted audits: march=${marchPersisted.auditId}, april=${aprilPersisted.auditId}`,
  );

  // 5) Run the real rules engine against each audit + persist findings.
  // Use a fixed "today" to make rule outputs (e.g. expiring-soon thresholds)
  // deterministic across runs.
  const today = new Date('2026-05-08T12:00:00Z');

  const { findings: marchFindingsRaw, errors: marchErrors } = await runRules({
    bill: marchBill,
    today,
    carrier: marchBill.carrier,
  });
  const { findings: aprilFindingsRaw, errors: aprilErrors } = await runRules({
    bill: aprilBill,
    today,
    carrier: aprilBill.carrier,
  });
  if (marchErrors.length > 0 || aprilErrors.length > 0) {
    console.warn(`[seed] rule errors: march=${marchErrors.length}, april=${aprilErrors.length}`);
  }
  const marchFindings = translateFindingLineIndexes(marchFindingsRaw, marchBill);
  const aprilFindings = translateFindingLineIndexes(aprilFindingsRaw, aprilBill);

  const marchInserted = await persistFindingsForAudit(admin, marchPersisted, marchFindings);
  const aprilInserted = await persistFindingsForAudit(admin, aprilPersisted, aprilFindings);
  await updateAuditSavingsRollup(admin, marchPersisted.auditId, marchFindings);
  await updateAuditSavingsRollup(admin, aprilPersisted.auditId, aprilFindings);

  // 6) Run the autopsy engine + persist the comparison.
  const autopsy = compareBills(marchBill, aprilBill);
  const { id: comparisonId } = await persistComparison({
    userId: DEMO_USER_ID,
    previousAuditId: marchPersisted.auditId,
    currentAuditId: aprilPersisted.auditId,
    result: autopsy,
  });

  const totalLines = marchBill.accounts.reduce((s, a) => s + a.lines.length, 0);
  const totalFindings = marchInserted + aprilInserted;
  const deltaDollars = (autopsy.net_change_cents / 100).toFixed(2);
  console.log(
    `[seed] seeded 2 audits, ${totalLines} lines (march) / ${aprilBill.accounts.reduce((s, a) => s + a.lines.length, 0)} (april), ` +
      `${totalFindings} findings, autopsy ${comparisonId} with $${deltaDollars} change`,
  );

  // Sanity-check the engineered headline delta — if a future edit drifts off
  // the +$843 target, surface it loudly rather than letting the demo lie.
  const observed = autopsy.net_change_cents;
  const drift = Math.abs(observed - TARGET_DELTA_CENTS);
  if (drift > 50) {
    console.warn(
      `[seed] WARN: engineered delta drifted from target +$${(TARGET_DELTA_CENTS / 100).toFixed(2)} ` +
        `by $${(drift / 100).toFixed(2)} — observed +$${(observed / 100).toFixed(2)}. ` +
        `Adjust ENGINEERED_NOISE_PER_ACCOUNT_CENTS or the per-driver tables.`,
    );
  }
}

main().catch((err: unknown) => {
  console.error('[seed] FAILED:', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
