'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { encyclopedia } = require('../src/core/game-data.cjs');
const helpers = {
  esc: (v) =>
    String(v ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('"', '&quot;'),
  act: (action, label, cls, id) => `<button data-action="${action}" data-id="${id}">${label}</button>`,
};
test('abandoning the massacre investigation exposes the exact removed quest without predicting permanent loss', async () => {
  const index = encyclopedia();
  const { createCodexDetailViews } = await import('../src/renderer/codex-detail-views.js');
  const entry = index.world.quests.find((q) => q.gameId === 11272);
  const before = JSON.stringify(index.codex.quests[11276]);
  const html = createCodexDetailViews(helpers).quest(index, entry);
  assert.match(html, /就此作罢/);
  assert.match(html, /data-id="quest-11272"[^>]*>[^<]*灭门之案[^<]*<\/button>：从任务列表移除/);
  assert.doesNotMatch(html, /永久不能重接|永久锁死|必定.*结局/);
  assert.equal(JSON.stringify(index.codex.quests[11276]), before);
});
test('quest removal remains visible for the same quest and does not invent missing entity identities', async () => {
  const { createCodexDetailViews } = await import('../src/renderer/codex-detail-views.js');
  const entry = { id: 'quest-1', gameId: 1, kind: '任务', name: '当前调查', parentId: 0 };
  const data = (id) => ({
    entries: [entry],
    world: { quests: [entry] },
    codex: {
      quests: {
        1: {
          finish: [[], [], []],
          choices: [{ label: '放弃', requirements: [], actions: [{ type: 'RQuest', id, value: 0 }] }],
        },
      },
      hiddenSteps: {},
    },
  });
  const view = createCodexDetailViews(helpers);
  assert.match(view.quest(data(1), entry), /当前调查<\/button>：从任务列表移除/);
  assert.doesNotMatch(view.quest(data(999999), entry), /quest-999999|任务 #999999|从任务列表移除/);
});

test('item and quest codex share the exact collection rows with flow and count the same night chest once', async () => {
  const { flowSnapshot } = require('../src/core/flow.cjs');
  const { createCodexDetailViews } = await import('../src/renderer/codex-detail-views.js');
  const index = encyclopedia();
  const guide = flowSnapshot({ id: 'synthetic', referenceMode: 'latest' }, null).guide;
  const view = createCodexDetailViews({ ...helpers, guide: () => guide });
  const before = JSON.stringify(guide.map((row) => row.collectionStops));
  for (const [itemId, gatherId] of [
    [13808, 1631],
    [13106, 1612],
    [100310, 1663],
    [100244, 1283],
    [142, 1591],
  ]) {
    const entry = index.entries.find((row) => row.id === 'item-' + itemId);
    const html = view.item(index, entry);
    assert(html.includes(`data-gather-id="${gatherId}"`));
    assert.equal((html.match(new RegExp(`data-gather-id="${gatherId}"`, 'g')) || []).length, 1);
    const rule = guide.find((row) => row.collectionStops?.some((stop) => stop.gatherId === gatherId));
    const stop = rule.collectionStops.find((stop) => stop.gatherId === gatherId);
    assert(html.includes(stop.effect));
    assert(html.includes(stop.label));
    assert(html.includes('quest-' + rule.questId));
    assert.doesNotMatch(html, /本次已收齐|宝箱已全部|当前可取得/);
  }
  const night = view.item(
    index,
    index.entries.find((row) => row.id === 'item-13106'),
  );
  assert.match(night, /其他核对时点/);
  const root = index.world.quests.find((row) => row.gameId === 5368);
  const questHtml = view.quest(index, root);
  for (const id of [1631, 1612, 1663])
    assert.equal((questHtml.match(new RegExp(`data-gather-id="${id}"`, 'g')) || []).length, 1);
  assert.equal(JSON.stringify(guide.map((row) => row.collectionStops)), before);
  assert(
    !createCodexDetailViews(helpers)
      .item(
        index,
        index.entries.find((row) => row.id === 'item-13106'),
      )
      .includes('data-gather-id="1612"'),
    'an absent guide never loads a global fallback',
  );
});

test('story item codex exposes exact linked flow hints without fabricating a chest or matching by name', async () => {
  const { flowSnapshot } = require('../src/core/flow.cjs');
  const { createCodexDetailViews } = await import('../src/renderer/codex-detail-views.js');
  const index = encyclopedia();
  const guide = flowSnapshot({ id: 'synthetic', referenceMode: 'latest' }, null).guide;
  const entry = index.entries.find((row) => row.id === 'item-10464');
  const before = JSON.stringify(guide);
  const view = createCodexDetailViews({ ...helpers, guide: () => guide });
  const html = view.item(index, entry);
  assert.match(html, /codex-item-flow/);
  assert.match(html, /quest-18000/);
  assert.match(html, /石堆/);
  assert.match(html, /娜乌/);
  assert.doesNotMatch(html, /data-gather-id/);
  assert.equal((html.match(/相关流程 · 1/g) || []).length, 1);
  assert.equal(JSON.stringify(guide), before);
  assert.doesNotMatch(view.item(index, { ...entry, id: 'item-999999', gameId: 999999 }), /codex-item-flow/);
  assert.doesNotMatch(createCodexDetailViews(helpers).item(index, entry), /codex-item-flow/);
  const manual = index.entries.find((row) => row.id === 'item-13106');
  assert.doesNotMatch(
    view.item(index, manual),
    /codex-item-flow/,
    'a chest source is not repeated as the same flow hint',
  );
});
