'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Store } = require('../src/core/store.cjs');
const catalog = require('../src/data/catalog.cjs');
test('explicit query history persists, deduplicates and remains isolated by profile', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-search-history-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir, catalog), first = store.get().activeProfileId;
  for (const query of ['永久增加气血', '种类:物品 品质:蓝', '永久增加气血'])
    store.mutate({ type: 'search-remember', query });
  store.mutate({ type: 'search-save', query: '永久增加气血' });
  assert.deepEqual(new Store(dir, catalog).get().profiles[0].recentSearches,
    ['永久增加气血', '种类:物品 品质:蓝']);
  store.mutate({ type: 'profile-add', name: '新周目' });
  assert.equal(store.get().profiles[1].savedSearches, undefined);
  store.mutate({ type: 'profile-switch', id: first });
  store.mutate({ type: 'search-history-clear' });
  assert.equal(store.get().profiles[0].recentSearches.length, 0);
  assert.deepEqual(store.get().profiles[0].savedSearches, ['永久增加气血']);
  store.mutate({ type: 'search-forget', query: '永久增加气血' });
  assert.deepEqual(store.get().profiles[0].savedSearches, []);
});
