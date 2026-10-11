'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { Store } = require('../src/core/store.cjs');
const catalog = require('../src/data/catalog.cjs');
test('explicit query history persists, deduplicates and remains isolated by profile', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-search-history-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir, catalog),
    first = store.get().activeProfileId;
  for (const query of ['永久增加气血', '种类:物品 品质:蓝', '永久增加气血'])
    store.mutate({ type: 'search-remember', query });
  store.mutate({ type: 'search-save', query: '永久增加气血' });
  assert.deepEqual(new Store(dir, catalog).get().profiles[0].recentSearches, [
    '永久增加气血',
    '种类:物品 品质:蓝',
  ]);
  store.mutate({ type: 'profile-add', name: '新周目' });
  assert.equal(store.get().profiles[1].savedSearches, undefined);
  store.mutate({ type: 'profile-switch', id: first });
  store.mutate({ type: 'search-history-clear' });
  assert.equal(store.get().profiles[0].recentSearches.length, 0);
  assert.deepEqual(store.get().profiles[0].savedSearches, ['永久增加气血']);
  store.mutate({ type: 'search-forget', query: '永久增加气血' });
  assert.deepEqual(store.get().profiles[0].savedSearches, []);
});

test('saving beyond capacity preserves every explicit search and both journal copies', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-search-capacity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir, catalog);
  const queries = Array.from({ length: 20 }, (_, i) => `名称:收藏${i + 1}`);
  for (const query of queries) store.mutate({ type: 'search-save', query });
  const before = store.get();
  const bytes = [store.file, `${store.file}.previous`].map((file) => fs.readFileSync(file));
  assert.throws(() => store.mutate({ type: 'search-save', query: '名称:第21个收藏' }), /20.*管理已保存搜索/);
  assert.deepEqual(store.get(), before);
  for (const [i, file] of [store.file, `${store.file}.previous`].entries())
    assert.deepEqual(fs.readFileSync(file), bytes[i]);
  assert.deepEqual(new Store(dir, catalog).get().profiles[0].savedSearches, [...queries].reverse());
});

test('at capacity an existing search remains reusable and removing one permits an explicit replacement', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-search-replacement-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir, catalog);
  const queries = Array.from({ length: 20 }, (_, i) => `名称:收藏${i + 1}`);
  for (const query of queries) store.mutate({ type: 'search-save', query });
  store.mutate({ type: 'search-save', query: `  ${queries[0]}  ` });
  assert.deepEqual(store.get().profiles[0].savedSearches, [queries[0], ...queries.slice(1).reverse()]);
  store.mutate({ type: 'search-forget', query: queries[7] });
  store.mutate({ type: 'search-save', query: '名称:新收藏' });
  assert.deepEqual(
    new Set(store.get().profiles[0].savedSearches),
    new Set([...queries.filter((q) => q !== queries[7]), '名称:新收藏']),
  );
  for (const query of [...queries, '名称:最近搜索21']) store.mutate({ type: 'search-remember', query });
  const restarted = new Store(dir, catalog).get().profiles[0];
  assert.equal(restarted.recentSearches.length, 20);
  assert(!restarted.recentSearches.includes(queries[0]));
  assert.equal(restarted.savedSearches.length, 20);
  assert(restarted.savedSearches.includes(queries[0]));
  assert(!restarted.savedSearches.includes(queries[7]));
});
