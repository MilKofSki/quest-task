-- Run once as the database owner, after all migrations and after confirming
-- the intended account in Authentication > Users. Never expose this as RPC.
begin;
do $$
declare
  v_admin_id uuid := '00000000-0000-0000-0000-000000000000'; -- Replace with confirmed auth.users.id.
begin
  if v_admin_id = '00000000-0000-0000-0000-000000000000' then
    raise exception 'Replace v_admin_id before running';
  end if;
  if exists (select 1 from public.profiles where role = 'admin') then
    raise exception 'An administrator already exists; use admin_set_role instead';
  end if;
  if not exists (select 1 from auth.users where id = v_admin_id and email_confirmed_at is not null)
    or not exists (select 1 from public.profiles where id = v_admin_id) then
    raise exception 'Confirmed account with profile not found';
  end if;
  update public.profiles set role = 'admin' where id = v_admin_id;
end;
$$;
commit;
