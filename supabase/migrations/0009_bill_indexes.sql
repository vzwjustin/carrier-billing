-- Performance indexes for bill_* child tables.
--
-- Every report render fans `select * where audit_id = ?` against five child
-- tables (bill_accounts, bill_lines, bill_features, bill_credits,
-- bill_dpp_installments). Only `bill_lines.audit_id` had an index until now.
-- bill_lines also gets `account_id` indexed because rule runners and report
-- aggregations group lines by account.
--
-- NOTE: Supabase migrations run inside a transaction, so `concurrently` is
-- intentionally NOT used here.

create index if not exists bill_features_audit_id_idx
  on public.bill_features (audit_id);

create index if not exists bill_credits_audit_id_idx
  on public.bill_credits (audit_id);

create index if not exists bill_dpp_installments_audit_id_idx
  on public.bill_dpp_installments (audit_id);

create index if not exists bill_lines_account_id_idx
  on public.bill_lines (account_id);
