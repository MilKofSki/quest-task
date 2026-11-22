import { useCallback, useEffect, useRef, useState } from 'react';
import { Coins, LoaderCircle, Plus, Shield, Trash2, Users, Zap } from 'lucide-react';
import { formatNumber, friendlyError } from '../lib/game';

const initialChallenge = { title: '', description: '', rule: 'tasks_total', target: 1, difficulty: '', xp: 100, coins: 0 };
const initialItem = { title: '', icon: '🏅', price: 50, type: 'badge', bonus: 0 };

function ConfirmDialog({ action, busy, onClose, onConfirm }) {
  const dialog = useRef(null);
  const [reason, setReason] = useState('');
  useEffect(() => { dialog.current?.showModal(); }, []);
  const reset = action.type === 'reset';
  const title = reset ? `Сбросить прогресс игрока «${action.item.nickname}»?`
    : action.type === 'role' ? `Изменить роль игрока «${action.item.nickname}»?`
      : `Архивировать «${action.item.title}»?`;
  return <dialog ref={dialog} className="confirm-dialog" onCancel={event => { if (busy) event.preventDefault(); else onClose(); }} aria-labelledby="admin-confirm-title">
    <span className="dialog-icon"><Shield size={22} /></span>
    <h2 id="admin-confirm-title">{title}</h2>
    <p className="muted">{reset ? 'XP, монеты и активный титул станут нулевыми. Задачи, покупки и награды останутся в истории, но исчезнут из текущей эпохи.'
      : action.type === 'role' ? `Новая роль: ${action.newRole === 'admin' ? 'администратор' : 'игрок'}. Права изменятся сразу после сохранения.`
        : 'Запись исчезнет из активного каталога. История и купленные титулы сохранятся.'}</p>
    {reset && <label className="admin-reason">Причина сброса (3–300 символов)
      <textarea value={reason} onChange={event => setReason(event.target.value)} minLength={3} maxLength={300} placeholder="Например: новый игровой сезон" />
    </label>}
    <div className="dialog-actions"><button className="secondary" disabled={busy} onClick={onClose} autoFocus>Отмена</button>
      <button className="danger" disabled={busy || (reset && reason.trim().length < 3)} onClick={() => onConfirm(reason.trim())}>
        {busy ? 'Сохраняем…' : reset ? 'Сбросить прогресс' : action.type === 'role' ? 'Изменить роль' : 'Архивировать'}
      </button></div>
  </dialog>;
}

export default function AdminTab({ adapter, game }) {
  const [tab, setTab] = useState('challenges');
  const [rows, setRows] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [challenge, setChallenge] = useState(initialChallenge);
  const [item, setItem] = useState(initialItem);
  const [action, setAction] = useState(null);
  const [working, setWorking] = useState(false);
  const version = useRef(0);
  const profile = game.data?.profile;
  const load = useCallback(async (nextCursor = null) => {
    const current = ++version.current;
    setLoading(true);
    try {
      const result = await adapter.readAdmin(tab, nextCursor);
      if (current !== version.current) return;
      setRows(previous => nextCursor ? [...previous, ...result[tab]] : result[tab]);
      setCursor(result.next_cursor);
      setError('');
    } catch (err) {
      if (current === version.current) setError(friendlyError(err));
    } finally {
      if (current === version.current) setLoading(false);
    }
  }, [adapter, tab]);
  useEffect(() => { load(); return () => { version.current++; }; }, [load]);
  if (profile && profile.role !== 'admin') return <div className="notice error" role="alert">Админ-панель доступна только администратору.</div>;
  const disabled = loading || working || game.busy || Boolean(game.pending);
  async function mutate(method, args) {
    setWorking(true);
    const success = await game.mutate(method, args);
    await load();
    setWorking(false);
    return success;
  }
  async function createChallenge(event) {
    event.preventDefault();
    if (disabled) return;
    const success = await mutate('admin_create_challenge', {
      p_title: challenge.title.trim(), p_description: challenge.description,
      p_rule_type: challenge.rule, p_target_count: Number(challenge.target),
      p_difficulty_filter: challenge.difficulty || null, p_reward_xp: Number(challenge.xp),
      p_reward_coins: Number(challenge.coins),
    });
    if (success) setChallenge(initialChallenge);
  }
  async function createItem(event) {
    event.preventDefault();
    if (disabled) return;
    const success = await mutate('admin_create_item', {
      p_title: item.title.trim(), p_icon: item.icon, p_price: Number(item.price),
      p_type: item.type, p_bonus_xp: item.type === 'badge' ? 0 : Number(item.bonus),
    });
    if (success) setItem(initialItem);
  }
  async function confirm(reason) {
    if (!action || disabled) return;
    const selected = action;
    let method; let args;
    if (selected.type === 'reset') {
      method = 'admin_reset_progress';
      args = { p_target_user_id: selected.item.id, p_expected_epoch: selected.item.progress_epoch, p_reason: reason };
    } else if (selected.type === 'role') {
      method = 'admin_set_role';
      args = { p_target_user_id: selected.item.id, p_new_role: selected.newRole };
    } else {
      method = selected.type === 'challenge' ? 'admin_archive_challenge' : 'admin_archive_item';
      args = selected.type === 'challenge' ? { p_challenge_id: selected.item.id } : { p_item_id: selected.item.id };
    }
    const success = await mutate(method, args);
    if (success) setAction(null);
  }
  return <section className="admin-section" aria-label="Админ-панель">
    <div className="admin-tabs" role="tablist" aria-label="Разделы админ-панели">
      {[[ 'challenges', 'Челленджи' ], [ 'items', 'Товары' ], [ 'users', 'Игроки' ]].map(([key, label]) =>
        <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'selected' : ''} onClick={() => { setTab(key); setRows([]); setCursor(null); }} disabled={working}>{label}</button>)}
    </div>
    {error && <div className="notice error" role="alert">{error}</div>}
    {tab === 'challenges' && <form className="admin-form glass" onSubmit={createChallenge}>
      <h2><Plus size={17} /> Опубликовать челлендж</h2>
      <div className="admin-fields"><label>Название<input required maxLength={100} value={challenge.title} onChange={event => setChallenge({ ...challenge, title: event.target.value })} /></label>
        <label>Описание<textarea maxLength={1000} value={challenge.description} onChange={event => setChallenge({ ...challenge, description: event.target.value })} /></label>
        <label>Правило<select value={challenge.rule} onChange={event => setChallenge({ ...challenge, rule: event.target.value })}><option value="tasks_total">Всего задач</option><option value="tasks_in_day">За день по Москве</option></select></label>
        <label>Цель<input required type="number" min="1" max="1000" value={challenge.target} onChange={event => setChallenge({ ...challenge, target: event.target.value })} /></label>
        <label>Сложность<select value={challenge.difficulty} onChange={event => setChallenge({ ...challenge, difficulty: event.target.value })}><option value="">Любая</option><option value="easy">Лёгкая</option><option value="medium">Средняя</option><option value="hard">Сложная</option></select></label>
        <label>XP<input required type="number" min="0" max="10000" value={challenge.xp} onChange={event => setChallenge({ ...challenge, xp: event.target.value })} /></label>
        <label>Монеты<input required type="number" min="0" max="10000" value={challenge.coins} onChange={event => setChallenge({ ...challenge, coins: event.target.value })} /></label></div>
      <p className="admin-hint">Хотя бы одна награда должна быть больше нуля. После публикации правила не меняются.</p>
      <button className="primary" type="submit" disabled={disabled}>Опубликовать</button>
    </form>}
    {tab === 'items' && <form className="admin-form glass" onSubmit={createItem}>
      <h2><ShoppingBagIcon /> Добавить товар</h2>
      <div className="admin-fields"><label>Название<input required maxLength={100} value={item.title} onChange={event => setItem({ ...item, title: event.target.value })} /></label>
        <label>Иконка<input required maxLength={16} value={item.icon} onChange={event => setItem({ ...item, icon: event.target.value })} /></label>
        <label>Тип<select value={item.type} onChange={event => setItem({ ...item, type: event.target.value, bonus: event.target.value === 'badge' ? 0 : 50 })}><option value="badge">Титул</option><option value="bonus">Бонус XP</option></select></label>
        <label>Цена, монеты<input required type="number" min="1" max="100000" value={item.price} onChange={event => setItem({ ...item, price: event.target.value })} /></label>
        {item.type === 'bonus' && <label>Бонус XP<input required type="number" min="1" max="10000" value={item.bonus} onChange={event => setItem({ ...item, bonus: event.target.value })} /></label>}</div>
      <p className="admin-hint">Опубликованный товар нельзя редактировать. Для замены архивируйте его и создайте новый.</p>
      <button className="primary" type="submit" disabled={disabled}>Добавить товар</button>
    </form>}
    <div className="list-header admin-list-heading"><div><h2>{tab === 'users' ? 'Игроки' : tab === 'items' ? 'Каталог товаров' : 'Каталог челленджей'}</h2><span className="list-count">{rows.length}</span></div></div>
    {!rows.length && loading ? <div className="empty-state" role="status"><LoaderCircle className="spin" /><p>Загружаем данные…</p></div>
      : !rows.length ? <div className="empty-state"><Users size={25} /><p>Записей пока нет.</p></div>
        : <div className="admin-list">{rows.map(row => <article className="admin-row glass" key={row.id}>
          <div className="admin-row-main"><h3>{row.icon && <span aria-hidden="true">{row.icon} </span>}{row.title || row.nickname}</h3>
            <p>{tab === 'users' ? row.email : tab === 'items' ? `${row.type === 'badge' ? 'Титул' : `Бонус +${row.bonus_xp} XP`} · ${formatNumber(row.price)} монет`
              : `${row.rule_type === 'tasks_total' ? 'Всего задач' : 'За день'} · цель ${row.target_count} · +${row.reward_xp} XP / +${row.reward_coins} монет`}</p>
            <span className={`admin-status ${row.archived_at ? 'archived' : ''}`}>{tab === 'users' ? `${row.role === 'admin' ? 'Админ' : 'Игрок'} · ${formatNumber(row.xp)} XP · ${formatNumber(row.coins)} монет · эпоха ${row.progress_epoch}` : row.archived_at ? 'В архиве' : 'Опубликовано'}</span></div>
          {tab === 'users' ? <div className="admin-row-actions">
            {row.id !== profile?.id && <button className="secondary" disabled={disabled} onClick={() => setAction({ type: 'role', item: row, newRole: row.role === 'admin' ? 'user' : 'admin' })}>{row.role === 'admin' ? 'Снять роль' : 'Сделать админом'}</button>}
            <button className="secondary" disabled={disabled} onClick={() => setAction({ type: 'reset', item: row })}>Сбросить</button>
          </div> : !row.archived_at && <button className="secondary admin-archive" disabled={disabled} onClick={() => setAction({ type: tab === 'items' ? 'item' : 'challenge', item: row })}><Trash2 size={14} /> Архивировать</button>}
        </article>)}</div>}
    {cursor && <div className="pagination"><button className="secondary" disabled={disabled} onClick={() => load(cursor)}>Показать ещё</button></div>}
    {action && <ConfirmDialog action={action} busy={working || game.busy} onClose={() => setAction(null)} onConfirm={confirm} />}
  </section>;
}

function ShoppingBagIcon() { return <Coins size={17} />; }
