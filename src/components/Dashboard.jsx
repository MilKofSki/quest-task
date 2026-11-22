import { useEffect, useRef, useState } from 'react';
import { Zap, ListTodo, Swords, ShoppingBag, Shield, Sparkles, ArrowUpRight, Coins,
  Check, Plus, Trash2, LogOut, RotateCcw, RefreshCw, ChevronLeft, ChevronRight,
  ArrowRight, CircleCheck, LoaderCircle, Flag, X } from 'lucide-react';
import { useTasks } from '../hooks/useTasks';
import ChallengesTab from './ChallengesTab';
import { difficulties, levelOf, progressOf, formatNumber, textLength, friendlyError } from '../lib/game';

function DeleteDialog({ task, onClose, onConfirm, busy }) {
  const dialog = useRef(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="confirm-dialog" onCancel={event => { if (busy) event.preventDefault(); else onClose(); }} aria-labelledby="delete-title">
    <span className="dialog-icon"><Trash2 size={22} /></span>
    <h2 id="delete-title">Удалить задачу?</h2>
    <p className="dialog-task">{task.title}</p>
    <p className="muted">Она исчезнет из списка. Заработанные XP и монеты сохранятся.</p>
    <div className="dialog-actions"><button className="secondary" disabled={busy} onClick={onClose} autoFocus>Оставить</button><button className="danger" disabled={busy} onClick={onConfirm}>{busy ? 'Удаляем…' : 'Удалить'}</button></div>
  </dialog>;
}

export default function Dashboard({ adapter, onSignOut, section = 'tasks' }) {
  const game = useTasks(adapter);
  const { data, loading, busy, pending, error, notice } = game;
  const [title, setTitle] = useState('');
  const [difficulty, setDifficulty] = useState('medium');
  const [formError, setFormError] = useState('');
  const [logoutError, setLogoutError] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const input = useRef(null);
  useEffect(() => { window.scrollTo({ top: 0, left: 0 }); }, []);
  const demo = adapter.kind === 'demo';
  const disabled = busy || loading || Boolean(pending);
  const profile = data?.profile;
  const reward = difficulties[difficulty];
  const level = levelOf(profile?.xp || 0);
  const progress = progressOf(profile?.xp || 0);
  const today = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' }).format(new Date());
  async function addTask(event) {
    event.preventDefault();
    if (disabled) return;
    if (!title.trim() || textLength(title.trim()) > 200) { setFormError('Напиши название от 1 до 200 символов.'); return; }
    setFormError('');
    if (await game.mutate('create_task', { p_title: title.trim(), p_difficulty: difficulty })) { setTitle(''); game.setPage(0); input.current?.focus(); }
  }
  async function logout() {
    setLoggingOut(true); setLogoutError('');
    try { await onSignOut(); } catch (err) { setLogoutError(friendlyError(err)); setLoggingOut(false); }
  }
  return <div className="app-layout">
    <aside className="sidebar">
      <a className="brand" href="#/tasks"><span className="brand-icon"><Zap fill="currentColor" size={23} /></span>QuestTask<span className="brand-dot">.</span></a>
      <span className="sidebar-kicker">ТВОЁ ПРИКЛЮЧЕНИЕ</span>
      <nav aria-label="Основная навигация">
        <a className={`nav-item ${section === 'tasks' ? 'active' : ''}`} href="#/tasks" aria-current={section === 'tasks' ? 'page' : undefined}><ListTodo size={19} /><span>Мои задачи</span><span className="nav-count">{data?.active ?? '—'}</span></a>
        <a className={`nav-item ${section === 'challenges' ? 'active' : ''}`} href="#/challenges" aria-current={section === 'challenges' ? 'page' : undefined}><Swords size={18} /><span>Челленджи</span></a>
      </nav>
      <div className="next-nav" aria-label="В следующих этапах разработки">
        <span className="sidebar-kicker">СЛЕДУЮЩИЕ ЭТАПЫ</span>
        <div className="nav-item planned"><ShoppingBag size={18} /><span>Магазин</span><span className="soon">скоро</span></div>
        <div className="nav-item planned"><Shield size={18} /><span>Админ-панель</span><span className="soon">скоро</span></div>
      </div>
      <div className="sidebar-bottom">
        <div className="level-card">
          <div className="level-symbol"><Shield size={25} /><b>{level}</b></div>
          <span className="eyebrow">ТВОЙ УРОВЕНЬ</span>
          <strong>Каждый шаг считается</strong>
          <p>Ещё {100 - progress} XP до уровня {level + 1}</p>
          <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>
          <div className="progress-caption"><span>{progress} XP</span><span>100 XP</span></div>
        </div>
        <div className="sidebar-foot"><span className="online-dot" /> {demo ? 'Локальный деморежим' : 'Прогресс в твоём аккаунте'}<small>QuestTask · первый этап</small></div>
      </div>
    </aside>
    <div className="workspace">
      <header className="topbar">
        <div className="breadcrumb">Приключение <ChevronRight size={13} /><span>{section === 'challenges' ? 'Челленджи' : 'Мои задачи'}</span></div>
        <div className="topbar-actions">
          <span className={`mode-label ${demo ? 'demo' : ''}`}><i />{demo ? 'Демо' : 'Аккаунт'}</span>
          <span className="profile-avatar">{profile?.nickname?.slice(0, 1) || '?'}</span>
          <div className="profile-name"><strong>{profile?.nickname || 'Загрузка…'}</strong><span>{profile?.role === 'admin' ? 'Администратор' : 'Искатель приключений'}</span></div>
          <button className="icon-button logout" aria-label="Выйти" title="Выйти" onClick={logout} disabled={loggingOut || busy}><LogOut size={18} /></button>
        </div>
      </header>
      <main id="main-content">
        <div className="page-heading"><div><p className="eyebrow">{today} <span className="date-dot">·</span> ТВОЙ НОВЫЙ ШАГ</p><h1>{section === 'challenges' ? 'Челленджи' : 'Мои задачи'}<span className="heading-dot">.</span></h1><p className="muted">{section === 'challenges' ? 'Выполняй условия и забирай награды.' : 'Большие приключения начинаются с маленьких дел.'}</p></div><button className="secondary refresh" onClick={game.refresh} disabled={loading || busy} aria-label="Обновить данные"><RefreshCw size={15} className={loading ? 'spin' : ''} /><span>Обновить</span></button></div>
        {demo && <div className="demo-strip"><Sparkles size={16} /><p><strong>Ты в деморежиме.</strong> Данные локальные и сбрасываются при обновлении страницы.</p><button onClick={game.reset} disabled={busy || loading} aria-label="Начать заново"><RotateCcw size={14} /><span>Начать заново</span></button></div>}
        {(error || logoutError) && <div className="notice error" role="alert">{error || logoutError}</div>}
        {notice && <div className="notice success" role="status"><CircleCheck size={17} />{notice}</div>}
        {pending && <div className="notice pending" role="alert"><p>{pending.invalid ? 'Сохранённый запрос повреждён. Не создавайте повторный запрос: обратитесь к разработчику.' : 'Результат предыдущего запроса ещё не подтверждён. Повтор безопасен: награда начисляется только один раз.'}</p>{!pending.invalid && <button className="secondary" disabled={busy || loading} onClick={() => game.mutate(null, {}, true)}>Повторить запрос</button>}</div>}
        <section className="journey-hero glass" aria-label="Твой игровой прогресс">
          <div className="hero-copy"><span className="hero-tag"><Zap size={13} fill="currentColor" /> ВРЕМЯ ДЛЯ НОВОЙ ПОБЕДЫ</span><h2>Прокачивай себя.<br /><span>По одной задаче.</span></h2><p>Выбери квест, сделай шаг и забери заслуженную награду.</p><button className="hero-link" onClick={() => { if (section === 'challenges') window.location.hash = '#/tasks'; else { input.current?.focus(); input.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }); } }}>{section === 'challenges' ? 'Перейти к задачам' : 'Какой твой следующий шаг?'} <ArrowUpRight size={17} /></button></div>
          <div className="hero-art" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><span className="star star-a">✦</span><span className="star star-b">✧</span><div className="hero-crystal"><Zap size={64} fill="currentColor" strokeWidth={1.1} /></div><span className="art-caption">LEVEL {String(level).padStart(2, '0')}</span></div>
        </section>
        <section className="stat-grid" aria-label="Статистика игрока">
          <div className="stat-card"><span className="stat-icon violet"><Zap size={20} /></span><div><span>Всего опыта</span><strong>{formatNumber(profile?.xp || 0)}<small>XP</small></strong></div><span className="stat-detail">Уровень {level}</span></div>
          <div className="stat-card"><span className="stat-icon gold"><Coins size={21} /></span><div><span>Твои монеты</span><strong>{formatNumber(profile?.coins || 0)}<small>монет</small></strong></div></div>
          <div className="stat-card"><span className="stat-icon mint"><CircleCheck size={21} /></span><div><span>Выполнено в списке</span><strong>{data?.completed ?? 0}<small>из {(data?.active || 0) + (data?.completed || 0)}</small></strong></div></div>
        </section>
        {section === 'tasks' ? <><section className="task-section glass" aria-labelledby="new-task-title">
          <div className="section-title"><span className="section-icon"><Plus size={19} /></span><h2 id="new-task-title">Новый квест</h2><span className="section-hint">Маленький шаг к большому результату</span></div>
          <form onSubmit={addTask} className="task-form">
            <label className="title-field"><span>Что хочешь сделать?</span><input ref={input} value={title} onChange={e => setTitle(e.target.value)} placeholder="Например, закончить главу проекта…" disabled={disabled} required aria-describedby={formError ? 'task-form-error' : undefined} /></label>
            <label className="difficulty-field"><span>Сложность</span><select value={difficulty} onChange={e => setDifficulty(e.target.value)} disabled={disabled}><option value="easy">Лёгкая · 10 XP</option><option value="medium">Средняя · 25 XP</option><option value="hard">Сложная · 50 XP</option></select></label>
            <button type="submit" className="primary add-button" disabled={disabled || !data}>{busy ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />}Добавить</button>
          </form>
          <div className="form-meta"><span><Sparkles size={13} /> Награда за выполнение: <b>+{reward.xp} XP</b><i /> <strong>+{reward.coins} монет</strong></span><span>{textLength(title.trim())}/200</span></div>
          {formError && <p id="task-form-error" className="field-error" role="alert">{formError}</p>}
        </section>
        <section className="quest-list" aria-labelledby="quest-list-title" aria-busy={loading}>
          <div className="list-header"><div><h2 id="quest-list-title">Твои квесты</h2><span className="list-count">{(data?.active || 0) + (data?.completed || 0)}</span></div>
            <div className="filters" aria-label="Фильтр задач">{[['all', 'Все'], ['active', 'Активные'], ['completed', 'Выполненные']].map(([value, label]) => <button key={value} aria-pressed={game.filter === value} className={game.filter === value ? 'selected' : ''} onClick={() => game.setFilter(value)} disabled={busy}>{label}</button>)}</div>
          </div>
          {!data && loading ? <div className="empty-state" role="status"><LoaderCircle className="spin" /><p>Загружаем твои квесты…</p></div> : data?.tasks.length ? <div className={`task-rows ${loading ? 'is-loading' : ''}`}>
            {data.tasks.map(task => <div className={`task-row ${task.completed_at ? 'completed' : ''}`} key={task.id}>
              <button className="task-checkbox" disabled={disabled || Boolean(task.completed_at)} aria-label={task.completed_at ? `Выполнено: ${task.title}` : `Выполнить: ${task.title}`} onClick={() => game.mutate('complete_task', { p_task_id: task.id })}>{task.completed_at && <Check size={17} />}</button>
              <div className="task-content"><h3>{task.title}</h3><div className="task-meta"><span className={`difficulty-label ${task.difficulty}`}><i />{difficulties[task.difficulty].label}</span><span className="task-status">{task.completed_at ? 'Квест завершён' : difficulties[task.difficulty].caption}</span></div></div>
              <div className="task-rewards"><span><Zap size={13} />+{difficulties[task.difficulty].xp} XP</span><span><Coins size={13} />+{difficulties[task.difficulty].coins}</span></div>
              <button className="icon-button delete-task" disabled={disabled} aria-label={`Удалить: ${task.title}`} title="Удалить задачу" onClick={() => setDeleting(task)}><Trash2 size={16} /></button>
            </div>)}
          </div> : <div className="empty-state"><span className="empty-icon"><Flag size={26} /></span><h3>{game.filter === 'completed' ? 'Первая победа ещё впереди' : game.filter === 'active' ? 'Все квесты завершены' : 'Здесь начинается твоё приключение'}</h3><p>{game.filter === 'completed' ? 'Выполни любую задачу, и она появится здесь.' : 'Добавь задачу выше — даже маленький шаг приносит опыт.'}</p></div>}
          {data?.count > 20 && <div className="pagination"><button className="secondary" disabled={game.page === 0 || loading || busy} onClick={() => game.setPage(game.page - 1)}><ChevronLeft size={16} /> Назад</button><span>Страница {game.page + 1} из {Math.ceil(data.count / 20)}</span><button className="secondary" disabled={(game.page + 1) * 20 >= data.count || loading || busy} onClick={() => game.setPage(game.page + 1)}>Далее <ChevronRight size={16} /></button></div>}
        </section></> : <ChallengesTab adapter={adapter} game={game} />}
        <footer className="workspace-footer"><ShieldCheckMini /><span>Не сравнивай свой прогресс с чужим. Просто двигайся вперёд.</span><span className="footer-version">СДЕЛАНО ДЛЯ ТВОИХ ПОБЕД</span></footer>
      </main>
    </div>
    {deleting && <DeleteDialog task={deleting} busy={busy} onClose={() => setDeleting(null)} onConfirm={async () => { if (await game.mutate('archive_task', { p_task_id: deleting.id })) setDeleting(null); }} />}
  </div>;
}
function ShieldCheckMini() { return <Shield size={14} />; }
