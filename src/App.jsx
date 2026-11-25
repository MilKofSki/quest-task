import { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { LoaderCircle } from 'lucide-react';
import { supabase } from './lib/supabaseClient';
import { createDemoAdapter } from './demo/adapter';
import { createRemoteAdapter } from './api/tasks';
import AuthScreen from './components/AuthScreen';
import Dashboard from './components/Dashboard';

function hasRecoveryLinkError() {
  const fragments = [window.location.search, window.location.hash.replace(/^#/, '')];
  return fragments.some(value => {
    const params = new URLSearchParams(value);
    return params.has('error_code') || params.get('error') === 'access_denied';
  });
}

function hasStoredRecovery() {
  try { return sessionStorage.getItem('questtask:password-recovery') === 'true'; } catch { return false; }
}

export default function App() {
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const [session, setSession] = useState(null);
  const [ready, setReady] = useState(!supabase);
  const [demoRole, setDemoRole] = useState(null);
  const [authError, setAuthError] = useState(() => hasRecoveryLinkError() ? 'Ссылка для восстановления недействительна или истекла. Запросите новую.' : '');
  const [expiredRecovery, setExpiredRecovery] = useState(hasRecoveryLinkError);
  const [passwordRecovery, setPasswordRecovery] = useState(hasStoredRecovery);
  useEffect(() => {
    if (!supabase) return;
    let alive = true;
    let eventSeen = false;
    const { data } = supabase.auth.onAuthStateChange((event, value) => {
      eventSeen = true;
      if (!alive) return;
      setSession(value);
      if (event === 'PASSWORD_RECOVERY') {
        try { sessionStorage.setItem('questtask:password-recovery', 'true'); } catch { /* optional session marker */ }
        setPasswordRecovery(true);
        setExpiredRecovery(false);
        navigateRef.current('/tasks', { replace: true });
      }
      if (event === 'SIGNED_OUT') {
        try { sessionStorage.removeItem('questtask:password-recovery'); } catch { /* optional session marker */ }
        setPasswordRecovery(false);
      }
      setReady(true);
    });
    supabase.auth.getSession().then(({ data, error }) => {
      if (!alive) return;
      if (!eventSeen) setSession(data.session);
      if (error) setAuthError('Не удалось восстановить сессию. Войдите снова.');
      if (expiredRecovery) {
        setAuthError('Ссылка для восстановления недействительна или истекла. Запросите новую.');
        navigateRef.current('/tasks', { replace: true });
      }
      setReady(true);
    }).catch(() => { if (alive) { setReady(true); setAuthError('Не удалось соединиться с сервером авторизации.'); } });
    return () => { alive = false; data.subscription.unsubscribe(); };
  }, []);
  const userId = session?.user?.id;
  const adapter = useMemo(() => demoRole ? createDemoAdapter(demoRole) : userId ? createRemoteAdapter(userId) : null, [demoRole, userId]);
  async function signOut() {
    if (demoRole) { setDemoRole(null); return; }
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
    setSession(null);
    setPasswordRecovery(false);
  }
  async function cancelRecovery() {
    try {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      try { sessionStorage.removeItem('questtask:password-recovery'); } catch { /* optional session marker */ }
      setSession(null);
      setPasswordRecovery(false);
    } catch {
      setAuthError('Не удалось завершить сессию. Обновите страницу и попробуйте ещё раз.');
    }
  }
  const authScreen = <AuthScreen
    key={passwordRecovery ? 'password-recovery' : expiredRecovery ? 'expired-recovery' : 'normal-auth'}
    initialError={authError}
    recovery={passwordRecovery}
    expiredRecovery={expiredRecovery}
    onRecoveryComplete={() => setPasswordRecovery(false)}
    onRecoveryCancel={cancelRecovery}
    onDemo={() => setDemoRole('user')}
    onDemoAdmin={() => setDemoRole('admin')}
  />;
  const renderSection = section => passwordRecovery || expiredRecovery || !adapter
    ? authScreen
    : <Dashboard key={demoRole ? `demo-${demoRole}` : userId} adapter={adapter} onSignOut={signOut} section={section} />;
  if (!ready) return <div className="loading-screen" role="status"><LoaderCircle className="spin" /> Восстанавливаем сессию…</div>;
  return <Routes>
    <Route path="/tasks" element={renderSection('tasks')} />
    <Route path="/challenges" element={renderSection('challenges')} />
    <Route path="/shop" element={renderSection('shop')} />
    <Route path="/admin" element={renderSection('admin')} />
    <Route path="*" element={<Navigate to="/tasks" replace />} />
  </Routes>;
}
