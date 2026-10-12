'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { readMetadata } = require('../src/core/save-reader.cjs');
const { enrich } = require('../src/core/game-data.cjs');
const { flowSnapshot } = require('../src/core/flow.cjs');
const { syntheticSave } = require('./fixtures.cjs');
const { createDuelReadiness } = require('../src/core/duel-readiness.cjs');
const game = require('../src/data/game-index.json');
const path = require('node:path'),
  { pathToFileURL } = require('node:url');
const fullEquipment = [1002, 6002, 9002, 7002].map((id) => ({ id, count: 1 }));
const player = (extra = {}) => ({
  id: 0,
  attributes: { 1: 100, 2: 100, 3: 50, 4: 50, 5: 45 },
  equipment: fullEquipment,
  skills: [{ id: 700, level: 5 }],
  ...extra,
});
const cheng = (own, enemy = {}) => {
  const metadata = enrich(
    readMetadata(
      syntheticSave({
        full: true,
        trackingMainQuest: 5820,
        quests: [
          { id: 5820, step: 1 },
          { id: 5829, step: 4 },
        ],
        npcs: [own, { id: 5037, attributes: { 5: 40 }, friendliness: [[0, 32]], ...enemy }],
      }),
      { details: true },
    ),
  );
  return flowSnapshot(
    { id: 'readiness', referenceMode: 'latest' },
    { name: 'Synthetic.sav', hash: 'synthetic', metadata, modifiedAt: '2026-10-12T00:00:00Z' },
  );
};

test('actual native save details reach the stage duel with actionable gaps, not only a difficulty label', () => {
  const flow = cheng(
    player({
      attributes: { 1: 30, 2: 100, 3: 10, 4: 50, 5: 25 },
      equipment: [],
      skills: [{ id: 700, level: 2 }],
      skillPoints: 720,
      meridianPoints: 35,
    }),
    { friendliness: [[0, 12]] },
  );
  const row = flow.duels.candidates.find((n) => n.npcId === 5037);
  assert(row);
  const ready = row.readiness;
  assert.equal(ready.status, 'prepare');
  assert.match(ready.action, /气血.*回满/);
  assert.match(ready.growth, /720.*35.*道微.*道通/);
  const check = (id) => ready.checks.find((c) => c.id === id);
  assert.equal(check('health').status, 'unmet');
  assert.equal(check('weapon').status, 'unmet');
  assert.match(check('level').detail, /宇文逸 25.*存档对手 40.*15/);
  assert.match(check('friendship').detail, /12.*还差 8/);
  assert.match(check('skill-700').detail, /2 级.*5 级/);
  assert.match(check('skill-700').next, /三清殿.*道微.*身法\+5.*不是必胜/);
  assert.equal(check('skill-700').optional, true);
});

test('newly saved recovery and equipment retire old gaps; raw good friendship never certifies story gates', () => {
  const ready = cheng(player()).duels.candidates.find((n) => n.npcId === 5037).readiness;
  assert.equal(ready.status, 'verify');
  assert(!ready.checks.some((c) => c.status === 'unmet'));
  assert.match(ready.action, /基础记录未发现明显缺口.*保留可回读存档/);
  assert.equal(ready.checks.find((c) => c.id === 'friendship').status, 'unknown');
  assert.match(ready.checks.find((c) => c.id === 'friendship').detail, /32.*剧情好感锁/);
  assert.match(ready.basis, /最近一次保存.*未保存.*不.*实战面板/);
  const advanced = cheng(player({ skills: [{ id: 9999, level: 10 }] })).duels.candidates.find(
    (n) => n.npcId === 5037,
  ).readiness;
  assert.equal(
    advanced.status,
    'verify',
    'optional basic lightness does not force advanced builds to relearn',
  );
});

test('Qinlie unknown and low-level ordinary starts defer with interaction limits and an alternative growth route', () => {
  const { createDuelProjector } = require('../src/core/duels.cjs');
  const project = createDuelProjector({
    game,
    world: require('../src/data/world-index.json'),
    guide: require('../src/data/duel-guide.cjs'),
  });
  const input = { available: true, states: [{ id: 5063, step: 4 }], mainQuestId: 5062 };
  for (const combat of [
    null,
    {
      format: 14,
      player: { id: 0, level: 5, healthRatio: 1, manaRatio: 1, equipment: [], skills: [] },
      opponents: [],
    },
  ]) {
    const row = project({ ...input, combat }).candidates.find((n) => n.npcId === 10023);
    assert.equal(row.readiness.status, 'defer');
    assert.match(row.readiness.action, /暂缓秦烈.*普通新档.*继承档/);
    assert.match(row.readiness.checks.find((c) => c.id === 'friendship').next, /境界.*20.*丹方/);
    assert.match(row.readiness.growth, /村内.*武学点.*元曾/);
    assert.match(row.preparation, /不能.*2932.*秦烈/);
  }
});

test('unknown templates, offline data and a saved bag weapon do not certify equipment or victory', () => {
  const ready = createDuelReadiness(game)(
    { npcId: 10023, level: 35 },
    {
      format: 14,
      player: {
        id: 0,
        level: 10,
        healthRatio: 1,
        manaRatio: 1,
        equipment: [{ id: 987654, count: 1 }],
        skills: [],
      },
      opponents: [],
    },
  );
  assert.equal(ready.checks.find((c) => c.id === 'weapon').status, 'unknown');
  assert.match(ready.checks.find((c) => c.id === 'level').detail, /静态模板/);
  assert.doesNotMatch(JSON.stringify(ready), /必定获胜|胜率\d/);
  assert.equal(
    createDuelReadiness(game)({ level: 35 }, null).checks.find((c) => c.id === 'weapon').status,
    'unknown',
  );
  const partial = createDuelReadiness(game)(
    { level: 35 },
    { format: 14, player: { id: 0, level: 45 }, opponents: [] },
  );
  assert.match(partial.action, /气血仍待核对/);
  assert.doesNotMatch(partial.action, /未发现明显缺口/);
});

test('Pingkang readiness exposes exact linked static opponent skills and an optional return route', () => {
  const { createDuelProjector } = require('../src/core/duels.cjs');
  const project = createDuelProjector({
    game,
    world: require('../src/data/world-index.json'),
    guide: require('../src/data/duel-guide.cjs'),
  });
  const row = project({
    available: true,
    states: [{ id: 5246, step: 1 }],
    mainQuestId: 5246,
  }).candidates.find((n) => n.npcId === 10249);
  assert.match(row.readiness.action, /平康衙门.*调查交付/);
  assert.match(row.readiness.growth, /不要求赢.*三才刀法.*破军刀法/);
  const threat = row.readiness.opponentSkills.find((s) => s.id === 'skill-217');
  assert.equal(threat.level, 10);
  assert.match(threat.description, /前方横排3格/);
  assert.match(threat.special, /无视防御/);
});

test('both duel views expose the recommendation and a folded concrete checklist with escaped values', async () => {
  const { createDuelViews } = await import(
    pathToFileURL(path.join(__dirname, '../src/renderer/duel-views.js')).href
  );
  const esc = (v) =>
    String(v ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  const views = createDuelViews({ esc, act: (_a, t) => t, pill: esc });
  const flow = cheng(player({ attributes: { 1: 30, 2: 100, 3: 50, 4: 50, 5: 25 } }));
  for (const compact of [false, true]) {
    const html = views.page(flow, { compact, scope: 'synthetic' });
    assert.match(html, /先补准备/);
    assert.match(html, /核对准备与成长路径/);
    assert.match(html, /存档气血约 30%/);
    assert.match(html, /data-readiness-check="weapon"/);
    assert.match(html, /推荐成长/);
  }
  flow.duels.candidates[0].readiness.reason = '<script>bad</script>';
  assert.doesNotMatch(views.page(flow), /<script>bad/);
});
