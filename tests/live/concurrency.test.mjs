// This test changes ONLY dedicated test accounts. Run against a test Supabase project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const required = ['TEST_SUPABASE_URL', 'TEST_SUPABASE_ANON_KEY', 'TEST_EMAIL', 'TEST_PASSWORD'];
const available = required.every(key => process.env[key]);
test('LIVE: 10 concurrent requests complete one task and award only 50 XP / 30 coins', { skip: !available }, async () => {
  const client = createClient(process.env.TEST_SUPABASE_URL, process.env.TEST_SUPABASE_ANON_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } });
  const login = await client.auth.signInWithPassword({ email: process.env.TEST_EMAIL, password: process.env.TEST_PASSWORD });
  assert.ifError(login.error);
  const getProfile = async () => {
    const { data, error } = await client.from('profiles').select('*').eq('id', login.data.user.id).single();
    assert.ifError(error); return data;
  };
  const before = await getProfile();
  const request = { p_title: `Concurrency check ${randomUUID()}`, p_difficulty: 'hard',
    p_expected_epoch: before.progress_epoch, p_request_id: randomUUID() };
  const created = await client.rpc('create_task', request);
  assert.ifError(created.error);
  const taskId = created.data.task.id;
  try {
    const responses = await Promise.all(Array.from({ length: 10 }, () => client.rpc('complete_task', {
      p_task_id: taskId, p_expected_epoch: before.progress_epoch, p_request_id: randomUUID(),
    })));
    assert.equal(responses.filter(r => !r.error).length, 1);
    for (const r of responses.filter(r => r.error)) assert.match(r.error.message, /TASK_ALREADY_COMPLETED/);
    const after = await getProfile();
    assert.equal(Number(after.xp) - Number(before.xp), 50);
    assert.equal(Number(after.coins) - Number(before.coins), 30);
  } finally {
    const archived = await client.rpc('archive_task', { p_task_id: taskId, p_expected_epoch: before.progress_epoch, p_request_id: randomUUID() });
    assert.ifError(archived.error);
    await client.auth.signOut();
  }
});
