import { AutopsyClient } from '@/components/autopsy/autopsy-client';

export const dynamic = 'force-static';

export default function PreviewAutopsyPage(): React.JSX.Element {
  // Realistic fixture: a 3-account business audit where the current bill
  // jumped ~$843 over the prior period. Mirrors the example output in the
  // SignalAudit "Bill Increase Autopsy" spec section.
  const audit = {
    id: '00000000-0000-0000-0000-000000000001',
    carrier: 'verizon',
    billing_period_start: '2026-04-01',
    billing_period_end: '2026-04-30',
    total_charges_cents: 1287321,
    original_filename: 'verizon-business-april-2026.pdf',
  };

  const candidates = [
    {
      id: '00000000-0000-0000-0000-000000000002',
      billing_period_start: '2026-03-01',
      billing_period_end: '2026-03-31',
      total_charges_cents: 1203000,
      carrier: 'verizon',
      original_filename: 'verizon-business-march-2026.pdf',
    },
    {
      id: '00000000-0000-0000-0000-000000000003',
      billing_period_start: '2026-02-01',
      billing_period_end: '2026-02-28',
      total_charges_cents: 1186200,
      carrier: 'verizon',
      original_filename: 'verizon-business-february-2026.pdf',
    },
  ];

  const existing = {
    id: '11111111-1111-1111-1111-111111111111',
    previous_audit_id: candidates[0]!.id,
    current_audit_id: audit.id,
    previous_total_cents: 1203000,
    current_total_cents: 1287321,
    net_change_cents: 84321,
    percent_change_bps: 701,
    disputable_cents: 27450,
    optimization_cents: 14600,
    unexplained_cents: 4221,
    executive_summary: `The bill increased by $843.21 compared with the previous period.

Top drivers:
- +$312.00 from New device installments on 8 lines (+$312.00/mo)
- +$220.00 from 11 lines lost a recurring credit (+$220.00/mo)
- +$146.00 from International features changed on 3 lines (+$146.00/mo)
- +$98.00 from 2 new lines added
- +$67.21 from Taxes, surcharges, and admin fees changed (+$67.21)

We found $274.50 that appears potentially disputable.`,
    created_at: '2026-05-24T22:14:08.000Z',
  };

  const drivers = [
    {
      id: 'd1',
      category: 'device_installments_added',
      title: 'New device installments on 8 lines (+$312.00/mo)',
      summary:
        '8 lines started a new device payment agreement this cycle, adding $312.00/mo.',
      previous_cents: 0,
      current_cents: 31200,
      difference_cents: 31200,
      affected_lines_count: 8,
      confidence: 0.9,
      is_disputable: false,
      is_optimization: false,
      is_unexplained: false,
      recommended_action:
        'Confirm each new device installment maps to an approved equipment order and includes any promo trade-in credits negotiated up front.',
      evidence: {
        lines: Array.from({ length: 8 }, (_, i) => ({
          account_last4: i < 5 ? '7281' : '4419',
          mdn_last4: String(2100 + i),
          user_label: null,
          previous_cents: 0,
          current_cents: 3900,
          difference_cents: 3900,
          note: `New device installment: iPhone 16 ${i % 2 === 0 ? 'Pro' : ''}`.trim(),
        })),
      },
    },
    {
      id: 'd2',
      category: 'missing_credits',
      title: '11 lines lost a recurring credit (+$220.00/mo)',
      summary:
        '11 lines had a promotional credit drop off this cycle without a matching device payoff, disconnect, or plan change, adding $220.00/mo to the bill. This is the most common disputable pattern.',
      previous_cents: -22000,
      current_cents: 0,
      difference_cents: 22000,
      affected_lines_count: 11,
      confidence: 0.85,
      is_disputable: true,
      is_optimization: false,
      is_unexplained: false,
      recommended_action:
        'Open a carrier dispute requesting restoration of the credit going forward and a back-credit for the current cycle.',
      evidence: {
        lines: Array.from({ length: 11 }, (_, i) => ({
          account_last4: '7281',
          mdn_last4: String(3300 + i),
          user_label: null,
          previous_cents: -2000,
          current_cents: 0,
          difference_cents: 2000,
          note: 'Promo credit "BYOD Loyalty Bonus" (-$20.00/mo) is no longer on the bill',
        })),
      },
    },
    {
      id: 'd3',
      category: 'international_charges',
      title: 'International features changed on 3 lines (+$146.00/mo)',
      summary:
        '3 lines had international add-ons added, removed, or repriced (+$146.00/mo).',
      previous_cents: 0,
      current_cents: 14600,
      difference_cents: 14600,
      affected_lines_count: 3,
      confidence: 0.7,
      is_disputable: false,
      is_optimization: true,
      is_unexplained: false,
      recommended_action:
        'If a TravelPass / international plan was added without a corresponding trip, ask the carrier to remove and back-credit.',
      evidence: {
        lines: [
          { account_last4: '7281', mdn_last4: '4012', user_label: null, previous_cents: 0, current_cents: 7000, difference_cents: 7000, note: 'New feature "International Travel Pass"' },
          { account_last4: '7281', mdn_last4: '4188', user_label: null, previous_cents: 0, current_cents: 5000, difference_cents: 5000, note: 'New feature "Global Choice Mexico/Canada"' },
          { account_last4: '4419', mdn_last4: '5512', user_label: null, previous_cents: 0, current_cents: 2600, difference_cents: 2600, note: 'New feature "International Long Distance"' },
        ],
      },
    },
    {
      id: 'd4',
      category: 'new_lines',
      title: '2 new lines added',
      summary:
        '2 new wireless lines on the current bill added $98.00/mo.',
      previous_cents: 0,
      current_cents: 9800,
      difference_cents: 9800,
      affected_lines_count: 2,
      confidence: 0.9,
      is_disputable: false,
      is_optimization: false,
      is_unexplained: false,
      recommended_action:
        "Confirm each new line was approved by an authorized requester. If any weren't, ask the carrier to deactivate and credit back.",
      evidence: {
        lines: [
          { account_last4: '7281', mdn_last4: '8841', user_label: null, previous_cents: 0, current_cents: 5500, difference_cents: 5500, note: 'New line *8841 appeared' },
          { account_last4: '7281', mdn_last4: '8842', user_label: null, previous_cents: 0, current_cents: 4300, difference_cents: 4300, note: 'New line *8842 appeared' },
        ],
      },
    },
    {
      id: 'd5',
      category: 'taxes_fees_change',
      title: 'Taxes, surcharges, and admin fees changed (+$67.21)',
      summary:
        'Taxes, surcharges, and regulatory/admin fees rose by $67.21 this cycle.',
      previous_cents: 162400,
      current_cents: 169121,
      difference_cents: 6721,
      affected_lines_count: 0,
      confidence: 0.8,
      is_disputable: false,
      is_optimization: false,
      is_unexplained: false,
      recommended_action:
        'Tax/fee shifts are usually driven by underlying charges. If the change is disproportionate to the base bill change, escalate to your carrier rep.',
      evidence: {
        accounts: [
          { account_last4: '7281', previous_cents: 121000, current_cents: 126500, difference_cents: 5500 },
          { account_last4: '4419', previous_cents: 41400, current_cents: 42621, difference_cents: 1221 },
        ],
      },
    },
    {
      id: 'd6',
      category: 'suspended_line_still_billed',
      title: '1 suspended line still being billed (+$45.00/mo)',
      summary:
        '1 line is marked suspended on the current bill but is still being charged a plan fee, totaling $45.00/mo.',
      previous_cents: 0,
      current_cents: 4500,
      difference_cents: 4500,
      affected_lines_count: 1,
      confidence: 0.97,
      is_disputable: true,
      is_optimization: false,
      is_unexplained: false,
      recommended_action:
        'Dispute the suspended-line plan charges and request the carrier move them to the no-cost / vacation suspension tier.',
      evidence: {
        lines: [
          {
            account_last4: '7281',
            mdn_last4: '6677',
            user_label: null,
            previous_cents: 0,
            current_cents: 4500,
            difference_cents: 4500,
            note: 'Line marked suspended on current bill but still being charged plan fee',
          },
        ],
      },
    },
    {
      id: 'd7',
      category: 'unexplained',
      title: 'Unexplained change (+$42.21)',
      summary:
        '$42.21 of the bill change could not be categorized confidently.',
      previous_cents: 0,
      current_cents: 0,
      difference_cents: 4221,
      affected_lines_count: 0,
      confidence: 0.5,
      is_disputable: false,
      is_optimization: false,
      is_unexplained: true,
      recommended_action:
        'Manually review the unattributed amount. If the bill PDF is missing line-item detail, ask the carrier for a detail-level export and re-run the comparison.',
      evidence: {
        notes: [
          'Bill total moved by +$843.21 but categorized drivers explain only +$801.00. Residual = +$42.21.',
        ],
      },
    },
  ];

  return (
    <AutopsyClient
      audit={audit}
      candidates={candidates}
      existing={existing}
      drivers={drivers}
    />
  );
}
