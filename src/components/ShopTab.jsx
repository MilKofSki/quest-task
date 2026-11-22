import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleCheck, Coins, LoaderCircle, ShoppingBag, Sparkles, Zap } from 'lucide-react';
import { formatNumber, friendlyError } from '../lib/game';

export default function ShopTab({ adapter, game }) {
  const [catalog, setCatalog] = useState([]);
  const [inventory, setInventory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(null);
  const version = useRef(0);
  const profile = game.data?.profile;
  const load = useCallback(async () => {
    if (!profile) return;
    const current = ++version.current;
    setLoading(true);
    try {
      const result = await adapter.readShop(profile.progress_epoch);
      if (current !== version.current) return;
      setCatalog(result.items);
      setInventory(result.inventory);
      setError('');
    } catch (err) {
      if (current === version.current) setError(friendlyError(err));
    } finally {
      if (current === version.current) setLoading(false);
    }
  }, [adapter, profile?.progress_epoch]);
  useEffect(() => {
    load();
    return () => { version.current++; };
  }, [load, profile?.coins, profile?.xp, profile?.active_badge_id]);
  async function act(method, args, id) {
    if (working || game.busy || game.pending) return;
    setWorking(id);
    const success = await game.mutate(method, args);
    if (!success) await load();
    setWorking(null);
  }
  const owned = new Set(inventory.map(item => item.item_id));
  return <section className="shop-section" aria-labelledby="shop-title" aria-busy={loading}>
    <div className="list-header"><div><h2 id="shop-title">Магазин наград</h2><span className="list-count">{catalog.length}</span></div><span className="shop-balance"><Coins size={15} /> {formatNumber(profile?.coins || 0)} монет</span></div>
    <p className="shop-intro">Титулы остаются с тобой до сброса прогресса. Зелье опыта начисляет XP сразу при покупке.</p>
    {error && <div className="notice error" role="alert">{error}</div>}
    {!catalog.length && loading ? <div className="empty-state" role="status"><LoaderCircle className="spin" /><p>Загружаем каталог…</p></div>
      : !catalog.length ? <div className="empty-state"><ShoppingBag size={26} /><h3>Магазин пока пуст</h3><p>Новые награды появятся после публикации.</p></div>
        : <div className="shop-grid">{catalog.map(item => {
          const isOwned = item.type === 'badge' && owned.has(item.id);
          const affordable = Number(profile?.coins || 0) >= item.price;
          return <article className="shop-card glass" key={item.id}>
            <div className="shop-icon" aria-hidden="true">{item.icon}</div>
            <span className="shop-type">{item.type === 'badge' ? 'ТИТУЛ' : 'БОНУС ОПЫТА'}</span>
            <h3>{item.title}</h3>
            <p>{item.type === 'badge' ? 'Добавится в инвентарь. Можно выбрать как активный титул.' : `Сразу получишь +${formatNumber(item.bonus_xp)} XP. Можно купить снова.`}</p>
            <div className="shop-card-bottom"><strong><Coins size={16} /> {formatNumber(item.price)}</strong>
              <button className={affordable && !isOwned ? 'primary' : 'secondary'}
                disabled={loading || game.busy || Boolean(game.pending) || isOwned || !affordable}
                onClick={() => act('buy_item', { p_item_id: item.id }, item.id)}>
                {working === item.id ? <><LoaderCircle className="spin" size={15} /> Покупка…</>
                  : isOwned ? <><CircleCheck size={15} /> Куплено</>
                    : affordable ? 'Купить' : 'Недостаточно монет'}
              </button></div>
          </article>;
        })}</div>}
    <div className="list-header inventory-heading"><div><h2>Мои титулы</h2><span className="list-count">{inventory.length}</span></div></div>
    {inventory.length ? <div className="inventory-list">{inventory.map(item => <article className="inventory-row glass" key={item.id}>
      <span className="inventory-icon" aria-hidden="true">{item.shop_items?.icon || '🏅'}</span>
      <div><h3>{item.shop_items?.title || 'Титул'}</h3><p>{profile?.active_badge_id === item.id ? 'Активный титул' : 'В твоей коллекции'}</p></div>
      <button className="secondary" disabled={loading || game.busy || Boolean(game.pending)}
        onClick={() => act('equip_badge', { p_inventory_id: profile?.active_badge_id === item.id ? null : item.id }, item.id)}>
        {working === item.id ? <LoaderCircle className="spin" size={15} /> : profile?.active_badge_id === item.id ? 'Снять' : 'Выбрать'}
      </button>
    </article>)}</div> : <div className="empty-state inventory-empty"><Sparkles size={24} /><p>Первый титул ждёт тебя в магазине.</p></div>}
    {profile?.active_badge_id && <p className="shop-footnote"><Zap size={14} /> Активный титул виден в твоём профиле.</p>}
  </section>;
}
