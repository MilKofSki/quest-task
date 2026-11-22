import { useEffect, useMemo, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { LoaderCircle } from 'lucide-react';
import { supabase } from './lib/supabaseClient';
import { createDemoAdapter } from './demo/adapter';
import { createRemoteAdapter } from './api/tasks';
import AuthScreen from './components/AuthScreen';
import Dashboard from './components/Dashboard';

export default function App() {
  const [session, setSession] = useState(null);
  const [ready, setReady] = useState(!supabase);
  const [demo, setDemo] = useState(false);
  const [authError, setAuthError] = useState('');
  useEffect(() => {
    if (!supabase) return;
    let alive = true;
    let eventSeen = false;
    const { data } = supabase.auth.onAuthStateChange((_event, value) => {
      eventSeen = true;
      if (alive) { setSession(value); setReady(true); }
    });
    supabase.auth.getSession().then(({ data, error }) => {
      if (!alive) return;
      if (!eventSeen) setSession(data.session);
      if (error) setAuthError('Не удалось восстановить сессию. Войдите снова.');
      setReady(true);
    }).catch(() => { if (alive) { setReady(true); setAuthError('Не удалось соединиться с сервером авторизации.'); } });
    return () => { alive = false; data.subscription.unsubscribe(); };
  }, []);
  const userId = session?.user?.id;
  const adapter = useMemo(() => demo ? createDemoAdapter() : userId ? createRemoteAdapter(userId) : null, [demo, userId]);
  async function signOut() {
    if (demo) { setDemo(false); return; }
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
    setSession(null);
  }
  if (!ready) return <div className="loading-screen" role="status"><LoaderCircle className="spin" /> Восстанавливаем сессию…</div>;
  return <Routes>
    <Route path="/tasks" element={adapter
      ? <Dashboard key={demo ? 'demo' : userId} adapter={adapter} onSignOut={signOut} section="tasks" />
      : <AuthScreen initialError={authError} onDemo={() => setDemo(true)} />} />
    <Route path="/challenges" element={adapter
      ? <Dashboard key={demo ? 'demo' : userId} adapter={adapter} onSignOut={signOut} section="challenges" />
      : <AuthScreen initialError={authError} onDemo={() => setDemo(true)} />} />
    <Route path="*" element={<Navigate to="/tasks" replace />} />
  </Routes>;
}
