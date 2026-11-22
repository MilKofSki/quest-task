import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleCheck, Coins, LoaderCircle, Swords, Zap } from 'lucide-react';
import { difficulties, friendlyError } from '../lib/game';

export default function ChallengesTab({ adapter, game }) {
  const [items, setItems] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [claiming, setClaiming] = useState(null);
  const version = useRef(0);
  const load = useCallback(async (cursor = null) => {
    const current = ++version.current;
    setLoading(true);
    try {
      const result = await adapter.readChallenges(cursor);
      if (current !== version.current) return;
      setItems(previous => cursor ? [...previous, ...result.challenges] : result.challenges);
      setNextCursor(result.next_cursor);
      setError('');
    } catch (err) {
      if (current === version.current) setError(friendlyError(err));
    } finally {
      if (current === version.current) setLoading(false);
    }
  }, [adapter]);
  useEffect(() => {
    load();
    return () => { version.current++; };
  }, [load, game.data?.profile?.xp, game.data?.profile?.coins]);
  async function claim(id) {
    if (claiming || game.busy || game.pending) return;
    setClaiming(id);
    const succeeded = await game.mutate('claim_challenge', { p_challenge_id: id });
    if (!succeeded) await load();
    setClaiming(null);
  }
  return <section className="challenges-section" aria-labelledby="challenges-title" aria-busy={loading}>
    <div className="list-header"><div><h2 id="challenges-title">Доступные челленджи</h2><span className="list-count">{items.length}</span></div></div>
    {error && <div className="notice error" role="alert">{error}</div>}
    {!items.length && loading ? <div className="empty-state" role="status"><LoaderCircle className="spin" /><p>Считаем твой прогресс…</p></div>
      : !items.length ? <div className="empty-state"><Swords className="empty-icon" size={26} /><h3>Пока нет активных челленджей</h3><p>Новые испытания появятся здесь после публикации.</p></div>
        : <div className={`challenge-grid ${loading ? 'is-loading' : ''}`}>{items.map(item => {
          const percent = Math.min(100, Math.round(item.progress / item.target_count * 100));
          const rule = item.rule_type === 'tasks_in_day' ? 'За один день по Москве' : 'За всё время после публикации';
          const difficulty = item.difficulty_filter ? `${difficulties[item.difficulty_filter].label} сложность` : 'Любая сложность';
          return <article className="challenge-card glass" key={item.id}>
            <div className="challenge-card-top"><span className="challenge-emblem"><Swords size={21} /></span><span className={`challenge-state ${item.claimed ? 'claimed' : item.eligible ? 'ready' : ''}`}>{item.claimed ? 'Награда получена' : item.eligible ? 'Готово к награде' : 'В процессе'}</span></div>
            <h3>{item.title}</h3><p>{item.description}</p>
            <div className="challenge-rules"><span>{rule}</span><span>{difficulty}</span></div>
            <div className="challenge-progress-caption"><strong>Прогресс {item.progress}/{item.target_count}</strong><span>{percent}%</span></div>
            <div className="challenge-progress-track" role="progressbar" aria-valuenow={item.progress} aria-valuemin="0" aria-valuemax={item.target_count} aria-label={`Прогресс челленджа ${item.title}`}><span style={{ width: `${percent}%` }} /></div>
            <div className="challenge-card-bottom"><div className="challenge-reward"><span><Zap size={14} />+{item.reward_xp} XP</span><span><Coins size={14} />+{item.reward_coins} монет</span></div>
              <button className={item.eligible && !item.claimed ? 'primary' : 'secondary'} disabled={item.claimed || !item.eligible || loading || game.busy || Boolean(game.pending)} onClick={() => claim(item.id)}>
                {claiming === item.id ? <><LoaderCircle className="spin" size={15} /> Получаем…</> : item.claimed ? <><CircleCheck size={15} /> Получено</> : item.eligible ? 'Получить награду' : `Прогресс ${item.progress}/${item.target_count}`}
              </button></div>
          </article>;
        })}</div>}
    {nextCursor && <div className="pagination"><button className="secondary" disabled={loading || game.busy} onClick={() => load(nextCursor)}>Показать ещё</button></div>}
  </section>;
}
