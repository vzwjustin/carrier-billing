-- Widen the source_format CHECK constraint to allow 'csv' ingests in addition
-- to 'pdf' (the default) and 'edi_811'. The CSV import wizard (Phase 5)
-- creates audits with source_format='csv' so the rules engine + reports can
-- tag the ingest path without sniffing the original filename.
--
-- This is a constraint-only change; no data rewrite. Existing rows keep
-- their value.

alter table public.audits
  drop constraint if exists audits_source_format_check;

alter table public.audits
  add constraint audits_source_format_check
  check (source_format in ('pdf', 'edi_811', 'csv'));
