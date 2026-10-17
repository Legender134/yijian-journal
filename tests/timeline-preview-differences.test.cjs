'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path');
const root = path.resolve(__dirname, '..');
const { pathToFileURL } = require('node:url');
const { compareRecords } = require(path.join(root, 'src/core/save-comparison.cjs'));
const index = require(path.join(root, 'src/data/game-index.json'));
const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const modulePromise = import(pathToFileURL(path.join(root, 'src/renderer/timeline-views.js')).href);
function metadata(extra = {}) {
  return {
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
  };
}
const record = (name, m) => ({ name, modifiedAt: '2026-10-17T00:00:00Z', metadata: m });
test('rollback preview reports recipe-only losses and links exact known recipes, without claiming identical saves', async () => {
  const { createTimelineViews } = await modulePromise;
  const views = createTimelineViews({
    esc,
    icon: () => '',
    act: (a, label, cls, id) => `<button data-action="${a}" data-id="${esc(id)}">${label}</button>`,
    pill: esc,
    notice: esc,
    hours: esc,
    bytes: esc,
    iconButton: () => '',
    getIndex: () => index,
  });
  const learned = {},
    ids = [];
  for (const [prefix, field] of [
    ['fusion', 'fusionRecipes'],
    ['alchemy', 'alchemyRecipes'],
    ['cooking', 'cookingRecipes'],
  ]) {
    const e = index.entries.find((e) => e.id.startsWith(prefix + '-'));
    assert(e);
    ids.push(e.id);
    learned[field] = [Number(e.id.slice(prefix.length + 1))];
  }
  const diff = compareRecords(record('new.sav', metadata(learned)), record('old.sav', metadata()));
  const input = {
    record: { id: 'old', at: Date.now(), mapName: '世界地图' },
    metadata: metadata(),
    basis: { id: 'new', at: Date.now() },
    comparison: diff,
    readiness: { ready: false, reason: '合成只读检查' },
  };
  const before = structuredClone(input),
    html = views.preview(input);
  assert.doesNotMatch(html, /与最近保存相同|已比较的.*无变化/);
  for (const id of ids) assert.match(html, new RegExp('data-action="database-detail" data-id="' + id + '"'));
  assert.equal((html.match(/读回后未学会/g) || []).length, 3);
  assert.deepEqual(input, before);
  const equal = structuredClone(input);
  equal.comparison = compareRecords(
    record('same-left.sav', metadata()),
    record('same-right.sav', metadata()),
  );
  assert.match(views.preview(equal), /已比较的铜钱、时长、队伍、任务、物品与配方无变化/);
  for (const mutate of [
    (c) => {
      c.recipes[1].available = false;
    },
    (c) => {
      c.fightTeam.available = false;
    },
    (c) => {
      c.playSecondsDelta = null;
    },
  ]) {
    const unknown = structuredClone(equal);
    mutate(unknown.comparison);
    const out = views.preview(unknown);
    assert.doesNotMatch(out, /无变化|相同/);
    assert.match(out, /无法比较/);
  }
  const fight = structuredClone(equal);
  fight.comparison.fightTeam.rightOnly = [{ id: 9001, name: '万花红' }];
  assert.match(views.preview(fight), /<h4>出战队伍<\/h4>/);
  assert.doesNotMatch(views.preview(fight), /无变化/);
  const elapsed = structuredClone(equal);
  elapsed.comparison.playSecondsDelta = -3601;
  assert.match(views.preview(elapsed), /−1 小时 0 分钟 1 秒/);
  assert.doesNotMatch(views.preview(elapsed), /无变化/);
  const unknownRecipe = structuredClone(equal);
  unknownRecipe.comparison.recipes[0].leftOnly = [{ id: 'fusion-999999', name: '<同名配方>', known: false }];
  const unknownHTML = views.preview(unknownRecipe);
  assert.match(unknownHTML, /&lt;同名配方&gt;/);
  assert.doesNotMatch(unknownHTML, /data-id="fusion-999999"|无变化/);
  const favorite = structuredClone(input);
  favorite.record.kind = 'manual';
  const favoriteHTML = views.preview(favorite);
  assert.match(favoriteHTML, /timeline-bookmark-action[^]*取消收藏[^]*取消后参与自动轮换，可能被清理。/);
  const automatic = structuredClone(favorite);
  automatic.record.bookmarked = false;
  automatic.record.kind = 'auto';
  assert.doesNotMatch(views.preview(automatic), /取消后参与自动轮换/);
});
