-- 0033 — Slack notification integration.
--
-- Lets a user paste a Slack incoming-webhook URL and opt-in to receive a
-- message whenever:
--   * a high-severity finding is created (currently fired from the
--     /api/autopsy/drivers/[driverId]/escalate route — the single starter
--     emit site to keep blast radius small until we wire the rules-runner
--     persistence path), or
--   * a bill-comparison (autopsy) is persisted with a disputable amount
--     (fired from src/autopsy/persist.ts after the comparison row + drivers
--     have been written).
--
-- Columns are all additive and either nullable or default-truthy, so the
-- migration is backward-compatible and needs no backfill.
--
-- PII discipline: the webhook URL is the secret. We never log it, we never
-- include it in Inngest event payloads, and the dispatcher loads it fresh
-- from the profile row on every send. The Slack payload itself carries
-- counts + finding titles only — never MDNs, account numbers, or raw bill
-- text (see send-slack-notification.ts).
--
-- The CHECK constraint pins the URL to Slack's hooks domain so a leaked
-- webhook on this profile column can't be repurposed to drive arbitrary
-- outbound HTTP. The dispatcher additionally enforces the prefix at send
-- time, but defence-in-depth is cheap.

alter table public.profiles
  add column if not exists slack_webhook_url text,
  add column if not exists slack_notify_on_high_finding boolean not null default true,
  add column if not exists slack_notify_on_autopsy boolean not null default true;

alter table public.profiles
  drop constraint if exists profiles_slack_webhook_url_format;
alter table public.profiles
  add constraint profiles_slack_webhook_url_format
  check (
    slack_webhook_url is null
    or slack_webhook_url ~ '^https://hooks\.slack\.com/'
  );
