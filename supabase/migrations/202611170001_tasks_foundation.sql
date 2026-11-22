-- QuestTask v2, milestone 1. Apply to a NEW Supabase project as postgres.
-- Client mutations must use RPC. This migration intentionally has no admin RPC.
begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
revoke create on schema public from public, anon, authenticated;
alter default privileges revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon, authenticated;
alter default privileges in schema private revoke execute on functions from anon, authenticated;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete restrict,
  nickname text not null check (char_length(btrim(nickname)) between 2 and 40),
  role text not null default 'user' check (role in ('user', 'admin')),
  xp bigint not null default 0 check (xp between 0 and 9007199254740991),
  coins bigint not null default 0 check (coins between 0 and 9007199254740991),
  progress_epoch integer not null default 1 check (progress_epoch >= 1),
  epoch_started_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete restrict,
  progress_epoch integer not null check (progress_epoch >= 1),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  difficulty text not null check (difficulty in ('easy', 'medium', 'hard')),
  created_at timestamptz not null default now(),
  completed_at timestamptz check (completed_at >= created_at),
  archived_at timestamptz
);
create index tasks_user_page on public.tasks(user_id, progress_epoch, created_at desc, id);
create index tasks_completion on public.tasks(user_id, progress_epoch, completed_at, difficulty);

create table private.operations (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references public.profiles(id),
  request_id uuid not null,
  operation_type text not null,
  progress_epoch integer not null,
  payload jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  unique(actor_id, request_id)
);
create table private.economy_events (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null references private.operations(id),
  user_id uuid not null references public.profiles(id),
  progress_epoch integer not null,
  reason text not null check (reason = 'task_reward'),
  source_id uuid not null references public.tasks(id),
  delta_xp bigint not null,
  delta_coins bigint not null,
  balance_xp_after bigint not null,
  balance_coins_after bigint not null,
  created_at timestamptz not null default now(),
  unique(operation_id, reason),
  unique(user_id, progress_epoch, reason, source_id)
);

alter table public.profiles enable row level security;
alter table public.tasks enable row level security;
alter table private.operations enable row level security;
alter table private.economy_events enable row level security;
revoke all on public.profiles, public.tasks from public, anon, authenticated;
revoke all on private.operations, private.economy_events from public, anon, authenticated;
grant select on public.profiles, public.tasks to authenticated;

create function private.require_user() returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  if not exists (select 1 from auth.users where id = v_uid and email_confirmed_at is not null) then
    raise exception 'EMAIL_NOT_CONFIRMED';
  end if;
  return v_uid;
end;
$$;

-- A deliberately narrow public predicate: no parameters, no other user's data.
create function public.is_confirmed_user() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from auth.users where id = auth.uid() and email_confirmed_at is not null);
$$;
create policy own_profile on public.profiles for select to authenticated
  using (id = (select auth.uid()) and (select public.is_confirmed_user()));
create policy own_tasks on public.tasks for select to authenticated
  using (user_id = (select auth.uid()) and (select public.is_confirmed_user()));

create function private.clean_text(p_text text) returns text
language sql immutable set search_path = '' as $$
  select regexp_replace(p_text, '^[[:space:]]+|[[:space:]]+$', '', 'g');
$$;

create function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_nickname text := private.clean_text(coalesce(new.raw_user_meta_data->>'nickname', 'Игрок'));
begin
  if char_length(v_nickname) not between 2 and 40 then raise exception 'VALIDATION_ERROR'; end if;
  insert into public.profiles(id, nickname) values(new.id, v_nickname);
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

-- Lock before checking; the lock lives until the caller's transaction ends.
create function private.replay_operation(p_request_id uuid, p_kind text, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_user(); v_op private.operations; v_epoch integer;
begin
  if p_request_id is null then raise exception 'VALIDATION_ERROR'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_uid::text || ':' || p_request_id::text, 0));
  select * into v_op from private.operations where actor_id = v_uid and request_id = p_request_id;
  if found then
    if v_op.operation_type <> p_kind or v_op.payload <> p_payload then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
    select progress_epoch into v_epoch from public.profiles where id = v_uid;
    return v_op.result || jsonb_build_object('replayed', true, 'superseded', v_op.progress_epoch <> v_epoch);
  end if;
  return null;
end;
$$;

create function public.create_task(p_title text, p_difficulty text, p_expected_epoch integer, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_user(); v_profile public.profiles; v_task public.tasks;
  v_id uuid := gen_random_uuid(); v_payload jsonb; v_result jsonb;
begin
  v_payload := jsonb_build_object('title', private.clean_text(p_title), 'difficulty', p_difficulty, 'epoch', p_expected_epoch);
  v_result := private.replay_operation(p_request_id, 'create_task', v_payload);
  if v_result is not null then return v_result; end if;
  if p_title is null or char_length(private.clean_text(p_title)) not between 1 and 200 or p_difficulty is null
    or p_difficulty not in ('easy', 'medium', 'hard') or p_expected_epoch is null then raise exception 'VALIDATION_ERROR'; end if;
  select * into v_profile from public.profiles where id = v_uid for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if v_profile.progress_epoch <> p_expected_epoch then raise exception 'EPOCH_CHANGED'; end if;
  insert into public.tasks(user_id, progress_epoch, title, difficulty)
    values(v_uid, v_profile.progress_epoch, private.clean_text(p_title), p_difficulty) returning * into v_task;
  v_result := jsonb_build_object('operation_id', v_id, 'replayed', false, 'superseded', false, 'task', to_jsonb(v_task));
  insert into private.operations(id, actor_id, request_id, operation_type, progress_epoch, payload, result)
    values(v_id, v_uid, p_request_id, 'create_task', v_profile.progress_epoch, v_payload, v_result);
  return v_result;
end;
$$;

create function public.complete_task(p_task_id uuid, p_expected_epoch integer, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_user(); v_profile public.profiles; v_task public.tasks;
  v_id uuid := gen_random_uuid(); v_payload jsonb; v_result jsonb; v_xp integer; v_coins integer;
begin
  v_payload := jsonb_build_object('task_id', p_task_id, 'epoch', p_expected_epoch);
  v_result := private.replay_operation(p_request_id, 'complete_task', v_payload);
  if v_result is not null then return v_result; end if;
  if p_task_id is null or p_expected_epoch is null then raise exception 'VALIDATION_ERROR'; end if;
  select * into v_profile from public.profiles where id = v_uid for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if v_profile.progress_epoch <> p_expected_epoch then raise exception 'EPOCH_CHANGED'; end if;
  select * into v_task from public.tasks where id = p_task_id and user_id = v_uid
    and progress_epoch = v_profile.progress_epoch and archived_at is null for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if v_task.completed_at is not null then raise exception 'TASK_ALREADY_COMPLETED'; end if;
  v_xp := case v_task.difficulty when 'easy' then 10 when 'medium' then 25 else 50 end;
  v_coins := case v_task.difficulty when 'easy' then 5 when 'medium' then 15 else 30 end;
  update public.tasks set completed_at = clock_timestamp() where id = v_task.id returning * into v_task;
  update public.profiles set xp = xp + v_xp, coins = coins + v_coins where id = v_uid returning * into v_profile;
  v_result := jsonb_build_object('operation_id', v_id, 'replayed', false, 'superseded', false,
    'task', to_jsonb(v_task), 'reward_xp', v_xp, 'reward_coins', v_coins);
  insert into private.operations(id, actor_id, request_id, operation_type, progress_epoch, payload, result)
    values(v_id, v_uid, p_request_id, 'complete_task', v_profile.progress_epoch, v_payload, v_result);
  insert into private.economy_events(operation_id, user_id, progress_epoch, reason, source_id,
    delta_xp, delta_coins, balance_xp_after, balance_coins_after)
    values(v_id, v_uid, v_profile.progress_epoch, 'task_reward', v_task.id, v_xp, v_coins, v_profile.xp, v_profile.coins);
  return v_result;
end;
$$;

create function public.archive_task(p_task_id uuid, p_expected_epoch integer, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_user(); v_profile public.profiles; v_task public.tasks;
  v_id uuid := gen_random_uuid(); v_payload jsonb; v_result jsonb;
begin
  v_payload := jsonb_build_object('task_id', p_task_id, 'epoch', p_expected_epoch);
  v_result := private.replay_operation(p_request_id, 'archive_task', v_payload);
  if v_result is not null then return v_result; end if;
  if p_task_id is null or p_expected_epoch is null then raise exception 'VALIDATION_ERROR'; end if;
  select * into v_profile from public.profiles where id = v_uid for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if v_profile.progress_epoch <> p_expected_epoch then raise exception 'EPOCH_CHANGED'; end if;
  select * into v_task from public.tasks where id = p_task_id and user_id = v_uid
    and progress_epoch = v_profile.progress_epoch for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  update public.tasks set archived_at = coalesce(archived_at, clock_timestamp()) where id = v_task.id returning * into v_task;
  v_result := jsonb_build_object('operation_id', v_id, 'replayed', false, 'superseded', false, 'task', to_jsonb(v_task));
  insert into private.operations(id, actor_id, request_id, operation_type, progress_epoch, payload, result)
    values(v_id, v_uid, p_request_id, 'archive_task', v_profile.progress_epoch, v_payload, v_result);
  return v_result;
end;
$$;

create function public.get_operation(p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_user(); v_op private.operations; v_epoch integer;
begin
  select * into v_op from private.operations where actor_id = v_uid and request_id = p_request_id;
  if not found then raise exception 'NOT_FOUND'; end if;
  select progress_epoch into v_epoch from public.profiles where id = v_uid;
  return v_op.result || jsonb_build_object('replayed', true, 'superseded', v_op.progress_epoch <> v_epoch);
end;
$$;

-- Explicit allowlist, including the predicate used by RLS. No private helper grants.
revoke all on function public.is_confirmed_user() from public, anon, authenticated;
revoke all on function public.create_task(text,text,integer,uuid) from public, anon, authenticated;
revoke all on function public.complete_task(uuid,integer,uuid) from public, anon, authenticated;
revoke all on function public.archive_task(uuid,integer,uuid) from public, anon, authenticated;
revoke all on function public.get_operation(uuid) from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function public.is_confirmed_user() to authenticated;
grant execute on function public.create_task(text,text,integer,uuid) to authenticated;
grant execute on function public.complete_task(uuid,integer,uuid) to authenticated;
grant execute on function public.archive_task(uuid,integer,uuid) to authenticated;
grant execute on function public.get_operation(uuid) to authenticated;
commit;
