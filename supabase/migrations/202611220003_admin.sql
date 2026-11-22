-- QuestTask milestone 4: role-checked administration and epoch reset.
begin;

alter table private.operations add column target_user_id uuid references public.profiles(id) on delete restrict;
create index profiles_role on public.profiles(role);

create table private.admin_audit (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null unique references private.operations(id) on delete restrict,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  action text not null,
  target_id uuid not null,
  before_data jsonb,
  after_data jsonb,
  reason text,
  created_at timestamptz not null default now()
);
alter table private.admin_audit enable row level security;
revoke all on private.admin_audit from public, anon, authenticated;

create function private.immutable_challenge() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if to_jsonb(new) - 'archived_at' <> to_jsonb(old) - 'archived_at'
    or (old.archived_at is not null and new.archived_at is distinct from old.archived_at) then
    raise exception 'FORBIDDEN';
  end if;
  return new;
end;
$$;
create trigger immutable_challenge before update on public.challenges
  for each row execute function private.immutable_challenge();

alter table private.economy_events drop constraint economy_events_reason_check;
alter table private.economy_events add constraint economy_events_reason_check
  check (reason in ('task_reward', 'challenge_reward', 'purchase', 'reset'));
create or replace function private.check_reward_source() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (new.reason = 'task_reward' and not exists (select 1 from public.tasks where id = new.source_id))
    or (new.reason = 'challenge_reward' and not exists (select 1 from public.challenges where id = new.source_id))
    or (new.reason = 'purchase' and not exists (select 1 from public.shop_items where id = new.source_id))
    or (new.reason = 'reset' and not exists (select 1 from public.profiles where id = new.source_id)) then
    raise exception 'VALIDATION_ERROR';
  end if;
  return new;
end;
$$;

create function private.require_admin() returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := private.require_user();
begin
  if not exists (select 1 from public.profiles where id = v_uid and role = 'admin') then
    raise exception 'FORBIDDEN';
  end if;
  return v_uid;
end;
$$;

create function private.admin_start(p_request_id uuid, p_kind text, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_result jsonb;
begin
  v_result := private.replay_operation(p_request_id, p_kind, p_payload);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('questtask:admin-management', 0));
  perform private.require_admin();
  return v_result;
end;
$$;

create function public.admin_create_challenge(
  p_title text, p_description text, p_rule_type text, p_target_count integer,
  p_difficulty_filter text, p_reward_xp integer, p_reward_coins integer, p_request_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := private.require_user(); v_challenge public.challenges; v_op_id uuid := gen_random_uuid();
  v_payload jsonb; v_result jsonb; v_epoch integer;
begin
  v_payload := jsonb_build_object('title', private.clean_text(p_title), 'description', coalesce(p_description,''),
    'rule_type', p_rule_type, 'target_count', p_target_count, 'difficulty_filter', p_difficulty_filter,
    'reward_xp', p_reward_xp, 'reward_coins', p_reward_coins);
  v_result := private.admin_start(p_request_id, 'admin_create_challenge', v_payload);
  if v_result is not null then return v_result; end if;
  if p_title is null or char_length(private.clean_text(p_title)) not between 1 and 100
    or p_description is null or char_length(p_description) > 1000
    or p_rule_type is null or p_rule_type not in ('tasks_total','tasks_in_day')
    or p_target_count is null or p_target_count not between 1 and 1000
    or (p_difficulty_filter is not null and p_difficulty_filter not in ('easy','medium','hard'))
    or p_reward_xp is null or p_reward_xp not between 0 and 10000
    or p_reward_coins is null or p_reward_coins not between 0 and 10000
    or p_reward_xp + p_reward_coins <= 0 then raise exception 'VALIDATION_ERROR'; end if;
  select progress_epoch into v_epoch from public.profiles where id = v_actor;
  insert into public.challenges(title, description, rule_type, target_count, difficulty_filter, reward_xp, reward_coins)
    values(private.clean_text(p_title), p_description, p_rule_type, p_target_count,
      p_difficulty_filter, p_reward_xp, p_reward_coins) returning * into v_challenge;
  v_result := jsonb_build_object('operation_id', v_op_id, 'replayed', false, 'challenge', to_jsonb(v_challenge));
  insert into private.operations(id, actor_id, request_id, operation_type, progress_epoch, payload, result)
    values(v_op_id, v_actor, p_request_id, 'admin_create_challenge', v_epoch, v_payload, v_result);
  insert into private.admin_audit(operation_id, actor_id, action, target_id, after_data)
    values(v_op_id, v_actor, 'create_challenge', v_challenge.id, to_jsonb(v_challenge));
  return v_result;
end;
$$;

create function public.admin_archive_challenge(p_challenge_id uuid, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := private.require_user(); v_challenge public.challenges; v_before jsonb;
  v_op_id uuid := gen_random_uuid(); v_payload jsonb; v_result jsonb; v_epoch integer;
begin
  v_payload := jsonb_build_object('challenge_id', p_challenge_id);
  v_result := private.admin_start(p_request_id, 'admin_archive_challenge', v_payload);
  if v_result is not null then return v_result; end if;
  if p_challenge_id is null then raise exception 'VALIDATION_ERROR'; end if;
  select * into v_challenge from public.challenges where id = p_challenge_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  v_before := to_jsonb(v_challenge);
  if v_challenge.archived_at is null then
    update public.challenges set archived_at = clock_timestamp() where id = p_challenge_id returning * into v_challenge;
  end if;
  select progress_epoch into v_epoch from public.profiles where id = v_actor;
  v_result := jsonb_build_object('operation_id', v_op_id, 'replayed', false, 'challenge', to_jsonb(v_challenge));
  insert into private.operations(id, actor_id, request_id, operation_type, progress_epoch, payload, result)
    values(v_op_id, v_actor, p_request_id, 'admin_archive_challenge', v_epoch, v_payload, v_result);
  if v_before->>'archived_at' is null then
    insert into private.admin_audit(operation_id, actor_id, action, target_id, before_data, after_data)
      values(v_op_id, v_actor, 'archive_challenge', p_challenge_id, v_before, to_jsonb(v_challenge));
  end if;
  return v_result;
end;
$$;

create function public.admin_create_item(p_title text, p_icon text, p_price integer,
  p_type text, p_bonus_xp integer, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := private.require_user(); v_item public.shop_items; v_op_id uuid := gen_random_uuid();
  v_payload jsonb; v_result jsonb; v_epoch integer;
begin
  v_payload := jsonb_build_object('title', private.clean_text(p_title), 'icon', p_icon,
    'price', p_price, 'type', p_type, 'bonus_xp', p_bonus_xp);
  v_result := private.admin_start(p_request_id, 'admin_create_item', v_payload);
  if v_result is not null then return v_result; end if;
  if p_title is null or char_length(private.clean_text(p_title)) not between 1 and 100
    or p_icon is null or char_length(private.clean_text(p_icon)) not between 1 and 16
    or p_icon ~ '[<>]' or p_price is null or p_price not between 1 and 100000
    or p_type is null or p_type not in ('badge','bonus') or p_bonus_xp is null
    or (p_type = 'badge' and p_bonus_xp <> 0)
    or (p_type = 'bonus' and p_bonus_xp not between 1 and 10000) then raise exception 'VALIDATION_ERROR'; end if;
  select progress_epoch into v_epoch from public.profiles where id = v_actor;
  insert into public.shop_items(title, icon, price, type, bonus_xp)
    values(private.clean_text(p_title), p_icon, p_price, p_type, p_bonus_xp) returning * into v_item;
  v_result := jsonb_build_object('operation_id', v_op_id, 'replayed', false, 'item', to_jsonb(v_item));
  insert into private.operations(id, actor_id, request_id, operation_type, progress_epoch, payload, result)
    values(v_op_id, v_actor, p_request_id, 'admin_create_item', v_epoch, v_payload, v_result);
  insert into private.admin_audit(operation_id, actor_id, action, target_id, after_data)
    values(v_op_id, v_actor, 'create_item', v_item.id, to_jsonb(v_item));
  return v_result;
end;
$$;

create function public.admin_archive_item(p_item_id uuid, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := private.require_user(); v_item public.shop_items; v_before jsonb;
  v_op_id uuid := gen_random_uuid(); v_payload jsonb; v_result jsonb; v_epoch integer;
begin
  v_payload := jsonb_build_object('item_id', p_item_id);
  v_result := private.admin_start(p_request_id, 'admin_archive_item', v_payload);
  if v_result is not null then return v_result; end if;
  if p_item_id is null then raise exception 'VALIDATION_ERROR'; end if;
  select * into v_item from public.shop_items where id = p_item_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  v_before := to_jsonb(v_item);
  if v_item.archived_at is null then
    update public.shop_items set archived_at = clock_timestamp() where id = p_item_id returning * into v_item;
  end if;
  select progress_epoch into v_epoch from public.profiles where id = v_actor;
  v_result := jsonb_build_object('operation_id', v_op_id, 'replayed', false, 'item', to_jsonb(v_item));
  insert into private.operations(id, actor_id, request_id, operation_type, progress_epoch, payload, result)
    values(v_op_id, v_actor, p_request_id, 'admin_archive_item', v_epoch, v_payload, v_result);
  if v_before->>'archived_at' is null then
    insert into private.admin_audit(operation_id, actor_id, action, target_id, before_data, after_data)
      values(v_op_id, v_actor, 'archive_item', p_item_id, v_before, to_jsonb(v_item));
  end if;
  return v_result;
end;
$$;

create function public.admin_set_role(p_target_user_id uuid, p_new_role text, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := private.require_user(); v_target public.profiles; v_op_id uuid := gen_random_uuid();
  v_payload jsonb; v_result jsonb; v_epoch integer;
begin
  v_payload := jsonb_build_object('target_user_id', p_target_user_id, 'new_role', p_new_role);
  v_result := private.admin_start(p_request_id, 'admin_set_role', v_payload);
  if v_result is not null then return v_result; end if;
  if p_target_user_id is null or p_new_role is null or p_new_role not in ('user','admin') then
    raise exception 'VALIDATION_ERROR'; end if;
  if p_target_user_id = v_actor then raise exception 'SELF_ROLE_CHANGE'; end if;
  select * into v_target from public.profiles where id = p_target_user_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if v_target.role = 'admin' and p_new_role = 'user'
    and (select count(*) from public.profiles where role = 'admin') <= 1 then raise exception 'LAST_ADMIN'; end if;
  select progress_epoch into v_epoch from public.profiles where id = v_actor;
  if v_target.role <> p_new_role then
    update public.profiles set role = p_new_role where id = p_target_user_id;
  end if;
  v_result := jsonb_build_object('operation_id', v_op_id, 'replayed', false,
    'target_user_id', p_target_user_id, 'role', p_new_role);
  insert into private.operations(id, actor_id, request_id, operation_type, target_user_id, progress_epoch, payload, result)
    values(v_op_id, v_actor, p_request_id, 'admin_set_role', p_target_user_id, v_epoch, v_payload, v_result);
  if v_target.role <> p_new_role then
    insert into private.admin_audit(operation_id, actor_id, action, target_id, before_data, after_data)
      values(v_op_id, v_actor, 'set_role', p_target_user_id,
        jsonb_build_object('role', v_target.role), jsonb_build_object('role', p_new_role));
  end if;
  return v_result;
end;
$$;

create function public.admin_reset_progress(p_target_user_id uuid, p_expected_epoch integer,
  p_reason text, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := private.require_user(); v_target public.profiles; v_op_id uuid := gen_random_uuid();
  v_payload jsonb; v_result jsonb; v_actor_epoch integer; v_reason text := private.clean_text(p_reason);
begin
  v_payload := jsonb_build_object('target_user_id', p_target_user_id, 'expected_epoch', p_expected_epoch,
    'reason', v_reason);
  v_result := private.admin_start(p_request_id, 'admin_reset_progress', v_payload);
  if v_result is not null then return v_result; end if;
  if p_target_user_id is null or p_expected_epoch is null or p_reason is null
    or char_length(v_reason) not between 3 and 300 then raise exception 'VALIDATION_ERROR'; end if;
  select progress_epoch into v_actor_epoch from public.profiles where id = v_actor;
  select * into v_target from public.profiles where id = p_target_user_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if v_target.progress_epoch <> p_expected_epoch then raise exception 'EPOCH_CHANGED'; end if;
  update public.profiles set xp = 0, coins = 0, active_badge_id = null,
    progress_epoch = progress_epoch + 1, epoch_started_at = clock_timestamp()
    where id = p_target_user_id;
  v_result := jsonb_build_object('operation_id', v_op_id, 'replayed', false,
    'target_user_id', p_target_user_id, 'progress_epoch', p_expected_epoch + 1);
  insert into private.operations(id, actor_id, request_id, operation_type, target_user_id, progress_epoch, payload, result)
    values(v_op_id, v_actor, p_request_id, 'admin_reset_progress', p_target_user_id, v_actor_epoch, v_payload, v_result);
  insert into private.economy_events(operation_id, user_id, progress_epoch, reason, source_id,
    delta_xp, delta_coins, balance_xp_after, balance_coins_after)
    values(v_op_id, p_target_user_id, p_expected_epoch + 1, 'reset', p_target_user_id,
      -v_target.xp, -v_target.coins, 0, 0);
  insert into private.admin_audit(operation_id, actor_id, action, target_id, before_data, after_data, reason)
    values(v_op_id, v_actor, 'reset_progress', p_target_user_id,
      jsonb_build_object('epoch', v_target.progress_epoch, 'xp', v_target.xp, 'coins', v_target.coins,
        'active_badge_id', v_target.active_badge_id),
      jsonb_build_object('epoch', p_expected_epoch + 1, 'xp', 0, 'coins', 0, 'active_badge_id', null), v_reason);
  return v_result;
end;
$$;

create function public.admin_list_users(p_limit integer default 20, p_cursor uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_cursor_at timestamptz; v_row record; v_items jsonb := '[]'::jsonb;
  v_count integer := 0; v_next uuid;
begin
  perform private.require_admin();
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'VALIDATION_ERROR'; end if;
  if p_cursor is not null then
    select created_at into v_cursor_at from public.profiles where id = p_cursor;
    if not found then raise exception 'VALIDATION_ERROR'; end if;
  end if;
  for v_row in select p.id, p.nickname, u.email, p.role, p.xp, p.coins,
      p.progress_epoch, p.created_at from public.profiles p join auth.users u on u.id = p.id
    where p_cursor is null or (p.created_at, p.id) < (v_cursor_at, p_cursor)
    order by p.created_at desc, p.id desc limit p_limit + 1 loop
    v_count := v_count + 1;
    if v_count > p_limit then exit; end if;
    v_items := v_items || jsonb_build_array(jsonb_build_object('id', v_row.id,
      'nickname', v_row.nickname, 'email', v_row.email, 'role', v_row.role,
      'xp', v_row.xp, 'coins', v_row.coins, 'progress_epoch', v_row.progress_epoch,
      'level', (v_row.xp / 100) + 1, 'created_at', v_row.created_at));
    v_next := v_row.id;
  end loop;
  return jsonb_build_object('users', v_items, 'next_cursor', case when v_count > p_limit then v_next else null end);
end;
$$;

create function public.admin_list_challenges(p_limit integer default 20, p_cursor uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_cursor_at timestamptz; v_row public.challenges; v_items jsonb := '[]'::jsonb;
  v_count integer := 0; v_next uuid;
begin
  perform private.require_admin();
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'VALIDATION_ERROR'; end if;
  if p_cursor is not null then
    select created_at into v_cursor_at from public.challenges where id = p_cursor;
    if not found then raise exception 'VALIDATION_ERROR'; end if;
  end if;
  for v_row in select * from public.challenges
    where p_cursor is null or (created_at, id) < (v_cursor_at, p_cursor)
    order by created_at desc, id desc limit p_limit + 1 loop
    v_count := v_count + 1;
    if v_count > p_limit then exit; end if;
    v_items := v_items || jsonb_build_array(to_jsonb(v_row));
    v_next := v_row.id;
  end loop;
  return jsonb_build_object('challenges', v_items, 'next_cursor', case when v_count > p_limit then v_next else null end);
end;
$$;

create function public.admin_list_items(p_limit integer default 20, p_cursor uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_cursor_at timestamptz; v_row public.shop_items; v_items jsonb := '[]'::jsonb;
  v_count integer := 0; v_next uuid;
begin
  perform private.require_admin();
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'VALIDATION_ERROR'; end if;
  if p_cursor is not null then
    select created_at into v_cursor_at from public.shop_items where id = p_cursor;
    if not found then raise exception 'VALIDATION_ERROR'; end if;
  end if;
  for v_row in select * from public.shop_items
    where p_cursor is null or (created_at, id) < (v_cursor_at, p_cursor)
    order by created_at desc, id desc limit p_limit + 1 loop
    v_count := v_count + 1;
    if v_count > p_limit then exit; end if;
    v_items := v_items || jsonb_build_array(to_jsonb(v_row));
    v_next := v_row.id;
  end loop;
  return jsonb_build_object('items', v_items, 'next_cursor', case when v_count > p_limit then v_next else null end);
end;
$$;

revoke all on function public.admin_create_challenge(text,text,text,integer,text,integer,integer,uuid) from public, anon, authenticated;
revoke all on function public.admin_archive_challenge(uuid,uuid) from public, anon, authenticated;
revoke all on function public.admin_create_item(text,text,integer,text,integer,uuid) from public, anon, authenticated;
revoke all on function public.admin_archive_item(uuid,uuid) from public, anon, authenticated;
revoke all on function public.admin_set_role(uuid,text,uuid) from public, anon, authenticated;
revoke all on function public.admin_reset_progress(uuid,integer,text,uuid) from public, anon, authenticated;
revoke all on function public.admin_list_users(integer,uuid) from public, anon, authenticated;
revoke all on function public.admin_list_challenges(integer,uuid) from public, anon, authenticated;
revoke all on function public.admin_list_items(integer,uuid) from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function public.admin_create_challenge(text,text,text,integer,text,integer,integer,uuid) to authenticated;
grant execute on function public.admin_archive_challenge(uuid,uuid) to authenticated;
grant execute on function public.admin_create_item(text,text,integer,text,integer,uuid) to authenticated;
grant execute on function public.admin_archive_item(uuid,uuid) to authenticated;
grant execute on function public.admin_set_role(uuid,text,uuid) to authenticated;
grant execute on function public.admin_reset_progress(uuid,integer,text,uuid) to authenticated;
grant execute on function public.admin_list_users(integer,uuid) to authenticated;
grant execute on function public.admin_list_challenges(integer,uuid) to authenticated;
grant execute on function public.admin_list_items(integer,uuid) to authenticated;
commit;
