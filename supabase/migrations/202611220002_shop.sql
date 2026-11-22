-- QuestTask milestone 3: atomic purchases, badge inventory and equipped titles.
begin;

create table public.shop_items (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(btrim(title)) between 1 and 100),
  icon text not null check (char_length(btrim(icon)) between 1 and 16 and icon !~ '[<>]'),
  price integer not null check (price between 1 and 100000),
  type text not null check (type in ('badge', 'bonus')),
  bonus_xp integer not null default 0 check (bonus_xp between 0 and 10000),
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  check ((type = 'badge' and bonus_xp = 0) or (type = 'bonus' and bonus_xp between 1 and 10000))
);
create index shop_items_active_page on public.shop_items(created_at desc, id desc) where archived_at is null;

create table public.purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete restrict,
  progress_epoch integer not null check (progress_epoch >= 1),
  item_id uuid not null references public.shop_items(id) on delete restrict,
  operation_id uuid not null unique references private.operations(id) on delete restrict,
  paid_coins integer not null check (paid_coins between 1 and 100000),
  granted_xp integer not null check (granted_xp between 0 and 10000),
  item_type text not null check (item_type in ('badge', 'bonus')),
  created_at timestamptz not null default now(),
  check ((item_type = 'badge' and granted_xp = 0) or (item_type = 'bonus' and granted_xp > 0))
);
create index purchases_user_epoch on public.purchases(user_id, progress_epoch, created_at desc);

create table public.user_inventory (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete restrict,
  progress_epoch integer not null check (progress_epoch >= 1),
  item_id uuid not null references public.shop_items(id) on delete restrict,
  purchase_id uuid not null unique references public.purchases(id) on delete restrict,
  purchased_at timestamptz not null default now(),
  unique(user_id, progress_epoch, item_id)
);
create index user_inventory_user_epoch on public.user_inventory(user_id, progress_epoch, purchased_at desc);
alter table public.profiles add column active_badge_id uuid references public.user_inventory(id) on delete restrict;

create function private.validate_inventory() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.purchases p join public.shop_items i on i.id = p.item_id
    where p.id = new.purchase_id and p.user_id = new.user_id
      and p.progress_epoch = new.progress_epoch and p.item_id = new.item_id
      and p.item_type = 'badge' and i.type = 'badge'
  ) then raise exception 'VALIDATION_ERROR'; end if;
  return new;
end;
$$;
create trigger validate_inventory before insert or update on public.user_inventory
  for each row execute function private.validate_inventory();

create function private.validate_active_badge() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.active_badge_id is not null and not exists (
    select 1 from public.user_inventory i where i.id = new.active_badge_id
      and i.user_id = new.id and i.progress_epoch = new.progress_epoch
  ) then raise exception 'BADGE_NOT_OWNED'; end if;
  return new;
end;
$$;
create trigger validate_active_badge before insert or update on public.profiles
  for each row execute function private.validate_active_badge();

create function private.immutable_shop_item() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if to_jsonb(new) - 'archived_at' <> to_jsonb(old) - 'archived_at'
    or (old.archived_at is not null and new.archived_at is distinct from old.archived_at) then
    raise exception 'FORBIDDEN';
  end if;
  return new;
end;
$$;
create trigger immutable_shop_item before update on public.shop_items
  for each row execute function private.immutable_shop_item();

alter table public.shop_items enable row level security;
alter table public.purchases enable row level security;
alter table public.user_inventory enable row level security;
revoke all on public.shop_items, public.purchases, public.user_inventory from public, anon, authenticated;
grant select on public.shop_items, public.purchases, public.user_inventory to authenticated;
create policy own_purchases on public.purchases for select to authenticated
  using (user_id = (select auth.uid()) and (select public.is_confirmed_user()));
create policy own_inventory on public.user_inventory for select to authenticated
  using (user_id = (select auth.uid()) and (select public.is_confirmed_user()));
create policy active_or_purchased_items on public.shop_items for select to authenticated
  using ((select public.is_confirmed_user()) and (archived_at is null or exists (
    select 1 from public.purchases p where p.item_id = shop_items.id and p.user_id = (select auth.uid())
  )));

alter table private.economy_events drop constraint economy_events_user_id_progress_epoch_reason_source_id_key;
create unique index economy_unique_rewards on private.economy_events(user_id, progress_epoch, reason, source_id)
  where reason in ('task_reward', 'challenge_reward');
alter table private.economy_events drop constraint economy_events_reason_check;
alter table private.economy_events add constraint economy_events_reason_check
  check (reason in ('task_reward', 'challenge_reward', 'purchase'));
create or replace function private.check_reward_source() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (new.reason = 'task_reward' and not exists (select 1 from public.tasks where id = new.source_id))
    or (new.reason = 'challenge_reward' and not exists (select 1 from public.challenges where id = new.source_id))
    or (new.reason = 'purchase' and not exists (select 1 from public.shop_items where id = new.source_id)) then
    raise exception 'VALIDATION_ERROR';
  end if;
  return new;
end;
$$;

create function public.buy_item(p_item_id uuid, p_expected_epoch integer, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_user(); v_profile public.profiles; v_item public.shop_items;
  v_op_id uuid := gen_random_uuid(); v_purchase_id uuid := gen_random_uuid(); v_inventory_id uuid;
  v_payload jsonb; v_result jsonb;
begin
  v_payload := jsonb_build_object('item_id', p_item_id, 'epoch', p_expected_epoch);
  v_result := private.replay_operation(p_request_id, 'buy_item', v_payload);
  if v_result is not null then return v_result; end if;
  if p_item_id is null or p_expected_epoch is null then raise exception 'VALIDATION_ERROR'; end if;
  select * into v_profile from public.profiles where id = v_uid for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if v_profile.progress_epoch <> p_expected_epoch then raise exception 'EPOCH_CHANGED'; end if;
  select * into v_item from public.shop_items where id = p_item_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if v_item.archived_at is not null then raise exception 'ITEM_ARCHIVED'; end if;
  if v_item.type = 'badge' and exists (
    select 1 from public.user_inventory where user_id = v_uid
      and progress_epoch = p_expected_epoch and item_id = p_item_id
  ) then raise exception 'ITEM_ALREADY_OWNED'; end if;
  if v_profile.coins < v_item.price then raise exception 'INSUFFICIENT_COINS'; end if;
  if v_item.type = 'badge' then v_inventory_id := gen_random_uuid(); end if;
  update public.profiles set coins = coins - v_item.price,
    xp = xp + case when v_item.type = 'bonus' then v_item.bonus_xp else 0 end
    where id = v_uid returning * into v_profile;
  v_result := jsonb_build_object('operation_id', v_op_id, 'replayed', false, 'superseded', false,
    'purchase_id', v_purchase_id, 'inventory_id', v_inventory_id, 'item_id', v_item.id,
    'item_type', v_item.type, 'paid_coins', v_item.price,
    'granted_xp', case when v_item.type = 'bonus' then v_item.bonus_xp else 0 end);
  insert into private.operations(id, actor_id, request_id, operation_type, progress_epoch, payload, result)
    values(v_op_id, v_uid, p_request_id, 'buy_item', p_expected_epoch, v_payload, v_result);
  insert into public.purchases(id, user_id, progress_epoch, item_id, operation_id, paid_coins, granted_xp, item_type)
    values(v_purchase_id, v_uid, p_expected_epoch, v_item.id, v_op_id, v_item.price,
      case when v_item.type = 'bonus' then v_item.bonus_xp else 0 end, v_item.type);
  if v_item.type = 'badge' then
    insert into public.user_inventory(id, user_id, progress_epoch, item_id, purchase_id)
      values(v_inventory_id, v_uid, p_expected_epoch, v_item.id, v_purchase_id);
  end if;
  insert into private.economy_events(operation_id, user_id, progress_epoch, reason, source_id,
    delta_xp, delta_coins, balance_xp_after, balance_coins_after)
    values(v_op_id, v_uid, p_expected_epoch, 'purchase', v_item.id,
      case when v_item.type = 'bonus' then v_item.bonus_xp else 0 end,
      -v_item.price, v_profile.xp, v_profile.coins);
  return v_result;
end;
$$;

create function public.equip_badge(p_inventory_id uuid, p_expected_epoch integer, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_user(); v_profile public.profiles;
  v_op_id uuid := gen_random_uuid(); v_payload jsonb; v_result jsonb;
begin
  v_payload := jsonb_build_object('inventory_id', p_inventory_id, 'epoch', p_expected_epoch);
  v_result := private.replay_operation(p_request_id, 'equip_badge', v_payload);
  if v_result is not null then return v_result; end if;
  if p_expected_epoch is null then raise exception 'VALIDATION_ERROR'; end if;
  select * into v_profile from public.profiles where id = v_uid for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if v_profile.progress_epoch <> p_expected_epoch then raise exception 'EPOCH_CHANGED'; end if;
  if p_inventory_id is not null and not exists (
    select 1 from public.user_inventory where id = p_inventory_id
      and user_id = v_uid and progress_epoch = p_expected_epoch
  ) then raise exception 'BADGE_NOT_OWNED'; end if;
  update public.profiles set active_badge_id = p_inventory_id where id = v_uid;
  v_result := jsonb_build_object('operation_id', v_op_id, 'replayed', false, 'superseded', false,
    'active_badge_id', p_inventory_id);
  insert into private.operations(id, actor_id, request_id, operation_type, progress_epoch, payload, result)
    values(v_op_id, v_uid, p_request_id, 'equip_badge', p_expected_epoch, v_payload, v_result);
  return v_result;
end;
$$;

insert into public.shop_items(title, icon, price, type, bonus_xp) values
  ('Новичок-Воин', '⚔️', 50, 'badge', 0),
  ('Мастер Задач', '🏆', 150, 'badge', 0),
  ('Зелье Опыта', '🧪', 100, 'bonus', 50);

revoke all on function public.buy_item(uuid,integer,uuid) from public, anon, authenticated;
revoke all on function public.equip_badge(uuid,integer,uuid) from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function public.buy_item(uuid,integer,uuid) to authenticated;
grant execute on function public.equip_badge(uuid,integer,uuid) to authenticated;
commit;
