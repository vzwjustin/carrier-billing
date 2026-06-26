-- Expand the audits.carrier CHECK domain to include US MVNOs and regional
-- carriers that show up on real-world SignalAudit deployments:
--
--   * uscellular  — US Cellular (regional, primarily Midwest/Northwest)
--   * spectrum    — Spectrum Mobile (Charter MVNO on Verizon's network)
--   * xfinity     — Xfinity Mobile (Comcast MVNO on Verizon's network)
--   * cricket     — Cricket Wireless (AT&T MVNO)
--
-- Detection is updated in src/extraction/detect.ts; the new carriers prefer
-- the MVNO label when both the MVNO and its underlying network appear in the
-- bill text (operators want to dispute against Spectrum, not Verizon).
--
-- No data backfill is needed — no existing rows carry these values. The
-- previous constraint (added in migration 0005) restricted to four values;
-- we drop and re-create with the expanded domain.

alter table public.audits
  drop constraint if exists audits_carrier_check;

alter table public.audits
  add constraint audits_carrier_check
    check (carrier is null or carrier in (
      'verizon',
      'att',
      'tmobile',
      'uscellular',
      'spectrum',
      'xfinity',
      'cricket',
      'unknown'
    ));
