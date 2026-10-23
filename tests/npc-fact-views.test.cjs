'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const path = require('node:path'),
  { pathToFileURL } = require('node:url');
const { encyclopedia } = require('../src/core/game-data.cjs');
const loaded = import(pathToFileURL(path.join(__dirname, '../src/renderer/npc-fact-views.js')).href);
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const act = (action, label, cls, id) =>
  `<button data-action="${esc(action)}" data-id="${esc(id)}">${label}</button>`;
test('character detail connects fixed and random private items without revealing those lists by default', async () => {
  const { createNpcFactViews } = await loaded,
    index = encyclopedia(),
    view = createNpcFactViews({ esc, act });
  const qin = view.person(
    index,
    index.entries.find((e) => e.id === 'npc-10023'),
  );
  assert.match(qin, /初始等级 35/);
  assert.match(qin, /data-id="item-100312"/);
  assert.match(qin, /初始私物 · 5 种/);
  assert.doesNotMatch(qin, /<details[^>]*\bopen\b/);
  const hammer = view.person(
    index,
    index.entries.find((e) => e.id === 'npc-10005'),
  );
  assert.match(hammer, /data-npc-private-items/);
  assert.match(hammer, /data-npc-random-items/);
  assert.match(hammer, /随机私物/);
  assert.doesNotMatch(hammer, /掉率|胜率|%|必得/);
  assert.equal(view.person(index, { id: 'npc-unknown' }), '');
});
test('item holder links use exact identities, retain all results and distinguish random candidates from fixed source counts', async () => {
  const { createNpcFactViews } = await loaded,
    index = encyclopedia(),
    view = createNpcFactViews({ esc, act });
  const formula = view.holders(
    index,
    index.entries.find((e) => e.id === 'item-100312'),
  );
  assert.match(formula, /data-id="npc-10023"/);
  assert.match(formula, /初始固定私物记录 ×1/);
  const rawOnly = view.holders(index, { gameId: -999 });
  assert.equal(rawOnly, '');
  const potion = view.holders(
    index,
    index.entries.find((e) => e.id === 'item-133'),
  );
  assert.match(potion, /其余 \d+ 位人物/);
  const expected = index.entries.filter(
    (e) =>
      e.npcFacts &&
      (e.npcFacts.fixedItems.some((row) => row.id === 133) ||
        e.npcFacts.randomItems.some((pool) => index.npcFacts.pools[pool.poolId].includes(133))),
  );
  for (const npc of expected) assert(potion.includes(`data-id="${npc.id}"`), npc.id);
});
test('repeated initial source rows show their recorded total and untrusted names remain escaped', async () => {
  const { createNpcFactViews } = await loaded,
    view = createNpcFactViews({ esc, act });
  const index = {
    entries: [{ id: 'item-9', gameId: 9, name: '<img onerror="bad">' }],
    npcFacts: { pools: { 7: [9] } },
  };
  const html = view.person(index, {
    npcFacts: {
      level: 5,
      fixedItems: [
        { id: 9, count: 2 },
        { id: 9, count: 1 },
      ],
      randomItems: [{ poolId: 7, count: 5 }],
    },
  });
  assert.match(html, /初始私物 · 1 种/);
  assert.match(html, /<small>×3<\/small>/);
  assert.match(html, /&lt;img onerror=&quot;bad&quot;&gt;/);
  assert.doesNotMatch(html, /<img |获得 5/);
  assert.match(html, /随机私物 · 1 组.*候选 1 · 1 种/s);
  assert.doesNotMatch(html, /固定私物[^<]*×5|必得/);
});

test('observed item sources use remaining private items and keep only unobserved templates as folded leads', async () => {
  const { createNpcFactViews } = await loaded;
  const view = createNpcFactViews({ esc, act });
  const index = {
    entries: [1, 2, 3].map((id) => ({
      id: 'npc-' + id,
      gameId: id,
      kind: '人物',
      name: '侠客' + id,
      npcFacts: { level: 10, fixedItems: [{ id: 9, count: 1 }], randomItems: [] },
    })),
    npcFacts: { pools: {} },
  };
  index.entries.push({ id: 'npc-4', gameId: 4, kind: '人物', name: '随机持有者' });
  const progress = {
    available: true,
    origin: 'live',
    people: [
      { npcId: 1, remainingItems: [], compare: { status: 'met', checks: [] } },
      { npcId: 2, remainingItems: [{ id: 8, count: 1 }], compare: { status: 'met', checks: [] } },
      {
        npcId: 4,
        remainingItems: [{ id: 9, count: 3 }],
        place: { id: 'place-9', name: '梧桐村' },
        compare: { status: 'unmet', checks: [{ status: 'unmet', text: '比武好感20（当前10）' }] },
      },
    ],
  };
  const before = structuredClone({ index, progress });
  const html = view.holders(index, { gameId: 9 }, progress);
  assert.match(html, /现场仍持有.*1 位/s);
  assert.match(html, /data-id="npc-4".*剩余 ×3/s);
  assert.match(html, /data-action="world-place" data-id="place-9"/);
  assert.match(html, /比武好感20（当前10）/);
  assert.doesNotMatch(html, /data-id="npc-1"|data-id="npc-2"/);
  assert.match(html, /<details[^>]*data-item-private-candidates[^>]*><summary>未核对人物的初始线索 · 1 位/);
  assert.match(html, /data-id="npc-3"/);
  assert(html.indexOf('npc-4') < html.indexOf('npc-3'));
  assert.doesNotMatch(html, /<details[^>]*\bopen\b|全部拿完|必得/);
  assert.deepEqual({ index, progress }, before);
  progress.people[2].remainingItems = [];
  const empty = view.holders(index, { gameId: 9 }, progress);
  assert.match(empty, /已读取的人物中暂未发现此私物/);
  assert.match(empty, /<summary>现场未发现持有者 · 未核对线索 1<\/summary>/);
  assert.doesNotMatch(empty, /data-id="npc-4"/);
});

test('item sources retain every observed holder and escape current place and interaction hints', async () => {
  const { createNpcFactViews } = await loaded;
  const view = createNpcFactViews({ esc, act });
  const index = { entries: [], npcFacts: { pools: {} } };
  const progress = { available: true, origin: 'saved', people: [] };
  for (let id = 1; id <= 10; id++) {
    index.entries.push({ id: 'npc-' + id, gameId: id, kind: '人物', name: '侠客' + id });
    progress.people.push({
      npcId: id,
      remainingItems: [{ id: 9, count: id }],
      place: id === 1 ? { id: 'place-1', name: '<img src=x>' } : null,
      compare: { status: 'unknown', checks: [{ status: 'unknown', text: '<script>未知</script>' }] },
    });
  }
  const html = view.holders(index, { gameId: 9 }, progress);
  assert.match(html, /保存时仍持有.*10 位/s);
  for (const person of progress.people) assert(html.includes(`data-id="npc-${person.npcId}"`));
  assert.match(html, /其余 2 位人物/);
  assert.match(html, /&lt;img src=x&gt;|&lt;script&gt;未知&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<img|<script>|未核对人物的初始线索/);
});

test('item codex selects one explicit saved or live NPC cohort without leaking into historical references', async () => {
  const { createGameViews } = await import('../src/renderer/game-views.js');
  const index = encyclopedia();
  const view = createGameViews({
    esc,
    act,
    pill: esc,
    icon: () => '',
    iconButton: () => '',
    picture: () => '',
    notice: esc,
    qualityText: { label: () => '', name: (_e, name) => esc(name) },
  });
  const progress = (origin, id, count) => ({
    available: true,
    origin,
    people: [{ npcId: id, remainingItems: [{ id: 100312, count }], compare: { status: 'met', checks: [] } }],
  });
  const saved = { name: '1.sav', metadata: { npcProgress: progress('saved', 10023, 2) } };
  const live = progress('live', 10016, 7);
  const render = (reference, observed = null, liveReference = null) =>
    view.detail(index, 'item-100312', 1, reference, [], '', false, {}, 0, {}, '', observed, liveReference);
  const section = (html) =>
    html.match(/<section[^>]*data-item-private-holders[\s\S]*?<\/section>/)?.[0] || '';
  const historical = section(render(saved, live));
  assert.match(historical, /保存时仍持有.*data-id="npc-10023".*剩余 ×2/s);
  assert.doesNotMatch(historical, /现场仍持有|剩余 ×7/);
  const current = section(render(saved, live, { origin: 'live', metadata: {} }));
  assert.match(current, /现场仍持有.*data-id="npc-10016".*剩余 ×7/s);
  assert.doesNotMatch(current, /保存时仍持有|剩余 ×2/);
  const withdrawn = render(saved, null, { origin: 'live', metadata: {} });
  assert.doesNotMatch(withdrawn, /保存时仍持有|现场仍持有|剩余 ×2/);
  assert.match(withdrawn, /初始线索/);
  assert.doesNotMatch(
    render({ ...saved, metadata: { npcProgress: live } }),
    /现场仍持有|剩余 ×7/,
    'a saved reference cannot carry an unrelated live cohort',
  );
  assert.match(section(render(saved)), /保存时仍持有.*剩余 ×2/s);
});
