-- Track the source format an audit was ingested from. Existing rows are 'pdf'
-- (the only path that existed before). New EDI 811 ingests use 'edi_811'.
-- The default keeps the column NOT NULL without backfilling existing rows.

alter table public.audits
  add column if not exists source_format text not null default 'pdf';

alter table public.audits
  drop constraint if exists audits_source_format_check;

alter table public.audits
  add constraint audits_source_format_check
  check (source_format in ('pdf', 'edi_811'));

-- An index is overkill for a 2-value enum; rules + reports never filter on it.
