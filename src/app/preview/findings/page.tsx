import { FindingCard } from '@/components/report/finding-card';
import type { Finding } from '@/rules/types';

export const dynamic = 'force-static';

const AUDIT_ID = '00000000-0000-0000-0000-000000000001';

const FINDINGS: Finding[] = [
  {
    id: 'f-1',
    rule_id: 'missing_recurring_credit',
    severity: 'high',
    title: 'Promotional credit "BYOD Loyalty Bonus" expired on 2026-04-15',
    description:
      'This $25.00/mo account-level credit expired during the current cycle and is no longer applied. The next bill will be $25.00/mo higher unless a renewal credit is in place.',
    recommended_action:
      'Contact your carrier representative to negotiate a renewal or replacement promotional credit. Ask for a back-credit covering any periods billed after expiration.',
    estimated_monthly_savings_cents: 2500,
    confidence: 0.95,
    affected_line_indexes: [],
    affected_account_indexes: [0],
    evidence: { credit_name: 'BYOD Loyalty Bonus', expires_on: '2026-04-15' },
    status: 'in_review',
  },
  {
    id: 'f-2',
    rule_id: 'suspended_line_billed',
    severity: 'high',
    title: 'Suspended line still has a plan charge',
    description:
      'Line *6677 is marked suspended but is still being charged $45.00/mo for plan access. Suspended lines should typically be at zero or a minimal seasonal rate.',
    recommended_action:
      'Decide whether to cancel the line outright (eliminating the charge) or move it to the carrier\'s no-cost / vacation suspension tier.',
    estimated_monthly_savings_cents: 4500,
    confidence: 0.97,
    affected_line_indexes: [12],
    affected_account_indexes: [0],
    evidence: { plan_base_cents: 4500, is_suspended: true },
    status: 'approved',
  },
  {
    id: 'f-3',
    rule_id: 'completed_device_payment_still_billed',
    severity: 'medium',
    title: 'Device payment for "iPhone 13" is complete but still billing',
    description:
      'The device payment plan for "iPhone 13" on line *2222 has 0 remaining payments out of 36 — the device should be paid off. The $27.99/mo installment line should drop off automatically; if it persists, dispute for back-credit.',
    recommended_action:
      'Confirm the device payoff in your carrier portal. If the installment line is still present on the next bill, dispute the charge and request a credit for the current cycle.',
    estimated_monthly_savings_cents: 2799,
    confidence: 0.9,
    affected_line_indexes: [3],
    affected_account_indexes: [0],
    evidence: { device: 'iPhone 13', remaining_payments: 0, total_payments: 36 },
    status: 'new',
  },
  {
    id: 'f-4',
    rule_id: 'redundant_hotspot_addon',
    severity: 'medium',
    title: 'Paid hotspot add-on on a plan that already includes hotspot',
    description:
      'Line *4188 is on "Business Unlimited Plus 2.0" — which already includes 50 GB of mobile hotspot — but is also being charged $20.00/mo for an extra Mobile Hotspot add-on.',
    recommended_action:
      'Ask your carrier rep to remove the redundant add-on SOC and back-credit any cycles billed after the plan upgrade.',
    estimated_monthly_savings_cents: 2000,
    confidence: 0.75,
    affected_line_indexes: [7],
    affected_account_indexes: [0],
    evidence: {
      plan_name: 'Business Unlimited Plus 2.0',
      addons: [{ name: 'Mobile Hotspot 30GB', monthly_cents: 2000 }],
    },
    status: 'disputed',
  },
  {
    id: 'f-5',
    rule_id: 'zero_usage_phone_line',
    severity: 'medium',
    title: 'Line shows zero usage but still billed $45.00/mo',
    description:
      'Line *8841 recorded 0 voice minutes, 0 SMS, and 0 GB of data this billing period while still being charged $45.00/mo for plan access. The most common cause is a line that was never deactivated when an employee left.',
    recommended_action:
      'Confirm the device is in service. If the line is not in use, cancel it or move it to the carrier\'s vacation/suspension tier.',
    estimated_monthly_savings_cents: 4500,
    confidence: 0.85,
    affected_line_indexes: [15],
    affected_account_indexes: [0],
    evidence: { mdn_last4: '8841', data_used_gb: 0, voice_used_min: 0 },
    status: 'rejected',
  },
];

export default function PreviewFindingsPage(): React.JSX.Element {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-neutral-900">
          Finding cards — all 6 reviewer statuses
        </h1>
        <p className="mt-1 text-sm text-neutral-600">
          The status dropdown is what landed in PR #24 (reviewer workflow). On
          the public <code>/share/[token]</code> surface the badge renders
          read-only and the dropdown is omitted.
        </p>
      </div>
      <div className="space-y-3">
        {FINDINGS.map((f) => (
          <FindingCard key={f.id} finding={f} auditId={AUDIT_ID} />
        ))}
      </div>
      <div className="border-t border-neutral-200 pt-6">
        <h2 className="text-lg font-semibold text-neutral-900">Read-only (public share)</h2>
        <p className="mt-1 text-sm text-neutral-600">
          Same card, but <code>isPublic</code> hides the interactive control.
        </p>
        <div className="mt-3">
          <FindingCard finding={FINDINGS[0]!} isPublic />
        </div>
      </div>
    </div>
  );
}
