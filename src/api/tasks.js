import { supabase } from '../lib/supabaseClient';
import { isDefiniteError } from '../lib/game';

const pendingKey = userId => `questtask:pending:v1:${userId}`;
export function loadPending(userId) {
  try {
    const value = JSON.parse(localStorage.getItem(pendingKey(userId)) || 'null');
    if (!value) return null;
    if (!['create_task', 'complete_task', 'archive_task', 'claim_challenge', 'buy_item', 'equip_badge',
      'admin_create_challenge', 'admin_archive_challenge', 'admin_create_item', 'admin_archive_item',
      'admin_set_role', 'admin_reset_progress'].includes(value.method)
      || typeof value.args?.p_request_id !== 'string') throw new Error('Invalid saved request');
    return value;
  } catch {
    // Do not silently overwrite an unreadable pending financial operation.
    return { invalid: true };
  }
}
export function savePending(userId, operation) {
  if (operation) localStorage.setItem(pendingKey(userId), JSON.stringify(operation));
  else localStorage.removeItem(pendingKey(userId));
}

export function createRemoteAdapter(userId) {
  return {
    kind: 'remote',
    async read(filter, page) {
      const { data: profile, error } = await supabase.from('profiles').select('*').eq('id', userId).single();
      if (error) throw error;
      if (profile.active_badge_id) {
        const badge = await supabase.from('user_inventory').select('shop_items(title,icon)')
          .eq('id', profile.active_badge_id).eq('user_id', userId).single();
        if (badge.error) throw badge.error;
        profile.active_badge = badge.data.shop_items;
      }
      const base = () => supabase.from('tasks').select('*', { count: 'exact' }).eq('user_id', userId)
        .eq('progress_epoch', profile.progress_epoch).is('archived_at', null);
      let query = base();
      if (filter === 'active') query = query.is('completed_at', null);
      if (filter === 'completed') query = query.not('completed_at', 'is', null);
      const [tasks, active, completed] = await Promise.all([
        query.order('created_at', { ascending: false }).order('id').range(page * 20, page * 20 + 19),
        supabase.from('tasks').select('id', { count: 'exact', head: true }).eq('user_id', userId)
          .eq('progress_epoch', profile.progress_epoch).is('archived_at', null).is('completed_at', null),
        supabase.from('tasks').select('id', { count: 'exact', head: true }).eq('user_id', userId)
          .eq('progress_epoch', profile.progress_epoch).is('archived_at', null).not('completed_at', 'is', null),
      ]);
      for (const result of [tasks, active, completed]) if (result.error) throw result.error;
      return { profile, tasks: tasks.data, count: tasks.count, active: active.count, completed: completed.count };
    },
    async readChallenges(cursor = null) {
      const { data, error } = await supabase.rpc('get_challenge_progress', { p_limit: 20, p_cursor: cursor });
      if (error) throw error;
      return data;
    },
    async readShop(epoch) {
      const [items, inventory] = await Promise.all([
        supabase.from('shop_items').select('id,title,icon,price,type,bonus_xp,created_at').is('archived_at', null)
          .order('created_at', { ascending: false }).order('id').limit(100),
        supabase.from('user_inventory').select('id,item_id,purchased_at,shop_items(title,icon,archived_at)')
          .eq('user_id', userId).eq('progress_epoch', epoch).order('purchased_at', { ascending: false }).limit(100),
      ]);
      if (items.error) throw items.error;
      if (inventory.error) throw inventory.error;
      return { items: items.data, inventory: inventory.data };
    },
    async readAdmin(section, cursor = null) {
      const method = { challenges: 'admin_list_challenges', items: 'admin_list_items', users: 'admin_list_users' }[section];
      if (!method) throw new Error('VALIDATION_ERROR');
      const { data, error } = await supabase.rpc(method, { p_limit: 20, p_cursor: cursor });
      if (error) throw error;
      return data;
    },
    getPending: () => loadPending(userId),
    async mutate(method, args, pending) {
      const operation = pending || { method, args: { ...args, p_request_id: crypto.randomUUID() } };
      if (operation.invalid) throw new Error('Не удалось прочитать ожидающий запрос. Обратитесь к разработчику, не повторяйте действие с новым ключом.');
      // Persist BEFORE sending. A network timeout must keep the same request id.
      savePending(userId, operation);
      const { data, error } = await supabase.rpc(operation.method, operation.args);
      if (error) {
        if (isDefiniteError(error)) savePending(userId, null);
        throw error;
      }
      savePending(userId, null);
      return data;
    },
  };
}
