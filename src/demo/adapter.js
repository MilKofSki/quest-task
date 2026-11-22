import { difficulties, textLength } from '../lib/game.js';

export function createDemoAdapter(role = 'user') {
  let profile;
  let tasks;
  let challenges;
  let shopItems;
  let inventory;
  let adminUsers;
  const reset = () => {
    profile = { id: role === 'admin' ? 'demo-admin' : 'demo-player', nickname: role === 'admin' ? 'Хранитель' : 'Искатель', role, xp: 0, coins: 0, progress_epoch: 1, active_badge_id: null };
    tasks = [
      ['Закончить важный проект', 'hard'],
      ['Прочитать 20 страниц книги', 'medium'],
      ['Спланировать завтрашний день', 'easy'],
    ].map(([title, difficulty], index) => ({ id: crypto.randomUUID(), title, difficulty,
      completed_at: null, archived_at: null, created_at: new Date(Date.now() - index * 1000).toISOString() }));
    challenges = [
      { id: 'first-blood', title: 'Первая кровь', description: 'Выполни три задачи за один день по Москве.', rule_type: 'tasks_in_day', target_count: 3, difficulty_filter: null, reward_xp: 100, reward_coins: 50 },
      { id: 'productivity-marathon', title: 'Марафон продуктивности', description: 'Выполни одну сложную задачу.', rule_type: 'tasks_total', target_count: 1, difficulty_filter: 'hard', reward_xp: 150, reward_coins: 75 },
    ].map(challenge => ({ ...challenge, created_at: new Date(Date.now() - 7 * 86400_000).toISOString(), archived_at: null, claimed: false }));
    shopItems = [
      { id: 'badge-warrior', title: 'Новичок-Воин', icon: '⚔️', price: 50, type: 'badge', bonus_xp: 0 },
      { id: 'badge-master', title: 'Мастер Задач', icon: '🏆', price: 150, type: 'badge', bonus_xp: 0 },
      { id: 'bonus-potion', title: 'Зелье Опыта', icon: '🧪', price: 100, type: 'bonus', bonus_xp: 50 },
    ].map(item => ({ ...item, created_at: new Date().toISOString(), archived_at: null }));
    inventory = [];
    adminUsers = [
      { id: profile.id, nickname: profile.nickname, email: 'admin@example.test', role, xp: 0, coins: 0, progress_epoch: 1, level: 1 },
      { id: 'demo-target', nickname: 'Тестовый игрок', email: 'player@example.test', role: 'user', xp: 175, coins: 85, progress_epoch: 1, level: 2 },
    ];
  };
  reset();
  return {
    kind: 'demo', reset, getPending: () => null,
    async read(filter, page) {
      profile.active_badge = inventory.find(value => value.id === profile.active_badge_id)?.shop_items || null;
      const visible = tasks.filter(t => !t.archived_at);
      const filtered = visible.filter(t => filter === 'all' || (filter === 'completed' ? t.completed_at : !t.completed_at));
      return structuredClone({ profile, tasks: filtered.slice(page * 20, page * 20 + 20), count: filtered.length,
        active: visible.filter(t => !t.completed_at).length, completed: visible.filter(t => t.completed_at).length });
    },
    async readChallenges() {
      const moscowDay = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
      const items = challenges.filter(challenge => !challenge.archived_at).map(challenge => {
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
    async readShopPage(kind, _epoch, page = 0) {
      const values = kind === 'items' ? shopItems.filter(item => !item.archived_at) : kind === 'inventory' ? inventory : null;
      if (!values || !Number.isInteger(page) || page < 0) throw new Error('VALIDATION_ERROR');
      const rows = values.slice(page * 20, page * 20 + 20).map(item => kind === 'items'
        ? { ...item, owned: inventory.some(entry => entry.item_id === item.id) } : item);
      return structuredClone({ rows, hasMore: values.length > (page + 1) * 20 });
    },
    async readShop(epoch) {
      const items = await this.readShopPage('items', epoch);
      const titles = await this.readShopPage('inventory', epoch);
      return { items: items.rows, inventory: titles.rows, moreItems: items.hasMore, moreInventory: titles.hasMore };
    },
    async readAdmin(section) {
      if (role !== 'admin') throw new Error('FORBIDDEN');
      adminUsers[0] = { ...adminUsers[0], role: profile.role, xp: profile.xp, coins: profile.coins,
        progress_epoch: profile.progress_epoch, level: Math.floor(profile.xp / 100) + 1 };
      const key = { challenges: 'challenges', items: 'items', users: 'users' }[section];
      const values = { challenges, items: shopItems, users: adminUsers }[section];
      if (!key) throw new Error('VALIDATION_ERROR');
      return structuredClone({ [key]: values, next_cursor: null });
    },
    async mutate(method, args) {
      if (method.startsWith('admin_')) {
        if (role !== 'admin') throw new Error('FORBIDDEN');
        if (method === 'admin_create_challenge') {
          const challenge = { id: crypto.randomUUID(), title: args.p_title.trim(), description: args.p_description,
            rule_type: args.p_rule_type, target_count: Number(args.p_target_count), difficulty_filter: args.p_difficulty_filter,
            reward_xp: Number(args.p_reward_xp), reward_coins: Number(args.p_reward_coins),
            created_at: new Date().toISOString(), archived_at: null, claimed: false };
          challenges.unshift(challenge); return { challenge };
        }
        if (method === 'admin_create_item') {
          const item = { id: crypto.randomUUID(), title: args.p_title.trim(), icon: args.p_icon,
            price: Number(args.p_price), type: args.p_type, bonus_xp: Number(args.p_bonus_xp),
            created_at: new Date().toISOString(), archived_at: null };
          shopItems.unshift(item); return { item };
        }
        if (method === 'admin_archive_challenge' || method === 'admin_archive_item') {
          const entries = method === 'admin_archive_challenge' ? challenges : shopItems;
          const item = entries.find(value => value.id === (args.p_challenge_id || args.p_item_id));
          if (!item) throw new Error('NOT_FOUND');
          item.archived_at ||= new Date().toISOString(); return { item };
        }
        if (method === 'admin_set_role') {
          if (args.p_target_user_id === profile.id) throw new Error('SELF_ROLE_CHANGE');
          const target = adminUsers.find(value => value.id === args.p_target_user_id);
          if (!target) throw new Error('NOT_FOUND');
          target.role = args.p_new_role; return { role: target.role };
        }
        if (method === 'admin_reset_progress') {
          const target = adminUsers.find(value => value.id === args.p_target_user_id);
          if (!target) throw new Error('NOT_FOUND');
          if (target.progress_epoch !== args.p_expected_epoch) throw new Error('EPOCH_CHANGED');
          target.xp = 0; target.coins = 0; target.level = 1; target.progress_epoch++;
          if (target.id === profile.id) { profile.xp = 0; profile.coins = 0; profile.progress_epoch++; profile.active_badge_id = null; }
          return { target_user_id: target.id, progress_epoch: target.progress_epoch };
        }
        throw new Error('VALIDATION_ERROR');
      }
      if (method === 'buy_item') {
        const item = shopItems.find(value => value.id === args.p_item_id);
        if (!item) throw new Error('NOT_FOUND');
        if (item.type === 'badge' && inventory.some(value => value.item_id === item.id)) throw new Error('ITEM_ALREADY_OWNED');
        if (profile.coins < item.price) throw new Error('INSUFFICIENT_COINS');
        profile.coins -= item.price;
        if (item.type === 'bonus') profile.xp += item.bonus_xp;
        else inventory.unshift({ id: crypto.randomUUID(), item_id: item.id, purchased_at: new Date().toISOString(), shop_items: { title: item.title, icon: item.icon } });
        return { item_type: item.type, paid_coins: item.price, granted_xp: item.type === 'bonus' ? item.bonus_xp : 0 };
      }
      if (method === 'equip_badge') {
        if (args.p_inventory_id && !inventory.some(value => value.id === args.p_inventory_id)) throw new Error('BADGE_NOT_OWNED');
        profile.active_badge_id = args.p_inventory_id || null;
        return { active_badge_id: profile.active_badge_id };
      }
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
