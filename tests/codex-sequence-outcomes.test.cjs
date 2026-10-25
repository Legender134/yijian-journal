'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { project } = require('../scripts/build-codex-details.cjs');
const source = require('../scripts/codex-sequence-outcomes.json');
const codex = require('../src/data/codex-details.json');
const { encyclopedia } = require('../src/core/game-data.cjs');
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );
const helpers = {
  esc,
  act: (action, label, _className, id) =>
    `<button data-action="${action}" data-id="${esc(id)}">${label}</button>`,
  icon: () => '',
  iconButton: () => '',
  picture: () => '',
  pill: esc,
  notice: esc,
  empty: esc,
  qualityText: { quality: (entry) => entry.quality, label: () => '', name: (_entry, name) => esc(name) },
};
const count = (data) =>
  [...Object.values(data.quests), ...Object.values(data.hiddenSteps)].reduce(
    (sum, detail) => sum + (detail.sequenceOutcomes?.length || 0),
    0,
  );

test('opening story grants retain separate timeline events and do not become tutorial or three-difficulty rewards', () => {
  assert.equal(count(codex), 3);
  const jade = codex.hiddenSteps[5021];
  const heart = codex.hiddenSteps[5039];
  for (const detail of [jade, heart]) {
    assert.equal(detail.relatedQuestId, 5020);
    assert.deepEqual(detail.ownerPath, [5020]);
    assert.equal(detail.name, undefined);
    assert(detail.finish.every((actions) => actions.every((action) => action.type === 'JumpStep')));
    for (const event of detail.sequenceOutcomes) {
      assert.equal(event.source.kind, 'owned-installed-game-sequence');
      assert.equal(event.source.engine, 'VER_UE4_26');
      assert.equal(event.source.build, codex.build);
      assert.equal(event.source.actionProgramSha256, codex.source.actionProgramSha256);
      for (const member of event.source.members) assert.match(member.sha256, /^[a-f0-9]{64}$/);
    }
  }
  assert.deepEqual(
    jade.sequenceOutcomes.map((event) => event.actions),
    [[{ type: 'CItem', id: 8065, value: 1 }]],
  );
  assert.deepEqual(
    heart.sequenceOutcomes.map((event) => event.actions),
    [[{ type: 'CItem', id: 13850, value: 1 }], [{ type: 'ASkill', id: 850, value: 1 }]],
  );
  assert(heart.sequenceOutcomes[0].source.event.frame < heart.sequenceOutcomes[1].source.event.frame);
  for (const id of [5022, 5024, 5040, 5046])
    assert.equal((codex.hiddenSteps[id] || codex.quests[id])?.sequenceOutcomes, undefined);
});

test('sequence projection requires the exact existing quest, owner, class, name, Build and finish sequence', () => {
  for (const step of source.steps) {
    const root = { QuestId: step.ownerId, OwnerQuestId: 0, Name: '主线' };
    const world = {
      quests: [{ gameId: step.ownerId, id: `quest-${step.ownerId}`, name: '主线', parentId: 0 }],
    };
    const raw = {
      QuestId: step.questId,
      OwnerQuestId: step.ownerId,
      Name: step.name,
      Blueprint: { AssetPath: { AssetName: step.blueprint } },
      FinishSequence: { AssetPath: { AssetName: step.finishSequence } },
      FinishedActions: [{ Type: 'EActionType::CMoney', Id: 0, Num: 1 }],
    };
    const game = { build: source.build, entries: [] };
    const before = structuredClone(raw);
    const correct = project([root, raw], [], game, world);
    assert.equal(count(correct), step.outcomes.length);
    assert.deepEqual(
      correct.hiddenSteps[step.questId].sequenceOutcomes.map((event) => event.actions),
      step.outcomes.map((event) => event.actions),
    );
    assert.deepEqual(raw, before);
    assert.equal(count(project([root], [], game, world)), 0);
    for (const changed of [
      { ...raw, QuestId: raw.QuestId + 100000 },
      { ...raw, OwnerQuestId: raw.OwnerQuestId + 100000 },
      { ...raw, Name: '另一个步骤' },
      { ...raw, Blueprint: { AssetPath: { AssetName: '/Game/Other.Other_C' } } },
      { ...raw, FinishSequence: { AssetPath: { AssetName: `${step.finishSequence}_Other` } } },
      { ...raw, FinishSequence: undefined },
    ])
      assert.equal(count(project([root, changed], [], game, world)), 0);
    assert.equal(count(project([root, raw, structuredClone(raw)], [], game, world)), 0);
    assert.equal(count(project([root, raw], [], { ...game, build: 'other' }, world)), 0);
    assert.equal(count(project([raw], [], game, { quests: [] })), 0);
  }
});

test('public opening quest and item/skill drawers expose real sources without assuming current receipt or making hidden tasks navigable', async () => {
  const { createCodexDetailViews } = await import('../src/renderer/codex-detail-views.js');
  const { createGameViews } = await import('../src/renderer/game-views.js');
  const index = encyclopedia();
  const view = createCodexDetailViews(helpers);
  const root = index.world.quests.find((quest) => quest.gameId === 5020);
  const html = view.quest(index, root, null);
  assert.equal((html.match(/class="codex-sequence-outcome"/g) || []).length, 3);
  for (const id of ['item-8065', 'item-13850', 'skill-850'])
    assert.match(html, new RegExp(`data-id="${id}"`));
  assert.match(html, /开局在江吟风家中获赠/);
  assert.match(html, /夺回木剑后，回江家领取秘籍/);
  assert.match(html, /夺回木剑后，回江家接受江吟风传授/);
  assert.equal(view.quest(index, root, { metadata: { quests: [{ id: 5020, step: 4 }] } }), html);
  assert.doesNotMatch(
    html,
    /data-id="quest-(?:5021|5039)"|本次已获得|已领取|已学会|\+3<|LS_CG|Blueprint|SHA/,
  );
  const full = createGameViews(helpers);
  for (const [id, step, wording] of [
    ['item-8065', 5021, '开局在江吟风家中获赠 ×1'],
    ['item-13850', 5039, '夺回木剑后，回江家领取秘籍 ×1'],
    ['skill-850', 5039, '夺回木剑后，回江家接受江吟风传授'],
  ]) {
    const drawer = full.detail(index, id);
    assert.match(drawer, /data-id="quest-5020"/);
    assert.match(drawer, new RegExp(`data-quest-step="${step}"`));
    assert(drawer.includes(wording));
    assert.doesNotMatch(drawer, /data-id="quest-(?:5021|5039)"|LS_CG|Blueprint|本次已获得|已领取/);
  }
  const skill = full.detail(index, 'skill-850');
  assert.match(skill, /剧情传授/);
  assert.match(skill, /学习秘籍/);
  assert.equal((skill.match(/夺回木剑后，回江家接受江吟风传授/g) || []).length, 1);
  for (const id of [5024, 5046]) {
    const tutorial = index.world.quests.find((quest) => quest.gameId === id);
    assert.doesNotMatch(view.quest(index, tutorial, null), /codex-sequence-outcome/);
  }
});
