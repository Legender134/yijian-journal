'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { flowSnapshot } = require('../src/core/flow.cjs');
const { project } = require('../scripts/build-live-choice-contracts.cjs');
const profile = { id: 'native-contract-synthetic', referenceMode: 'latest' };
const match = (questId, options) =>
  flowSnapshot(profile, null, '', {
    dialogue: {
      schema: 1,
      sequence: 1,
      questId,
      npcId: 0,
      options: options.map((text, i) => ({ index: i + 1, text })),
    },
  });

// Literal pinned game options, not generated from walkthrough labels or the
// production contract JSON. This catches a wrong hidden row or a guide heading
// substituted for a real button even when renderer tests still look correct.
const packets = [
  [12406, 'mowen-thankyou-gift-choice', ['剑', '茶', '棋盘']],
  [5078, 'early-jingyin-weapon-choice', ['剑系武器', '拳系武器', '刀系武器']],
  [5826, 'chengyu-stay-choice', ['赞成留下程钰', '同意把人送走']],
  [11005, 'early-woodcutter-axe-choice', ['买把新的比较好', '重新锻造一番吧']],
  [11061, 'early-sun-homesickness-choice', ['先生倒是豁达', '趁着还硬朗，回去看看吧']],
  [8553, 'changsheng-formation-choice', ['三人赴战', '孤身赴战', '多人赴战']],
  [8861, 'changsheng-rescue-choice', ['置之不理', '出手相救']],
  [8867, 'changsheng-rescue-choice', ['置之不理', '出手相救']],
  [21132, 'yanfu-investigation-choice', ['继续调查', '放弃调查']],
  [21141, 'yanfu-investigation-choice', ['继续调查', '放弃调查']],
  [22132, 'cold-wuqing-night-choice', ['矢志于此', '不负己心']],
  [24063, 'tianji-rebuild-choice', ['重建天机宫', '回绝此事']],
  [24070, 'tianji-rebuild-choice', ['重建天机宫', '回绝此事']],
  [12297, 'kongliang-choice', ['帮助孔亮', '袖手旁观']],
  [12079, 'chenlinxi-critical-choice', ['好言相劝', '义正辞严']],
];
test('proved native hidden rows match actual short buttons without a public world-index row or guessed speaker', () => {
  for (const [questId, id, options] of packets) {
    const flow = match(questId, options);
    assert.equal(flow.liveDialogue.matched, true, String(questId));
    assert.equal(flow.decisions[0].id, id);
    assert.deepEqual(
      flow.decisions[0].choices.map((row) => row.label),
      options,
    );
    assert.deepEqual(
      flow.decisions[0].choices.map((row) => row.index),
      options.map((_, i) => i + 1),
    );
    assert.equal(match(questId, options.slice(0, -1)).liveDialogue?.matched, false);
    assert.equal(match(questId, [...options, '陌生选项']).liveDialogue.matched, false);
  }
  const weapon = match(5078, ['剑系武器', '拳系武器', '刀系武器']).decisions[0];
  assert.match(weapon.choices[1].effect, /化功绵掌/);
  assert.match(weapon.choices[2].effect, /霹雳霸刀/);
  const rescued = match(8861, ['置之不理', '出手相救']).decisions[0];
  assert.match(rescued.choices[0].effect, /油尽灯枯/);
});
test('coarse guide nodes, multi-step route headings and unproved confirmation windows do not become native contracts', () => {
  for (const [questId, options] of [
    [11004, ['买把新的比较好', '重新锻造一番吧']],
    [5076, ['剑系武器', '拳系武器', '刀系武器']],
    [12078, ['好言相劝', '义正辞严']],
    [8536, ['三人赴战', '孤身赴战', '多人赴战']],
    [24062, ['重建天机宫', '回绝此事']],
    [8595, ['确定单人赴战', '再想想']],
    [13001, ['先调查牢房并救兆成', '直接前往一线天']],
  ]) {
    assert.equal(match(questId, options).liveDialogue.matched, false, String(questId));
    assert.deepEqual(match(questId, options).decisions, []);
  }
});
test('the narrow contract builder rejects conditional, incomplete and mismatched-root mappings', () => {
  const base = {
    schema: 1,
    build: '21798996',
    pins: {},
    contracts: [
      {
        ruleId: 'early-woodcutter-axe-choice',
        questId: 11005,
        rootQuestId: 11002,
        npcPolicy: 'contextual',
        options: [
          { text: '买把新的比较好', choiceIndex: 0, requirements: [] },
          { text: '重新锻造一番吧', choiceIndex: 1, requirements: [] },
        ],
      },
    ],
  };
  assert.equal(project(base).contracts.length, 1);
  for (const change of [
    (row) => {
      row.build = 'unknown';
    },
    (row) => {
      row.contracts[0].rootQuestId = 11004;
    },
    (row) => {
      row.contracts[0].options[0].choiceIndex = 1;
    },
    (row) => {
      row.contracts[0].options[0].requirements = [{ Type: 'Friendliness', Num: 70 }];
    },
  ]) {
    const row = structuredClone(base);
    change(row);
    assert.throws(() => project(row));
  }
});
