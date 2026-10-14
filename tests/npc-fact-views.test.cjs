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
