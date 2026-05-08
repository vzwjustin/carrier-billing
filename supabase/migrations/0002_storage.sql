-- CarrierAudit storage bucket + RLS policies
-- Source of truth: CLAUDE.md §6 Phase 1, task #2

-- Bucket --------------------------------------------------------------------

insert into storage.buckets (id, name, public)
  values ('bills', 'bills', false)
  on conflict (id) do nothing;

-- Policies ------------------------------------------------------------------
-- Path scheme: {userId}/{auditId}/{filename}
-- We enforce that the first folder of the path equals the caller's auth.uid().

drop policy if exists "users upload to own prefix" on storage.objects;
drop policy if exists "users read own bills" on storage.objects;
drop policy if exists "users update own bills" on storage.objects;
drop policy if exists "users delete own bills" on storage.objects;

create policy "users upload to own prefix" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'bills'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "users read own bills" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'bills'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "users update own bills" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'bills'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'bills'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "users delete own bills" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'bills'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Service role bypasses RLS by default; no policy required for workers.
