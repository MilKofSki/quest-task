export const difficulties = {
  easy: { label: 'Лёгкая', xp: 10, coins: 5, caption: 'Небольшой шаг' },
  medium: { label: 'Средняя', xp: 25, coins: 15, caption: 'Немного усилий' },
  hard: { label: 'Сложная', xp: 50, coins: 30, caption: 'Настоящий вызов' },
};
export const levelOf = xp => Math.floor(xp / 100) + 1;
export const progressOf = xp => xp % 100;
export const formatNumber = number => new Intl.NumberFormat('ru-RU').format(number);
export const textLength = text => Array.from(text).length;

export const messages = {
  AUTH_REQUIRED: 'Сессия завершилась. Войдите ещё раз.',
  EMAIL_NOT_CONFIRMED: 'Сначала подтвердите адрес электронной почты.',
  FORBIDDEN: 'У вас нет доступа к этому действию.',
  NOT_FOUND: 'Запись не найдена или недоступна. Данные обновлены.',
  VALIDATION_ERROR: 'Проверьте введённые данные и попробуйте ещё раз.',
  EPOCH_CHANGED: 'Прогресс изменился. Данные обновлены — попробуйте ещё раз.',
  TASK_ALREADY_COMPLETED: 'Эта задача уже выполнена. Повторная награда не начислена.',
  CHALLENGE_NOT_READY: 'Условие челленджа ещё не выполнено. Прогресс обновлён.',
  CHALLENGE_ALREADY_CLAIMED: 'Награда за этот челлендж уже получена.',
  ITEM_ARCHIVED: 'Товар уже снят с продажи. Каталог обновлён.',
  ITEM_ALREADY_OWNED: 'Этот титул уже есть в инвентаре.',
  INSUFFICIENT_COINS: 'Монет не хватает для покупки.',
  BADGE_NOT_OWNED: 'Этот титул недоступен в вашем инвентаре.',
  SELF_ROLE_CHANGE: 'Нельзя изменить собственную роль администратора.',
  LAST_ADMIN: 'Нельзя убрать последнего администратора.',
  IDEMPOTENCY_CONFLICT: 'Этот запрос уже использован для другого действия. Обновите страницу.',
};
export function friendlyError(error) {
  const code = Object.keys(messages).find(key => error?.message?.includes(key));
  if (code) return messages[code];
  if (error?.code === 'invalid_credentials') return 'Неверный email или пароль.';
  if (error?.code === 'email_not_confirmed') return messages.EMAIL_NOT_CONFIRMED;
  if (error?.code === 'otp_expired') return 'Код неверен или истёк. Запросите новый код.';
  if (error?.status === 429 || error?.code?.includes('rate_limit')) return 'Слишком много попыток. Подождите и попробуйте снова.';
  if (error?.code === 'weak_password') return 'Выберите более надёжный пароль: минимум 8 символов.';
  if (error?.code === 'email_address_invalid') return 'Проверьте адрес электронной почты.';
  if (error?.code === '23514') return 'Операция выходит за допустимые ограничения.';
  return 'Не удалось выполнить запрос. Проверьте соединение и попробуйте снова.';
}
export function isDefiniteError(error) {
  return Object.keys(messages).some(key => error?.message?.includes(key))
    || ['23514', '22003', '42501', 'PGRST202'].includes(error?.code);
}
