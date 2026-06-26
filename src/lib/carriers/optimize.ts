import type { LineItem } from './bill-schema';
import type { Carrier } from './types';

// ---------------------------------------------------------------------------
// Deterministic carrier bill optimization + validation engine.
//
// Pure functions, no I/O — safe to run on the client. Heuristics are
// description-based and intentionally conservative (a suggestion never raises
// a charge). Mirrors the product's audit-rules philosophy: each rule is
// isolated and individually testable.
// ---------------------------------------------------------------------------

export type Severity = 'high' | 'medium' | 'low';

export interface OptimizationSuggestion {
  lineItemId: string;
  ruleId: string;
  rationale: string;
  severity: Severity;
  currentCents: number;
  suggestedCents: number;
}

export interface ValidationIssue {
  lineItemId: string | null;
  ruleId: string;
  message: string;
  level: 'error' | 'warning';
}

export interface OptimizationResult {
  suggestions: OptimizationSuggestion[];
  issues: ValidationIssue[];
  projectedSavingsCents: number;
}

function matches(desc: string, re: RegExp): boolean {
  return re.test(desc);
}

// --- Validation ------------------------------------------------------------

export function validateBill(carrier: Carrier, lineItems: LineItem[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const li of lineItems) {
    if (li.description.trim().length === 0) {
      issues.push({
        lineItemId: li.id,
        ruleId: 'empty_description',
        message: 'Line item is missing a description.',
        level: 'error',
      });
    }
    if (li.monthlyCents < 0 || li.optimizedCents < 0) {
      issues.push({
        lineItemId: li.id,
        ruleId: 'negative_amount',
        message: 'Amounts cannot be negative.',
        level: 'error',
      });
    }
    if (li.optimizedCents > li.monthlyCents) {
      issues.push({
        lineItemId: li.id,
        ruleId: 'optimized_exceeds_current',
        message: 'Optimized amount is higher than the current amount.',
        level: 'warning',
      });
    }
  }

  // Carrier-specific sanity bound: a single residential wireless line item
  // above $500/mo almost always indicates a data-entry error.
  const ceilingCents = carrier === 'tmobile' ? 400_00 : 500_00;
  for (const li of lineItems) {
    if (li.monthlyCents > ceilingCents) {
      issues.push({
        lineItemId: li.id,
        ruleId: 'amount_exceeds_carrier_ceiling',
        message: `Unusually high for ${carrier} — double-check this amount.`,
        level: 'warning',
      });
    }
  }

  return issues;
}

// --- Optimization rules ----------------------------------------------------

function genericSuggestions(lineItems: LineItem[]): OptimizationSuggestion[] {
  const out: OptimizationSuggestion[] = [];

  // Duplicate device protection: keep the first, suggest removing the rest.
  const protection = lineItems.filter((li) =>
    matches(li.description, /\b(device protection|insurance|protect(ion)? plan)\b/i),
  );
  protection.slice(1).forEach((li) => {
    if (li.monthlyCents > 0) {
      out.push({
        lineItemId: li.id,
        ruleId: 'duplicate_device_protection',
        rationale: 'Multiple device-protection charges detected; typically only one is needed.',
        severity: 'medium',
        currentCents: li.monthlyCents,
        suggestedCents: 0,
      });
    }
  });

  // Over-provisioned premium unlimited tier.
  for (const li of lineItems) {
    if (
      matches(li.description, /unlimited\s+(elite|premium|ultimate|plus)/i) &&
      li.monthlyCents > 90_00
    ) {
      out.push({
        lineItemId: li.id,
        ruleId: 'premium_unlimited_overprovisioned',
        rationale: 'Premium unlimited tier — most users are well served by the standard tier.',
        severity: 'low',
        currentCents: li.monthlyCents,
        suggestedCents: 80_00,
      });
    }
  }

  return out;
}

function carrierSuggestions(carrier: Carrier, lineItems: LineItem[]): OptimizationSuggestion[] {
  const out: OptimizationSuggestion[] = [];
  const rule = (
    li: LineItem,
    ruleId: string,
    rationale: string,
    severity: Severity,
    suggestedCents: number,
  ): void => {
    if (li.monthlyCents > suggestedCents) {
      out.push({
        lineItemId: li.id,
        ruleId,
        rationale,
        severity,
        currentCents: li.monthlyCents,
        suggestedCents,
      });
    }
  };

  for (const li of lineItems) {
    if (carrier === 'verizon' && matches(li.description, /verizon cloud|cloud storage/i)) {
      rule(
        li,
        'verizon_cloud_unused',
        'Verizon Cloud is frequently unused and duplicates free phone backup.',
        'low',
        0,
      );
    }
    if (carrier === 'att' && matches(li.description, /\bnext ?up\b|upgrade program/i)) {
      rule(
        li,
        'att_nextup_optional',
        'AT&T Next Up early-upgrade add-on is optional and often unused.',
        'low',
        0,
      );
    }
    if (carrier === 'tmobile' && matches(li.description, /netflix|apple tv\+?|paramount\+?/i)) {
      rule(
        li,
        'tmobile_bundled_streaming_duplicate',
        'Bundled streaming perk may duplicate a subscription you already pay for.',
        'low',
        0,
      );
    }
  }

  return out;
}

export function optimizeBill(carrier: Carrier, lineItems: LineItem[]): OptimizationResult {
  const suggestions = [...genericSuggestions(lineItems), ...carrierSuggestions(carrier, lineItems)];
  const projectedSavingsCents = suggestions.reduce(
    (sum, s) => sum + Math.max(0, s.currentCents - s.suggestedCents),
    0,
  );
  return {
    suggestions,
    issues: validateBill(carrier, lineItems),
    projectedSavingsCents,
  };
}
