/**
 * scripts/generate-fixtures.ts
 *
 * Generates synthetic ExtractedBill JSON goldens for the LLM-extraction tests
 * to validate against. We don't ship real (or even anonymized) bill PDFs in
 * the open repo; instead we ship structurally-realistic JSON shapes so the
 * test suite can detect schema drift and rule-engine regressions.
 *
 * All values are obviously synthetic:
 *   - Phone numbers: 555-prefix only
 *   - Account numbers: '0001', '0002', ... (last4)
 *   - Employee names: "Employee A", "Employee B", ...
 *
 * Outputs to tests/fixtures/bills/<name>.expected.json
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  ExtractedBillSchema,
  type ExtractedBill,
  type ExtractedAccount,
  type ExtractedLine,
  type ExtractedCredit,
  type ExtractedDpp,
  type ExtractedFeature,
} from '../src/extraction/schema';

const OUT_DIR = path.resolve(__dirname, '..', 'tests', 'fixtures', 'bills');

function mdnLast4(idx: number): string {
  return (idx % 10000).toString().padStart(4, '0');
}

function employeeLabel(idx: number): string {
  // A..Z then AA, AB, ... – stays obviously synthetic.
  const A = 'A'.charCodeAt(0);
  if (idx < 26) return `Employee ${String.fromCharCode(A + idx)}`;
  const first = Math.floor(idx / 26) - 1;
  const second = idx % 26;
  return `Employee ${String.fromCharCode(A + first)}${String.fromCharCode(A + second)}`;
}

type LineOverrides = Partial<ExtractedLine>;

function makeLine(idx: number, overrides: LineOverrides = {}): ExtractedLine {
  const base: ExtractedLine = {
    mdn_last4: mdnLast4(idx),
    user_label: employeeLabel(idx),
    device: 'iPhone 15',
    plan_name: 'Business Unlimited Pro 2.0',
    plan_base_cents: 6000,
    data_used_gb: 8.5,
    voice_used_min: 120,
    sms_used_count: 80,
    is_suspended: false,
    features: [],
    credits: [],
    dpp_installments: [],
  };
  return { ...base, ...overrides };
}

function makeFeature(
  name: string,
  category: ExtractedFeature['category'],
  cents: number,
): ExtractedFeature {
  return { name, category, monthly_cents: cents };
}

function makeCredit(
  name: string,
  cents: number,
  expiresOn: string | null,
  isPromo = true,
): ExtractedCredit {
  return { name, monthly_cents: cents, expires_on: expiresOn, is_promo: isPromo };
}

function makeDpp(
  device: string,
  cents: number,
  remaining: number | null,
  total: number | null,
): ExtractedDpp {
  return {
    device,
    monthly_cents: cents,
    remaining_payments: remaining,
    total_payments: total,
  };
}

function sumCents(...values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0);
}

// --- Fixture 1: Verizon, small (3 lines, 1 account) ---
function verizonBusinessSmall(): ExtractedBill {
  const lines: ExtractedLine[] = [
    makeLine(0, {
      device: 'iPhone 15 Pro',
      credits: [
        // Expired 60 days before the period — fires expired_promo_credit.
        makeCredit('iPhone Trade-In Promo', -1500, '2026-02-01', true),
      ],
      dpp_installments: [makeDpp('iPhone 15 Pro 256GB', 4583, 18, 36)],
    }),
    makeLine(1, {
      device: 'iPhone 14',
      // Completed DPP: remaining=0 but still being charged.
      dpp_installments: [makeDpp('iPhone 14 128GB', 2999, 0, 36)],
    }),
    makeLine(2, {
      device: 'Samsung Galaxy S24',
      features: [makeFeature('Mobile Protect Pro', 'insurance', 1700)],
    }),
  ];

  const account: ExtractedAccount = {
    account_number_last4: '0001',
    label: 'Main Business Account',
    total_charges_cents: sumCents(6000 * 3, 4583, 2999, 1700),
    taxes_fees_cents: 1850,
    account_level_credits: [],
    lines,
  };

  return {
    carrier: 'verizon',
    billing_period_start: '2026-04-01',
    billing_period_end: '2026-04-30',
    total_charges_cents: account.total_charges_cents,
    accounts: [account],
    notes: [
      'Synthetic fixture — small Verizon Business bill.',
      'Includes one expired promo credit and one completed-but-billed DPP for rule engine coverage.',
    ],
  };
}

// --- Fixture 2: Verizon, multi-account (2 accounts × 5 lines) ---
function verizonBusinessMultiAccount(): ExtractedBill {
  const acct1Lines: ExtractedLine[] = [
    makeLine(0),
    makeLine(1, {
      device: 'Verizon Jetpack MiFi 8800L',
      plan_name: 'Business Mobile Hotspot Pro',
      plan_base_cents: 8000,
      // Hotspot device with effectively no usage — unused_mifi_or_jetpack_line.
      data_used_gb: 0.05,
      features: [makeFeature('Mobile Hotspot Premium', 'hotspot', 0)],
    }),
    makeLine(2, {
      // Suspended line still being billed.
      is_suspended: true,
      plan_base_cents: 4000,
      data_used_gb: 0,
      voice_used_min: 0,
      sms_used_count: 0,
    }),
    makeLine(3),
    makeLine(4, {
      features: [makeFeature('TravelPass', 'international', 1000)],
    }),
  ];
  // 3 default lines @ 6000 + jetpack 8000 + suspended 4000 + 1 travelpass-line (6000 + 1000) = 31000
  const acct1: ExtractedAccount = {
    account_number_last4: '0001',
    label: 'Account A',
    total_charges_cents: sumCents(6000 * 3, 8000, 4000, 6000 + 1000),
    taxes_fees_cents: 2400,
    account_level_credits: [
      // Account-level credit expiring soon.
      makeCredit('Volume Discount Promo', -2500, '2026-06-15', true),
    ],
    lines: acct1Lines,
  };

  const acct2Lines: ExtractedLine[] = [
    makeLine(5),
    makeLine(6),
    makeLine(7, { features: [makeFeature('Verizon Cloud 600GB', 'cloud', 800)] }),
    makeLine(8),
    makeLine(9, {
      dpp_installments: [makeDpp('iPhone 15 128GB', 3500, 12, 36)],
    }),
  ];
  const acct2: ExtractedAccount = {
    account_number_last4: '0002',
    label: 'Account B',
    total_charges_cents: sumCents(6000 * 5, 800, 3500),
    taxes_fees_cents: 2100,
    account_level_credits: [],
    lines: acct2Lines,
  };

  return {
    carrier: 'verizon',
    billing_period_start: '2026-04-01',
    billing_period_end: '2026-04-30',
    total_charges_cents: acct1.total_charges_cents + acct2.total_charges_cents,
    accounts: [acct1, acct2],
    notes: [
      'Synthetic fixture — multi-account Verizon Business bill.',
      'Covers hotspot under-utilization, suspended-but-billed, and account-level promo expiring within 60 days.',
    ],
  };
}

// --- Fixture 3: AT&T, medium (12 lines, 1 account) ---
function attBusinessMedium(): ExtractedBill {
  const lines: ExtractedLine[] = [];
  for (let i = 0; i < 12; i++) {
    if (i === 3) {
      lines.push(
        makeLine(i, {
          plan_name: 'Business Unlimited Premium',
          plan_base_cents: 7000,
          features: [
            makeFeature('AT&T International Day Pass', 'international', 1000),
            makeFeature('AT&T International Day Pass', 'international', 1000),
          ],
        }),
      );
      continue;
    }
    if (i === 7) {
      // Duplicate insurance features.
      lines.push(
        makeLine(i, {
          plan_name: 'Business Unlimited Performance',
          plan_base_cents: 6500,
          features: [
            makeFeature('AT&T Mobile Insurance', 'insurance', 1700),
            makeFeature('AT&T Protect Advantage for 1', 'insurance', 1700),
          ],
        }),
      );
      continue;
    }
    if (i === 10) {
      // International TravelPass present > 60 days (per fixture notes) without
      // usage signal — trips stale_international_feature.
      lines.push(
        makeLine(i, {
          plan_name: 'Business Unlimited Performance',
          plan_base_cents: 6500,
          features: [makeFeature('AT&T International Day Pass', 'international', 1000)],
        }),
      );
      continue;
    }
    lines.push(
      makeLine(i, {
        plan_name: 'Business Unlimited Performance',
        plan_base_cents: 6500,
      }),
    );
  }

  const lineCharges = lines.reduce(
    (acc, l) => acc + (l.plan_base_cents ?? 0) + l.features.reduce((a, f) => a + f.monthly_cents, 0),
    0,
  );

  const account: ExtractedAccount = {
    account_number_last4: '0001',
    label: 'AT&T Business Mobility',
    total_charges_cents: lineCharges,
    taxes_fees_cents: 4200,
    account_level_credits: [],
    lines,
  };

  return {
    carrier: 'att',
    billing_period_start: '2026-04-05',
    billing_period_end: '2026-05-04',
    total_charges_cents: lineCharges,
    accounts: [account],
    notes: [
      'Synthetic fixture — medium AT&T Business bill (12 lines).',
      'Includes duplicate protection features and a stale international add-on for rule coverage.',
    ],
  };
}

// --- Fixture 4: T-Mobile, large (25 lines across 2 accounts) ---
function tmobileBusinessLarge(): ExtractedBill {
  const acct1Lines: ExtractedLine[] = [];
  for (let i = 0; i < 13; i++) {
    if (i === 0) {
      // Legacy Magenta plan name.
      acct1Lines.push(
        makeLine(i, {
          plan_name: 'Magenta for Business',
          plan_base_cents: 5500,
        }),
      );
      continue;
    }
    if (i === 5) {
      // Completed DPP: remaining=0, still being billed.
      acct1Lines.push(
        makeLine(i, {
          plan_name: 'Business Unlimited Advanced',
          plan_base_cents: 5500,
          dpp_installments: [makeDpp('iPhone 13 128GB', 2799, 0, 24)],
        }),
      );
      continue;
    }
    acct1Lines.push(
      makeLine(i, {
        plan_name: 'Business Unlimited Advanced',
        plan_base_cents: 5500,
      }),
    );
  }
  const acct1Total = acct1Lines.reduce(
    (acc, l) =>
      acc +
      (l.plan_base_cents ?? 0) +
      l.dpp_installments.reduce((a, d) => a + d.monthly_cents, 0),
    0,
  );
  const acct1: ExtractedAccount = {
    account_number_last4: '0001',
    label: 'TMobile Business — HQ',
    total_charges_cents: acct1Total,
    taxes_fees_cents: 5200,
    account_level_credits: [],
    lines: acct1Lines,
  };

  const acct2Lines: ExtractedLine[] = [];
  for (let i = 13; i < 25; i++) {
    if (i === 20) {
      acct2Lines.push(
        makeLine(i, {
          plan_name: 'Business Unlimited Ultimate',
          plan_base_cents: 6500,
          features: [makeFeature('Protection<360>', 'insurance', 1800)],
        }),
      );
      continue;
    }
    acct2Lines.push(
      makeLine(i, {
        plan_name: 'Business Unlimited Ultimate',
        plan_base_cents: 6500,
      }),
    );
  }
  const acct2Total = acct2Lines.reduce(
    (acc, l) =>
      acc + (l.plan_base_cents ?? 0) + l.features.reduce((a, f) => a + f.monthly_cents, 0),
    0,
  );
  const acct2: ExtractedAccount = {
    account_number_last4: '0002',
    label: 'TMobile Business — Field',
    total_charges_cents: acct2Total,
    taxes_fees_cents: 4800,
    account_level_credits: [],
    lines: acct2Lines,
  };

  return {
    carrier: 'tmobile',
    billing_period_start: '2026-04-10',
    billing_period_end: '2026-05-09',
    total_charges_cents: acct1Total + acct2Total,
    accounts: [acct1, acct2],
    notes: [
      'Synthetic fixture — large T-Mobile for Business bill (25 lines, 2 accounts).',
      'Includes a legacy Magenta plan name and a completed DPP still being billed for rule coverage.',
    ],
  };
}

type Fixture = {
  filename: string;
  bill: ExtractedBill;
};

const FIXTURES: readonly Fixture[] = [
  { filename: 'verizon-business-small.expected.json', bill: verizonBusinessSmall() },
  {
    filename: 'verizon-business-multi-account.expected.json',
    bill: verizonBusinessMultiAccount(),
  },
  { filename: 'att-business-medium.expected.json', bill: attBusinessMedium() },
  { filename: 'tmobile-business-large.expected.json', bill: tmobileBusinessLarge() },
];

async function main(): Promise<void> {
  await fs.mkdir(OUT_DIR, { recursive: true });

  let written = 0;
  for (const fixture of FIXTURES) {
    // Validate before writing — drift is a build-time error.
    const parsed = ExtractedBillSchema.safeParse(fixture.bill);
    if (!parsed.success) {
      const issues = JSON.stringify(parsed.error.issues, null, 2);
      throw new Error(
        `Fixture ${fixture.filename} failed schema validation:\n${issues}`,
      );
    }
    const outPath = path.join(OUT_DIR, fixture.filename);
    await fs.writeFile(outPath, `${JSON.stringify(parsed.data, null, 2)}\n`, 'utf8');
    written += 1;
  }

  process.stdout.write(`wrote ${written} fixtures\n`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`generate-fixtures failed: ${message}\n`);
  process.exit(1);
});
