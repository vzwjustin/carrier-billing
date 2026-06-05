import type { Metadata } from 'next';
import Link from 'next/link';

import { formatRulesForDocs, type DocsRuleEntry } from '@/lib/docs/rules-list';
import type { Carrier } from '@/extraction/schema';
import { ALL_RULES } from '@/rules/registry';

export const dynamic = 'force-static';

export const metadata: Metadata = {
  title: 'Rules engine — CarrierAudit docs',
  description:
    'Every audit rule CarrierAudit runs against your wireless bill, grouped by the confidence band that drives the rendered severity badge.',
};

const CARRIER_LABELS: Record<Carrier, string> = {
  verizon: 'Verizon',
  att: 'AT&T',
  tmobile: 'T-Mobile',
  uscellular: 'U.S. Cellular',
  spectrum: 'Spectrum',
  xfinity: 'Xfinity',
  cricket: 'Cricket',
  unknown: 'Unknown',
};

type ConfidenceBand = 'high' | 'medium' | 'low' | 'info';

interface BandSection {
  band: ConfidenceBand;
  heading: string;
  blurb: string;
  ruleIds: ReadonlySet<string>;
}

/**
 * Hand-picked grouping into the confidence/severity band each rule most
 * commonly emits. Rules can fire at any severity at runtime — this page
 * just gives readers a quick way to understand which signals are
 * load-bearing versus advisory. If a rule isn't listed in any band it
 * falls into "Info / advisory" by default.
 */
const HIGH_BAND_IDS: ReadonlySet<string> = new Set([
  'expired_promo_credit',
  'completed_device_payment_still_billed',
  'suspended_line_billed',
  'insurance_after_device_payoff',
  'contract_rate_mismatch',
  'duplicate_device_installment_same_line',
  'account_total_mismatch',
  'duplicate_charge_within_audit',
  'duplicate_charge_across_accounts',
]);

const MEDIUM_BAND_IDS: ReadonlySet<string> = new Set([
  'orphan_insurance',
  'duplicate_protection_features',
  'account_level_promo_about_to_expire',
  'activation_fee_outsized',
  'redundant_hotspot_addon',
  'zero_usage_phone_line',
  'unused_mifi_or_jetpack_line',
  'tablet_watch_with_zero_usage',
  'dpp_exceeds_plan_base',
  'line_with_only_credits',
  'high_cost_low_usage_phone',
  'underutilized_phone_on_premium_plan',
  'legacy_unlimited_plan',
  'bill_increase_over_threshold_in_total',
]);

const LOW_BAND_IDS: ReadonlySet<string> = new Set([
  'stale_international_feature',
  'stranded_cloud_storage',
  'data_overage_pattern',
  'activation_fee_on_existing_line',
  'line_charge_outlier_within_account',
  'disproportionate_taxes_fees',
  'account_taxes_fees_low_anomaly',
  'feature_appears_on_majority_of_lines_under_one_dollar',
  'feature_first_seen',
  'unassigned_user_label',
  'promo_credit_expires_before_device_payoff',
]);

const BAND_ORDER: ConfidenceBand[] = ['high', 'medium', 'low', 'info'];

const BAND_BLURB: Record<ConfidenceBand, string> = {
  high: 'Load-bearing findings. The evidence is structural — a credit with a date in the past, a DPP with zero remaining payments, a suspended line that still has a plan charge. Act on these first.',
  medium:
    'Strong signals that usually have real money behind them, but benefit from a quick human review of the affected lines before you take action.',
  low: 'Lower-confidence patterns worth a glance. The rule found a shape worth investigating; the savings number is conservative.',
  info: 'Informational only. No recommended action — these surface so you can sanity-check the extracted bill against your own expectations.',
};

const BAND_HEADING: Record<ConfidenceBand, string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
  info: 'Info / advisory',
};

function bandForRule(id: string): ConfidenceBand {
  if (HIGH_BAND_IDS.has(id)) return 'high';
  if (MEDIUM_BAND_IDS.has(id)) return 'medium';
  if (LOW_BAND_IDS.has(id)) return 'low';
  return 'info';
}

function renderAppliesTo(appliesTo: DocsRuleEntry['appliesTo']): string {
  if (appliesTo === 'all') return 'All carriers';
  return appliesTo.map((c) => CARRIER_LABELS[c]).join(', ');
}

export default function DocsRulesPage(): React.ReactElement {
  const rules = formatRulesForDocs(ALL_RULES);

  const sections: BandSection[] = BAND_ORDER.map((band) => {
    // ⚡ Bolt: Single-pass filter & map avoids two intermediate array instantiations
    const ruleIds = new Set<string>();
    for (const r of rules) {
      if (bandForRule(r.id) === band) {
        ruleIds.add(r.id);
      }
    }

    return {
      band,
      heading: BAND_HEADING[band],
      blurb: BAND_BLURB[band],
      ruleIds,
    };
  });

  return (
    <div className="flex flex-col gap-10 text-neutral-700">
      <header className="flex flex-col gap-3">
        <span className="text-xs font-semibold tracking-wide text-neutral-500 uppercase">
          Rules engine
        </span>
        <h1 className="text-3xl font-semibold tracking-tight text-neutral-900 sm:text-4xl">
          What the audit looks for
        </h1>
        <p className="max-w-2xl text-sm sm:text-base">
          Every audit runs the same registered rule set against your extracted bill. Each rule emits
          findings with a confidence score; the rendered severity badge on a finding card is a
          function of that confidence and the affected dollar amount.
        </p>
        <p className="max-w-2xl text-sm sm:text-base">
          {rules.length} rules are currently registered, sorted by stable id below.
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold text-neutral-900">How confidence drives the badge</h2>
        <p>
          Confidence is a normalized 0&ndash;1 score the rule emits. The report UI bins it into
          three labels &mdash; <strong>Speculative</strong> below 0.5, <strong>Likely</strong>{' '}
          through 0.8, and <strong>High confidence</strong> above. We combine that with dollar
          impact to render the colored severity badge you see on each finding card. The same scale
          is used across every rule, so comparing badges across findings is meaningful.
        </p>
      </section>

      {sections.map((section) => {
        const sectionRules = rules.filter((r) => section.ruleIds.has(r.id));
        if (sectionRules.length === 0) return null;
        return (
          <section
            key={section.band}
            className="flex flex-col gap-4"
            aria-labelledby={`band-${section.band}`}
          >
            <div className="flex flex-col gap-2">
              <h2 id={`band-${section.band}`} className="text-xl font-semibold text-neutral-900">
                {section.heading}{' '}
                <span className="text-sm font-normal text-neutral-500">
                  &middot; {sectionRules.length} rule
                  {sectionRules.length === 1 ? '' : 's'}
                </span>
              </h2>
              <p className="max-w-3xl text-sm text-neutral-600">{section.blurb}</p>
            </div>
            <ul className="flex flex-col divide-y divide-neutral-200 rounded-xl border border-neutral-200 bg-white">
              {sectionRules.map((rule) => (
                <li
                  key={rule.id}
                  className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6"
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-sm font-medium text-neutral-900">{rule.title}</span>
                    <code className="truncate text-xs text-neutral-500">{rule.id}</code>
                  </div>
                  <span className="shrink-0 text-xs text-neutral-500 sm:text-right">
                    {renderAppliesTo(rule.appliesTo)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold text-neutral-900">What to do with a finding</h2>
        <p>
          High-severity findings usually warrant a{' '}
          <Link
            href="/docs/dispute-packets"
            className="text-neutral-900 underline underline-offset-2 hover:text-neutral-700"
          >
            dispute packet
          </Link>{' '}
          straight to your carrier rep. Medium-severity findings tend to drive plan-level
          optimization conversations. Low and info bands stay in the report as a paper trail.
        </p>
      </section>
    </div>
  );
}
