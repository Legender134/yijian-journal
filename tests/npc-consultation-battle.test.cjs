'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const rule = require('../scripts/npc-consultation-battle.json');
const contracts = require('../src/data/npc-interactions.json');
const { martialConsultation, martialConsultationHint } = require('../src/shared/martial-consultation.mjs');
const { createNpcProgressProjector } = require('../src/core/npc-progress.cjs');
const { project: build } = require('../scripts/build-npc-interactions.cjs');

test('native consultation quality and difficulty matrix stays separate from eligibility', () => {
  for (let grade = 1; grade <= 6; grade++) {
    for (const [name, value] of Object.entries(rule.difficultyValues)) {
      const method = grade >= 5 || (grade === 4 && name === 'Hell') ? 'battle' : 'direct';
      for (const difficulty of [name, value, 'EDifficultyMode::' + name])
        assert.deepEqual(martialConsultation(grade, difficulty, rule), { method, initialLevel: 1 });
    }
  }
  for (const difficulty of ['Normal', 'Difficult', 'EDifficultyMode::Normal'])
    assert.equal(martialConsultation(4, difficulty, rule).method, 'direct');
  for (const difficulty of [undefined, null, '4', 'HELL', 'Other::Hell', 9, -1, 4.5]) {
    assert.equal(martialConsultation(4, difficulty, rule).method, 'conditional');
    assert.equal(martialConsultation(5, difficulty, rule).method, 'battle');
    assert.equal(martialConsultation(3, difficulty, rule).method, 'direct');
  }
  for (const grade of [undefined, null, 0, 7, '5', 4.5])
    assert.equal(martialConsultation(grade, 'Hell', rule), null);
  assert.equal(martialConsultation(5, 'Hell'), null);
  assert.equal(martialConsultationHint(martialConsultation(4, null, rule)), '极难需比试');
});

test('public consultation rule pins the modern native and Blueprint victory path', () => {
  assert.deepEqual(contracts.martialConsultation, rule);
  assert.equal(rule.build, contracts.build);
  assert.equal(rule.source.exeSha256, contracts.source.exeSha256);
  assert.equal(rule.source.native.decision, '0x140fe77d0');
  assert.equal(rule.source.blueprint.event, 'BP_OnConsultSpell');
  assert.equal(rule.source.blueprint.winSettlement, 3268);
  assert.equal(rule.source.blueprint.lossReset, 3296);
  assert.equal(rule.victoryRequired, true);
  assert.equal(rule.settleConsultationOnVictory, true);
  assert.equal(rule.requestedSkillLevel, 1);
  assert.equal(rule.source.members.length, 8);
  assert.doesNotMatch(JSON.stringify(rule), /[A-Za-z]:\\|\/mnt\//);
});

function input() {
  return {
    schema: 1,
    source: structuredClone(contracts.source),
    people: Object.fromEntries(
      Object.entries(contracts.people).map(([id, r]) => [
        id,
        {
          compareRequirements: r.compareRequirements,
          bCantFighting: r.cannotFight,
          guildId: r.guildId,
        },
      ]),
    ),
    skills: Object.fromEntries(
      Object.entries(contracts.skills).map(([id, r]) => [
        id,
        {
          friendliness: r.friendliness,
          requirements: r.requirements,
          openForPlayer: r.openForPlayer,
          excludedFromNativeConsult: r.excluded,
          ConsultSExpCost: r.skillPointCost,
          grade: r.grade,
        },
      ]),
    ),
    friendlyLimits: {
      compareGlobalFriendliness: contracts.friendlyLimits.Compare,
      compare: contracts.compare,
      gift: contracts.gift,
      martialCost: contracts.martialCost,
      vigor: contracts.vigorCost,
    },
  };
}
test('builder rejects another executable or consultation system member before projection', () => {
  assert.deepEqual(build(input()), contracts);
  for (const mutate of [
    (r) => {
      r.source.exeSha256 = '0'.repeat(64);
    },
    (r) => {
      r.source.blueprints = r.source.blueprints.filter(
        (m) => !m.member.endsWith('/BP_ConsultSystem_Base.uexp'),
      );
    },
    (r) => {
      r.source.blueprints.find((m) => m.member.endsWith('/BP_ConsultSystem_Base.uasset')).sha256 = '0'.repeat(
        64,
      );
    },
  ]) {
    const raw = input();
    mutate(raw);
    assert.throws(() => build(raw), /consultation battle source mismatch/);
  }
});

const world = {
  people: [
    { id: 'npc-10', gameId: 10, name: '传授者', functions: ['Consult', 'Compare'], friendshipLocks: [] },
  ],
  quests: [],
  maps: [],
};
const game = {
  entries: Array.from({ length: 6 }, (_, i) => ({
    id: 'skill-' + (i + 1),
    gameId: i + 1,
    kind: '武学',
    name: '功法' + (i + 1),
  })),
};
const syntheticContracts = {
  friendlyLimits: { Compare: 20 },
  compare: { basis: 'raw', vigor: 10, talentVigor: 5 },
  people: { 10: { compareRequirements: [] } },
  martialConsultation: rule,
  skills: Object.fromEntries(
    game.entries.map((e) => [
      e.gameId,
      {
        grade: e.gameId,
        friendliness: 10 * (e.gameId + 3),
        requirements: [],
        openForPlayer: true,
        excluded: false,
        skillPointCost: 100,
      },
    ]),
  ),
};
const make = (c = syntheticContracts) => createNpcProgressProjector({ world, game, contracts: c });
function metadata(difficulty = 'Common') {
  return {
    difficulty,
    quests: [],
    inventory: [],
    combat: {
      format: 14,
      player: { skills: [], skillPoints: 1000, attributes: { 44: 60, 27: 1 } },
      npcStates: [
        {
          id: 10,
          rawFriendliness: 100,
          visible: true,
          inventory: [],
          skills: game.entries.map((e) => ({ id: e.gameId, level: 9 })),
          attributes: { 27: 3 },
        },
      ],
    },
  };
}
test('actual-state projection adds method without changing learning gates, costs or life teaching', () => {
  const { martialConsultation: unused, ...legacy } = syntheticContracts;
  for (const difficulty of ['Common', 'Hell', null]) {
    const data = metadata(difficulty),
      before = structuredClone(data);
    const result = make()(data);
    assert.equal(result.difficulty, difficulty);
    assert.equal(result.people[0].learning.length, 7);
    const methods = result.people[0].learning
      .filter((r) => r.kind === 'martial')
      .map((r) => r.consultation.method);
    assert.deepEqual(methods, [
      'direct',
      'direct',
      'direct',
      difficulty === 'Hell' ? 'battle' : difficulty === null ? 'conditional' : 'direct',
      'battle',
      'battle',
    ]);
    const withoutNew = structuredClone(result);
    delete withoutNew.difficulty;
    for (const key of ['people', 'learning', 'remaining', 'locked', 'cleared'])
      for (const p of withoutNew[key]) for (const item of p.learning) delete item.consultation;
    assert.deepEqual(withoutNew, make(legacy)(data));
    assert.deepEqual(data, before);
  }
});
test('battle method cannot promote missing resources, locked entries or already learned skills', () => {
  for (const [vigor, expected] of [
    [29, 'unmet'],
    [30, 'unknown'],
    [59, 'unknown'],
    [60, 'met'],
  ]) {
    const data = metadata('Hell');
    data.combat.player.attributes[44] = vigor;
    const row = make()(data).people[0];
    assert.equal(row.learning.find((i) => i.id === 6 && i.kind === 'martial').status, expected);
    assert.equal(row.compare.status, 'met', 'ordinary compare retains its own lower cost');
  }
  const data = metadata('Hell');
  data.combat.player.skills = [{ id: 6, level: 1 }];
  data.combat.player.skillPoints = 0;
  assert(!make()(data).people[0].learning.some((i) => i.kind === 'martial' && i.id === 6));
  assert.equal(
    make()(data).people[0].learning.find((i) => i.id === 5 && i.kind === 'martial').status,
    'unknown',
  );
  const noEntry = structuredClone(world);
  noEntry.people[0].functions = ['Compare'];
  assert(
    new Set(
      createNpcProgressProjector({ world: noEntry, game, contracts: syntheticContracts })(
        metadata(),
      ).people[0].learning.map((i) => i.status),
    ).has('unmet'),
  );
});

const helpers = {
  esc: (v) =>
    String(v ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('"', '&quot;'),
  act: (action, label, cls, id) => `<button data-action="${action}" data-id="${id}">${label}</button>`,
};
test('compact learning UI splits direct and battle counts, folds settlement and retains skill links', async () => {
  const { createNpcProgressViews, npcLearningSummary } = await import(
    '../src/renderer/npc-progress-views.js'
  );
  const data = make()(metadata('Hell')),
    row = data.people[0],
    views = createNpcProgressViews(helpers);
  assert.equal(npcLearningSummary(row.learning), '可请教 4 项 · 需比试 3 项');
  const html = views.page(data, { tab: 'learning' });
  assert.match(html, /可请教 4 项 · 需比试 3 项/);
  assert.match(html, /data-id="skill-6"/);
  assert.match(html, /data-learning-status="met">需比试/);
  assert.equal((html.match(/武学初学 1 级/g) || []).length, 1);
  assert.match(html, /比试获胜才扣请教消耗/);
  assert.match(html, /<details[^>]*npc-learning-10[^>]*><summary>请教内容/);
  row.learning = row.learning.filter((i) => i.consultation?.method === 'battle');
  const allBattle = views.page(data, { tab: 'learning' });
  assert.match(allBattle, /需比试 3 项/);
  assert.doesNotMatch(allBattle, /（需比试）/);
  assert.doesNotMatch(allBattle, /可请教 3 项|必胜|已学会|失败.*零消耗/);
  const unknown = make()(metadata(null));
  assert.match(views.person(unknown.people[0]), /极难需比试/);
  assert.equal(
    npcLearningSummary([{ status: 'unknown', consultation: { method: 'battle' } }]),
    '待确认 1 项',
  );
});
test('skill codex uses the same method and excludes story-only skills from consultation cues', async () => {
  const { encyclopedia } = require('../src/core/game-data.cjs');
  const { createCodexDetailViews } = await import('../src/renderer/codex-detail-views.js');
  const index = encyclopedia(),
    views = createCodexDetailViews(helpers);
  assert.deepEqual(index.martialConsultation, rule);
  for (const grade of [3, 4, 5, 6]) {
    const entry = index.entries.find(
      (e) =>
        e.kind === '武学' &&
        index.skillConsultation[e.gameId]?.grade === grade &&
        !index.skillConsultation[e.gameId].excluded &&
        index.skillConsultation[e.gameId].openForPlayer !== false,
    );
    assert(entry);
    for (const difficulty of ['Common', 'Hell', null]) {
      const html = views.skill(index, entry, { people: [], difficulty });
      const method = martialConsultation(grade, difficulty, rule);
      const summary = html.match(/<summary>请教条件[^<]*<\/summary>/)[0];
      if (method.method === 'battle') assert.match(summary, /需比试/);
      else if (method.method === 'conditional') assert.match(summary, /极难需比试/);
      else assert.doesNotMatch(summary, /需比试/);
      assert.match(html, /初学 1 级/);
    }
  }
  const blocked = index.entries.find((e) => e.id === 'skill-480');
  const html = views.skill(index, blocked, { people: [], difficulty: 'Hell' });
  assert.match(html, /不可常规请教/);
  assert.doesNotMatch(html, /需比试|初学 1 级/);
});
