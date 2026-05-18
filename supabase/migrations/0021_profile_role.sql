-- Profile role -------------------------------------------------------------
-- Adds a coarse role for the admin panel. Default 'user'; 'admin' is granted
-- explicitly (via the admin panel's role-promotion action, performed by an
-- existing admin, or manually by an operator for the first admin).
--
-- RLS note: the existing "own profile update" policy lets a user update their
-- own row. To prevent a user self-promoting to admin via a crafted client,
-- a trigger forbids non-service-role role changes. Admin-panel promotions go
-- through the service-role client after a server-side admin check.

alter table public.profiles
  add column if not exists role text not null default 'user'
    check (role in ('user', 'admin'));

create or replace function public.forbid_self_role_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role
     and auth.role() <> 'service_role' then
    raise exception 'role changes are not permitted from this context';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_forbid_self_role_change on public.profiles;
create trigger profiles_forbid_self_role_change
  before update on public.profiles
  for each row execute function public.forbid_self_role_change();
