import { useEffect, useState } from 'react';
import { ArrowRight, ArrowLeft, Zap, ShieldCheck, Mail, LoaderCircle, Sparkles } from 'lucide-react';
import { configured, configurationMessage, supabase } from '../lib/supabaseClient';
import { friendlyError, textLength } from '../lib/game';

const readVerification = () => {
  try { return JSON.parse(sessionStorage.getItem('questtask:verification') || 'null'); } catch { return null; }
};
function rememberVerification(value) {
  try { value ? sessionStorage.setItem('questtask:verification', JSON.stringify(value)) : sessionStorage.removeItem('questtask:verification'); } catch { /* optional email-only recovery */ }
}

export default function AuthScreen({ onDemo, initialError }) {
  const [saved] = useState(readVerification);
  const [mode, setMode] = useState(saved?.email ? 'verify' : 'login');
  const [email, setEmail] = useState(saved?.email || '');
  const [nickname, setNickname] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [resendAt, setResendAt] = useState(saved?.resendAt || 0);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError || '');
  const [notice, setNotice] = useState('');
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const cooldown = Math.max(0, Math.ceil((resendAt - now) / 1000));
  function changeMode(value) { setMode(value); setError(''); setNotice(''); setPassword(''); setOtp(''); }
  async function submit(event) {
    event.preventDefault();
    if (!configured || busy) return;
    setError(''); setNotice(''); setBusy(true);
    try {
      if (mode === 'register') {
        if (textLength(nickname.trim()) < 2 || textLength(nickname.trim()) > 40) throw new Error('NICKNAME');
        const { error } = await supabase.auth.signUp({ email: email.trim(), password, options: { data: { nickname: nickname.trim() } } });
        if (error) throw error;
        const resendAt = Date.now() + 60_000;
        rememberVerification({ email: email.trim(), resendAt });
        setResendAt(resendAt); setPassword(''); setMode('verify');
        setNotice('Если адрес доступен для регистрации, письмо с кодом уже отправлено.');
      } else if (mode === 'verify') {
        const { error } = await supabase.auth.verifyOtp({ email: email.trim(), token: otp, type: 'email' });
        if (error) throw error;
        rememberVerification(null);
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw error;
        rememberVerification(null);
      }
    } catch (err) { setError(err.message === 'NICKNAME' ? 'Никнейм должен содержать от 2 до 40 символов.' : friendlyError(err)); }
    finally { setBusy(false); }
  }
  async function resend() {
    if (cooldown || busy || !configured) return;
    setBusy(true); setError('');
    try {
      const { error } = await supabase.auth.resend({ type: 'signup', email: email.trim() });
      if (error) throw error;
      const resendAt = Date.now() + 60_000;
      setResendAt(resendAt); rememberVerification({ email: email.trim(), resendAt });
      setNotice('Если адрес ожидает подтверждения, новый код отправлен.');
    } catch (err) { setError(friendlyError(err)); }
    finally { setBusy(false); }
  }
  return <div className="auth-layout">
    <section className="auth-story">
      <a className="brand" href="#/tasks"><span className="brand-icon"><Zap fill="currentColor" size={23} /></span>QuestTask<span className="brand-dot">.</span></a>
      <div className="auth-pitch">
        <span className="eyebrow"><Sparkles size={14} /> КАЖДЫЙ ДЕНЬ — НОВЫЙ УРОВЕНЬ</span>
        <h1>Большие цели.<br /><span>Маленькие квесты.</span></h1>
        <p>Сделай первый шаг, заверши задачу<br className="desktop-break" /> и преврати свой прогресс в приключение.</p>
        <div className="auth-quest-card glass">
          <div className="mini-check"><ShieldCheck size={24} /></div>
          <div><strong>Твоя первая победа</strong><span>Сложная задача выполнена</span></div>
          <div className="mini-reward">+50 XP<span>+30 монет</span></div>
        </div>
        <div className="auth-principles"><span><i /> Свой темп</span><span><i /> Видимый прогресс</span><span><i /> Маленькие победы</span></div>
      </div>
      <p className="auth-footer">Не нужно быть героем. Достаточно начать.</p>
    </section>
    <section className="auth-form-wrap">
      <div className="auth-form glass">
        <span className="form-emblem">{mode === 'verify' ? <Mail /> : <Zap />}</span>
        <h2>{mode === 'verify' ? 'Проверь свою почту' : mode === 'register' ? 'Начни своё приключение' : 'С возвращением'}</h2>
        <p className="muted">{mode === 'verify' ? `Введи код из письма для ${email}` : 'Следующий уровень начинается с одного шага.'}</p>
        {mode !== 'verify' && <div className="auth-tabs" aria-label="Режим авторизации">
          <button className={mode === 'login' ? 'selected' : ''} onClick={() => changeMode('login')}>Вход</button>
          <button className={mode === 'register' ? 'selected' : ''} onClick={() => changeMode('register')}>Регистрация</button>
        </div>}
        {!configured && <p className="configuration-note">{configurationMessage}</p>}
        {error && <p className="notice error" role="alert">{error}</p>}
        {notice && <p className="notice" role="status">{notice}</p>}
        <form onSubmit={submit}>
          <fieldset disabled={busy || !configured}>
            {mode === 'register' && <label>Никнейм<input value={nickname} onChange={e => setNickname(e.target.value)} autoComplete="nickname" required placeholder="Как тебя называть?" /></label>}
            {mode !== 'verify' && <>
              <label>Электронная почта<input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoComplete="email" placeholder="you@example.com" /></label>
              <label>Пароль<input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={mode === 'register' ? 8 : undefined} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} placeholder={mode === 'register' ? 'Не менее 8 символов' : 'Твой пароль'} /></label>
            </>}
            {mode === 'verify' && <label>Код подтверждения (8 цифр)<input className="otp-input" inputMode="numeric" autoComplete="one-time-code" value={otp} onChange={e => setOtp(e.target.value.replace(/\D/g, '').slice(0, 8))} required minLength={8} maxLength={8} pattern="[0-9]{8}" placeholder="00000000" /></label>}
            <button className="primary auth-submit" type="submit">{busy ? <LoaderCircle className="spin" size={18} /> : <>{mode === 'verify' ? 'Подтвердить почту' : mode === 'register' ? 'Создать аккаунт' : 'Войти в QuestTask'}<ArrowRight size={17} /></>}</button>
          </fieldset>
        </form>
        {mode === 'verify' && <div className="verification-actions">
          <button className="text-button" disabled={Boolean(cooldown) || busy || !configured} onClick={resend}>{cooldown ? `Отправить снова через ${cooldown} с` : 'Отправить новый код'}</button>
          <button className="text-button" disabled={busy} onClick={() => { rememberVerification(null); changeMode('login'); }}><ArrowLeft size={14} /> Вернуться ко входу</button>
        </div>}
        <div className="divider"><span>или познакомься с приложением</span></div>
        <button className="demo-button" onClick={onDemo}><Sparkles size={17} /> Попробовать демо <ArrowRight size={16} /></button>
        <p className="form-footnote">Без регистрации. Демо-данные сбрасываются<br /> при выходе и обновлении страницы.</p>
      </div>
      <span className="auth-version">QUESTTASK · ПЕРВЫЕ ШАГИ</span>
    </section>
  </div>;
}
