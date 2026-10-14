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
  questId: 11005,
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
    { id: 11005, step: 1 },
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
  const single = dialogue({ options: [{ index: 1, text: '继续' }] });
  assert.deepEqual(readDialogue(single), single, 'the producer also reports single-option windows');
  const invalid = [
    null,
    {},
    dialogue({ schema: 2 }),
    dialogue({ sequence: 0 }),
    dialogue({ questId: -1 }),
    dialogue({ npcId: NaN }),
    dialogue({ options: [] }),
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
  assert.equal(current.recommendation.materials[0].required, 4);
  assert.equal(current.recommendation.materials[0].owned, null, 'saved stock is not live holdings');
  assert.equal(current.recommendation.materials[0].missing, null);
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
    dialogue({ questId: 999999, npcId: 0, options: [{ index: 1, text: '继续' }] }),
    dialogue({ questId: 5076 }),
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
    changes: [{ id: old.id }, ordinary],
  };
  const unknown = withLiveDialogue(base, context(dialogue({ questId: 999999 })), new Map());
  for (const rows of [unknown.warnings, unknown.advice, unknown.opportunities, unknown.changes])
    assert.deepEqual(rows, [ordinary]);
  assert(unknown.guide.some((row) => row.id === choiceId));
  const other = saved.guide.find((row) => row.id === 'early-jingyin-weapon-choice');
  const matched = flowSnapshot(
    profile,
    reference(),
    '',
    context(
      dialogue({
        questId: 5078,
        npcId: 10016,
        options: [
          { index: 1, text: '剑系武器' },
          { index: 2, text: '拳系武器' },
          { index: 3, text: '刀系武器' },
        ],
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

test('retired and superseded choices leave stage changes and their derived next node', () => {
  const saved = reference([
    { id: 5820, step: 1 },
    { id: 5821, step: 1 },
  ]);
  saved.metadata.trackingMainQuest = 5820;
  const before = flowSnapshot(profile, saved);
  assert(before.changes.some((row) => row.id === 'chengyu-stay-choice'));
  assert.match(before.chapter.next.title, /程钰/);
  for (const live of [
    context(null, [5821]),
    context(dialogue({ questId: 999999, npcId: 0, options: [{ index: 1, text: '继续' }] })),
    context(dialogue()),
  ]) {
    const after = flowSnapshot(profile, saved, '', live);
    for (const rows of [after.decisions, after.warnings, after.advice, after.opportunities, after.changes])
      assert(!rows.some((row) => row.id === 'chengyu-stay-choice'));
    assert.doesNotMatch(after.chapter.next?.title || '', /程钰/);
    assert(after.guide.some((row) => row.id === 'chengyu-stay-choice'));
  }
});

test('a first single-option window reaches the bridge and removes old choices from lightweight hints', () => {
  const source = '/synthetic/76561190000000000/SaveGames';
  const single = dialogue({ questId: 999999, npcId: 0, options: [{ index: 1, text: '继续' }] });
  const bridge = Object.assign(Object.create(GameBridge.prototype), {
    npcReader: { sample: () => null, withdraw: () => {} },
    test: true,
    timeline: { data: { source } },
    blocked: () => false,
    heartbeat: () => ({ session: '1800000000-123456', source, ready: true, dialogue: single }),
    connected: () => true,
  });
  const live = bridge.liveGuidance(source);
  assert.deepEqual(live, context(single));
  const view = companionSnapshot(defaults(), catalog, reference(), '', live);
  assert.equal(view.flow.liveDialogue.matched, false);
  for (const rows of [view.flow.decisions, view.flow.warnings, view.flow.advice, view.flow.opportunities])
    assert(!rows.some((row) => row.choices?.length > 1));
  assert(!view.hints.some((row) => row.type === 'flow-choice'));
});

test('closed live choices retire stale saved advice and a newly observed opening can restore it', () => {
  assert(flowSnapshot(profile, reference()).decisions.some((row) => row.id === choiceId));
  const closed = flowSnapshot(profile, reference(), '', context(null, [11005]));
  assert(!closed.active.some((task) => task.steps.some((step) => step.id === 'quest-11005')));
  const passive = companionSnapshot(defaults(), catalog, reference(), '', context(null, [11005]));
  assert(!passive.hints.some((hint) => /告诉樵夫两个选择/.test(hint.title)));
  for (const rows of [closed.decisions, closed.warnings, closed.advice, closed.opportunities])
    assert(!rows.some((row) => row.id === choiceId));
  assert(
    closed.guide.some((row) => row.id === choiceId),
    'offline lookup remains available',
  );
  const reopened = flowSnapshot(profile, reference(), '', context(dialogue({ sequence: 2 })));
  assert.equal(reopened.decisions[0].liveSequence, 2);
});

test('retirement removes only stale choice actions and recalculates their shared-material display', () => {
  const saved = flowSnapshot(profile, reference());
  const material = {
    id: 'item-10201',
    owned: 2,
    required: 12,
    missing: 10,
    steps: [
      { id: 'quest-11005', required: 7 },
      { id: 'quest-900001', required: 3 },
      { id: 'quest-900002', required: 2 },
    ],
  };
  const base = {
    ...saved,
    active: [
      {
        id: 'quest-11002',
        steps: [
          { id: 'quest-11005', nextAction: '旧选择' },
          { id: 'quest-900001', nextAction: '交付材料' },
          { id: 'quest-900002', nextAction: '回访樵夫' },
        ],
      },
    ],
    sharedMaterials: [material],
  };
  const before = structuredClone(base);
  for (const live of [context(null, [11005]), context(dialogue({ questId: 999999 }))]) {
    const after = withLiveDialogue(base, live, new Map());
    assert.deepEqual(
      after.active[0].steps.map((step) => step.id),
      ['quest-900001', 'quest-900002'],
    );
    assert.equal(after.sharedMaterials[0].required, 5);
    assert.equal(after.sharedMaterials[0].missing, 3);
    assert.equal(after.active[0].steps[0].nextAction, '交付材料', 'ordinary saved tasks remain available');
  }
  assert.deepEqual(base, before, 'saved facts and offline source are not modified');
  const fixed = withLiveDialogue({ ...base, referenceMode: 'slot' }, context(null, [11005]), new Map());
  assert.equal(fixed.active[0].steps[0].id, 'quest-11005', 'explicit historical lookup keeps saved actions');
});

test('retirement is bounded by known choice steps and survives more than 64 unrelated dialogues', () => {
  const source = '/synthetic/76561190000000000/SaveGames';
  const bridge = Object.create(GameBridge.prototype);
  bridge.npcReader = { sample: () => null, withdraw: () => {} };
  let pulse = { session: '1800000000-123456', source, ready: true, dialogue: dialogue() };
  Object.assign(bridge, {
    test: true,
    timeline: { data: { source } },
    blocked: () => false,
    heartbeat: () => pulse,
    connected: (state) => !!state && state.source === source,
  });
  bridge.liveGuidance(source);
  pulse = { ...pulse, dialogue: null };
  assert.deepEqual(bridge.liveGuidance(source), context(null, [11005]));
  const unrelated = Array.from({ length: 65 }, (_, i) => 900000 + i);
  for (const questId of unrelated) {
    pulse = { ...pulse, dialogue: dialogue({ questId, npcId: 0 }) };
    bridge.liveGuidance(source);
    pulse = { ...pulse, dialogue: null };
    assert.deepEqual(bridge.liveGuidance(source), context(null, [11005]));
  }
  for (const retired of [bridge.liveGuidance(source), context(null, [...unrelated, 11005])]) {
    const flow = flowSnapshot(profile, reference(), '', retired);
    for (const rows of [flow.decisions, flow.warnings, flow.advice, flow.opportunities])
      assert(!rows.some((row) => row.id === choiceId));
    assert(flow.guide.some((row) => row.id === choiceId));
  }
  const known = [
    ...new Set([
      ...require('../src/data/flow-guide.cjs').rules.flatMap((r) => r.decisionSteps || []),
      ...require('../src/data/live-choice-contracts.json').contracts.map((r) => r.questId),
    ]),
  ];
  for (const questId of known) {
    pulse = { ...pulse, dialogue: dialogue({ questId }) };
    bridge.liveGuidance(source);
    pulse = { ...pulse, dialogue: null };
    bridge.liveGuidance(source);
  }
  assert.deepEqual(new Set(bridge.liveGuidance(source).suppressedQuestIds), new Set(known));
  const largerGuide = Array.from({ length: 65 }, (_, i) => ({
    id: `choice-${i}`,
    decisionSteps: [800000 + i],
  }));
  const larger = withLiveDialogue(
    { referenceMode: 'latest', guide: largerGuide, decisions: largerGuide },
    context(
      null,
      largerGuide.flatMap((r) => r.decisionSteps),
    ),
    new Map(),
  );
  assert.deepEqual(larger.decisions, [], 'a larger curated guide does not acquire a 64-step limit');
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
  bridge.npcReader = { sample: () => null, withdraw: () => {} };
  Object.assign(bridge, {
    root,
    test: true,
    now: () => now,
    token: 'a'.repeat(64),
    revision: 'b'.repeat(64),
    guidanceSource: source,
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
  assert.deepEqual(bridge.liveGuidance(source), context(null, [11005]));
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
    assert.deepEqual(bridge.liveGuidance(source), context(null, [11005]));
  }
  pulse();
  assert.equal(bridge.liveGuidance(path.join(root, 'another', 'SaveGames')), null);
  for (const flag of ['busy', 'loadQueued', 'quiescing', 'disposed']) {
    bridge[flag] = true;
    assert.deepEqual(bridge.liveGuidance(source), context(null, [11005]), flag);
    bridge[flag] = false;
  }
  bridge.timeline.data.pending = { type: 'load' };
  assert.deepEqual(bridge.liveGuidance(source), context(null, [11005]));
  bridge.timeline.data.pending = null;
  bridge.test = false;
  bridge.installation = () => ({ installed: false, reason: '游戏版本不匹配' });
  assert.deepEqual(
    bridge.liveGuidance(source),
    context(null, [11005]),
    'an authenticated heartbeat cannot bypass installation hashes',
  );
});

test('same-session interruption preserves retirement until a fresh choice or a new session', () => {
  const source = '/synthetic/76561190000000000/SaveGames';
  const bridge = Object.create(GameBridge.prototype);
  bridge.npcReader = { sample: () => null, withdraw: () => {} };
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
    assert.equal(bridge.liveGuidance(source).dialogue.questId, 11005);
    pulse = interruption;
    const withdrawn = bridge.liveGuidance(source);
    assert.deepEqual(withdrawn, context(null, [11005]));
    assert.deepEqual(flowSnapshot(profile, reference(), '', withdrawn).decisions, []);
    pulse = { session: '1800000000-123456', source, ready: true, dialogue: null };
    assert.deepEqual(bridge.liveGuidance(source), context(null, [11005]));
  }
  pulse = { ...pulse, session: '1800000001-123456' };
  assert.deepEqual(bridge.liveGuidance(source), context(null, []), 'a verified new session starts fresh');
  assert.equal(
    bridge.liveGuidance('/synthetic/foreign/SaveGames'),
    null,
    'never share retirement with another source',
  );
});

test('restarting the assistant retains closed choices only for the same verified game session', (t) => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-guidance-restart-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const root = path.join(data, 'bridge'),
    guidanceFile = path.join(data, 'live-guidance.json'),
    source = path.join(data, '76561190000000000', 'SaveGames');
  let state = { session: '1800000000-123456', source, ready: true, dialogue: dialogue() };
  const restart = () => {
    const bridge = new GameBridge(
      root,
      { data: { source: state.source } },
      {
        test: true,
        blocked: () => false,
        guidanceFile,
      },
    );
    bridge.heartbeat = () => ({ ...state, token: bridge.token, revision: bridge.revision });
    return bridge;
  };
  let bridge = restart();
  bridge.liveGuidance(source);
  state.dialogue = null;
  assert.deepEqual(bridge.liveGuidance(source), context(null, [11005]));
  const stamp = fs.statSync(guidanceFile, { bigint: true }).mtimeNs;
  bridge.liveGuidance(source);
  assert.equal(
    fs.statSync(guidanceFile, { bigint: true }).mtimeNs,
    stamp,
    'unchanged heartbeats do not write',
  );
  bridge = restart();
  const restored = bridge.liveGuidance(source);
  assert.deepEqual(restored, context(null, [11005]));
  assert.deepEqual(flowSnapshot(profile, reference(), '', restored).decisions, []);
  state.dialogue = dialogue({ sequence: 2 });
  assert.deepEqual(
    bridge.liveGuidance(source),
    context(state.dialogue),
    'a genuine reopening clears retirement',
  );
  bridge = restart();
  state.dialogue = null;
  assert.deepEqual(
    bridge.liveGuidance(source),
    context(null, [11005]),
    'close while the assistant is off also retires its last observed choice',
  );
  fs.writeFileSync(guidanceFile, '{broken');
  bridge = restart();
  assert.deepEqual(
    bridge.liveGuidance(source),
    context(null, [11005]),
    'recover the previous complete record',
  );
  state.session = '1800000001-123456';
  bridge = restart();
  assert.deepEqual(
    bridge.liveGuidance(source),
    context(null, []),
    'new game session does not inherit retirement',
  );
  state.dialogue = dialogue({ sequence: 3 });
  bridge.liveGuidance(source);
  state.dialogue = null;
  bridge.liveGuidance(source);
  state.source = path.join(data, 'foreign', 'SaveGames');
  bridge = restart();
  assert.deepEqual(bridge.liveGuidance(state.source), context(null, []), 'another source starts fresh');
  state.source = source;
  bridge = restart();
  assert.deepEqual(
    bridge.liveGuidance(source),
    context(null, []),
    'valid foreign record cannot revive a matching previous copy',
  );
  state.dialogue = dialogue({ sequence: 4 });
  bridge.liveGuidance(source);
  state.dialogue = null;
  bridge.liveGuidance(source);
  bridge = restart();
  bridge.revision = 'c'.repeat(64);
  assert.deepEqual(
    bridge.liveGuidance(source),
    context(null, []),
    'script changes invalidate stored retirement',
  );
  state.dialogue = dialogue({ sequence: 5 });
  bridge.liveGuidance(source);
  state.dialogue = null;
  bridge.liveGuidance(source);
  bridge = restart();
  bridge.revision = 'c'.repeat(64);
  bridge.token = 'd'.repeat(64);
  assert.deepEqual(
    bridge.liveGuidance(source),
    context(null, []),
    'another bridge identity cannot inherit retirement',
  );
  assert.equal(fs.existsSync(source), false, 'no save directory was created or written');
  assert.equal(
    bridge.timeline.data.enabled,
    undefined,
    'reminder persistence grants no timeline permissions',
  );
});

test('a verified new observation restores loaded choices without reviving stale saved advice', (t) => {
  const crypto = require('node:crypto');
  const { NpcObservationReader } = require('../src/core/live-npc-state.cjs');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-guidance-epoch-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const source = path.join(data, 'synthetic', 'SaveGames');
  const token = 'a'.repeat(64),
    revision = 'b'.repeat(64),
    session = '1800000000-123456';
  const now = 1800000000000,
    world = 'World /Synthetic.LV_25_P';
  const mac = (value) => crypto.createHmac('sha256', Buffer.from(token, 'hex')).update(value).digest('hex');
  const attributes = Object.fromEntries(
    [5, 27, 48, 61, 63, 65, 67, 44, 9, 10, 14, 11, 12, 2, 4].map((id) => [id, 1]),
  );
  let pulse,
    bytes,
    sequence = 0;
  const sample = (epoch, step = 1, choice = null) => {
    const pawn = 'Pawn Synthetic' + epoch;
    sequence++;
    const body = {
      schema: 1,
      source,
      session,
      revision,
      world,
      pawn,
      epoch,
      version: sequence,
      identity: ['gi' + epoch, 'sm' + epoch, 'nm' + epoch, 'qm' + epoch, 'player' + epoch],
      quests: [
        { id: 11002, step },
        { id: 11005, step },
      ],
      npcs: [
        {
          id: 0,
          rawFriendliness: 0,
          visible: true,
          mapKey: 'LV_25_P',
          attributes,
          skills: [],
          inventory: [],
          guildId: 0,
          skillPoints: 0,
        },
      ],
    };
    bytes = Buffer.from(JSON.stringify(body));
    const at = now / 1000,
      blobMac = mac(bytes);
    pulse = {
      protocol: 2,
      token,
      revision,
      source,
      session,
      ready: true,
      reason: '',
      world,
      pawn,
      at,
      dialogue: choice,
      npcObservation: {
        epoch,
        version: sequence,
        sequence,
        at,
        mac: blobMac,
        sampleMac: mac(
          [
            'npc-sample-v1',
            source,
            session,
            revision,
            world,
            pawn,
            epoch,
            sequence,
            sequence,
            at,
            blobMac,
          ].join('\n'),
        ),
      },
    };
  };
  const restart = () =>
    Object.assign(Object.create(GameBridge.prototype), {
      test: true,
      token,
      revision,
      guidanceSource: source,
      guidanceFile: path.join(data, 'live-guidance.json'),
      timeline: { data: { source } },
      blocked: () => false,
      heartbeat: () => pulse,
      now: () => now,
      npcReader: new NpcObservationReader({ read: () => bytes, token, revision, now: () => now }),
    });
  let bridge = restart();
  sample(1, 1, dialogue());
  assert.equal(bridge.liveGuidance(source).dialogue.questId, 11005);
  sample(1);
  assert.deepEqual(
    bridge.liveGuidance(source).suppressedQuestIds,
    [11005],
    'close retires even before the quest record advances',
  );
  bridge = restart();
  assert.deepEqual(
    bridge.liveGuidance(source).suppressedQuestIds,
    [11005],
    'same epoch retirement survives assistant restart',
  );
  sample(1, 4);
  assert.deepEqual(flowSnapshot(profile, reference(), '', bridge.liveGuidance(source)).active, []);
  pulse = { ...pulse, ready: false, reason: '正在读档', dialogue: null };
  assert.deepEqual(bridge.liveGuidance(source), context(null, [11005]));
  sample(2);
  pulse.npcObservation.sampleMac = '0'.repeat(64);
  assert.deepEqual(
    bridge.liveGuidance(source),
    context(null, [11005]),
    'unverified epoch cannot clear retirement',
  );
  bridge = restart();
  sample(2);
  const loaded = bridge.liveGuidance(source);
  assert.equal(loaded.npcState.epoch, 2);
  assert.deepEqual(loaded.suppressedQuestIds, []);
  const flow = flowSnapshot(profile, reference(), '', loaded);
  assert.equal(flow.stateOrigin, 'live');
  assert(
    flow.active.some((row) => row.gameId === 11002),
    'loaded active task returns',
  );
  assert(
    flow.decisions.some((row) => row.id === choiceId),
    'loaded choice advice returns',
  );
  bridge = restart();
  sample(2);
  assert.deepEqual(
    bridge.liveGuidance(source).suppressedQuestIds,
    [],
    'restored cohort stays available after assistant restart',
  );
  pulse = { ...pulse, ready: false, reason: '战斗、过场或切换场景中暂停保存' };
  const withdrawn = bridge.liveGuidance(source);
  assert.deepEqual(withdrawn, context(null, [11005]), 'old saved-file retirement is retained independently');
  assert.deepEqual(flowSnapshot(profile, reference(), '', withdrawn).decisions, []);
  sample(3, 4);
  assert.deepEqual(
    flowSnapshot(profile, reference(), '', bridge.liveGuidance(source)).decisions,
    [],
    'completed quest does not revive after travel',
  );
  sample(4, 1, dialogue({ sequence: 2 }));
  bridge.liveGuidance(source);
  sample(4);
  assert.deepEqual(
    bridge.liveGuidance(source).suppressedQuestIds,
    [11005],
    'a newly closed choice retires in its own cohort',
  );
  assert.equal(fs.existsSync(source), false, 'no game save directory is touched');
});

test('live choices retain fixed material requirements and sources without borrowing saved stock', async () => {
  const { createFlowViews } = await import('../src/renderer/flow-views.js');
  const view = createFlowViews({
    esc: String,
    act: (_action, label) => label,
    icon: () => '',
    pill: () => '',
    when: String,
  });
  for (const saved of [null, reference([{ id: 5020, step: 1 }]), reference()]) {
    if (saved) saved.metadata.inventory = [{ id: 10201, count: 99 }];
    const flow = flowSnapshot(profile, saved, '', context());
    const row = flow.decisions[0];
    const material = row.recommendation.materials[0];
    assert.equal(material.id, 'item-10201');
    assert.equal(material.required, 4);
    assert.equal(material.owned, null);
    assert.equal(material.missing, null);
    assert(material.routes.length > 0, 'known acquisition details are retained');
    for (const compact of [false, true]) {
      const visible = view.choice(row, { compact }).split('<details')[0];
      assert.match(visible, /铁矿石.*需 4.*后山山洞附近采集 → 村西铁匠/s);
      assert.match(visible, /库存未读取/);
      assert.doesNotMatch(visible, /持有 99|缺 4|已齐/);
    }
    assert.equal(flow.sharedMaterials.length, 0, 'conditional branch stock is not current task allocation');
  }
});

test('default choice hints retain permanent consequences before ordinary task hints', async () => {
  const { pathToFileURL } = require('node:url');
  const { createCompanionViews } = await import(
    pathToFileURL(path.join(__dirname, '../src/renderer/companion-view.js')).href
  );
  const render = createCompanionViews({ esc: String, icon: () => '', act: () => '', qualityText: {} });
  const rules = require('../src/data/flow-guide.cjs').rules;
  // Literal native packets from the pinned Quests asset, independent of guide labels.
  for (const [id, questId, options] of [
    ['chenlinxi-critical-choice', 12079, ['好言相劝', '义正辞严']],
    ['tianji-rebuild-choice', 24063, ['重建天机宫', '回绝此事']],
    ['changsheng-rescue-choice', 8861, ['置之不理', '出手相救']],
  ]) {
    const rule = rules.find((r) => r.id === id);
    const value = dialogue({
      questId,
      npcId: 0,
      options: options.map((text, i) => ({ index: i + 1, text })),
    });
    const data = companionSnapshot(defaults(), catalog, reference(), '', context(value));
    assert.equal(data.flow.liveDialogue.matched, true, id);
    assert.deepEqual(
      data.hints.map((h) => h.type),
      ['flow-choice', 'flow-caution'],
    );
    assert.equal(data.hints[1].title, rule.recommendation.caution);
    assert(
      render.passive(data).includes(rule.recommendation.caution),
      id + ' exposes its complete critical consequence',
    );
  }
});
