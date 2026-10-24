'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { flowSnapshot } = require('../src/core/flow.cjs');
const { withLiveDialogue } = require('../src/core/live-guidance.cjs');
const { companionSnapshot } = require('../src/core/companion.cjs');
const { defaults } = require('../src/core/store.cjs');
const catalog = require('../src/data/catalog.cjs');

const profile = { id: 'synthetic-performer', referenceMode: 'latest' };
const firstId = 'gusu-performer-first-bowls-choice';
const threeId = 'gusu-performer-three-bowls-followup-choice';
const sixId = 'gusu-performer-six-bowls-followup-choice';
const ironId = 'gusu-performer-iron-arm-choice';
const performer = (row) => row.id.startsWith('gusu-performer-');
const reference = (quests) => ({
  name: 'Synthetic.sav',
  hash: 'synthetic-performer-choice',
  metadata: { quests, inventory: [], mapName: '姑苏城' },
});
const dialogue = (questId, options, sequence = 1) => ({
  schema: 1,
  sequence,
  questId,
  npcId: 0,
  options: options.map((text, i) => ({ index: i + 1, text })),
});
const live = (questId, options, saved = null) =>
  flowSnapshot(profile, saved, '', { dialogue: dialogue(questId, options) });

// Literal buttons from the pinned Build 21798996 Quests rows, independent of
// the guide labels and production contracts. In 11454 and 11455 the identical
// text has different actions, so positive row identity is essential.
const packets = [
  [11453, firstId, ['吃三盆', '吃六盆', '吃九盆']],
  [11454, threeId, ['再吃三盆', '认输']],
  [11455, sixId, ['再吃三盆', '认输']],
  [11456, ironId, ['拼了', '认输']],
];

test('street performers require the exact native row and its complete option set', () => {
  for (const [questId, id, options] of packets) {
    const flow = live(questId, options);
    assert.equal(flow.liveDialogue.matched, true, String(questId));
    assert.deepEqual(
      flow.decisions.map((row) => row.id),
      [id],
    );
    assert.equal(flow.decisions[0].live, true);
    assert.deepEqual(
      flow.decisions[0].choices.map((row) => row.label),
      options,
    );
    assert.deepEqual(
      flow.decisions[0].choices.map((row) => row.index),
      options.map((_, i) => i + 1),
    );
    for (const wrong of [options.slice(1), [...options, '陌生选项'], options.map(() => options[0])]) {
      const unmatched = live(questId, wrong);
      assert.equal(unmatched.liveDialogue.matched, false);
      assert.deepEqual(unmatched.decisions, []);
    }
    for (const wrongId of [11447, 11449, 999999]) {
      assert.equal(live(wrongId, options).liveDialogue.matched, false);
    }
  }
  for (const [id, options] of [
    [11453, ['再吃三盆', '认输']],
    [11454, ['吃三盆', '吃六盆', '吃九盆']],
    [11456, ['再吃三盆', '认输']],
  ])
    assert.equal(live(id, options).liveDialogue.matched, false);
});

test('same-text follow-ups retain their different rewards and maximum-health costs', () => {
  const first = live(11453, ['吃三盆', '吃六盆', '吃九盆']).decisions[0];
  assert.match(first.recommendation.action, /优先选「吃三盆」/);
  assert.match(first.choices[2].effect, /气血上限减少5点/);
  assert.match(first.choices[2].effect, /不发东坡肉/);
  const three = live(11454, ['再吃三盆', '认输']).decisions[0];
  const six = live(11455, ['再吃三盆', '认输']).decisions[0];
  assert.match(three.recommendation.action, /可选「再吃三盆」/);
  assert.equal(three.choices[0].effect, three.choices[1].effect);
  assert.match(three.choices[0].effect, /东坡肉×1；无气血上限扣减/);
  assert.match(six.recommendation.action, /优先选「认输」/);
  assert.match(six.choices[0].effect, /气血上限减少2点/);
  assert.match(six.choices[0].effect, /不发东坡肉/);
  assert.match(six.choices[1].effect, /东坡肉×1；无气血上限扣减/);
  const iron = live(11456, ['拼了', '认输']).decisions[0];
  assert.match(iron.recommendation.action, /优先选「认输」/);
  assert.match(iron.choices[0].effect, /气血上限减少5点/);
  assert.match(iron.choices[0].effect, /不发赤铜锭/);
  assert.match(iron.choices[1].effect, /赤铜锭×3；无气血上限扣减/);
  const reordered = live(11455, ['认输', '再吃三盆']).decisions[0];
  assert.match(reordered.choices[0].effect, /东坡肉×1/);
  assert.match(reordered.choices[1].effect, /气血上限减少2点/);
});

test('saved visible steps give advance advice without guessing hidden follow-ups', () => {
  for (const [step, id] of [
    [11453, firstId],
    [11456, ironId],
  ]) {
    const flow = flowSnapshot(
      profile,
      reference([
        { id: 11447, step: 1 },
        { id: step, step: 1 },
      ]),
    );
    assert.deepEqual(
      flow.decisions.filter(performer).map((row) => row.id),
      [id],
    );
    assert(!flow.decisions.find((row) => row.id === id).live);
  }
  for (const quests of [
    [{ id: 11447, step: 1 }],
    [{ id: 11447, step: 4 }],
    [
      { id: 11447, step: 1 },
      { id: 11453, step: 4 },
    ],
    [
      { id: 11447, step: 1 },
      { id: 11454, step: 1 },
    ],
    [
      { id: 11447, step: 1 },
      { id: 11455, step: 1 },
    ],
  ]) {
    const flow = flowSnapshot(profile, reference(quests));
    for (const rows of [flow.decisions, flow.warnings, flow.advice, flow.opportunities])
      assert(!rows.some(performer), JSON.stringify(quests));
    assert.equal(flow.guide.filter(performer).length, 4, 'offline details remain available');
  }
});

test('closing hidden follow-ups retires an older saved first-question recommendation', () => {
  const saved = reference([
    { id: 11447, step: 1 },
    { id: 11453, step: 1 },
  ]);
  const base = flowSnapshot(profile, saved);
  assert(base.decisions.some((row) => row.id === firstId));
  for (const questId of [11454, 11455]) {
    const open = live(questId, ['再吃三盆', '认输'], saved);
    assert.equal(open.decisions.length, 1);
    const closed = withLiveDialogue(open, { dialogue: null, suppressedQuestIds: [questId] }, new Map());
    for (const rows of [
      closed.decisions,
      closed.warnings,
      closed.advice,
      closed.opportunities,
      closed.changes,
    ])
      assert(!rows.some(performer));
    const stale = flowSnapshot(profile, saved, '', { dialogue: null, suppressedQuestIds: [questId] });
    assert(!stale.decisions.some(performer));
    assert(!stale.active.some((task) => task.steps.some((step) => step.id === 'quest-11453')));
    assert.equal(stale.guide.filter(performer).length, 4);
    const iron = flowSnapshot(
      profile,
      reference([
        { id: 11447, step: 1 },
        { id: 11456, step: 1 },
      ]),
      '',
      {
        dialogue: null,
        suppressedQuestIds: [questId],
      },
    );
    assert.deepEqual(
      iron.decisions.filter(performer).map((row) => row.id),
      [ironId],
    );
  }
});

test('mismatch, reopening, reload and fixed historical references retain existing isolation', () => {
  const saved = reference([
    { id: 11447, step: 1 },
    { id: 11453, step: 1 },
  ]);
  const closedContext = { dialogue: null, suppressedQuestIds: [11453] };
  assert(!flowSnapshot(profile, saved, '', closedContext).decisions.some(performer));
  const unmatched = live(11455, ['再吃三盆', '继续'], saved);
  for (const rows of [unmatched.decisions, unmatched.warnings, unmatched.advice, unmatched.opportunities])
    assert(!rows.some(performer));
  const reopened = flowSnapshot(profile, saved, '', {
    dialogue: dialogue(11455, ['再吃三盆', '认输'], 2),
    suppressedQuestIds: [11453],
  });
  assert.equal(reopened.decisions[0].id, sixId);
  assert.equal(reopened.decisions[0].liveSequence, 2);
  const reloaded = flowSnapshot(profile, saved, '', { dialogue: null, suppressedQuestIds: [] });
  assert.deepEqual(
    reloaded.decisions.filter(performer).map((row) => row.id),
    [firstId],
  );
  const fixed = flowSnapshot({ ...profile, referenceMode: 'slot', saveSlot: saved.name }, saved, '', {
    dialogue: dialogue(11455, ['再吃三盆', '认输']),
    suppressedQuestIds: [11453],
  });
  assert.deepEqual(
    fixed.decisions.filter(performer).map((row) => row.id),
    [firstId],
  );
  assert.equal(fixed.liveDialogue, undefined);
});

test('performer advice stays compact while its reasons and option effects expand', async () => {
  const { createFlowViews } = await import('../src/renderer/flow-views.js');
  const view = createFlowViews({
    esc: String,
    act: (_action, label) => label,
    icon: () => '',
    pill: () => '',
    when: String,
  });
  for (const [questId, id, options] of packets) {
    const data = companionSnapshot(defaults(), catalog, null, '', { dialogue: dialogue(questId, options) });
    const row = data.flow.decisions[0];
    assert.equal(row.id, id);
    assert.deepEqual(
      data.hints.map((hint) => hint.type),
      ['flow-choice', 'flow-caution'],
    );
    assert.equal(data.hints[1].title, row.recommendation.caution);
    for (const compact of [false, true]) {
      const html = view.choice(row, { compact });
      const lead = html.split('<details')[0];
      assert(lead.includes(row.recommendation.hint));
      assert(lead.includes(row.recommendation.caution));
      assert(!lead.includes(row.recommendation.reason));
      assert(html.includes(row.recommendation.reason));
      assert(html.includes(row.recommendation.tradeoff));
      assert(!/<details[^>]*\bopen\b/.test(html));
    }
  }
});
