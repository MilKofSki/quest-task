import { supabase } from '../lib/supabaseClient';
import { isDefiniteError } from '../lib/game';

const pendingKey = userId => `questtask:pending:v1:${userId}`;
export function loadPending(userId) {
  try {
    const value = JSON.parse(localStorage.getItem(pendingKey(userId)) || 'null');
    if (!value) return null;
    if (!['create_task', 'complete_task', 'archive_task', 'claim_challenge'].includes(value.method)
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
