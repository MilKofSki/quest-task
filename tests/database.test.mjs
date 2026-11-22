import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

let db;
before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users(id uuid primary key, raw_user_meta_data jsonb default '{}', email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
    grant usage on schema auth, public to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
  `);
  await db.exec(await readFile(new URL('../supabase/migrations/202611170001_tasks_foundation.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/202611220001_challenges.sql', import.meta.url), 'utf8'));
});
after(async () => { await db?.close(); });

async function user(confirmed = true, metadata = { nickname: 'Тестовый игрок' }) {
  const id = randomUUID();
  await db.query('insert into auth.users(id,raw_user_meta_data,email_confirmed_at) values($1,$2,$3)',
    [id, JSON.stringify(metadata), confirmed ? new Date().toISOString() : null]);
  return id;
}
async function asUser(id, sql, params = [], role = 'authenticated') {
  return db.transaction(async tx => {
    await tx.exec(`set local role ${role}`);
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [id || '']);
    return tx.query(sql, params);
  });
}
async function create(id, difficulty = 'hard', request = randomUUID(), title = 'Мой квест') {
  const result = await asUser(id, 'select public.create_task($1,$2,1,$3) as result', [title, difficulty, request]);
  return result.rows[0].result;
}
async function complete(id, task, request = randomUUID(), epoch = 1) {
  const result = await asUser(id, 'select public.complete_task($1,$2,$3) as result', [task, epoch, request]);
  return result.rows[0].result;
}
async function profile(id) { return (await asUser(id, 'select * from public.profiles')).rows[0]; }
async function challengeProgress(id) {
  return (await asUser(id, 'select public.get_challenge_progress(20,null) as result')).rows[0].result.challenges;
}
async function claim(id, challengeId, request = randomUUID()) {
  return (await asUser(id, 'select public.claim_challenge($1,1,$2) as result', [challengeId, request])).rows[0].result;
}

test('registration ignores role and balance supplied through user metadata', async () => {
  const id = await user(true, { nickname: '  Герой  ', role: 'admin', xp: 999, coins: 999 });
  const p = await profile(id);
  assert.equal(p.nickname, 'Герой'); assert.equal(p.role, 'user');
  assert.equal(Number(p.xp), 0); assert.equal(Number(p.coins), 0);
  assert.equal(p.progress_epoch, 1);
  await assert.rejects(user(true, { nickname: ' ' }), /VALIDATION_ERROR/);
});

test('anon and unconfirmed users cannot access game data', async () => {
  const id = await user(false);
  await assert.rejects(asUser(null, 'select * from public.profiles', [], 'anon'), /permission denied/);
  await assert.rejects(asUser(null, 'select public.create_task($1,$2,1,$3)', ['X','hard',randomUUID()], 'anon'), /permission denied/);
  assert.equal((await asUser(id, 'select * from public.profiles')).rows.length, 0);
  await assert.rejects(create(id), /EMAIL_NOT_CONFIRMED/);
  await assert.rejects(asUser(null, 'select public.get_operation($1)', [randomUUID()]), /AUTH_REQUIRED/);
});

test('RLS and RPC ownership isolate two accounts', async () => {
  const a = await user(); const b = await user();
  const task = await create(a);
  assert.equal((await asUser(b, 'select * from public.tasks where id=$1', [task.task.id])).rows.length, 0);
  assert.equal((await asUser(b, 'select * from public.profiles where id=$1', [a])).rows.length, 0);
  await assert.rejects(complete(b, task.task.id), /NOT_FOUND/);
  await assert.rejects(asUser(b, 'select public.archive_task($1,1,$2)', [task.task.id, randomUUID()]), /NOT_FOUND/);
});

test('direct mutations and private helpers are inaccessible even with app admin role', async () => {
  const id = await user();
  await db.query("update public.profiles set role='admin' where id=$1", [id]);
  for (const sql of [
    'update public.profiles set xp=1000', "update public.profiles set role='admin'", 'delete from public.tasks',
    "insert into public.tasks(user_id,progress_epoch,title,difficulty) values(auth.uid(),1,'x','hard')",
    'update public.tasks set completed_at=now()', 'truncate public.tasks',
    'select * from private.operations', 'select private.require_user()',
  ]) await assert.rejects(asUser(id, sql), /permission denied/);
});

test('server awards exactly 10/5, 25/15 and 50/30; completion cannot be repeated', async () => {
  const id = await user();
  for (const [difficulty, xp, coins] of [['easy',10,5],['medium',25,15],['hard',50,30]]) {
    const { task } = await create(id, difficulty);
    const result = await complete(id, task.id);
    assert.equal(result.reward_xp, xp); assert.equal(result.reward_coins, coins);
    assert.ok(result.task.completed_at);
    for (let i = 0; i < 10; i++) await assert.rejects(complete(id, task.id), /TASK_ALREADY_COMPLETED/);
  }
  const p = await profile(id);
  assert.equal(Number(p.xp), 85); assert.equal(Number(p.coins), 50);
  const events = await db.query('select count(*) as n,sum(delta_xp) as xp,sum(delta_coins) as coins from private.economy_events where user_id=$1', [id]);
  assert.equal(Number(events.rows[0].n), 3); assert.equal(Number(events.rows[0].xp), 85); assert.equal(Number(events.rows[0].coins), 50);
});

test('challenge progress counts completed archived tasks and grants each reward once', async () => {
  const id = await user();
  const initial = await challengeProgress(id);
  const daily = initial.find(c => c.rule_type === 'tasks_in_day');
  const hard = initial.find(c => c.rule_type === 'tasks_total');
  assert.equal(initial.length, 2);
  await assert.rejects(claim(id, daily.id), /CHALLENGE_NOT_READY/);
  const tasks = [];
  for (const difficulty of ['hard', 'easy', 'medium']) {
    const { task } = await create(id, difficulty);
    await complete(id, task.id);
    tasks.push(task);
  }
  await asUser(id, 'select public.archive_task($1,1,$2)', [tasks[0].id, randomUUID()]);
  const ready = await challengeProgress(id);
  assert.equal(ready.find(c => c.id === daily.id).progress, 3);
  assert.equal(ready.find(c => c.id === hard.id).progress, 1);
  assert.ok(ready.every(c => c.eligible && !c.claimed));
  const before = await profile(id);
  const request = randomUUID();
  const first = await claim(id, daily.id, request);
  const replay = await claim(id, daily.id, request);
  assert.equal(first.reward_xp, 100);
  assert.equal(first.reward_coins, 50);
  assert.equal(replay.replayed, true);
  await assert.rejects(claim(id, daily.id), /CHALLENGE_ALREADY_CLAIMED/);
  const after = await profile(id);
  assert.equal(Number(after.xp) - Number(before.xp), 100);
  assert.equal(Number(after.coins) - Number(before.coins), 50);
  const events = await db.query("select count(*) as n from private.economy_events where user_id=$1 and reason='challenge_reward'", [id]);
  assert.equal(Number(events.rows[0].n), 1);
  assert.equal((await challengeProgress(id)).find(c => c.id === daily.id).claimed, true);
});

test('daily challenge groups by Moscow date and excludes other epochs', async () => {
  const id = await user();
  const tasks = [];
  for (let i = 0; i < 3; i++) {
    const { task } = await create(id, 'easy');
    await complete(id, task.id);
    tasks.push(task.id);
  }
  const times = ['2030-01-01T20:59:00Z', '2030-01-01T21:01:00Z', '2030-01-01T21:02:00Z'];
  for (let i = 0; i < 3; i++) await db.query('update public.tasks set created_at=$1, completed_at=$1 where id=$2', [times[i], tasks[i]]);
  const daily = (await challengeProgress(id)).find(c => c.rule_type === 'tasks_in_day');
  assert.equal(daily.progress, 2);
  assert.equal(daily.eligible, false);
  await db.query('update public.tasks set created_at=$1, completed_at=$1 where id=$2', ['2030-01-01T21:03:00Z', tasks[0]]);
  assert.equal((await challengeProgress(id)).find(c => c.id === daily.id).progress, 3);
  await db.query('update public.tasks set progress_epoch=2 where id=$1', [tasks[0]]);
  assert.equal((await challengeProgress(id)).find(c => c.id === daily.id).progress, 2);
});

test('challenge tables and reward helper reject direct client access', async () => {
  const a = await user(); const b = await user();
  const challenge = (await challengeProgress(a))[0];
  for (const sql of [
    "insert into public.challenges(title,rule_type,target_count,reward_xp,reward_coins) values('x','tasks_total',1,100,0)",
    'update public.challenges set reward_xp=9999',
    'delete from public.challenges',
    'insert into public.completed_challenges(user_id,progress_epoch,challenge_id,reward_xp,reward_coins,operation_id) values(auth.uid(),1,gen_random_uuid(),100,0,gen_random_uuid())',
    'select private.challenge_progress(null,auth.uid(),1)',
  ]) await assert.rejects(asUser(a, sql), /permission denied/);
  await assert.rejects(asUser(null, 'select public.get_challenge_progress(20,null)', [], 'anon'), /permission denied/);
  await assert.rejects(asUser(b, 'select public.claim_challenge($1,1,$2)', [challenge.id, randomUUID()]), /CHALLENGE_NOT_READY/);
  assert.equal((await asUser(b, 'select * from public.completed_challenges')).rows.length, 0);
});

test('challenge reward rolls back balance, claim and receipt when event insert fails', async () => {
  const id = await user();
  const { task } = await create(id, 'hard');
  await complete(id, task.id);
  const hard = (await challengeProgress(id)).find(c => c.difficulty_filter === 'hard');
  const before = await profile(id); const request = randomUUID();
  await db.exec(`create function private.test_fail_challenge_event() returns trigger language plpgsql as $$
    begin if new.reason = 'challenge_reward' then raise exception 'TEST_FAILURE'; end if; return new; end; $$;
    create trigger test_fail_challenge before insert on private.economy_events
      for each row execute function private.test_fail_challenge_event();`);
  try { await assert.rejects(claim(id, hard.id, request), /TEST_FAILURE/); }
  finally { await db.exec('drop trigger test_fail_challenge on private.economy_events; drop function private.test_fail_challenge_event();'); }
  assert.equal(Number((await profile(id)).xp), Number(before.xp));
  assert.equal(Number((await profile(id)).coins), Number(before.coins));
  assert.equal((await asUser(id, 'select * from public.completed_challenges')).rows.length, 0);
  await assert.rejects(asUser(id, 'select public.get_operation($1)', [request]), /NOT_FOUND/);
  assert.equal((await claim(id, hard.id, request)).reward_xp, 150);
});

test('idempotency survives a lost response and rejects changed payloads', async () => {
  const id = await user(); const createKey = randomUUID();
  const first = await create(id, 'hard', createKey);
  const replay = await create(id, 'hard', createKey);
  assert.equal(replay.replayed, true); assert.equal(replay.task.id, first.task.id);
  await assert.rejects(create(id, 'easy', createKey), /IDEMPOTENCY_CONFLICT/);
  const completeKey = randomUUID();
  await complete(id, first.task.id, completeKey);
  assert.equal((await complete(id, first.task.id, completeKey)).replayed, true);
  assert.equal(Number((await profile(id)).xp), 50);
  const found = await asUser(id, 'select public.get_operation($1) as result', [completeKey]);
  assert.equal(found.rows[0].result.reward_xp, 50);
  const other = await user();
  await assert.rejects(asUser(other, 'select public.get_operation($1)', [completeKey]), /NOT_FOUND/);
  await assert.rejects(complete(id, first.task.id, createKey), /IDEMPOTENCY_CONFLICT/);
});

test('archiving retains rewards and historical completion, but blocks unfinished tasks', async () => {
  const id = await user(); const { task } = await create(id); await complete(id, task.id);
  await asUser(id, 'select public.archive_task($1,1,$2)', [task.id, randomUUID()]);
  const history = await asUser(id, 'select completed_at,archived_at from public.tasks where id=$1', [task.id]);
  assert.ok(history.rows[0].completed_at); assert.ok(history.rows[0].archived_at);
  assert.equal(Number((await profile(id)).coins), 30);
  const fresh = await create(id);
  await asUser(id, 'select public.archive_task($1,1,$2)', [fresh.task.id, randomUUID()]);
  await assert.rejects(complete(id, fresh.task.id), /NOT_FOUND/);
});

test('validation and stale epochs cannot mutate the economy', async () => {
  const id = await user();
  await assert.rejects(create(id, 'extreme'), /VALIDATION_ERROR/);
  await assert.rejects(create(id, 'easy', randomUUID(), ' '), /VALIDATION_ERROR/);
  await assert.rejects(create(id, 'easy', randomUUID(), '\n\t\r '), /VALIDATION_ERROR/);
  await assert.rejects(create(id, 'easy', randomUUID(), 'x'.repeat(201)), /VALIDATION_ERROR/);
  const key = randomUUID(); const first = await create(id, 'hard', key);
  await db.query('update public.profiles set progress_epoch=2 where id=$1', [id]);
  await assert.rejects(complete(id, first.task.id), /EPOCH_CHANGED/);
  const replay = await create(id, 'hard', key);
  assert.equal(replay.superseded, true); assert.equal(replay.replayed, true);
  assert.equal(Number((await profile(id)).xp), 0);
});

test('an event-write failure rolls back completion, balance AND operation receipt', async () => {
  const id = await user(); const { task } = await create(id); const key = randomUUID();
  await db.exec(`create function private.test_fail_event() returns trigger language plpgsql as $$ begin raise exception 'TEST_FAILURE'; end; $$;
    create trigger test_fail before insert on private.economy_events for each row execute function private.test_fail_event();`);
  try { await assert.rejects(complete(id, task.id, key), /TEST_FAILURE/); }
  finally { await db.exec('drop trigger test_fail on private.economy_events; drop function private.test_fail_event();'); }
  assert.equal(Number((await profile(id)).xp), 0);
  assert.equal((await asUser(id, 'select completed_at from public.tasks where id=$1', [task.id])).rows[0].completed_at, null);
  await assert.rejects(asUser(id, 'select public.get_operation($1)', [key]), /NOT_FOUND/);
  assert.equal((await complete(id, task.id, key)).reward_xp, 50);
});

test('all definer functions fix search_path and private functions have no public grants', async () => {
  const functions = await db.query(`select p.proname,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','private') and p.prosecdef`);
  assert.ok(functions.rows.length >= 8);
  for (const fn of functions.rows) assert.ok(fn.proconfig.some(x => x.startsWith('search_path=')), fn.proname);
  const grants = await db.query(`select has_function_privilege('authenticated','private.replay_operation(uuid,text,jsonb)','EXECUTE') as allowed`);
  assert.equal(grants.rows[0].allowed, false);
});
