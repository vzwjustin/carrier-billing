import type { ContractTerms, ContractWithTerms } from '@/contracts/schema';
import { getAdminClient } from '@/lib/supabase/admin';

type LoadContractsLogger = {
  warn: (message: string, ctx?: Record<string, unknown>) => void;
};

/**
 * Best-effort load of the user's parsed contracts for rules that join bill
 * lines against contracted rates (`contract_rate_mismatch`). Returns an empty
 * array when the table is missing or the query fails so the rest of the rules
 * engine still runs.
 */
export async function loadParsedContractsForUser(
  userId: string,
  logger?: LoadContractsLogger,
): Promise<ContractWithTerms[]> {
  try {
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from('contracts')
      .select(
        'id,carrier,ban_last4,effective_date,expiration_date,status,contract_terms(plan_name,contracted_monthly_rate_cents,discount_percentage_bps,waived_fees,promo_credit_cents,promo_duration_months,device_credit_terms,line_minimums,upgrade_fee_rules,activation_fee_rules,international_package_terms,early_termination_terms,notes)',
      )
      .eq('user_id', userId)
      .eq('status', 'parsed');
    if (error) {
      logger?.warn('loadParsedContractsForUser failed (continuing without)', {
        userId,
        message: error.message,
      });
      return [];
    }
    const rows = (data ?? []) as Array<{
      id: string;
      carrier: string | null;
      ban_last4: string | null;
      effective_date: string | null;
      expiration_date: string | null;
      contract_terms: ContractTerms[] | ContractTerms | null;
    }>;
    return rows.map<ContractWithTerms>((r) => {
      const termsField = r.contract_terms;
      const terms = Array.isArray(termsField) ? (termsField[0] ?? null) : (termsField ?? null);
      return {
        id: r.id,
        carrier: r.carrier,
        ban_last4: r.ban_last4,
        effective_date: r.effective_date,
        expiration_date: r.expiration_date,
        terms,
      };
    });
  } catch (loadErr) {
    logger?.warn('loadParsedContractsForUser threw (continuing without)', {
      userId,
      message: loadErr instanceof Error ? loadErr.message : 'unknown error',
    });
    return [];
  }
}
