// Read-only smoke checks: no user credentials and no records are created.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.TEST_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const available = Boolean(url && key);

test('LIVE: public key reaches Auth and anonymous clients cannot read game data', { skip: !available }, async () => {
  const get = path => fetch(`${url.replace(/\/$/, '')}${path}`, {
    headers: { apikey: key }, signal: AbortSignal.timeout(15_000),
  });
  const settings = await get('/auth/v1/settings');
  assert.equal(settings.status, 200, 'Public key must be accepted by Auth');
  const auth = await settings.json();
  assert.equal(auth.external.email, true);
  assert.equal(auth.mailer_autoconfirm, false, 'Email confirmation must stay enabled');
  for (const table of ['profiles', 'tasks', 'challenges', 'completed_challenges',
    'shop_items', 'purchases', 'user_inventory']) {
    const response = await get(`/rest/v1/${table}?select=id&limit=1`);
    const result = await response.json();
    assert.equal(response.status, 401, `${table}: anonymous access must be rejected`);
    assert.equal(result.code, '42501', `${table}: rejection must come from database privileges`);
  }
});
