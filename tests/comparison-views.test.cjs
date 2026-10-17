'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const { compareRecords } = require(path.join(root, 'src/core/save-comparison.cjs')),
  index = require(path.join(root, 'src/data/game-index.json'));
const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const modulePromise = import(pathToFileURL(path.join(root, 'src/renderer/comparison-views.js')).href);
async function views() {
  const { createComparisonViews } = await modulePromise;
  return createComparisonViews({
    esc,
    act: (a, label, cls, id) => `<button data-action="${a}" data-id="${esc(id)}">${label}</button>`,
    iconButton: () => '',
    pill: esc,
    notice: esc,
    when: esc,
    hours: esc,
    icon: () => '',
    picture: () => '',
    getIndex: () => index,
  });
}
const metadata = (extra) => ({
  map: 'LV_World',
  mapName: '世界地图',
  money: 100,
  playSeconds: 100,
  team: [],
  fightTeam: [],
  quests: [],
  inventory: [],
  fusionRecipes: [],
  alchemyRecipes: [],
  cookingRecipes: [],
  ...extra,
});
const record = (name, m) => ({ name, modifiedAt: '2026-10-17T00:00:00Z', metadata: m });
const compare = (a = {}, b = {}) =>
  compareRecords(record('1.sav', metadata(a)), record('2.sav', metadata(b)));
const view = { query: '', questQuery: '', filter: 'all' };
const firstGroup = (html) => html.match(/<details class="save-quests compare-([a-z]+)"( open)?>/)?.slice(1);
test('recipe-only differences are counted and opened before unchanged inventory, with exact recipe links', async () => {
  const v = await views(),
    learned = {},
    ids = [];
  for (const [prefix, field] of [
    ['fusion', 'fusionRecipes'],
    ['alchemy', 'alchemyRecipes'],
    ['cooking', 'cookingRecipes'],
  ]) {
    const e = index.entries.find((e) => e.id.startsWith(prefix + '-'));
    ids.push(e.id);
    learned[field] = [Number(e.id.slice(prefix.length + 1))];
  }
  const diff = compare({}, learned),
    before = structuredClone(diff),
    html = v.result(diff, view);
  assert.deepEqual(firstGroup(html), ['recipes', ' open']);
  assert.match(html, /已学配方差异 · 3 项/);
  const overview = html.slice(0, html.indexOf('<details class="save-quests'));
  for (const label of ['锻造/制衣配方', '炼丹配方', '烹饪配方']) assert(overview.includes(label));
  assert.doesNotMatch(overview, /铜钱|累计时长|背包|任务|0 种|0 条/);
  for (const id of ids) assert(html.includes('data-id="' + id + '"'));
  assert.deepEqual(diff, before);
});
test('all nine covered categories independently expose a sole change, including both teams and all recipe families', async () => {
  const v = await views();
  const cases = [
    ['铜钱', { money: 101 }, null],
    ['累计时长', { playSeconds: 101 }, null],
    ['背包', { inventory: [{ id: 100, name: '药', type: '药品', count: 1 }] }, 'inventory'],
    ['任务', { quests: [{ id: 11005, name: '任务', step: 1 }] }, 'quests'],
    ['同行队伍', { team: [{ id: 10016, name: '江吟风' }] }, 'team'],
    ['出战队伍', { fightTeam: [{ id: 10016, name: '江吟风' }] }, 'team'],
    ['锻造/制衣配方', { fusionRecipes: [999999] }, 'recipes'],
    ['炼丹配方', { alchemyRecipes: [999999] }, 'recipes'],
    ['烹饪配方', { cookingRecipes: [999999] }, 'recipes'],
  ];
  for (const [label, extra, group] of cases) {
    const html = v.result(compare({}, extra), view),
      head = html.slice(0, html.indexOf('<details'));
    assert(head.includes(label), label);
    assert.doesNotMatch(head, /无变化|未读取/);
    if (group) assert.deepEqual(firstGroup(html), [group, ' open'], label);
  }
});
test('unknown fields stay visible, never become zero or an overall unchanged claim', async () => {
  const v = await views();
  for (const field of [
    'money',
    'playSeconds',
    'inventory',
    'quests',
    'team',
    'fightTeam',
    'fusionRecipes',
    'alchemyRecipes',
    'cookingRecipes',
  ]) {
    const html = v.result(compare({}, { [field]: null }), view);
    assert.match(html, /未读取的记录 · 1 项/);
    assert.doesNotMatch(html, /compare-unchanged-message/);
    if (field === 'team') assert.match(html, /队伍成员差异 · 同行未读取/);
    if (field === 'alchemyRecipes') assert.match(html, /已学配方差异 · 炼丹未读取/);
  }
  assert.match(v.result(compare(), view), /已比较的铜钱、时长、队伍、任务、物品与配方无变化/);
});
test('result reading surface starts with escaped exact endpoints and preserves direction after swapping', async () => {
  const v = await views(),
    left = record('<左>.sav', metadata()),
    right = record('右&2.sav', metadata({ money: 105 }));
  const forward = v.result(compareRecords(left, right), view),
    reverse = v.result(compareRecords(right, left), view);
  assert(forward.startsWith('<p class="compare-direction">&lt;左&gt;.sav → 右&amp;2.sav</p>'));
  assert.match(forward, />\+5 文</);
  assert(reverse.startsWith('<p class="compare-direction">右&amp;2.sav → &lt;左&gt;.sav</p>'));
  assert.match(reverse, />-5 文</);
});
test('known changes coexist with unknown groups and unknown recipe identities are escaped without fake links', async () => {
  const v = await views(),
    diff = compare({}, { inventory: null, team: [{ id: 10016, name: '江吟风' }], alchemyRecipes: [999999] });
  diff.recipes[1].rightOnly[0].name = '<未知配方>';
  const html = v.result(diff, view);
  assert.match(html, /未读取的记录 · 1 项/);
  assert.match(html, /同行队伍/);
  assert.match(html, /炼丹配方/);
  assert.match(html, /&lt;未知配方&gt;/);
  assert.doesNotMatch(html, /data-id="alchemy-999999"/);
  assert.match(html, /队伍成员差异 · 1 位/);
});
test('missing selected slots stay explicitly named and disabled instead of falling back to other files', async () => {
  const v = await views(),
    files = [record('3.sav', metadata())],
    html = v.shell(files, { ...view, left: '1.sav', right: '2.sav', result: null });
  assert.match(html, /<option value="1.sav" selected disabled>1.sav · 暂不可读/);
  assert.match(html, /<option value="2.sav" selected disabled>2.sav · 暂不可读/);
  assert.match(html, /所选进度暂不可读/);
});
const renderer = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
function section(a, b) {
  const start = renderer.indexOf(a),
    end = renderer.indexOf(b, start);
  assert(start >= 0 && end > start);
  return renderer.slice(start, end);
}
function context() {
  const c = vm.createContext({
    environment: { saves: { files: [record('1.sav', metadata()), record('2.sav', metadata())] } },
    comparisonState: null,
    currentDrawer: null,
    detailRequest: 0,
    gameIndex: index,
    comparisonViews: { shell: (_files, v) => v, populate: () => {} },
    rememberDrawer: (v) => {
      c.currentDrawer = v;
    },
    showOverlay: (v) => {
      c.rendered = v;
    },
  });
  vm.runInContext(section('function showComparison(', '\nasync function readComparison('), c);
  return c;
}
test('reopening or refreshing a comparison preserves the exact pair, search and filter, invalidating results if a slot disappears', () => {
  const c = context(),
    prior = {
      left: '1.sav',
      right: '2.sav',
      query: '剑',
      questQuery: '支线',
      filter: 'less',
      result: { left: { name: '1.sav' }, right: { name: '2.sav' } },
    };
  c.showComparison('', prior);
  assert.equal(c.comparisonState.left, '1.sav');
  assert.equal(c.comparisonState.result, prior.result);
  c.environment.saves.files = [record('3.sav', metadata())];
  c.showComparison('', prior);
  assert.equal(c.comparisonState.left, '1.sav');
  assert.equal(c.comparisonState.right, '2.sav');
  assert.equal(c.comparisonState.query, '剑');
  assert.equal(c.comparisonState.filter, 'less');
  assert.equal(c.comparisonState.result, null);
  assert.notEqual(prior.result, null);
  c.environment.saves.files = [];
  c.showComparison('', prior);
  assert.equal(c.comparisonState.right, '2.sav');
  assert.throws(() => c.showComparison(), /至少一份/);
});
test('a delayed slot refresh cannot reopen a comparison after navigation, and a current refresh clears stale results', async () => {
  const c = context(),
    prior = { ...view, left: '1.sav', right: '2.sav', result: {} };
  c.showComparison('', prior);
  let release;
  c.refresh = () => new Promise((r) => (release = r));
  const code =
    '(async()=>{switch("compare-refresh"){' +
    section("    case 'compare-refresh':", "    case 'compare-filter':") +
    '}})()';
  const pending = vm.runInContext(code, c);
  c.currentDrawer = { type: 'database' };
  c.detailRequest++;
  release();
  await pending;
  assert.equal(c.currentDrawer.type, 'database');
  c.showComparison('', prior);
  const current = vm.runInContext(code, c);
  release();
  await current;
  assert.equal(c.currentDrawer.type, 'comparison');
  assert.equal(c.comparisonState.left, '1.sav');
  assert.equal(c.comparisonState.result, null);
});
