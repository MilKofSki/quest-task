import { useCallback, useEffect, useRef, useState } from 'react';
import { friendlyError } from '../lib/game';

export function useTasks(adapter) {
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(() => adapter.getPending());
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const version = useRef(0);
  const mounted = useRef(true);
  const locked = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; version.current++; }; }, []);
  const refresh = useCallback(async () => {
    const current = ++version.current;
    setLoading(true);
    try {
      const next = await adapter.read(filter, page);
      if (mounted.current && current === version.current) {
        if (page > 0 && next.tasks.length === 0) setPage(page - 1);
        else { setData(next); setError(''); }
      }
      return true;
    } catch (err) {
      if (mounted.current && current === version.current) setError(friendlyError(err));
      return false;
    } finally { if (mounted.current && current === version.current) setLoading(false); }
  }, [adapter, filter, page]);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    const focus = () => { setPending(adapter.getPending()); refresh(); };
    window.addEventListener('focus', focus);
    window.addEventListener('storage', focus);
    return () => { window.removeEventListener('focus', focus); window.removeEventListener('storage', focus); };
  }, [adapter, refresh]);
  async function mutate(method, args = {}, retry = false) {
    if (locked.current || !data) return false;
    const currentPending = adapter.getPending();
    if (currentPending && !retry) { setPending(currentPending); return false; }
    const effectiveMethod = retry ? currentPending?.method : method;
    locked.current = true;
    setBusy(true); setError(''); setNotice('');
    let result;
    try {
      result = await adapter.mutate(method, { ...args, p_expected_epoch: data.profile.progress_epoch }, retry ? currentPending : null);
    } catch (err) {
      if (mounted.current) { setPending(adapter.getPending()); setError(friendlyError(err)); }
      // A rejected operation may reveal stale state, but keep its error visible.
      const message = friendlyError(err);
      await refresh();
      if (mounted.current) setError(message);
      locked.current = false;
      if (mounted.current) setBusy(false);
      return false;
    }
    if (!mounted.current) return true;
    setPending(adapter.getPending());
    const fresh = await refresh();
    if (mounted.current) {
      setNotice(!fresh ? 'Действие сохранено. Не удалось обновить список — нажми «Обновить».'
        : result.superseded ? 'Найден результат прошлого прогресса. Текущие данные обновлены.'
        : result.replayed ? 'Запрос уже был обработан. Данные обновлены без повторного начисления.'
        : effectiveMethod === 'claim_challenge' ? `Награда за челлендж получена! +${result.reward_xp} XP и +${result.reward_coins} монет.`
        : result.reward_xp ? `Квест завершён! +${result.reward_xp} XP и +${result.reward_coins} монет.`
        : effectiveMethod === 'create_task' ? 'Новый квест добавлен. Всё начинается с первого шага.' : 'Задача удалена из списка. Заработанные награды сохранены.');
      setBusy(false);
    }
    locked.current = false;
    return true;
  }
  return { data, filter, page, loading, busy, pending, error, notice, refresh, mutate,
    setFilter: value => { setFilter(value); setPage(0); }, setPage,
    reset: async () => { adapter.reset(); setPage(0); setNotice('Демонстрация начата заново.'); await refresh(); } };
}
