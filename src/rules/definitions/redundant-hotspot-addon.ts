import type { Rule, Finding } from '../types';
import { formatCents, isHotspotDevice } from '../helpers';

const RULE_ID = 'redundant_hotspot_addon';

// Plan-name tier markers that include some level of mobile-hotspot allotment
// on all three major carriers' current business unlimited stacks:
//   - Verizon Business Unlimited Plus / Pro / Ultimate 2.0 → 50–150 GB MHS
//   - AT&T Business Unlimited Performance / Premium → 30–100 GB MHS
//   - T-Mobile Business Unlimited Advanced / Ultimate+ → 50–100 GB MHS
// "Starter"/"Start"/"Starter" tiers usually do NOT include hotspot and are
// excluded. A line on a starter plan paying for a hotspot add-on is legit.
const PREMIUM_TIER_RE = /\b(pro|premium|plus|advanced|ultimate|elite|performance)\b/i;

// Feature-name markers that look like a redundant hotspot add-on rather than
// a true MiFi/Jetpack device line (which is its own line and is excluded via
// isHotspotDevice). Phrases vary across carrier billing engines, hence the
// permissive alternation. Excludes "international hotspot" since that's a
// roaming-only feature distinct from domestic MHS.
const HOTSPOT_FEATURE_RE = /\b(mobile\s*hotspot|hotspot\s*data|mhs|tether|tethering)\b/i;
const INTL_FEATURE_RE = /\binternational\b/i;

export const redundantHotspotAddonRule: Rule = {
  id: RULE_ID,
  title: 'Hotspot add-on stacked on a plan that already includes hotspot',
  appliesTo: 'all',
  evaluate: ({ bill }) => {
    const findings: Finding[] = [];

    bill.accounts.forEach((account, accountIndex) => {
      account.lines.forEach((line, lineIndex) => {
        // The MiFi/Jetpack/Inseego case is a separate product and handled by
        // `unused_mifi_or_jetpack_line` — don't double-flag.
        if (isHotspotDevice(line.device)) return;
        if (line.plan_name === null) return;
        if (!PREMIUM_TIER_RE.test(line.plan_name)) return;

        const hotspotAddons = line.features.filter((f) => {
          if (INTL_FEATURE_RE.test(f.name)) return false;
          return HOTSPOT_FEATURE_RE.test(f.name);
        });
        if (hotspotAddons.length === 0) return;
        // Only flag PAID add-ons. Some carriers print a $0 hotspot feature
        // row that just documents the plan-included allotment — flagging
        // that would be noise.
        const billed = hotspotAddons.filter((f) => f.monthly_cents > 0);
        if (billed.length === 0) return;

        const total = billed.reduce((sum, f) => sum + f.monthly_cents, 0);
        const names = billed.map((f) => f.name).join(', ');

        findings.push({
          rule_id: RULE_ID,
          severity: 'medium',
          title: `Paid hotspot add-on on a plan that already includes hotspot`,
          description: `This line is on "${line.plan_name}", which already includes a mobile-hotspot data allotment, but is also being charged ${formatCents(total)}/mo for ${billed.length === 1 ? 'the add-on' : 'add-ons'} (${names}). Carriers commonly attach a hotspot SOC at activation that should be removed once the plan is upgraded to a tier that bundles hotspot data.`,
          recommended_action:
            "Confirm the line's monthly hotspot usage against the plan's included allotment. If usage fits, ask your carrier rep to remove the redundant add-on SOC (Service Order Code) and back-credit any cycles billed after the plan upgrade.",
          estimated_monthly_savings_cents: total,
          // Strong signal (plan tier name + named add-on) but we cannot
          // verify actual hotspot consumption from the bill, so this stays
          // in the "likely" bucket rather than "high confidence".
          confidence: 0.75,
          affected_line_indexes: [lineIndex],
          affected_account_indexes: [accountIndex],
          evidence: {
            plan_name: line.plan_name,
            addons: billed.map((f) => ({
              name: f.name,
              monthly_cents: f.monthly_cents,
            })),
            total_addon_monthly_cents: total,
          },
        });
      });
    });

    return findings;
  },
};
