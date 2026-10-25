'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { project } = require('../scripts/build-codex-details.cjs');
const source = require('../scripts/codex-opening-choice-outcomes.json');
const codex = require('../src/data/codex-details.json');
const { encyclopedia } = require('../src/core/game-data.cjs');
const { flowSnapshot } = require('../src/core/flow.cjs');
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );
const helpers = {
  esc,
  act: (action, label, _className, id) =>
    `<button data-action="${action}" data-id="${esc(id)}">${label}</button>`,
};
const cases = [
  [5079, 1000, 312, 1008, 13155],
  [5080, 4000, 311, 4008, 13465],
  [5081, 2000, 310, 2008, 13255],
];
const sequenceCount = (data) =>
  [...Object.values(data.quests), ...Object.values(data.hiddenSteps)].reduce(
    (sum, detail) => sum + (detail.sequenceOutcomes?.length || 0),
    0,
  );

test('opening choices separate their initial weapon from the exact two-item chest variant and retain actual instance provenance', () => {
  assert.equal(sequenceCount(codex), 6);
  assert.equal(codex.gatherSources.length, 3);
  for (const [questId, initial, gatherId, equipment, manual] of cases) {
    const step = codex.hiddenSteps[questId];
    assert.equal(step.relatedQuestId, 5074);
    assert.equal(step.sequenceOutcomes.length, 1);
    assert.deepEqual(step.sequenceOutcomes[0].actions, [{ type: 'CItem', id: initial, value: 1 }]);
    assert.deepEqual(step.sequenceOutcomes[0].source.requirements, [
      { type: 'PreQuest', id: questId, value: 1 },
    ]);
    assert(
      step.finish.every((actions) => !actions.some((action) => ['CItem', 'ASkill'].includes(action.type))),
    );
    const chest = codex.gatherSources.find((chest) => chest.gatherId === gatherId);
    assert.equal(chest.selectionQuestId, questId);
    assert.equal(chest.placeId, 'place-14');
    assert.equal(chest.relatedQuestId, 5176);
    assert.deepEqual(
      chest.actions,
      [equipment, manual].map((id) => ({ type: 'CItem', id, value: 1 })),
    );
    assert.equal(chest.source.kind, 'owned-installed-game-level-gather');
    assert.equal(chest.source.selection.requiredState, 4);
    assert.equal(chest.source.selection.ubergraphEntry, 81);
    assert.equal(chest.source.actor.defId, gatherId);
    assert.match(chest.source.actor.guid, /^\{[0-9A-F-]+\}$/);
    assert.equal(chest.source.collection.typeId, 6);
    assert.equal(chest.source.collection.postGather.ifState, 1);
    assert.equal(chest.source.collection.postGather.finishedAction.id, 5178);
    for (const member of chest.source.members) assert.match(member.sha256, /^[a-f0-9]{64}$/);
  }
});

function fixture() {
  const roots = [
    { QuestId: 5074, OwnerQuestId: 0, Name: '洞口主线' },
    { QuestId: 5176, OwnerQuestId: 0, Name: '山寨主线' },
  ];
  const selection = {
    QuestId: 5078,
    OwnerQuestId: 5074,
    Name: null,
    Blueprint: { AssetPath: { AssetName: 'None' } },
  };
  for (const step of source.steps) {
    selection['OptionText' + step.choice.index] = step.choice.text;
    selection['OptionActions' + step.choice.index] = step.choice.actions.map((action) => ({
      Type: 'EActionType::' + action.type,
      Id: action.id,
      Num: action.value,
    }));
  }
  const steps = source.steps.map((step) => ({
    QuestId: step.questId,
    OwnerQuestId: step.ownerId,
    Name: step.name,
    Blueprint: { AssetPath: { AssetName: step.blueprint } },
    FinishSequence: { AssetPath: { AssetName: step.finishSequence } },
  }));
  const collection = source.collectionIdentity.steps.map((step) => ({
    QuestId: step.questId,
    OwnerQuestId: step.ownerId,
    Name: step.name,
    Blueprint: { AssetPath: { AssetName: step.blueprint } },
    ...(step.questId === 5179
      ? Object.fromEntries(
          ['FinishedActions', 'FinishedActionsForDifficulty', 'FinishedActionsForHell'].map((key) => [
            key,
            [{ Type: 'EActionType::CQuestStep', Id: 5178, Num: 4 }],
          ]),
        )
      : {}),
  }));
  return {
    rows: [...roots, selection, ...steps, ...collection],
    game: { build: source.build, entries: [] },
    world: {
      maps: [{ id: 'place-14', key: 'LV_23_P' }],
      quests: roots.map((root) => ({
        id: 'quest-' + root.QuestId,
        gameId: root.QuestId,
        parentId: 0,
        name: root.Name,
      })),
    },
  };
}

test('builder gates opening projections on the exact choice dispatch, unique identities, map and collection follow-up without fabricating missing rows', () => {
  const input = fixture(),
    before = structuredClone(input);
  const run = (rows = input.rows, game = input.game, world = input.world) => project(rows, [], game, world);
  assert.equal(sequenceCount(run()), 3);
  assert.equal(run().gatherSources.length, 3);
  assert.deepEqual(input, before);
  for (const patch of [
    { Name: '另一段剧情' },
    { OwnerQuestId: 999999 },
    { Blueprint: { AssetPath: { AssetName: '/Game/Other.Other_C' } } },
    { FinishSequence: { AssetPath: { AssetName: '/Game/Other.Other' } } },
  ]) {
    const changed = input.rows.map((row) => (row.QuestId === 5079 ? { ...row, ...patch } : row));
    assert.equal(sequenceCount(run(changed)), 2);
    assert(!run(changed).gatherSources.some((chest) => chest.selectionQuestId === 5079));
  }
  for (const patch of [
    { OptionText1: '改选' },
    { OptionActions1: [] },
    { OptionActions1: [{ Type: 'EActionType::CQuestStep', Id: 5079, Num: 4 }] },
  ]) {
    const changed = input.rows.map((row) => (row.QuestId === 5078 ? { ...row, ...patch } : row));
    assert.equal(sequenceCount(run(changed)), 2);
    assert.equal(run(changed).gatherSources.length, 2);
  }
  for (const id of [5078, 5079]) {
    const changed = input.rows.filter((row) => row.QuestId !== id);
    assert.equal(sequenceCount(run(changed)), id === 5078 ? 0 : 2);
    assert(!run(changed).hiddenSteps[5079]?.sequenceOutcomes);
    assert(
      !run([...input.rows, structuredClone(input.rows.find((row) => row.QuestId === id))]).hiddenSteps[5079]
        ?.sequenceOutcomes,
    );
  }
  assert.equal(run(input.rows, { ...input.game, build: 'other' }).gatherSources, undefined);
  assert.equal(sequenceCount(run(input.rows, { ...input.game, build: 'other' })), 0);
  assert.equal(
    run(input.rows, input.game, { ...input.world, maps: [{ id: 'place-14', key: 'OTHER' }] }).gatherSources,
    undefined,
  );
  assert.equal(run(input.rows.filter((row) => row.QuestId !== 5178)).gatherSources, undefined);
  assert.equal(
    run(input.rows.map((row) => (row.QuestId === 5179 ? { ...row, FinishedActionsForHell: [] } : row)))
      .gatherSources,
    undefined,
  );
});

test('shared codex drawers show initial weapons and conditional chest items through public navigation without promising receipt or directly teaching the book', async () => {
  const { createCodexDetailViews } = await import('../src/renderer/codex-detail-views.js');
  const index = encyclopedia(),
    views = createCodexDetailViews(helpers);
  const opening = index.world.quests.find((quest) => quest.gameId === 5074);
  const rescue = index.world.quests.find((quest) => quest.gameId === 5176);
  const weapons = views.quest(index, opening, null),
    chest = views.quest(index, rescue, null);
  for (const [questId, initial, gatherId, equipment, manual] of cases) {
    assert.match(weapons, new RegExp(`data-quest-step="${questId}"`));
    assert.match(weapons, new RegExp(`data-id="item-${initial}"`));
    assert.match(chest, new RegExp(`data-gather-id="${gatherId}"`));
    for (const id of [equipment, manual]) {
      assert.match(chest, new RegExp(`data-id="item-${id}"`));
      const item = views.item(
        index,
        index.entries.find((entry) => entry.id === `item-${id}`),
      );
      assert.match(item, /宝箱获取/);
      assert.match(item, /data-id="place-14"/);
      assert.match(item, new RegExp(`data-gather-id="${gatherId}"`));
      assert.match(item, /开山寨宝箱 ×1/);
    }
    assert.match(
      views.item(
        index,
        index.entries.find((entry) => entry.id === `item-${initial}`),
      ),
      /data-id="quest-5074"/,
    );
  }
  assert.doesNotMatch(
    chest.slice(chest.indexOf('<details class="detail-block codex-chest-outcomes"')),
    /学会|已领取|已获得|胜利获得|\+3<|data-id="quest-517[89]"|SHA|LV_23|DefId/,
  );
  assert.equal(views.quest(index, rescue, { metadata: { quests: [{ id: 5178, step: 4 }] } }), chest);
  for (const id of [155, 255, 465])
    assert.doesNotMatch(
      views.skill(
        index,
        index.entries.find((entry) => entry.id === `skill-${id}`),
      ),
      /skill-story-sources/,
    );
});

test('flow option rewards resolve all three exact item images and manuals instead of their same-name martial arts in both presentations', async () => {
  const { createEntityReferences } = await import('../src/renderer/entity-references.js');
  const { createFlowViews } = await import('../src/renderer/flow-views.js');
  const index = encyclopedia();
  const refs = createEntityReferences({
    index: () => index,
    esc,
    picture: (id) => `<img data-picture="${esc(id)}">`,
    icon: () => '',
    qualityText: { html: (_id, label) => label },
  });
  const flow = flowSnapshot(
    { id: 'choice', referenceMode: 'latest' },
    {
      name: 'Synthetic.sav',
      hash: 'synthetic',
      metadata: {
        inventory: [],
        quests: [
          { id: 5074, step: 1 },
          { id: 5076, step: 4 },
        ],
        trackingMainQuest: 5074,
      },
    },
  );
  const choice = flow.decisions.find((row) => row.id === 'early-jingyin-weapon-choice');
  assert(choice);
  const view = createFlowViews({
    ...helpers,
    act: refs.button,
    icon: () => '',
    pill: esc,
    when: () => '',
    richText: (value, targets) => refs.text(value, 'world-quest', targets),
  });
  assert.doesNotMatch(view.choice(choice), /data-id="name:惊雷剑法"/);
  for (const html of [view.choice(choice), view.panel(flow)]) {
    const options = html.match(
      /<dl class="flow-choices">[\s\S]*?<\/dl>|<div class="flow-choices">[\s\S]*?<\/div>/,
    )?.[0];
    assert(options);
    for (const [_quest, initial, _gather, equipment, manual] of cases)
      for (const id of [initial, equipment, manual]) {
        assert.match(options, new RegExp(`data-id="item-${id}"`));
        assert.match(options, new RegExp(`data-picture="item-${id}"`));
      }
    assert.doesNotMatch(
      options,
      /data-id="skill-(?:155|255|465)"|data-id="name:(?:惊雷剑法|霹雳霸刀|化功绵掌)"/,
    );
  }
});
