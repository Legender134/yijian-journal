'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createFlowProjector, flowSnapshot } = require('../src/core/flow.cjs');
const { encyclopedia } = require('../src/core/game-data.cjs');
const guide = require('../src/data/flow-guide.cjs');
const world = require('../src/data/world-index.json');
const game = require('../src/data/game-index.json');
const codex = require('../src/data/codex-details.json');

const profile = { id: 'synthetic-sword-festival', referenceMode: 'latest' };
const saved = (quests = [], extra = {}) => ({
  name: 'Synthetic.sav',
  hash: 'synthetic-sword-festival',
  metadata: { quests, inventory: [], ...extra },
});
const active = (root, step, extra = {}) =>
  saved([{ id: root, step: 1 }, { id: step, step: 1 }], extra);
const windows = [
  { id: 'sword-festival-dusk-chest', steps: [5390, 5394], before: 5388 },
  { id: 'sword-festival-night-before-fair', steps: [5399], before: 5394 },
  { id: 'sword-festival-lantern-fair-chest', steps: [5401, 5408], before: 5399 },
  { id: 'sword-festival-night-before-rest', steps: [5412], before: 5408 },
];
const caveId = 'wanjie-yaoji-hidden-cave';
const ids = [...windows.map((row) => row.id), caveId];
const rules = guide.rules.filter((row) => ids.includes(row.id));
const content = { sources: guide.sources, rules };
const project = (nativeChoices) =>
  createFlowProjector({ world, game, guide: content, nativeChoices }).flowSnapshot;
const decisions = (flow) => flow.decisions.filter((row) => ids.includes(row.id));
const rowIn = (flow, id) => flow.decisions.find((row) => row.id === id);
function absent(flow, id, context = '') {
  for (const channel of ['decisions', 'warnings', 'advice', 'changes', 'opportunities'])
    assert(!flow[channel].some((row) => row.id === id), `${channel}: ${id} ${context}`);
  assert(flow.guide.some((row) => row.id === id), 'the reference remains searchable');
}

const esc = (value) => String(value ?? '').replace(
  /[&<>"']/g,
  (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
);
const unescape = (value) => value.replace(
  /&(amp|lt|gt|quot|#39);/g,
  (_, key) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[key],
);
function visibleText(html) {
  const details = [];
  let result = '';
  for (const [token] of html.matchAll(/<[^>]*>|[^<]+/g)) {
    if (/^<details\b/.test(token)) details.push({ open: /\sopen(?:\s|>|=)/.test(token), summary: false });
    else if (/^<\/details/.test(token)) details.pop();
    else if (/^<summary\b/.test(token) && details.length) details.at(-1).summary = true;
    else if (/^<\/summary/.test(token) && details.length) details.at(-1).summary = false;
    else if (!token.startsWith('<') && details.every((row) => row.open || row.summary)) result += token;
  }
  return unescape(result);
}
const moduleUrls = new Map();
function rendererUrl(name) {
  if (moduleUrls.has(name)) return moduleUrls.get(name);
  let source = fs.readFileSync(path.join(__dirname, '../src/renderer', name), 'utf8');
  source = source.replace(
    /from '(\.\.?\/[^']+)'/g,
    (_, dependency) => 'from ' + JSON.stringify(rendererUrl(path.posix.join(path.posix.dirname(name), dependency))),
  );
  const url = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  moduleUrls.set(name, url);
  return url;
}
const views = Promise.all([
  import(rendererUrl('flow-views.js')),
  import(rendererUrl('entity-references.js')),
]).then(([{ createFlowViews }, { createEntityReferences }]) => {
  const index = encyclopedia();
  const references = createEntityReferences({
    index: () => index,
    esc,
    picture: () => '',
    icon: () => '',
    qualityText: { html: (_, label) => label },
  });
  return createFlowViews({
    esc,
    act: references.button,
    richText: (value, targets) => references.text(value, 'flow-quest', targets),
    icon: () => '',
    pill: esc,
    when: esc,
  });
});

test('festival rules bind exact public windows, current Build sources and one shared night chest', () => {
  assert.equal(rules.length, 5);
  for (const window of windows) {
    const rule = rules.find((row) => row.id === window.id);
    assert.equal(rule.questId, 5368);
    assert.deepEqual(rule.decisionSteps, window.steps);
    assert.equal(rule.requireActiveRoot, true);
    assert.equal(rule.requireDecisionWindow, true);
    assert.deepEqual(rule.chapterRoots, []);
    for (const step of rule.decisionSteps)
      assert.equal(world.quests.find((row) => row.gameId === step).parentId, 5368);
    assert(rule.sourceIds.some((id) => guide.sources[id].version === `Build ${world.build}`));
    if (window.id !== 'sword-festival-lantern-fair-chest') assert.deepEqual(rule.choices, []);
  }
  const beforeFair = rules.find((row) => row.id === 'sword-festival-night-before-fair');
  const beforeRest = rules.find((row) => row.id === 'sword-festival-night-before-rest');
  assert.strictEqual(beforeFair.collectionStops, beforeRest.collectionStops);
  assert.equal(world.maps.find((row) => row.id === 'place-1006').key, 'LV_MJSZ_P1');
  assert.equal(world.maps.find((row) => row.id === 'place-1007').key, 'LV_MJSZ_P2');
  assert.equal(world.maps.find((row) => row.id === 'place-30').key, 'LV_32_P3');
  assert.equal(guide.sources.swordFestivalStarRoute.author, '星1辰2之3羽');
  assert.equal(guide.sources.swordFestivalTeaRoute.author, '虚饮茶');
  assert.match(guide.sources.swordFestivalTeaRoute.version, /碧海仙踪/);
});

for (const window of windows) {
  test(`${window.id} requires an active root and its exact active step, then retires`, () => {
    const rule = rules.find((row) => row.id === window.id);
    for (const current of window.steps) {
      assert(rowIn(flowSnapshot(profile, active(5368, current)), window.id));
      const scenarios = [
        [],
        [{ id: 5368, step: 1 }],
        [{ id: current, step: 1 }],
        [{ id: 5368, step: 1 }, { id: window.before, step: 1 }],
        [{ id: 5368, step: 1 }, { id: 999999, step: 1 }],
        ...[0, 2, 3, 4, 99].map((step) => [{ id: 5368, step: 1 }, { id: current, step }]),
        ...[0, 2, 3, 4, 99].map((step) => [{ id: 5368, step }, { id: current, step: 1 }]),
        ...(rule.untilAnyStarted || []).flatMap((id) => [1, 2, 4].map((step) => [
          { id: 5368, step: 1 }, { id: current, step: 1 }, { id, step },
        ])),
      ];
      for (const quests of scenarios)
        absent(flowSnapshot(profile, saved(quests, { mapName: '名剑山庄' })), window.id, JSON.stringify(quests));
      for (const id of [5419, 5426, 5439, 5441, 5443, 5444, 5446, 5501])
        absent(flowSnapshot(profile, saved([
          { id: 5368, step: 1 }, { id: current, step: 1 }, { id, step: 1 },
        ])), window.id, `later main progress ${id}`);
      for (const selected of [
        { ...profile, referenceMode: 'none' },
        { ...profile, referenceMode: 'slot', saveSlot: 'Missing.sav' },
      ]) absent(flowSnapshot(selected, active(5368, current)), window.id);
    }
    absent(flowSnapshot(profile, { name: 'Unreadable.sav', metadata: {} }), window.id);
  });
}

test('dusk, night departure, fair and night rest stay mutually exclusive across stale earlier records', () => {
  const history = [];
  for (const [step, expected] of [
    [5390, windows[0].id], [5394, windows[0].id], [5399, windows[1].id],
    [5401, windows[2].id], [5408, windows[2].id], [5412, windows[3].id], [5419, null],
  ]) {
    history.push({ id: step, step: 1 });
    const flow = flowSnapshot(profile, saved([{ id: 5368, step: 1 }, ...history]));
    assert.deepEqual(decisions(flow).map((row) => row.id), expected ? [expected] : []);
  }
  absent(flowSnapshot(profile, saved([
    { id: 5368, step: 1 }, { id: 5390, step: 1 }, { id: 5394, step: 4 },
  ])), windows[0].id, 'completed last dusk exploration cannot be reopened by the earlier step');
});

test('the real fair exit retains collection during its active dialog and retires on leaving', () => {
  const id = windows[2].id;
  const rule = rules.find((row) => row.id === id);
  assert.deepEqual(rule.trackedDecisionSteps, [5409]);
  assert.deepEqual(rule.coveredChoiceSteps, [5409]);
  assert.deepEqual(rule.choices.map((row) => row.label), ['离开', '再逛逛']);
  assert.deepEqual(rule.choices.map((row) => row.label), codex.hiddenSteps[5409].choices.map((row) => row.text));
  assert.deepEqual(codex.hiddenSteps[5409].choices.map((row) => row.actions), [
    [{ type: 'JumpStep', id: 5409, value: 4 }], [],
  ]);
  assert.deepEqual(codex.hiddenSteps[5409].finish[0], [{ type: 'JumpStep', id: 5410, value: 4 }]);
  const reference = active(5368, 5409, { trackingQuest: 5409 });
  const original = JSON.stringify(reference);
  assert(rowIn(flowSnapshot(profile, reference), id));
  assert.equal(JSON.stringify(reference), original);
  assert(rowIn(flowSnapshot(profile, saved([
    ...reference.metadata.quests, { id: 5408, step: 4 },
  ], { trackingQuest: 5409 })), id), 'the exact active exit dialog remains actionable after its public context');
  for (const step of [2, 4]) absent(flowSnapshot(profile, saved([
    { id: 5368, step: 1 }, { id: 5408, step: 1 }, { id: 5409, step },
  ], { trackingQuest: 5409 })), id);
  for (const trackingQuest of [undefined, 5408, 999999, '5409'])
    absent(flowSnapshot(profile, active(5368, 5409, { trackingQuest })), id);
  absent(project(undefined)(profile, reference), id);
  for (const hidden of [
    { ...codex.hiddenSteps[5409], ownerPath: [] },
    { ...codex.hiddenSteps[5409], ownerId: 5700 },
    { ...codex.hiddenSteps[5409], relatedQuestId: 999999 },
  ]) absent(project({ hiddenSteps: { 5409: hidden } })(profile, reference), id);
});

test('wanjie return requires the completed cooperation path and a still active return step', () => {
  const rule = rules.find((row) => row.id === caveId);
  assert.equal(rule.questId, 5700);
  assert.deepEqual(rule.decisionSteps, [5720]);
  assert.deepEqual(rule.decisionRequiresAllComplete, [5719]);
  assert.deepEqual(rule.untilAnyRecorded, [5722]);
  assert.deepEqual(rule.choices, []);
  assert.equal(world.maps.find((row) => row.id === 'place-69').key, 'LV_31_P2');
  const reference = saved([{ id: 5700, step: 1 }, { id: 5719, step: 4 }, { id: 5720, step: 1 }]);
  assert(rowIn(flowSnapshot(profile, reference), caveId));
  for (const step of [undefined, 0, 1, 2, 3, 99]) {
    const quests = reference.metadata.quests.filter((row) => row.id !== 5719);
    if (step !== undefined) quests.push({ id: 5719, step });
    absent(flowSnapshot(profile, saved(quests)), caveId, `5719=${step}`);
  }
  for (const field of [5700, 5720])
    for (const step of [undefined, 0, 2, 3, 4, 99]) {
      const quests = reference.metadata.quests.filter((row) => row.id !== field);
      if (step !== undefined) quests.push({ id: field, step });
      absent(flowSnapshot(profile, saved(quests)), caveId, `${field}=${step}`);
    }
  for (const step of [0, 1, 2, 3, 4, 99])
    absent(flowSnapshot(profile, saved([...reference.metadata.quests, { id: 5722, step }])), caveId);
  for (const step of [1, 2, 4])
    absent(flowSnapshot(profile, saved([...reference.metadata.quests, { id: 5721, step }])), caveId);
  for (const step of [1, 2, 4])
    assert(rowIn(flowSnapshot(profile, saved([...reference.metadata.quests, { id: 5742, step }])), caveId),
      'having entered the hidden cave does not prove its chest was opened');
  absent(project(undefined)(profile, reference), caveId);
  for (const hidden of [
    { ...codex.hiddenSteps[5719], ownerPath: [] },
    { ...codex.hiddenSteps[5719], ownerId: 5368 },
    { ...codex.hiddenSteps[5719], relatedQuestId: 999999 },
  ]) absent(project({ hiddenSteps: { 5719: hidden } })(profile, reference), caveId);
});

test('finite box facts and entity links stay inside expandable collection lists', async () => {
  // Finite actor DefIds and Gathers rewards were independently checked against Build 21798996.
  // Tests depend only on public repository data, never installed-game files or personal saves.
  const rewards = {
    1631: [[133, 2], [100332, 1], [13808, 1]],
    1612: [[156, 1], [161, 1], [13106, 1]],
    1663: [[109, 1], [100310, 1]],
    1591: [[100318, 1], [100306, 1], [142, 1]],
  };
  const references = [
    ...windows.map((row) => [row.id, active(5368, row.steps[0])]),
    [caveId, saved([{ id: 5700, step: 1 }, { id: 5719, step: 4 }, { id: 5720, step: 1 }])],
  ];
  const firstActions = {
    'sword-festival-dusk-chest': /客房假山后.*名剑心法秘籍/,
    'sword-festival-night-before-fair': /乘船前.*客房假山后.*名剑剑法秘籍/,
    'sword-festival-lantern-fair-chest': /花灯小贩身后.*心火丹.*上品纯阳丹丹方.*桥头.*再逛逛/,
    'sword-festival-night-before-rest': /休息前.*客房假山后.*名剑剑法秘籍/,
    [caveId]: /万劫窟密洞.*瑶姬互动.*两张丹方.*四转洗髓丹/,
  };
  const frontTargets = {
    'sword-festival-dusk-chest': ['place-1006', 'item-13808'],
    'sword-festival-night-before-fair': ['place-1007', 'item-13106'],
    'sword-festival-lantern-fair-chest': ['place-30', 'item-109', 'item-100310'],
    'sword-festival-night-before-rest': ['place-1007', 'item-13106'],
    [caveId]: ['place-69', 'item-100318', 'item-100306', 'item-142'],
  };
  const view = await views;
  for (const [id, reference] of references) {
    const row = rowIn(flowSnapshot(profile, reference), id);
    assert(row, id);
    const html = view.choice(row, { compact: true });
    const front = visibleText(html);
    assert.match(front, /宝箱/);
    assert.match(front, firstActions[id]);
    for (const targetId of frontTargets[id])
      assert([...row.recommendation.targets.places, ...row.recommendation.targets.items].some((target) => target.id === targetId));
    assert.doesNotMatch(front, /×|金疮药|蜂王浆|四品宁神丹|Build|原表|LV_|DefId|推荐做法：|为什么：/);
    assert.equal((html.match(/data-flow-collection-stops/g) || []).length, 1);
    const expanded = visibleText(html.replace('<details class="flow-choice-details"', '<details open class="flow-choice-details"'));
    assert.match(expanded, /路线与资料/);
    assert.doesNotMatch(expanded, /推荐做法：|为什么：|适合：|Build|LV_/);
    for (const stop of row.collectionStops) {
      assert(html.includes(`data-gather-id="${stop.gatherId}"`));
      const expected = rewards[stop.gatherId].map(([itemId, quantity]) => {
        const item = game.entries.find((entry) => entry.id === `item-${itemId}`);
        assert.equal(item.kind, '物品');
        assert(stop.effect.includes(`${item.name}${/秘籍$/.test(item.type) ? '秘籍' : ''}×${quantity}`));
        assert(html.includes(`data-entity-id="${item.id}"`));
        assert(expanded.includes(item.name));
        return { id: item.id, name: item.name };
      });
      assert.deepEqual(stop.targets.items, expected);
    }
    assert.match(row.uncertainty + row.recommendation.tradeoff, /未读|没有.*开箱|不能.*判断|不能认定|无法.*判断|不证明.*已开/);
    assert.doesNotMatch(html, /本次已收齐|宝箱已全部|永久绝版|唯一获得途径/);
  }
  const night = rules.find((row) => row.id === 'sword-festival-night-before-fair');
  assert.match(night.recommendation.reason, /名剑剑法.*欧阳雪携带来源/);
  const cave = rules.find((row) => row.id === caveId);
  assert.match(cave.recommendation.action, /还没回折.*已经回折进入/);
  assert.match(cave.recommendation.reason, /5742记录/);
  assert.match(cave.uncertainty, /5742已有记录不证明箱1591已开/);
});
