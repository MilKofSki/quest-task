import { difficulties, textLength } from '../lib/game';

export function createDemoAdapter() {
  let profile;
  let tasks;
  let challenges;
  const reset = () => {
    profile = { id: 'demo-player', nickname: 'Искатель', role: 'user', xp: 0, coins: 0, progress_epoch: 1 };
    tasks = [
      ['Закончить важный проект', 'hard'],
      ['Прочитать 20 страниц книги', 'medium'],
      ['Спланировать завтрашний день', 'easy'],
    ].map(([title, difficulty], index) => ({ id: crypto.randomUUID(), title, difficulty,
      completed_at: null, archived_at: null, created_at: new Date(Date.now() - index * 1000).toISOString() }));
    challenges = [
      { id: 'first-blood', title: 'Первая кровь', description: 'Выполни три задачи за один день по Москве.', rule_type: 'tasks_in_day', target_count: 3, difficulty_filter: null, reward_xp: 100, reward_coins: 50 },
      { id: 'productivity-marathon', title: 'Марафон продуктивности', description: 'Выполни одну сложную задачу.', rule_type: 'tasks_total', target_count: 1, difficulty_filter: 'hard', reward_xp: 150, reward_coins: 75 },
    ].map(challenge => ({ ...challenge, created_at: new Date(Date.now() - 7 * 86400_000).toISOString(), claimed: false }));
  };
  reset();
  return {
    kind: 'demo', reset, getPending: () => null,
    async read(filter, page) {
      const visible = tasks.filter(t => !t.archived_at);
      const filtered = visible.filter(t => filter === 'all' || (filter === 'completed' ? t.completed_at : !t.completed_at));
      return structuredClone({ profile, tasks: filtered.slice(page * 20, page * 20 + 20), count: filtered.length,
        active: visible.filter(t => !t.completed_at).length, completed: visible.filter(t => t.completed_at).length });
    },
    async readChallenges() {
      const moscowDay = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
      const items = challenges.map(challenge => {
        const matched = tasks.filter(task => task.completed_at && task.completed_at >= challenge.created_at
          && (!challenge.difficulty_filter || task.difficulty === challenge.difficulty_filter));
        const counts = new Map();
        if (challenge.rule_type === 'tasks_in_day') matched.forEach(task => {
          const day = moscowDay(task.completed_at);
          counts.set(day, (counts.get(day) || 0) + 1);
        });
        const progress = challenge.rule_type === 'tasks_total' ? matched.length : Math.max(0, ...counts.values());
        return { ...challenge, progress: Math.min(progress, challenge.target_count), eligible: progress >= challenge.target_count };
      });
      return structuredClone({ challenges: items, next_cursor: null, server_time: new Date().toISOString() });
    },
    async mutate(method, args) {
      if (method === 'claim_challenge') {
        const challenge = challenges.find(item => item.id === args.p_challenge_id);
        if (!challenge) throw new Error('NOT_FOUND');
        if (challenge.claimed) throw new Error('CHALLENGE_ALREADY_CLAIMED');
        const { challenges: current } = await this.readChallenges();
        if (!current.find(item => item.id === challenge.id).eligible) throw new Error('CHALLENGE_NOT_READY');
        challenge.claimed = true;
        profile.xp += challenge.reward_xp;
        profile.coins += challenge.reward_coins;
        return { reward_xp: challenge.reward_xp, reward_coins: challenge.reward_coins };
      }
      if (method === 'create_task') {
        const title = args.p_title.trim();
        if (textLength(title) < 1 || textLength(title) > 200 || !difficulties[args.p_difficulty]) throw new Error('VALIDATION_ERROR');
        const task = { id: crypto.randomUUID(), title, difficulty: args.p_difficulty,
          created_at: new Date().toISOString(), completed_at: null, archived_at: null };
        tasks.unshift(task);
        return { task };
      }
      const task = tasks.find(t => t.id === args.p_task_id);
      if (!task || task.archived_at) throw new Error('NOT_FOUND');
      if (method === 'archive_task') { task.archived_at = new Date().toISOString(); return { task }; }
      if (method !== 'complete_task') throw new Error('VALIDATION_ERROR');
      if (task.completed_at) throw new Error('TASK_ALREADY_COMPLETED');
      const reward = difficulties[task.difficulty];
      task.completed_at = new Date().toISOString();
      profile.xp += reward.xp;
      profile.coins += reward.coins;
      return { task, reward_xp: reward.xp, reward_coins: reward.coins };
    },
  };
}
