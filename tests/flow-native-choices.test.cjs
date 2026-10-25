'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFlowProjector, flowSnapshot } = require('../src/core/flow.cjs');
const { encyclopedia } = require('../src/core/game-data.cjs');
const world = require('../src/data/world-index.json');
const game = require('../src/data/game-index.json');
const guide = require('../src/data/flow-guide.cjs');

const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (letter) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[letter],
  );
const helpers = { esc, icon: () => '', pill: esc, when: esc };
const profile = { id: 'native-choice', referenceMode: 'latest' };
const reference = (quests, extra = {}) => ({
  name: 'Synthetic.sav',
  hash: 'synthetic',
  modifiedAt: '2026-10-25T00:00:00Z',
  metadata: { quests, inventory: [], ...extra },
});
const quest = (gameId, parentId = 0, name = '合成任务') => ({
  id: `quest-${gameId}`,
  gameId,
  parentId,
  name,
  kind: 'Secondary',
  description: '',
  requestNPCs: [],
  finishNPCs: [],
  requirements: [],
  placements: [],
});
const choice = (text, actions, requirements = []) => ({ text, actions, requirements });
const detail = (choices, finish = [[], [], []]) => ({ choices, finish });
const modules = Promise.all([
  import('../src/renderer/flow-views.js'),
  import('../src/renderer/codex-detail-views.js'),
  import('../src/renderer/quest-effect-views.js'),
  import('../src/renderer/entity-references.js'),
]);
async function views(index) {
  const [
    { createFlowViews },
    { createCodexDetailViews },
    { createQuestEffectViews },
    { createEntityReferences },
  ] = await modules;
  const refs = createEntityReferences({
    index: () => index,
    esc,
    picture: (id) => `<span data-picture="${esc(id)}"></span>`,
    icon: () => '',
    qualityText: { html: (_id, label) => label },
  });
  const common = { ...helpers, act: refs.button };
  return {
    flow: createFlowViews({ ...common, index: () => index }),
    plain: createFlowViews(common),
    codex: createCodexDetailViews(common),
    effects: createQuestEffectViews(common),
  };
}
function fixture(choiceTable, extra = {}) {
  const quests = [
    quest(100, 0, '合成调查'),
    ...Object.keys(choiceTable)
      .filter((id) => Number(id) !== 100)
      .map((id) => quest(Number(id), 100, '交谈 ' + id)),
  ];
  const index = {
    entries: [],
    world: { quests, people: [], maps: [], npcNames: {} },
    codex: { quests: choiceTable, hiddenSteps: {} },
    ...extra,
  };
  const project = createFlowProjector({
    world: index.world,
    game: { entries: index.entries },
    guide: { sources: {}, rules: [] },
  }).flowSnapshot;
  return { index, project: (records, extra = {}) => project(profile, reference(records, extra)) };
}
function visibleText(html) {
  const details = [];
  let result = '';
  for (const token of html.match(/<[^>]*>|[^<]+/g) || []) {
    if (/^<details\b/.test(token)) details.push({ open: /\bopen(?:[\s=>]|$)/.test(token), summary: false });
    else if (/^<\/details/.test(token)) details.pop();
    else if (/^<summary\b/.test(token) && details.length) details.at(-1).summary = true;
    else if (/^<\/summary/.test(token) && details.length) details.at(-1).summary = false;
    else if (!token.startsWith('<') && details.every((row) => row.open || row.summary)) result += token;
  }
  return result;
}
const hasNative = (html, id) => html.includes(`data-flow-native-choice="${id}"`);

test('only actually active child steps expose native option facts, with no root pickup replay or tracking inference', async () => {
  const choices = [choice('答应', [{ type: 'CMoney', id: 1, value: 200 }]), choice('拒绝', [])];
  const f = fixture({ 100: detail(choices), 101: detail(choices) });
  const { flow, plain } = await views(f.index);
  const current = f.project([
    { id: 100, step: 1 },
    { id: 101, step: 1 },
  ]);
  assert.equal(current.active[0].steps[0].choiceStepId, 101);
  for (const compact of [false, true]) {
    assert(hasNative(flow.panel(current, { compact }), 101));
    assert(
      !hasNative(plain.panel(current, { compact }), 101),
      'no injected source means no real-table fallback',
    );
    for (const step of [undefined, 0, 2, 3, 4]) {
      const records = [{ id: 100, step: 1 }, ...(step === undefined ? [] : [{ id: 101, step }])];
      const html = flow.panel(f.project(records, { trackingQuest: 101, trackingMainQuest: 101 }), {
        compact,
      });
      assert(!hasNative(html, 101), `step ${step} cannot be inferred from a root or tracking`);
      assert(!hasNative(html, 100), 'an accepted root cannot replay its pickup choices');
    }
    for (const step of [2, 3, 4])
      assert(
        !hasNative(
          flow.panel(
            f.project([
              { id: 100, step },
              { id: 101, step: 1 },
            ]),
            { compact },
          ),
          101,
        ),
      );
    assert(!hasNative(flow.panel({ ...current, available: false }, { compact }), 101));
  }
});

test('both presentations share typed effects and artwork with codex, keeping severe consequences visible and rewards folded', async () => {
  const actions = [
    { type: 'CItem', id: 'cache_A', value: 2 },
    { type: 'CMoney', id: 1, value: 111 },
    { type: 'ASExp', id: 0, value: 17 },
    { type: 'ASkill', id: 7, value: 0 },
    { type: 'CYHD', id: 8, value: -10 },
    { type: 'ATeam', id: 9, value: 0 },
    { type: 'RTeam', id: 8, value: 0 },
    { type: 'CAttr', id: 2, value: -5 },
    { type: 'RQuest', id: 100, value: 0 },
    { type: 'CQuestStep', id: 101, value: 2 },
  ];
  const f = fixture(
    {
      101: detail(
        [choice('接受考验', actions), choice('稍后再说', [{ type: 'CMoney', id: 1, value: 222 }])],
        [[{ type: 'CMoney', id: 1, value: 333 }], [{ type: 'CMoney', id: 1, value: 444 }], []],
      ),
    },
    {
      entries: [
        { id: 'item-cache_A', gameId: 'cache_A', kind: '物品', name: '同名奖励' },
        { id: 'skill-7', gameId: 7, kind: '武学', name: '同名奖励' },
        { id: 'npc-8', gameId: 8, kind: '人物', name: '离队同伴' },
        { id: 'npc-9', gameId: 9, kind: '人物', name: '入队同伴' },
      ],
      itemStats: { attributes: { 2: { name: '气血上限', scale: 1, unit: '点' } } },
    },
  );
  const { flow, codex, effects } = await views(f.index);
  const state = f.project([
    { id: 100, step: 1 },
    { id: 101, step: 1 },
  ]);
  const before = JSON.stringify({ index: f.index, state });
  const questEntry = f.index.world.quests.find((row) => row.gameId === 101);
  const source = codex.quest(f.index, questEntry);
  const expected = effects.effectList(f.index, actions, questEntry);
  for (const compact of [false, true]) {
    const html = flow.panel(state, { compact });
    for (const effect of expected) {
      assert(source.includes(effect), effect);
      assert(html.includes(effect), effect);
    }
    assert.match(html, /data-picture="item-cache_A"/);
    assert.match(html, /data-picture="skill-7"/);
    assert.equal((html.match(/data-flow-native-choice="101"/g) || []).length, 1);
    const visible = visibleText(html);
    assert.match(visible, /从任务列表移除/);
    assert.match(visible, /离队同伴.*离队/);
    assert.match(visible, /气血上限.*-5/);
    assert.match(visible, /交谈 101.*失败/);
    assert.match(visible, /选择「接受考验」/);
    assert.doesNotMatch(visible, /铜钱 \+111|铜钱 \+222|武学点 \+17|学会/);
    assert.doesNotMatch(html, /铜钱 \+333|铜钱 \+444|铜钱 \+666|完美线|永久|正在.*选择/);
  }
  assert.equal(JSON.stringify({ index: f.index, state }), before);
});

test('a curated decision deduplicates its exact step while another same-family same-label choice remains visible', async () => {
  const f = fixture({
    101: detail([choice('答应', [{ type: 'CMoney', id: 1, value: 111 }]), choice('拒绝', [])]),
    102: detail([
      choice('答应', [{ type: 'CMoney', id: 1, value: 222 }]),
      choice('拒绝', [{ type: 'CQuestStep', id: 102, value: 2 }]),
    ]),
  });
  const { flow } = await views(f.index);
  const state = f.project([
    { id: 100, step: 1 },
    { id: 101, step: 1 },
    { id: 102, step: 1 },
  ]);
  state.decisions = [
    {
      id: 'curated',
      questId: 100,
      name: '合成调查',
      decisionSteps: [101],
      warning: '既有推荐',
      choices: [
        { label: '答应', effect: '已核对' },
        { label: '拒绝', effect: '保持原样' },
      ],
    },
  ];
  for (const compact of [false, true]) {
    const html = flow.panel(state, { compact });
    assert(!hasNative(html, 101));
    assert(hasNative(html, 102));
    assert.match(html, /铜钱 \+222/);
    assert.doesNotMatch(html, /铜钱 \+111/);
    assert.match(visibleText(html), /选择「拒绝」.*交谈 102.*失败/);
  }
});

test('important consequences in additional active tasks remain visible through the existing task folds', async () => {
  const f = fixture({});
  const records = [];
  for (const root of [200, 300, 400, 500]) {
    f.index.world.quests.push(quest(root, 0, `合成任务 ${root}`), quest(root + 1, root, `当前行动 ${root}`));
    records.push({ id: root, step: 1 }, { id: root + 1, step: 1 });
  }
  f.index.codex.quests[501] = detail([
    choice('继续', [{ type: 'CQuestStep', id: 501, value: 2 }]),
    choice('稍后', []),
  ]);
  const project = createFlowProjector({
    world: f.index.world,
    game: { entries: [] },
    guide: { rules: [], sources: {} },
  }).flowSnapshot;
  const state = project(profile, reference(records));
  const { flow } = await views(f.index);
  for (const compact of [false, true]) {
    const visible = visibleText(flow.panel(state, { compact }));
    assert.match(visible, /选择「继续」.*当前行动 500.*失败/);
  }
});

test('bare progression, indistinguishable effects and unrenderable internal actions create no empty choice cards', async () => {
  const f = fixture({
    101: detail([
      choice('继续', [{ type: 'JumpStep', id: 101, value: 4 }]),
      choice('稍后', [{ type: 'CQuestStep', id: 102, value: 1 }]),
    ]),
    102: detail([
      choice('答应', [{ type: 'CMoney', id: 1, value: 100 }]),
      choice('同意', [{ type: 'CMoney', id: 1, value: 100 }]),
    ]),
    103: detail([
      choice('放弃', [{ type: 'RQuest', id: 9999, value: 0 }]),
      choice('拒绝', [{ type: 'FutureComposite', id: 1, value: 999 }]),
    ]),
  });
  f.index.codex.hiddenSteps[9999] = { relatedQuestId: 100, ownerId: 100 };
  const { flow } = await views(f.index);
  const state = f.project([{ id: 100, step: 1 }, ...[101, 102, 103].map((id) => ({ id, step: 1 }))]);
  for (const compact of [false, true]) {
    const html = flow.panel(state, { compact });
    assert.doesNotMatch(html, /data-flow-native-choice|FutureComposite|从任务列表移除|后续变化待核对/);
  }
});

test('unknown removal/failure targets do not become root outcomes when another option has a known effect', async () => {
  const f = fixture({
    101: detail([
      choice('留下', [{ type: 'CMoney', id: 1, value: 100 }]),
      choice('离开', [
        { type: 'RQuest', id: 9999, value: 0 },
        { type: 'CQuestStep', id: 9999, value: 2 },
      ]),
    ]),
  });
  f.index.codex.hiddenSteps[9999] = { relatedQuestId: 100, ownerId: 100 };
  const { flow } = await views(f.index);
  const state = f.project([
    { id: 100, step: 1 },
    { id: 101, step: 1 },
  ]);
  const html = flow.panel(state);
  assert(hasNative(html, 101));
  assert.match(html, /后续变化待核对/);
  assert.doesNotMatch(html, /从任务列表移除|→ 失败|quest-9999|data-flow-choice-consequence/);
});

test('hidden tables need an engine-recognized activity contract and never attach every hidden choice to an active root', async () => {
  const f = fixture({});
  f.index.codex.hiddenSteps[202] = {
    ...detail([choice('交付', [{ type: 'CMoney', id: 1, value: 500 }]), choice('稍后', [])]),
    ownerId: 100,
    relatedQuestId: 100,
  };
  const { flow } = await views(f.index);
  const records = [
    { id: 100, step: 1 },
    { id: 202, step: 1 },
  ];
  assert(!hasNative(flow.panel(f.project(records)), 202));
  const project = createFlowProjector({
    world: f.index.world,
    game: { entries: [] },
    guide: { rules: [], sources: {}, pickupQuests: [quest(202, 100, '合成的已核对活动步骤')] },
  }).flowSnapshot;
  assert(hasNative(flow.panel(project(profile, reference(records))), 202));
  assert(!hasNative(flow.panel(project(profile, reference([{ id: 100, step: 1 }]))), 202));
});

test('tracked hidden option facts require actual state 1, a canonical owner path and an explicitly active root', async () => {
  const f = fixture({ 101: detail([]) });
  f.index.codex.hiddenSteps[202] = {
    ...detail([choice('交付', [{ type: 'CMoney', id: 1, value: 500 }]), choice('稍后', [])]),
    ownerId: 101,
    ownerPath: [101, 100],
    relatedQuestId: 101,
  };
  const { flow } = await views(f.index);
  const saved = [
    { id: 100, step: 1 },
    { id: 101, step: 4 },
    { id: 202, step: 1 },
  ];
  for (const compact of [false, true]) {
    const current = f.project(saved, { trackingQuest: 202 });
    assert.equal(current.active[0].rootState, 1);
    assert(hasNative(flow.panel(current, { compact }), 202));
    assert(!hasNative(flow.panel(f.project(saved), { compact }), 202), 'untracked hidden steps stay unknown');
    for (const step of [undefined, 0, 2, 3, 4]) {
      const records = [
        ...(step === undefined ? [] : [{ id: 100, step }]),
        { id: 101, step: 1 },
        { id: 202, step: 1 },
      ];
      assert(
        !hasNative(flow.panel(f.project(records, { trackingQuest: 202 }), { compact }), 202),
        `root state ${step}`,
      );
    }
    for (const step of [undefined, 0, 2, 3, 4]) {
      const records = [{ id: 100, step: 1 }, ...(step === undefined ? [] : [{ id: 202, step }])];
      assert(
        !hasNative(flow.panel(f.project(records, { trackingQuest: 202 }), { compact }), 202),
        `hidden state ${step}`,
      );
    }
    assert.doesNotThrow(() =>
      flow.panel(
        f.project(
          [
            { id: 100, step: 1 },
            { id: 999999, step: 1 },
          ],
          { trackingQuest: 999999 },
        ),
        { compact },
      ),
    );
  }
  const foreign = structuredClone(f.index);
  foreign.codex.hiddenSteps[202].relatedQuestId = 999999;
  const foreignView = (await views(foreign)).flow;
  assert(!hasNative(foreignView.panel(f.project(saved, { trackingQuest: 202 })), 202));
});

test('explicit hidden coverage deduplicates only its own step, with provenance checked against native contracts', async () => {
  const contracts = require('../src/data/live-choice-contracts.json').contracts;
  const index = encyclopedia();
  for (const rule of guide.rules)
    for (const id of rule.coveredChoiceSteps || []) {
      const hidden = index.codex.hiddenSteps[id];
      assert(hidden, String(id));
      assert.equal(hidden.ownerPath[0], hidden.ownerId);
      assert(hidden.ownerPath.includes(hidden.relatedQuestId));
      assert.equal(hidden.relatedQuestId, rule.questId);
      assert(
        contracts.some(
          (contract) =>
            contract.ruleId === rule.id && contract.questId === id && contract.rootQuestId === rule.questId,
        ),
      );
    }
  const f = fixture({});
  for (const id of [202, 203])
    f.index.codex.hiddenSteps[id] = {
      ...detail([choice('答应', [{ type: 'CMoney', id: 1, value: id }]), choice('拒绝', [])]),
      ownerId: 100,
      ownerPath: [100],
      relatedQuestId: 100,
    };
  const { flow } = await views(f.index);
  const state = f.project(
    [
      { id: 100, step: 1 },
      { id: 202, step: 1 },
      { id: 203, step: 1 },
    ],
    { trackingQuest: 202, trackingMainQuest: 203 },
  );
  state.decisions = [
    {
      id: 'curated',
      questId: 100,
      name: '合成调查',
      coveredChoiceSteps: [202],
      warning: '已核对推荐',
      choices: [
        { label: '答应', effect: '已核对' },
        { label: '拒绝', effect: '保持原样' },
      ],
    },
  ];
  for (const compact of [false, true]) {
    const html = flow.panel(state, { compact });
    assert(!hasNative(html, 202));
    assert(hasNative(html, 203));
  }
});

test('canonical tracked hidden attribute costs are visible without summing or predicting dispatched follow-up rewards', async () => {
  const index = encyclopedia();
  const { flow } = await views(index);
  const uncurated = createFlowProjector({ world, game, guide: { sources: {}, rules: [] } }).flowSnapshot;
  const state = uncurated(
    profile,
    reference(
      [
        { id: 11447, step: 1 },
        { id: 11455, step: 1 },
      ],
      { trackingQuest: 11455 },
    ),
  );
  for (const compact of [false, true]) {
    const html = flow.panel(state, { compact });
    assert(hasNative(html, 11455));
    assert.match(visibleText(html), /气血上限.*-2/);
    assert.doesNotMatch(html, /永久.*扣|永远|完美线/);
  }
  const hiddenProgression = uncurated(
    profile,
    reference(
      [
        { id: 5074, step: 1 },
        { id: 5078, step: 1 },
      ],
      { trackingQuest: 5078 },
    ),
  );
  assert(
    !hasNative(flow.panel(hiddenProgression), 5078),
    'weapon rewards occur in later rows, not in this option action list',
  );
});

test('canonical choices use only their own actions and preserve all existing curated decisions', async () => {
  const index = encyclopedia();
  const { flow, effects } = await views(index);
  const uncurated = createFlowProjector({ world, game, guide: { sources: {}, rules: [] } }).flowSnapshot;
  for (const id of [11080, 11303, 11430, 11453, 11456, 11612, 11821, 13416]) {
    const q = world.quests.find((row) => row.gameId === id);
    const records = [
      { id: q.parentId, step: 1 },
      { id, step: 1 },
    ];
    const state = uncurated(profile, reference(records));
    const choices = effects.choiceRows(index, index.codex.quests[id], q);
    assert(choices.length, String(id));
    for (const compact of [false, true]) {
      const html = flow.panel(state, { compact });
      assert(hasNative(html, id), String(id));
      for (const row of choices) for (const change of row.changes) assert(html.includes(change), change);
      assert.doesNotMatch(html, /永久不能重接|永久.*扣|完美线/);
      if (id === 11080) {
        assert.match(visibleText(html), /选择「不行不行」.*相思.*失败/);
        assert.doesNotMatch(visibleText(html), /整条.*失败|永久失败/);
      }
    }
    const curated = flowSnapshot(profile, reference(records));
    for (const decision of curated.decisions.filter((row) => row.decisionSteps?.includes(id))) {
      const html = flow.panel(curated);
      assert(html.includes(`data-flow-decision="${decision.id}"`));
      assert(!hasNative(html, id), `${id}: curated exact-step coverage`);
      if (decision.recommendation?.reasonBrief) assert(html.includes('flow-reason-brief'));
    }
  }
  const state = uncurated(
    profile,
    reference([
      { id: 11427, step: 1 },
      { id: 11430, step: 1 },
    ]),
  );
  const html = flow.panel(state);
  assert.match(html, /萧家食录/);
  assert.doesNotMatch(html, /二十四气馄饨/);
  assert.equal(guide.rules.filter((row) => row.recommendation?.reasonBrief).length, 17);
});

test('an unreadable or disabled reference clears previous native choices instead of retaining a prior selection', async () => {
  const index = encyclopedia();
  const { flow } = await views(index);
  const records = [
    { id: 11388, step: 1 },
    { id: 11392, step: 1 },
  ];
  assert(hasNative(flow.panel(flowSnapshot(profile, reference(records))), 11392));
  for (const state of [
    flowSnapshot(profile, null, '读取失败'),
    flowSnapshot({ ...profile, referenceMode: 'none' }, reference(records)),
    flowSnapshot({ ...profile, referenceMode: 'slot', saveSlot: '1.sav' }, reference(records)),
  ])
    for (const compact of [false, true]) assert(!hasNative(flow.panel(state, { compact }), 11392));
});

test('routine single-option rewards stay in codex while a single-option cost remains visible', async () => {
  const f = fixture({
    101: detail([choice('收下', [{ type: 'CMoney', id: 1, value: 100 }])]),
    102: detail([choice('交付', [{ type: 'CMoney', id: 1, value: -500 }])]),
  });
  const { flow, codex } = await views(f.index);
  const state = f.project([
    { id: 100, step: 1 },
    { id: 101, step: 1 },
    { id: 102, step: 1 },
  ]);
  const html = flow.panel(state, { compact: true });
  assert(!hasNative(html, 101));
  assert.match(
    codex.quest(
      f.index,
      f.index.world.quests.find((q) => q.gameId === 101),
    ),
    /铜钱 \+100/,
  );
  assert(hasNative(html, 102));
  assert.match(visibleText(html), /选择「交付」.*铜钱 -500/);
});

test('a named hidden choice does not also appear as unidentified while unrelated unknown records remain', async () => {
  const index = encyclopedia(),
    { flow } = await views(index);
  const state = flowSnapshot(
    profile,
    reference(
      [
        { id: 11124, step: 1 },
        { id: 11126, step: 1 },
        { id: 999999, step: 1 },
      ],
      { trackingQuest: 11126 },
    ),
  );
  for (const compact of [false, true]) {
    const html = flow.panel(state, { compact });
    assert(hasNative(html, 11126));
    assert.match(html, /另有 1 条进行中记录待识别/);
    assert.doesNotMatch(html, /另有 2 条进行中记录待识别/);
  }
});

test('ending a parent investigation in one alternative is explicit in flow and codex, while ordinary completion stays quiet', async () => {
  const index = encyclopedia(),
    { flow, codex, effects } = await views(index);
  const state = flowSnapshot(
    profile,
    reference([
      { id: 11388, step: 1 },
      { id: 11392, step: 1 },
    ]),
  );
  const quest = index.world.quests.find((row) => row.gameId === 11392);
  for (const compact of [false, true]) {
    const html = flow.panel(state, { compact });
    assert.match(visibleText(html), /选择「不说算了」.*周家纠葛.*就此结束/);
    assert.doesNotMatch(visibleText(html), /永久|不能重接/);
  }
  assert.match(codex.quest(index, quest), /周家纠葛.*就此结束/);
  const ordinary = effects.choiceRows(
    index,
    {
      choices: [
        choice('继续', [{ type: 'CQuestStep', id: 11388, value: 4 }]),
        choice('前进', [{ type: 'CQuestStep', id: 11388, value: 4 }]),
      ],
    },
    quest,
  );
  assert.deepEqual(ordinary, []);
});

test('other simultaneous curated decisions show their consequences without expanding every card', async () => {
  const index = encyclopedia(),
    { flow } = await views(index);
  const state = flowSnapshot(
    profile,
    reference(
      [
        { id: 11427, step: 1 },
        { id: 11430, step: 1 },
        { id: 11272, step: 1 },
        { id: 11276, step: 1 },
        { id: 13415, step: 1 },
        { id: 13416, step: 1 },
      ],
      { trackingQuest: 11430 },
    ),
  );
  const html = flow.panel(state, { compact: true });
  assert.equal(state.decisions[0].id, 'gusu-wonton-food-record-choice');
  assert.match(visibleText(html), /就此作罢.*移除本任务及关联步骤/);
  assert.match(visibleText(html), /赤血珊瑚/);
  assert.match(html, /data-flow-secondary-decision="murder-clue-continue-choice"/);
  assert.match(html, /<details data-persist-detail="compact-more-choices"><summary>/);
});
