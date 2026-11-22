import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const key = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();
const validUrl = url && /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(url);
export const configured = Boolean(validUrl && key);
export const supabase = configured ? createClient(url, key) : null;

export const configurationMessage = url || key
  ? 'Проверьте URL и публичный ключ Supabase в .env.local, затем перезапустите приложение.'
  : 'Подключение аккаунтов ещё не настроено. Пока можно попробовать задачи в деморежиме.';
