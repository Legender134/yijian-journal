'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { encyclopedia } = require('../src/core/game-data.cjs');
const { flowSnapshot } = require('../src/core/flow.cjs');

const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );

test('task details lead with their own walkthrough and scope indirect promotion risks to the queried task', async () => {
  const [{ createEntityDetailViews }, { createEntityReferences }] = await Promise.all([
    import('../src/renderer/entity-detail-views.js'),
    import('../src/renderer/entity-references.js'),
  ]);
  const index = encyclopedia();
  const reference = {
    name: 'Synthetic.sav',
    metadata: {
      quests: [
        [5304, 1],
        [5322, 1],
        [12400, 1],
        [12404, 1],
        [14074, 1],
        [13824, 1],
      ].map(([id, step]) => ({ id, step })),
      inventory: [],
      trackingMainQuest: 5304,
    },
  };
  const flow = flowSnapshot({ id: 'advice-scope', referenceMode: 'latest' }, reference);
  const before = JSON.stringify(flow.guide);
  const references = createEntityReferences({
    index: () => index,
    esc,
    picture: () => '',
    icon: () => '',
    qualityText: { html: (_id, label) => esc(label) },
  });
  const views = createEntityDetailViews({
    esc,
    act: (action, label, _className, id) =>
      `<button data-action="${esc(action)}" data-id="${esc(id)}">${label}</button>`,
    pill: esc,
    guide: () => flow.guide,
    richText: references.text,
  });
  const render = (id) =>
    views.task(
      index,
      index.world.quests.find((row) => row.gameId === id),
      reference,
    );
  const cards = [
    ...render(12400).matchAll(/<details class="entity-related-advice">[\s\S]*?<\/details>/g),
  ].map((match) => match[0]);
  assert(cards.length >= 2);
  assert.match(cards[0], /莫问的喜好.*白光剑/s, 'the specific route remains the first actionable advice');
  assert.match(cards[0], /data-id="name:白光剑"/, 'the real entity selector stays reachable');
  const risk = cards.find((card) => card.includes('晋升精英前'));
  assert(risk);
  assert.match(risk, /data-id="quest-12400"/);
  assert.doesNotMatch(
    risk,
    /data-id="quest-(14074|13824)"|演武试艺|武林挑战/,
    'another task does not bring its whole risk list into this detail',
  );
  const promotion = render(5304);
  for (const id of [12400, 14074, 13824])
    assert(
      promotion.includes(`data-id="quest-${id}"`),
      'the promotion detail retains all relevant active tasks',
    );
  const globalRisk = flow.warnings.find((row) => row.id === 'elite-active-quests');
  assert.deepEqual(
    globalRisk.affectedTasks.map((row) => row.questId),
    [14074, 13824, 12400],
  );
  assert.equal(
    JSON.stringify(flow.guide),
    before,
    'local detail selection never mutates the shared workflow',
  );
});
