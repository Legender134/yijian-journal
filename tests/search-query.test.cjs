'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/search-query.js'), 'utf8');
const modulePromise = import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const entries = require('../src/data/game-index.json').entries;
test('global and catalogue matching share effects, descriptions, ingredients and personal target text', async () => {
  const { compileSearch } = await modulePromise;
  const results = entries.filter(compileSearch('永久增加气血'));
  assert.equal(results.filter((e) => e.kind === '物品').length, 7);
  assert(results.some((e) => e.kind === '配方'));
  assert(results.some((e) => e.id === 'item-100'));
  assert(compileSearch('采购验收甲')({ title: '武当采购验收甲', detail: '到药谷' }));
  assert(compileSearch('铁锭')(entries.find((e) => e.id === 'fusion-1000')));
});
test('plain text, Chinese facets, quoted phrases, negation and DIM-style grouping combine predictably', async () => {
  const { compileSearch } = await modulePromise;
  const item = entries.find((e) => e.id === 'item-100');
  assert(compileSearch('种类:物品 品质：绿 永久增加气血')(item));
  assert(!compileSearch('种类:物品 -品质:绿')(item));
  assert(compileSearch('品质:绿 或 品质:蓝')(item));
  assert(compileSearch('(品质:绿 or 品质:蓝) 种类:物品')(item));
  assert(!compileSearch('(品质:绿 or 品质:蓝) 种类:人物')(item));
  assert(compileSearch('"永久增加气血"')(item));
  assert(compileSearch('"foo:bar"')({ title: 'foo:bar' }));
  assert(compileSearch('名称:"小二-王宸"')({ name: '小二-王宸' }));
});
test('invalid or unfinished filters surface a useful error rather than silently returning no results', async () => {
  const { compileSearch } = await modulePromise;
  for (const query of ['unknown:value', '品质:', '"未闭合', '(品质:绿', '品质:绿)', '品质:绿 or', '-'])
    assert.throws(() => compileSearch(query));
  assert.throws(() => compileSearch('('.repeat(41) + '丹药' + ')'.repeat(41)), /过多/);
  assert.throws(() => compileSearch('a'.repeat(201)), /200/);
  assert(compileSearch('')({}));
});

test('filtered name intent ranks the actual copper recipe ahead of recipes using copper before the result quota', async () => {
  const { compileSearch, compareSearchTitles } = await modulePromise;
  for (const query of [
    '铜锭',
    '种类:配方 铜锭',
    '铜锭 kind:配方',
    '种类：配方 "铜锭"',
    '种类:配方 名称:铜锭',
    '(种类:配方 铜锭) -品质:红',
  ]) {
    const found = entries.filter(compileSearch(query)).sort(compareSearchTitles(query)).slice(0, 12);
    assert.equal(found.find((row) => row.kind === '配方')?.id, 'fusion-9501', query);
  }
});

test('ranking respects quoted names, matching OR branches and negative or non-name facets while preserving ties', async () => {
  const { compileSearch, compareSearchTitles } = await modulePromise;
  const rank = (query, rows) =>
    rows
      .filter(compileSearch(query))
      .sort(compareSearchTitles(query))
      .map((row) => row.id);
  const rows = [
    { id: 'incidental', title: '另一配方', kind: '配方', materials: '铜锭', quality: '白' },
    { id: 'copper', title: '铜锭', kind: '配方', quality: '绿' },
    { id: 'facet', title: '绿', kind: '配方', quality: '绿', materials: '铜锭' },
  ];
  assert.deepEqual(rank('种类:配方 品质:绿 铜锭', rows), ['copper', 'facet']);
  assert.deepEqual(rank('种类:配方 品质:绿', rows), ['copper', 'facet']);
  assert.deepEqual(rank('种类:配方 -名称:另一配方', rows), ['copper', 'facet']);
  assert.deepEqual(rank('(铜锭 品质:红) or 种类:配方', rows), ['incidental', 'copper', 'facet']);
  assert.deepEqual(rank('(铜锭 品质:绿) or 名称:另一', rows), ['copper', 'incidental', 'facet']);
  const spaced = [
    { id: 'description', title: 'Elsewhere', kind: '物品', description: 'White Sword' },
    { id: 'name', title: 'White Sword', kind: '物品' },
  ];
  for (const query of ['white sword', '种类:物品 "WHITE SWORD"', 'kind:物品 name:"White Sword"'])
    assert.deepEqual(
      rank(query, spaced),
      ['name', 'description'].filter((id) => (query.includes('name:') ? id === 'name' : true)),
    );
});

test('filter completion lists legal local values and preserves grouping, negation and caret suffix', async () => {
  const { searchFilterFields, searchFilterSuggestions, compileSearch, insertSearchFilter } =
    await modulePromise;
  assert.equal(searchFilterFields.length, 7);
  assert.deepEqual(
    searchFilterSuggestions('品质:').map((row) => row.label),
    ['品质:白', '品质:绿', '品质:蓝', '品质:金', '品质:暗金', '品质:红'],
  );
  const query = '(种类:物品 -quality:bl or 品质:绿) 名称:丹药';
  const caret = query.indexOf('bl') + 2;
  const suggestion = searchFilterSuggestions(query, caret, { quality: ['blue', 'green'] })[0];
  assert.equal(suggestion.query, '(种类:物品 -quality:blue or 品质:绿) 名称:丹药');
  assert.equal(suggestion.query.slice(suggestion.caret), ' or 品质:绿) 名称:丹药');
  assert.doesNotThrow(() => compileSearch(suggestion.query));
  assert.equal(searchFilterSuggestions('种类:物品 品')[0].query, '种类:物品 品质:');
  assert.equal(searchFilterSuggestions('品质：暗')[0].query, '品质：暗金 ');
  assert.deepEqual(searchFilterSuggestions('"品质:"'), []);
  assert.deepEqual(searchFilterSuggestions('卫霍'), []);
  const quoted = searchFilterSuggestions('标签:朋', 4, { tags: ['朋友 旧事:再访'] })[0];
  assert(compileSearch(quoted.query)({ tags: ['朋友 旧事:再访'] }));
  assert.deepEqual(insertSearchFilter('种类:物品 品质:', 10, '品质:蓝'), {
    query: '种类:物品 品质:蓝 ',
    caret: 11,
  });
  const inserted = insertSearchFilter('永久气血', 4, '品质:绿');
  assert.equal(inserted.query, '永久气血 品质:绿 ');
  assert(compileSearch(inserted.query)({ title: '永久气血', quality: '绿' }));
  assert.equal(insertSearchFilter('x'.repeat(200), 200, '品质:绿'), null);
});
