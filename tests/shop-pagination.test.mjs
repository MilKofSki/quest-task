import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoAdapter } from '../src/demo/adapter.js';

test('shop and inventory remain accessible beyond the first hundred records', async () => {
  const adapter = createDemoAdapter('admin');
  for (let index = 0; index < 105; index++) {
    await adapter.mutate('admin_create_item', {
      p_title: `Test badge ${index}`, p_icon: '🏅', p_price: 1,
      p_type: 'badge', p_bonus_xp: 0,
    });
  }
  for (let index = 0; index < 4; index++) {
    const { task } = await adapter.mutate('create_task', { p_title: `Earn coins ${index}`, p_difficulty: 'hard' });
    await adapter.mutate('complete_task', { p_task_id: task.id });
  }
  const catalog = [];
  for (let page = 0; page < 6; page++) {
    const result = await adapter.readShopPage('items', 1, page);
    assert.ok(result.rows.length <= 20);
    assert.equal(result.hasMore, page < 5);
    catalog.push(...result.rows);
  }
  assert.equal(catalog.length, 108);
  assert.equal(new Set(catalog.map(item => item.id)).size, 108);
  for (const item of catalog.filter(value => value.price === 1)) {
    await adapter.mutate('buy_item', { p_item_id: item.id });
  }
  const titles = [];
  for (let page = 0; page < 6; page++) {
    const result = await adapter.readShopPage('inventory', 1, page);
    assert.ok(result.rows.length <= 20);
    assert.equal(result.hasMore, page < 5);
    titles.push(...result.rows);
  }
  assert.equal(titles.length, 105);
  assert.equal(new Set(titles.map(item => item.item_id)).size, 105);
  const lastCatalogPage = await adapter.readShopPage('items', 1, 5);
  assert.ok(lastCatalogPage.rows.some(item => item.price === 1 && item.owned));
});
