'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { project } = require('../scripts/build-codex-details.cjs');
const blueprintSource = require('../scripts/codex-blueprint-outcomes.json');
const codex = require('../src/data/codex-details.json');
const { encyclopedia } = require('../src/core/game-data.cjs');
const cases = [
  [5242, 5317, 'Quest_5317', 'promotion-story-finished', '完成晋升剧情后'],
  [5304, 5323, 'Quest_5323', 'promotion-story-finished', '完成晋升剧情后'],
  [5850, 5858, 'Quest_5851', 'promotion-story-followup-finished', '完成晋升剧情及后续结算后'],
  [5980, 6261, 'Quest_5982', 'promotion-victory-dialogue-closed', '晋升比武胜利，结束结算对话后'],
];
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const helpers = {
  esc,
  act: (action, label, _cls, id) => `<button data-action="${action}" data-id="${esc(id)}">${label}</button>`,
};
const blueprintCount = (data) =>
  [...Object.values(data.quests), ...Object.values(data.hiddenSteps)].reduce(
    (n, detail) => n + (detail.blueprintOutcomes?.length || 0),
    0,
  );

test('four promotion effects retain their hidden identities, conditional paths and independent Blueprint provenance', () => {
  assert.equal(blueprintCount(codex), 4);
  assert.equal(codex.source.kind, 'owned-installed-game-static-tables');
  for (const [ownerId, id, stem, condition] of cases) {
    const detail = codex.hiddenSteps[id];
    assert.equal(detail.ownerId, ownerId);
    assert.equal(detail.relatedQuestId, ownerId);
    assert.deepEqual(detail.ownerPath, [ownerId]);
    assert.equal(detail.name, undefined);
    assert.equal(detail.blueprintOutcomes.length, 1);
    const outcome = detail.blueprintOutcomes[0];
    assert.equal(outcome.condition, condition);
    assert.deepEqual(outcome.actions, [{ type: 'CAttr', id: 45, value: 10 }]);
    assert.equal(outcome.source.kind, 'owned-installed-game-blueprint');
    assert.equal(outcome.source.build, '21798996');
    assert.equal(outcome.source.blueprint, `/Game/JH/Maps/WuDang/Quest/${stem}.${stem}_C`);
    assert.equal(outcome.source.target.npcId, 0);
    assert.equal(outcome.source.target.resourceName, 'Hero');
    assert.equal(outcome.source.native.attributeKey, 'MaxJingLi');
    assert.equal(outcome.source.native.operation, 'Additive');
    assert.equal(outcome.source.actionProgramSha256, codex.source.actionProgramSha256);
    assert.equal(outcome.source.engine, 'VER_UE4_26');
    for (const member of Object.values(outcome.source.members)) assert.match(member.sha256, /^[a-f0-9]{64}$/);
    for (const digest of Object.values(outcome.source.decoderLibraries))
      assert.match(digest, /^[a-f0-9]{64}$/);
    assert.match(outcome.source.decodedRawSha256, /^[a-f0-9]{64}$/);
    assert.match(outcome.source.expressionSizesSha256, /^[a-f0-9]{64}$/);
    assert(Number.isSafeInteger(outcome.source.excludedEntries.OnStop));
    assert(Number.isSafeInteger(outcome.source.excludedEntries.OnDlgSelectedOption));
    assert(!detail.finish.flat().some((a) => a.type === 'CAttr' && a.id === 45));
    assert(!detail.choices.some((choice) => choice.actions.some((a) => a.type === 'CAttr' && a.id === 45)));
    assert(
      !(detail.events || []).some((event) =>
        [...event.success, ...event.failure].some((a) => a.type === 'CAttr' && a.id === 45),
      ),
    );
  }
  const chair = codex.hiddenSteps[6261].blueprintOutcomes[0];
  assert.deepEqual(chair.source.normalPath, [995, 1022, 1774, 1952]);
  assert.deepEqual(chair.source.gates, {
    victoryEntries: [15, 1992],
    openDialogueOffset: 59,
    dialogueClosedEntry: 995,
  });
  assert.equal(chair.source.excludedEntries.defeat, 316);
  assert.deepEqual(codex.hiddenSteps[5858].finish, [[], [], []]);
});

test('the promotion overlay preserves all original difficulty-specific finish triples', () => {
  const expected = {
    5317: [
      ['JumpStep', 5244, 1],
      ['CQuestStep', 5316, 4],
      ['CQuestStep', 5245, 1],
      ['RTeam', 5029, 0],
      ['CItem', 10338, -1],
      ['CYHD', 5011, 5],
      ['AutoSaveData', 0, 0],
    ],
    5323: [
      ['JumpStep', 5331, 1],
      ['CQuestStep', 5322, 4],
      ['CItem', 10339, -1],
      ['CQuestStep', 5304, 4],
      ['CYHD', 5011, 5],
      ['AutoSaveData', 0, 0],
    ],
    6261: [
      ['JumpStep', 6264, 4],
      ['CQuestStep', 6263, 4],
      ['CQuestStep', 5991, 1],
      ['CItem', 10342, -1],
      ['CItem', 10343, 1],
      ['CQuestStep', 6252, 4],
      ['CQuestStep', 5980, 4],
      ['CQuestStep', 5984, 4],
      ['AutoSaveData', 0, 0],
    ],
    5858: [],
  };
  for (const [id, triples] of Object.entries(expected))
    assert.deepEqual(
      codex.hiddenSteps[id].finish,
      Array.from({ length: 3 }, () => triples.map(([type, id, value]) => ({ type, id, value }))),
    );
});

test('the builder adds a promotion only to its existing unique same-build row with the verified owner and Blueprint class', () => {
  for (const step of blueprintSource.steps) {
    const root = { QuestId: step.ownerId, OwnerQuestId: 0, Name: '公开晋升任务' };
    const other = { QuestId: step.ownerId + 100000, OwnerQuestId: 0, Name: '另一主线' };
    const world = {
      quests: [root, other].map((r) => ({
        gameId: r.QuestId,
        id: 'quest-' + r.QuestId,
        name: r.Name,
        parentId: 0,
      })),
    };
    const raw = {
      QuestId: step.questId,
      OwnerQuestId: step.ownerId,
      Name: null,
      Blueprint: { AssetPath: { AssetName: step.blueprint } },
      FinishedActions: [{ Type: 'EActionType::CMoney', Id: 0, Num: 1 }],
    };
    const game = { build: '21798996', entries: [] };
    const input = [root, other, raw],
      before = structuredClone(input);
    const correct = project(input, [], game, world);
    assert.equal(blueprintCount(correct), 1);
    assert.deepEqual(correct.hiddenSteps[step.questId].blueprintOutcomes[0].actions, [
      { type: 'CAttr', id: 45, value: 10 },
    ]);
    assert.deepEqual(input, before);
    assert.equal(
      blueprintCount(project([root, other], [], game, world)),
      0,
      'absent raw row is not fabricated',
    );
    for (const changed of [
      { ...raw, OwnerQuestId: other.QuestId },
      { ...raw, Blueprint: { AssetPath: { AssetName: step.blueprint.replace('_C', '_Other_C') } } },
      { ...raw, QuestId: step.questId + 100000 },
    ]) {
      const result = project([root, other, changed], [], game, world);
      assert.equal(blueprintCount(result), 0);
      assert.equal(
        result.hiddenSteps[changed.QuestId].finish[0][0].value,
        1,
        'unrelated table outcome remains',
      );
    }
    assert.equal(blueprintCount(project(input, [], { ...game, build: 'another-build' }, world)), 0);
    assert.equal(
      blueprintCount(project([...input, { ...raw }], [], game, world)),
      0,
      'ambiguous ID cannot acquire an outcome',
    );
    assert.equal(
      blueprintCount(project([raw], [], game, { quests: [] })),
      0,
      'missing owner chain cannot acquire a public association',
    );
  }
  assert.equal(
    blueprintCount(
      project(
        [{ QuestId: 10, OwnerQuestId: 0, Name: '合成任务' }],
        [],
        { build: '21798996', entries: [] },
        { quests: [{ gameId: 10, id: 'quest-10', name: '合成任务', parentId: 0 }] },
      ),
    ),
    0,
  );
});

test('each public promotion detail displays MaxJingLi +10 once with its real completion condition and no difficulty sum or saved-state claim', async () => {
  const { createCodexDetailViews } = await import('../src/renderer/codex-detail-views.js');
  const { itemEffectText } = await import('../src/renderer/item-stat-views.js');
  const { createWorldViews } = await import('../src/renderer/world-views.js');
  const index = encyclopedia(),
    view = createCodexDetailViews(helpers);
  const worldView = createWorldViews({
    ...helpers,
    pill: (label) => `<span>${esc(label)}</span>`,
    notice: esc,
    icon: () => '',
    iconButton: () => '',
    when: () => '',
    empty: () => '',
    picture: () => '',
  });
  assert.equal(index.itemStats.attributes[45].key, 'MaxJingLi');
  assert.deepEqual(itemEffectText({ type: 'CAttr', id: 45, value: 10 }, index.itemStats), {
    name: '精力上限',
    value: '+10 点',
  });
  for (const [ownerId, id, _stem, _condition, label] of cases) {
    const entry = index.world.quests.find((q) => q.gameId === ownerId);
    const html = view.quest(index, entry, null);
    assert.equal((html.match(/精力上限/g) || []).length, 1);
    assert.equal((html.match(/\+10 点/g) || []).length, 1);
    assert.equal((html.match(/<h4>晋升收益<\/h4>/g) || []).length, 1);
    assert.match(html, new RegExp(`data-quest-step="${id}"`));
    assert(html.includes(label));
    const promotion = html.match(/<section class="codex-promotion-outcome">[\s\S]*?<\/section>/)?.[0];
    assert(promotion);
    assert.doesNotMatch(
      promotion,
      /Blueprint|Quest_\d+|Build|SHA|原始步骤|动作偏移|未实机|以游戏为准|未证明/,
    );
    const player = html.replace(/<details><summary>资料来源<\/summary>[\s\S]*?<\/details>/g, '');
    assert.doesNotMatch(
      player,
      /Blueprint|Quest_\d+|source|SHA|未实机|以游戏为准|未证明|精力恢复|恢复精力|已写盘|本次已获得|\+30 点|\+40 点/,
    );
    assert.doesNotMatch(
      player,
      new RegExp(`quest-${id}(?:"|<)`),
      'hidden steps do not gain a public title/link',
    );
    assert.equal(
      view.quest(index, entry, { metadata: { quests: [{ id: ownerId, step: 4 }] } }),
      html,
      'root saved completion does not claim the script effect was granted',
    );
    const full = worldView.questDetail(index, entry.id, {}, true);
    assert.equal((full.match(/精力上限/g) || []).length, 1, 'full public detail retains the single gain');
    assert(full.includes(label));
  }
});
