'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readDialogue, withLiveDialogue } = require('../src/core/live-guidance.cjs');
const { flowSnapshot } = require('../src/core/flow.cjs');
const { companionSnapshot } = require('../src/core/companion.cjs');
const { defaults } = require('../src/core/store.cjs');
const { GameBridge } = require('../src/core/game-bridge.cjs');
const catalog = require('../src/data/catalog.cjs');

const dialogue = (extra = {}) => ({
  schema: 1,
  sequence: 1,
  questId: 11004,
  npcId: 10038,
  options: [
    { index: 1, text: '买把新的比较好' },
    { index: 2, text: '重新锻造一番吧' },
  ],
  ...extra,
});
const reference = (
  quests = [
    { id: 11002, step: 1 },
    { id: 11004, step: 1 },
  ],
) => ({
  name: 'Synthetic.sav',
  hash: 'synthetic-live-choice',
  modifiedAt: '2026-10-14T00:00:00Z',
  metadata: { quests, inventory: [], mapName: '梧桐村' },
});
const profile = { id: 'synthetic', referenceMode: 'latest' };
const context = (value = dialogue(), suppressedQuestIds = []) => ({ dialogue: value, suppressedQuestIds });
const choiceId = 'early-woodcutter-axe-choice';

test('bounded live option messages keep only the read-only fields and reject malformed input', () => {
  assert.deepEqual(readDialogue({ ...dialogue(), command: 'load', file: 'private' }), dialogue());
  const invalid = [
    null,
    {},
    dialogue({ schema: 2 }),
    dialogue({ sequence: 0 }),
    dialogue({ questId: -1 }),
    dialogue({ npcId: NaN }),
    dialogue({ options: [] }),
    dialogue({ options: [{ index: 1, text: '一项' }] }),
    dialogue({
      options: [
        { index: 1, text: '有效' },
        { index: 1, text: '重复' },
      ],
    }),
    dialogue({
      options: [
        { index: 1, text: '中'.repeat(171) },
        { index: 2, text: '有效' },
      ],
    }),
    dialogue({
      options: [
        { index: 1, text: '\u0000坏数据' },
        { index: 2, text: '有效' },
      ],
    }),
    dialogue({ options: Array.from({ length: 17 }, (_, i) => ({ index: i + 1, text: '选项' })) }),
    dialogue({ options: Array.from({ length: 16 }, (_, i) => ({ index: i + 1, text: 'a'.repeat(300) })) }),
  ];
  for (const value of invalid) assert.equal(readDialogue(value), null);
});

test('the current native choice can precede its saved step but must match the whole curated option set', () => {
  const oldSave = reference([{ id: 5020, step: 1 }]);
  const flow = flowSnapshot(profile, oldSave, '', context());
  assert.equal(flow.decisions.length, 1);
  const current = flow.decisions[0];
  assert.equal(current.id, choiceId);
  assert.equal(current.live, true);
  assert.match(current.recommendation.action, /重新锻造一番吧/);
  assert.deepEqual(current.recommendation.materials, [], 'saved materials are not promoted to live holdings');
  assert.deepEqual(
    current.choices.map((row) => row.label),
    dialogue().options.map((row) => row.text),
  );
  const formatted = dialogue({
    options: [
      { index: 1, text: '<Yellow>买把新的比较好。</>' },
      { index: 2, text: '「重新锻造一番吧」' },
    ],
  });
  assert.equal(flowSnapshot(profile, oldSave, '', context(formatted)).decisions[0].id, choiceId);
  for (const raw of [
    dialogue({ questId: 5076 }),
    dialogue({ npcId: 10016 }),
    dialogue({
      options: [
        { index: 1, text: '买把新的比较好' },
        { index: 2, text: '不重新锻造一番吧' },
      ],
    }),
    dialogue({ options: [...dialogue().options, { index: 3, text: '未知分支' }] }),
  ]) {
    const unmatched = flowSnapshot(profile, reference(), '', context(raw));
    assert.deepEqual(unmatched.decisions, [], 'an open unmatched dialogue never inherits a saved choice');
    for (const rows of [unmatched.warnings, unmatched.advice, unmatched.opportunities])
      assert(
        !rows.some((row) => row.choices?.length > 1),
        'saved choice recommendations cannot return through another carrier',
      );
    assert.equal(unmatched.liveDialogue.matched, false);
    assert(unmatched.guide.some((row) => row.id === choiceId));
  }
  const withoutSavedProgress = flowSnapshot(profile, null, '', context());
  assert.equal(withoutSavedProgress.available, false);
  assert.equal(withoutSavedProgress.decisions[0].live, true);
});

test('an open choice isolates every recommendation carrier and keeps ordinary risks and offline lookup', () => {
  const saved = flowSnapshot(profile, reference());
  const old = saved.guide.find((row) => row.id === choiceId);
  const ordinary = { id: 'ordinary-risk', warning: '出发前接取另一条普通任务' };
  const base = {
    ...saved,
    warnings: [old, ordinary],
    advice: [old, ordinary],
    opportunities: [old, ordinary],
  };
  const unknown = withLiveDialogue(base, context(dialogue({ questId: 999999 })), new Map());
  for (const rows of [unknown.warnings, unknown.advice, unknown.opportunities])
    assert.deepEqual(rows, [ordinary]);
  assert(unknown.guide.some((row) => row.id === choiceId));
  const other = saved.guide.find((row) => row.id === 'early-jingyin-weapon-choice');
  const matched = flowSnapshot(
    profile,
    reference(),
    '',
    context(
      dialogue({
        questId: 5076,
        npcId: 10016,
        options: other.choices.map((choice, index) => ({ index: index + 1, text: choice.label })),
      }),
    ),
  );
  assert.deepEqual(
    matched.decisions.map((row) => row.id),
    [other.id],
  );
  for (const rows of [matched.warnings, matched.advice, matched.opportunities])
    assert(!rows.some((row) => row.choices?.length > 1));
});

test('closed live choices retire stale saved advice and a newly observed opening can restore it', () => {
  assert(flowSnapshot(profile, reference()).decisions.some((row) => row.id === choiceId));
  const closed = flowSnapshot(profile, reference(), '', context(null, [11004]));
  for (const rows of [closed.decisions, closed.warnings, closed.advice, closed.opportunities])
    assert(!rows.some((row) => row.id === choiceId));
  assert(
    closed.guide.some((row) => row.id === choiceId),
    'offline lookup remains available',
  );
  const reopened = flowSnapshot(profile, reference(), '', context(dialogue({ sequence: 2 })));
  assert.equal(reopened.decisions[0].liveSequence, 2);
});

test('live guidance reaches the lightweight hint without mixing into fixed or reference-free queries', () => {
  const state = defaults();
  const current = companionSnapshot(state, catalog, reference([]), '', context());
  assert.equal(current.hints[0].type, 'flow-choice');
  assert.match(current.hints[0].title, /樵夫.*重锻/);
  for (const mode of ['none', 'slot']) {
    state.profiles[0].referenceMode = mode;
    state.profiles[0].saveSlot = mode === 'slot' ? 'Synthetic.sav' : '';
    const query = companionSnapshot(state, catalog, reference([]), '', context());
    assert(!query.flow.decisions.some((row) => row.live));
  }
});

test('bridge guidance is bound to the fresh session, current source and non-writing state', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-live-guidance-'));
  t.after(() => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert(path.basename(root).startsWith('yijian-live-guidance-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const source = path.join(root, '76561190000000000', 'SaveGames');
  const now = 1800000000000;
  const bridge = Object.create(GameBridge.prototype);
  Object.assign(bridge, {
    root,
    test: true,
    now: () => now,
    token: 'a'.repeat(64),
    revision: 'b'.repeat(64),
    timeline: { data: { source } },
    blocked: () => false,
  });
  const pulse = (extra = {}) =>
    fs.writeFileSync(
      path.join(root, 'state.json'),
      JSON.stringify({
        protocol: 2,
        token: bridge.token,
        revision: bridge.revision,
        source,
        at: now / 1000,
        ready: false,
        reason: '菜单或对话中暂停保存',
        session: '1800000000-123456',
        dialogue: dialogue(),
        ...extra,
      }),
    );
  pulse();
  assert.deepEqual(bridge.liveGuidance(source), context());
  pulse({ dialogue: null });
  assert.deepEqual(bridge.liveGuidance(source), context(null, [11004]));
  pulse();
  assert.deepEqual(bridge.liveGuidance(source), context());
  for (const extra of [
    { at: now / 1000 - 4 },
    { token: 'c'.repeat(64) },
    { revision: 'c'.repeat(64) },
    { source: path.join(root, 'foreign', 'SaveGames') },
    { reason: '战斗、过场或切换场景中暂停保存' },
  ]) {
    pulse(extra);
    assert.deepEqual(bridge.liveGuidance(source), context(null, [11004]));
  }
  pulse();
  assert.equal(bridge.liveGuidance(path.join(root, 'another', 'SaveGames')), null);
  for (const flag of ['busy', 'loadQueued', 'quiescing', 'disposed']) {
    bridge[flag] = true;
    assert.deepEqual(bridge.liveGuidance(source), context(null, [11004]), flag);
    bridge[flag] = false;
  }
  bridge.timeline.data.pending = { type: 'load' };
  assert.deepEqual(bridge.liveGuidance(source), context(null, [11004]));
  bridge.timeline.data.pending = null;
  bridge.test = false;
  bridge.installation = () => ({ installed: false, reason: '游戏版本不匹配' });
  assert.deepEqual(
    bridge.liveGuidance(source),
    context(null, [11004]),
    'an authenticated heartbeat cannot bypass installation hashes',
  );
});

test('same-session interruption preserves retirement until a fresh choice or a new session', () => {
  const source = '/synthetic/76561190000000000/SaveGames';
  const bridge = Object.create(GameBridge.prototype);
  let pulse = { session: '1800000000-123456', source, ready: true, dialogue: dialogue() };
  Object.assign(bridge, {
    test: true,
    timeline: { data: { source } },
    blocked: () => false,
    heartbeat: () => pulse,
    connected: (state) => !!state && state.source === source,
  });
  for (const interruption of [
    null,
    { ...pulse, ready: false, reason: '战斗、过场或切换场景中暂停保存', dialogue: null },
  ]) {
    pulse = { session: '1800000000-123456', source, ready: true, dialogue: dialogue() };
    assert.equal(bridge.liveGuidance(source).dialogue.questId, 11004);
    pulse = interruption;
    const withdrawn = bridge.liveGuidance(source);
    assert.deepEqual(withdrawn, context(null, [11004]));
    assert.deepEqual(flowSnapshot(profile, reference(), '', withdrawn).decisions, []);
    pulse = { session: '1800000000-123456', source, ready: true, dialogue: null };
    assert.deepEqual(bridge.liveGuidance(source), context(null, [11004]));
  }
  pulse = { ...pulse, session: '1800000001-123456' };
  assert.deepEqual(bridge.liveGuidance(source), context(null, []), 'a verified new session starts fresh');
  assert.equal(
    bridge.liveGuidance('/synthetic/foreign/SaveGames'),
    null,
    'never share retirement with another source',
  );
});
