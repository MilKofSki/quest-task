-- QuestTask milestone 2: server-verified challenges and atomic rewards.
begin;

create table public.challenges (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(btrim(title)) between 1 and 100),
  description text not null default '' check (char_length(description) <= 1000),
  rule_type text not null check (rule_type in ('tasks_total', 'tasks_in_day')),
  target_count integer not null check (target_count between 1 and 1000),
  difficulty_filter text check (difficulty_filter in ('easy', 'medium', 'hard')),
  reward_xp integer not null check (reward_xp between 0 and 10000),
  reward_coins integer not null check (reward_coins between 0 and 10000),
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  check (reward_xp + reward_coins > 0)
);
create index challenges_active_page on public.challenges(created_at desc, id desc) where archived_at is null;

create table public.completed_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete restrict,
  progress_epoch integer not null check (progress_epoch >= 1),
  challenge_id uuid not null references public.challenges(id) on delete restrict,
  claimed_at timestamptz not null default now(),
  reward_xp integer not null check (reward_xp >= 0),
  reward_coins integer not null check (reward_coins >= 0),
  operation_id uuid not null unique references private.operations(id) on delete restrict,
  unique(user_id, progress_epoch, challenge_id)
);
create index completed_challenges_user_epoch on public.completed_challenges(user_id, progress_epoch, claimed_at desc);

alter table private.economy_events drop constraint economy_events_source_id_fkey;
alter table private.economy_events drop constraint economy_events_reason_check;
alter table private.economy_events add constraint economy_events_reason_check
  check (reason in ('task_reward', 'challenge_reward'));

create function private.check_reward_source() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (new.reason = 'task_reward' and not exists (select 1 from public.tasks where id = new.source_id))
    or (new.reason = 'challenge_reward' and not exists (select 1 from public.challenges where id = new.source_id)) then
    raise exception 'VALIDATION_ERROR';
  end if;
  return new;
end;
$$;
create trigger check_reward_source before insert or update on private.economy_events
  for each row execute function private.check_reward_source();

create function private.keep_rewarded_task() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists(select 1 from private.economy_events where reason = 'task_reward' and source_id = old.id) then
    raise exception 'FORBIDDEN';
  end if;
  return old;
end;
$$;
create trigger keep_rewarded_task before delete on public.tasks
  for each row execute function private.keep_rewarded_task();

alter table public.challenges enable row level security;
alter table public.completed_challenges enable row level security;
revoke all on public.challenges, public.completed_challenges from public, anon, authenticated;
grant select on public.challenges, public.completed_challenges to authenticated;
create policy own_completed_challenges on public.completed_challenges for select to authenticated
  using (user_id = (select auth.uid()) and (select public.is_confirmed_user()));
create policy active_or_claimed_challenges on public.challenges for select to authenticated
  using ((select public.is_confirmed_user()) and (archived_at is null or exists (
    select 1 from public.completed_challenges cc join public.profiles p on p.id = cc.user_id
    where cc.challenge_id = challenges.id and cc.user_id = (select auth.uid())
      and cc.progress_epoch = p.progress_epoch
  )));

create function private.challenge_progress(p_challenge public.challenges, p_uid uuid, p_epoch integer)
returns integer language plpgsql stable security definer set search_path = '' as $$
declare v_progress integer;
begin
  if p_challenge.rule_type = 'tasks_total' then
    select count(*)::integer into v_progress from public.tasks t
      where t.user_id = p_uid and t.progress_epoch = p_epoch
        and t.completed_at >= p_challenge.created_at
        and (p_challenge.difficulty_filter is null or t.difficulty = p_challenge.difficulty_filter);
  else
    select coalesce(max(day_count), 0)::integer into v_progress from (
      select count(*) as day_count from public.tasks t
      where t.user_id = p_uid and t.progress_epoch = p_epoch
        and t.completed_at >= p_challenge.created_at
        and (p_challenge.difficulty_filter is null or t.difficulty = p_challenge.difficulty_filter)
      group by (t.completed_at at time zone 'Europe/Moscow')::date
    ) days;
  end if;
  return v_progress;
end;
$$;

create function public.get_challenge_progress(p_limit integer default 20, p_cursor uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_user(); v_profile public.profiles;
  v_cursor_at timestamptz; v_challenge public.challenges;
  v_progress integer; v_claimed boolean; v_items jsonb := '[]'::jsonb;
  v_count integer := 0; v_next uuid;
begin
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'VALIDATION_ERROR'; end if;
  select * into v_profile from public.profiles where id = v_uid;
  if not found then raise exception 'NOT_FOUND'; end if;
  if p_cursor is not null then
    select created_at into v_cursor_at from public.challenges where id = p_cursor and archived_at is null;
    if not found then raise exception 'VALIDATION_ERROR'; end if;
  end if;
  for v_challenge in
    select * from public.challenges c where c.archived_at is null
      and (p_cursor is null or (c.created_at, c.id) < (v_cursor_at, p_cursor))
    order by c.created_at desc, c.id desc limit p_limit + 1
  loop
    if v_count = p_limit then return jsonb_build_object('challenges', v_items,
      'next_cursor', v_next, 'server_time', clock_timestamp()); end if;
    v_progress := private.challenge_progress(v_challenge, v_uid, v_profile.progress_epoch);
    select exists(select 1 from public.completed_challenges cc
      where cc.user_id = v_uid and cc.progress_epoch = v_profile.progress_epoch
        and cc.challenge_id = v_challenge.id) into v_claimed;
    v_items := v_items || jsonb_build_array(to_jsonb(v_challenge) || jsonb_build_object(
      'progress', least(v_progress, v_challenge.target_count),
      'eligible', v_progress >= v_challenge.target_count, 'claimed', v_claimed));
    v_count := v_count + 1;
    v_next := v_challenge.id;
  end loop;
  return jsonb_build_object('challenges', v_items, 'next_cursor', null, 'server_time', clock_timestamp());
end;
$$;

create function public.claim_challenge(p_challenge_id uuid, p_expected_epoch integer, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_user(); v_profile public.profiles; v_challenge public.challenges;
  v_id uuid := gen_random_uuid(); v_payload jsonb; v_result jsonb; v_progress integer;
begin
  v_payload := jsonb_build_object('challenge_id', p_challenge_id, 'epoch', p_expected_epoch);
  v_result := private.replay_operation(p_request_id, 'claim_challenge', v_payload);
  if v_result is not null then return v_result; end if;
  if p_challenge_id is null or p_expected_epoch is null then raise exception 'VALIDATION_ERROR'; end if;
  select * into v_profile from public.profiles where id = v_uid for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if v_profile.progress_epoch <> p_expected_epoch then raise exception 'EPOCH_CHANGED'; end if;
  select * into v_challenge from public.challenges where id = p_challenge_id for update;
  if not found or v_challenge.archived_at is not null then raise exception 'NOT_FOUND'; end if;
  if exists(select 1 from public.completed_challenges where user_id = v_uid
      and progress_epoch = p_expected_epoch and challenge_id = p_challenge_id) then
    raise exception 'CHALLENGE_ALREADY_CLAIMED';
  end if;
  v_progress := private.challenge_progress(v_challenge, v_uid, p_expected_epoch);
  if v_progress < v_challenge.target_count then raise exception 'CHALLENGE_NOT_READY'; end if;
  update public.profiles set xp = xp + v_challenge.reward_xp, coins = coins + v_challenge.reward_coins
    where id = v_uid returning * into v_profile;
  v_result := jsonb_build_object('operation_id', v_id, 'replayed', false, 'superseded', false,
    'challenge_id', p_challenge_id, 'reward_xp', v_challenge.reward_xp, 'reward_coins', v_challenge.reward_coins);
  insert into private.operations(id, actor_id, request_id, operation_type, progress_epoch, payload, result)
    values(v_id, v_uid, p_request_id, 'claim_challenge', p_expected_epoch, v_payload, v_result);
  insert into public.completed_challenges(user_id, progress_epoch, challenge_id, reward_xp, reward_coins, operation_id)
    values(v_uid, p_expected_epoch, p_challenge_id, v_challenge.reward_xp, v_challenge.reward_coins, v_id);
  insert into private.economy_events(operation_id, user_id, progress_epoch, reason, source_id,
    delta_xp, delta_coins, balance_xp_after, balance_coins_after)
    values(v_id, v_uid, p_expected_epoch, 'challenge_reward', p_challenge_id,
      v_challenge.reward_xp, v_challenge.reward_coins, v_profile.xp, v_profile.coins);
  return v_result;
end;
$$;

insert into public.challenges(title, description, rule_type, target_count, difficulty_filter, reward_xp, reward_coins)
values
  ('Первая кровь', 'Выполни три задачи за один день по Москве.', 'tasks_in_day', 3, null, 100, 50),
  ('Марафон продуктивности', 'Выполни одну сложную задачу.', 'tasks_total', 1, 'hard', 150, 75);

revoke all on function private.check_reward_source() from public, anon, authenticated;
revoke all on function private.keep_rewarded_task() from public, anon, authenticated;
revoke all on function private.challenge_progress(public.challenges,uuid,integer) from public, anon, authenticated;
revoke all on function public.get_challenge_progress(integer,uuid) from public, anon, authenticated;
revoke all on function public.claim_challenge(uuid,integer,uuid) from public, anon, authenticated;
grant execute on function public.get_challenge_progress(integer,uuid) to authenticated;
grant execute on function public.claim_challenge(uuid,integer,uuid) to authenticated;
commit;
