-- Persist the bill-level extraction confidence so the report viewer can warn
-- operators when the savings figures rest on a low-confidence parse.
--
-- The extraction pipeline already computes this signal: `llm.ts` starts every
-- bill at 'high' and downgrades one tier (high→medium→low) when a post-extract
-- sanity check fails (e.g. the printed total doesn't reconcile with the summed
-- line components, or OCR fallback was needed). Until now that signal was
-- thrown away after extraction — never persisted, never shown. This column
-- carries it through to the UI.
--
-- Nullable with no default: existing rows (extracted before this column) stay
-- NULL and the viewer treats NULL the same as 'high' (no banner). New audits
-- always write a value via the mark-analyzing step in process-bill.ts.

alter table public.audits
  add column if not exists extraction_confidence text;

alter table public.audits
  drop constraint if exists audits_extraction_confidence_check;

alter table public.audits
  add constraint audits_extraction_confidence_check
  check (
    extraction_confidence is null
    or extraction_confidence in ('high', 'medium', 'low')
  );

-- No index: reports load a single audit by primary key and never filter on
-- confidence.
