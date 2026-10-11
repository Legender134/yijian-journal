'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { flowSnapshot, createFlowProjector } = require('../src/core/flow.cjs');
const { companionSnapshot } = require('../src/core/companion.cjs');
const { defaults } = require('../src/core/store.cjs');
const { syntheticSave } = require('./fixtures.cjs');
const { readMetadata } = require('../src/core/save-reader.cjs');
const { enrich } = require('../src/core/game-data.cjs');
const world = require('../src/data/world-index.json');
const game = require('../src/data/game-index.json');
const guide = require('../src/data/flow-guide.cjs');
const materialGuide = require('../src/data/material-guide.cjs');
const catalog = require('../src/data/catalog.cjs');
const profile = (extra = {}) => ({ id: 'flow', referenceMode: 'latest', ...extra });
const ref = (quests, extra = {}, name = 'Synthetic.sav') => ({
  name,
  hash: 'synthetic',
  modifiedAt: '2026-10-11T00:00:00Z',
  metadata: { quests, inventory: [], ...extra },
});

test('unindexed active records stay visible without inventing names, ownership or next actions', () => {
  const metadata = enrich(
    readMetadata(
      syntheticSave({
        full: true,
        quests: [
          { id: 5200, step: 1 },
          { id: 999999, step: 1 },
          { id: 5858, step: 1 },
          { id: 999998, step: 4 },
          { id: 999997, step: 3 },
          { id: 999996, step: 2 },
        ],
        trackingQuest: 999999,
      }),
      { details: true },
    ),
  );
  const snapshot = flowSnapshot(profile(), { ...ref([]), metadata });
  assert.deepEqual(
    snapshot.unindexedActive.map((row) => row.id),
    [999999, 5858],
  );
  assert.equal(snapshot.unindexedActive[0].tracked, true);
  assert.equal(snapshot.active.length, 1);
  assert.equal(
    flowSnapshot(profile({ referenceMode: 'none' }), { ...ref([]), metadata }).unindexedActive.length,
    0,
  );
  assert.equal(
    flowSnapshot(profile({ referenceMode: 'slot', saveSlot: '2.sav' }), { ...ref([]), metadata })
      .unindexedActive.length,
    0,
  );
});

test('a new profile gets actionable saved steps, NPCs, material deficits and acquisition routes without setup', () => {
  const bytes = syntheticSave({
    full: true,
    trackingMainQuest: 5057,
    trackingQuest: 14082,
    quests: [
      { id: 5053, step: 1 },
      { id: 5057, step: 1 },
      { id: 14073, step: 1 },
      { id: 14082, step: 1 },
    ],
    inventory: [{ id: 10259, count: 1 }],
  });
  const metadata = enrich(readMetadata(bytes, { details: true }));
  const before = structuredClone(metadata),
    p = profile();
  const flow = flowSnapshot(p, ref(metadata.quests, metadata));
  assert.equal(flow.chapter.name, '初入江湖');
  assert.equal(flow.active.length, 2);
  const task = flow.active.find((q) => q.gameId === 14073).steps[0];
  assert.equal(task.nextAction, '收集茯苓和川芎');
  assert(task.people.some((p) => p.name.includes('道玄')));
  assert.deepEqual(
    task.materials.map((m) => [m.id, m.owned, m.missing]),
    [
      ['item-10259', 1, 0],
      ['item-10268', 0, 1],
    ],
  );
  assert(task.materials[1].routes.some((r) => r.detail.includes('桃花林') && r.detail.includes('落英林')));
  assert(task.materials[1].routes.every((r) => r.efficiency && !r.efficiency.includes('最快')));
  assert(task.materials[0].routes.some((r) => r.personId === 'npc-10001' && r.detail.includes('梧桐村')));
  assert(
    task.materials[1].routes.some((r) =>
      r.sources?.some((s) => s.id.startsWith('material:') && s.url.startsWith('https://')),
    ),
  );
  assert.deepEqual(metadata, before);
  assert.deepEqual(p, profile());
});

test('unknown stock, older saves and explicit source selection never inherit another save progress', () => {
  const p = profile({ referenceMode: 'slot', saveSlot: 'Synthetic.sav' });
  const newer = ref(
    [
      { id: 14073, step: 1 },
      { id: 14082, step: 1 },
    ],
    { inventory: [{ id: 10259, count: 10 }] },
  );
  assert.equal(flowSnapshot(p, newer).active[0].steps[0].materials[0].missing, 0);
  const older = ref(
    [
      { id: 14073, step: 1 },
      { id: 14082, step: 1 },
    ],
    { inventory: undefined },
  );
  assert.equal(flowSnapshot(p, older).active[0].steps[0].materials[0].missing, null);
  assert.equal(flowSnapshot(p, { ...newer, name: 'Foreign.sav' }).available, false);
  assert.equal(flowSnapshot(p, newer, '文件正在更新').active.length, 0);
  assert.equal(flowSnapshot(profile({ referenceMode: 'none' }), newer).active.length, 0);
  assert.equal(flowSnapshot(p, ref([{ id: 14073, step: 4 }])).active.length, 0);
});

test('a failed, completed or unaccepted ancestor cannot be resurrected by a contradictory child', () => {
  for (const step of [2, 3, 4]) {
    const flow = flowSnapshot(
      profile(),
      ref([
        { id: 11077, step },
        { id: 11078, step: 1 },
      ]),
    );
    assert.equal(flow.active.length, 0);
  }
  const orphan = flowSnapshot(profile(), ref([{ id: 11078, step: 1 }]));
  assert.equal(orphan.active[0].gameId, 11077);
  assert.equal(orphan.active[0].steps[0].id, 'quest-11078');
});

test('parallel active steps remain separate and quest IDs do not choose a branch or future successor', () => {
  const flow = flowSnapshot(
    profile(),
    ref(
      [
        { id: 5368, step: 1 },
        { id: 5371, step: 1 },
        { id: 5372, step: 1 },
      ],
      { trackingQuest: 5372 },
    ),
  );
  assert.equal(flow.active[0].steps[0].name, '与莫弃交谈');
  assert.equal(flow.active[0].steps.length, 2);
  assert.equal(flowSnapshot(profile(), ref([{ id: 5368, step: 4 }])).chapter, null);
});

function ruleFixture() {
  const content = {
    sources: { synthetic: { title: '合成条件', url: 'https://example.com/synthetic', version: 'test' } },
    rules: [
      {
        id: 'window',
        title: '合成窗口',
        questId: 12200,
        chapterRoots: [5700, 5755],
        afterAllComplete: [5700],
        untilAnyStarted: [5780],
        pickup: { place: '合成地点', person: '合成人物', action: '核对任务' },
        warning: '推进前核对选择',
        steps: ['合成步骤'],
        choices: [
          { label: 'A', effect: '合成结果A' },
          { label: 'B', effect: '合成结果B' },
        ],
        sourceIds: ['synthetic'],
      },
    ],
  };
  return createFlowProjector({ world, game, guide: content }).flowSnapshot;
}
test('a guide window changes with saved main progress, without equating an absent quest with availability or failure', () => {
  const project = ruleFixture();
  const before = project(
    profile(),
    ref([
      { id: 5700, step: 4 },
      { id: 5755, step: 1 },
    ]),
  );
  assert.equal(before.opportunities[0].state, 'unrecorded');
  assert.equal(before.warnings[0].choices.length, 2);
  assert.equal(before.chapter.next.title, '天水祝寿');
  assert.equal(before.changes.length, 1);
  const after = project(
    profile(),
    ref([
      { id: 5700, step: 4 },
      { id: 5780, step: 1 },
    ]),
  );
  assert.equal(after.opportunities.length, 0);
  assert.match(after.warnings[0].message, /不等于错过/);
  const accepted = project(
    profile(),
    ref([
      { id: 5700, step: 4 },
      { id: 12200, step: 1 },
      { id: 12207, step: 1 },
    ]),
  );
  assert.equal(accepted.opportunities.length, 0);
  assert.equal(accepted.active[0].steps[0].nextAction, '前往姑苏迎仙楼找丘掌柜');
  assert.equal(
    project(
      profile(),
      ref([
        { id: 5700, step: 4 },
        { id: 12200, step: 4 },
      ]),
    ).warnings.length,
    0,
  );
  assert.equal(project(profile(), null).opportunities.length, 0);
});

test('public prerequisite leads expose unknown hidden exclusions and suppress positively unmet conditions', () => {
  const project = createFlowProjector({ world, game, guide: { sources: {}, rules: [] } }).flowSnapshot;
  const flow = project(profile(), ref([{ id: 5535, step: 4 }]));
  const medicine = flow.opportunities.find((q) => q.questId === 13407);
  assert(medicine);
  assert.equal(medicine.state, 'conditions-match');
  assert.equal(medicine.conditions.filter((c) => c.status === 'unknown').length, 2);
  assert.match(medicine.uncertainty, /隐藏条件/);
  assert(
    !project(
      profile(),
      ref([
        { id: 5535, step: 4 },
        { id: 6008, step: 1 },
      ]),
    ).opportunities.some((q) => q.questId === 13407),
  );
  assert(!project(profile(), ref([])).opportunities.some((q) => q.questId === 13407));
});

test('explicit unaccepted step records can supply pickup leads without inventing prerequisite-free availability', () => {
  const project = createFlowProjector({ world, game, guide: { sources: {}, rules: [] } }).flowSnapshot;
  const flow = project(profile(), ref([{ id: 11080, step: 3 }]));
  const smith = flow.opportunities.find((row) => row.questId === 11079);
  assert(smith);
  assert.equal(smith.state, 'not-accepted');
  assert.match(smith.pickup.person, /铁匠/);
  assert.match(smith.pickup.place, /梧桐村/);
  assert.match(smith.uncertainty, /未列出可核对的接取条件/);
  assert(!project(profile(), ref([])).opportunities.some((row) => row.questId === 11079));
  assert(
    !project(
      profile(),
      ref([
        { id: 11079, step: 4 },
        { id: 11080, step: 3 },
      ]),
    ).opportunities.some((row) => row.questId === 11079),
  );
});

test('unknown or ambiguous main tracking never assigns an unrelated chapter or next milestone', () => {
  const unknown = flowSnapshot(
    profile(),
    ref(
      [
        { id: 5200, step: 1 },
        { id: 999999, step: 1 },
      ],
      { trackingMainQuest: 999999 },
    ),
  );
  assert.equal(unknown.chapter, null);
  assert.match(unknown.stageUncertainty, /主线.*待核对/);
  assert(!unknown.opportunities.some((row) => row.id === 'early-bai-return-plan'));
  assert.equal(unknown.active[0].gameId, 5200);
  const ambiguous = flowSnapshot(
    profile(),
    ref(
      [
        { id: 5200, step: 1 },
        { id: 5500, step: 1 },
      ],
      { trackingMainQuest: 0 },
    ),
  );
  assert.equal(ambiguous.chapter, null);
  assert.match(ambiguous.stageUncertainty, /多条进行中主线/);
  const child = world.quests.find((q) => q.parentId === 5500);
  const tracked = flowSnapshot(
    profile(),
    ref(
      [
        { id: 5200, step: 1 },
        { id: 5500, step: 1 },
      ],
      { trackingMainQuest: child.gameId },
    ),
  );
  assert.equal(tracked.chapter.questId, 'quest-5500');
  assert.equal(tracked.stageUncertainty, '');
  assert.match(tracked.chapter.basis, /主线追踪/);
  const sole = flowSnapshot(profile(), ref([{ id: 5500, step: 1 }]));
  assert.equal(sole.chapter.questId, 'quest-5500');
  assert.match(sole.chapter.basis, /唯一已识别/);
});

test('early village choices remain useful after story changes without guessing deadlines', () => {
  const early = flowSnapshot(
    profile(),
    ref([
      { id: 5074, step: 1 },
      { id: 5111, step: 4 },
    ]),
  );
  assert(early.warnings.some((row) => row.id === 'early-jingyin-weapon-choice'));
  const smith = early.opportunities.find((row) => row.id === 'early-blacksmith-courtship');
  assert(smith);
  assert.equal(smith.deadlineReached, false);
  assert.equal(smith.state, 'unrecorded');
  const axe = early.guide.find((row) => row.id === 'early-woodcutter-axe-choice');
  assert.match(axe.choices.map((row) => row.effect).join(' '), /700.*2000/);
  assert.match(axe.steps.join(' '), /铁矿石×4/);
  const pig = early.guide.find((row) => row.id === 'early-wei-pig-return');
  assert.match(pig.steps.join(' '), /莲心湖.*李村长/);
});

test('Wudang onboarding tasks each respect their own completed or failed record', () => {
  const flow = flowSnapshot(
    profile(),
    ref([
      { id: 5231, step: 1 },
      { id: 14200, step: 4 },
      { id: 14065, step: 2 },
      { id: 13802, step: 3 },
    ]),
  );
  assert(
    !flow.opportunities.some((row) => row.id === 'early-wudang-martial' || row.id === 'early-wudang-boars'),
  );
  assert(flow.opportunities.some((row) => row.id === 'early-wudang-alchemy' && row.state === 'not-accepted'));
  assert.match(flow.guide.find((row) => row.id === 'early-wudang-alchemy').steps.join(' '), /茯苓、白芍各1/);
});

test('offline story index covers every non-demo main root once and distinguishes missing records from completion', () => {
  const flow = flowSnapshot(profile(), null);
  const actual = flow.chapters.flatMap((c) => c.roots.map((q) => q.id));
  const expected = world.quests
    .filter((q) => !q.parentId && q.kind === 'Primary' && !q.name.includes('试玩版'))
    .map((q) => q.id);
  assert.deepEqual([...actual].sort(), expected.sort());
  assert.equal(new Set(actual).size, actual.length);
  assert(flow.chapters.every((c) => c.roots.every((q) => q.status === '未核对存档')));
  assert.equal(flow.coverage.tasks, 1736);
  assert.equal(flow.coverage.curatedRules, guide.rules.length);
  for (const rule of guide.rules) {
    assert(rule.sourceIds.length, rule.id);
    for (const id of rule.sourceIds) assert(guide.sources[id]?.url.startsWith('https://'), rule.id);
    if (rule.questId)
      assert(
        world.quests.some((q) => q.gameId === rule.questId),
        rule.id,
      );
  }
  for (const [id, value] of Object.entries(materialGuide.items)) {
    assert(game.entries.some((item) => item.id === `item-${id}`));
    for (const route of value.routes) {
      assert(route.sourceIds.length);
      for (const key of route.sourceIds) assert(materialGuide.sources[key]?.url.startsWith('https://'));
      assert(!/600\s*秒|最快|每分钟\d/.test(route.efficiency));
    }
  }
});

test('actual current tasks take companion hint priority while preserving personal plans', () => {
  const state = defaults(),
    p = state.profiles[0];
  p.goals = [{ id: 'own', title: '我的个人计划', pinned: true, done: false }];
  const before = structuredClone(state);
  const snapshot = companionSnapshot(
    state,
    catalog,
    ref([
      { id: 11077, step: 1 },
      { id: 11078, step: 1 },
    ]),
  );
  assert.equal(snapshot.hints[0].id, 'quest-11077');
  assert.equal(snapshot.hints[0].type, 'quest');
  assert.equal(snapshot.hints[0].title, '收集药材向洛村郎中换取秘术');
  assert.equal(snapshot.hints[1].title, '我的个人计划');
  assert(snapshot.flow.advice.some((r) => r.id === 'medicine-shared-herbs'));
  assert.deepEqual(state, before);
});

test('native hidden story gates survive enrichment and close a guide pickup window', () => {
  const project = (gate) => {
    const bytes = syntheticSave({
      full: true,
      quests: [{ id: 12500, step: 4 }, { id: 5600, step: 1 }, ...(gate ? [{ id: 5603, step: 1 }] : [])],
    });
    const raw = readMetadata(bytes, { details: true });
    const before = structuredClone(raw);
    const metadata = enrich(raw);
    assert.deepEqual(raw, before);
    assert.equal(
      metadata.quests.some((q) => q.id === 5603),
      false,
      'hidden gate has no named public task',
    );
    assert.equal(
      metadata.questStates.some((q) => q.id === 5603),
      gate,
    );
    return flowSnapshot(profile(), ref(metadata.quests, metadata));
  };
  const before = project(false);
  assert(before.opportunities.some((q) => q.id === 'counterattack-window'));
  const after = project(true);
  assert.equal(
    after.opportunities.some((q) => q.id === 'counterattack-window'),
    false,
  );
  const notice = after.warnings.find((q) => q.id === 'counterattack-window');
  assert.equal(notice.deadlineReached, true);
  assert.match(notice.message, /没有任务记录不等于错过/);
  const metadata = enrich(
    readMetadata(
      syntheticSave({
        full: true,
        quests: [
          { id: 5850, step: 1 },
          { id: 30148, step: 4 },
          { id: 16107, step: 4 },
          { id: 5858, step: 1 },
        ],
      }),
      { details: true },
    ),
  );
  const banquet = flowSnapshot(profile(), ref(metadata.quests, metadata)).warnings.find(
    (row) => row.id === 'qiluo-window',
  );
  assert.equal(banquet.deadlineReached, true);
  assert.equal(banquet.conditions[0].status, 'met');
  assert.match(banquet.conditions[0].text, /道微请托/);
});

test('a root-only family record does not masquerade as a known current step', () => {
  const flow = flowSnapshot(profile(), ref([{ id: 11077, step: 1 }]));
  assert.match(flow.active[0].steps[0].nextAction, /具体步骤.*核对游戏任务栏/);
  assert.notEqual(flow.active[0].steps[0].nextAction, flow.active[0].name);
});

test('task progress retains saved completed, failed and pending steps without inventing missing branches', () => {
  const flow = flowSnapshot(
    profile(),
    ref([
      { id: 12200, step: 1 },
      { id: 12203, step: 4 },
      { id: 12205, step: 2 },
      { id: 12207, step: 1 },
      { id: 12209, step: 3 },
    ]),
  );
  const task = flow.active.find((row) => row.gameId === 12200);
  assert.deepEqual(
    task.steps.map((row) => row.id),
    ['quest-12207'],
  );
  assert.deepEqual(
    task.progress.map((row) => [row.id, row.status]),
    [
      ['quest-12203', '已完成'],
      ['quest-12205', '已失败'],
      ['quest-12207', '进行中'],
      ['quest-12209', '尚未接取'],
    ],
  );
  assert(!task.progress.some((row) => row.id === 'quest-12208'));
});

test('the shipped guide warns about the score window and consequential recruitment choices', () => {
  const before = flowSnapshot(
    profile(),
    ref([
      { id: 5700, step: 4 },
      { id: 5750, step: 1 },
    ]),
  );
  const score = before.warnings.find((q) => q.id === 'qin-score-window');
  assert(score);
  assert.equal(score.pickup.person, '欧阳雪');
  assert.equal(score.choices.length, 2);
  const after = flowSnapshot(
    profile(),
    ref([
      { id: 5700, step: 4 },
      { id: 5780, step: 1 },
    ]),
  );
  assert.equal(
    after.opportunities.some((q) => q.id === 'qin-score-window'),
    false,
  );
  assert.equal(after.warnings.find((q) => q.id === 'qin-score-window').deadlineReached, true);
  const chen = flowSnapshot(profile(), ref([{ id: 5246, step: 1 }])).warnings.find(
    (q) => q.id === 'chenlinxi-critical-choice',
  );
  assert(chen.choices.some((choice) => /恰好70/.test(choice.label) && /没有完整说明/.test(choice.effect)));
});

test('offline guide cards retain known outcomes rather than relabeling them as unknown', () => {
  const flow = flowSnapshot(
    profile(),
    ref([
      { id: 11942, step: 4 },
      { id: 11077, step: 2 },
    ]),
  );
  assert.equal(flow.guide.find((row) => row.id === 'lotus-meeting').state, 'done');
  assert.equal(flow.guide.find((row) => row.id === 'medicine-shared-herbs').state, 'failed');
  assert(!flow.opportunities.some((row) => row.questId === 11942 || row.questId === 11077));
  assert(!flow.warnings.some((row) => row.questId === 11942 || row.questId === 11077));
});

test('shared material demand discloses the combined deficit for simultaneously handing in saved active steps', () => {
  const flow = flowSnapshot(
    profile(),
    ref(
      [
        { id: 11077, step: 1 },
        { id: 11078, step: 1 },
        { id: 11052, step: 1 },
        { id: 11054, step: 1 },
      ],
      { inventory: [{ id: 10262, count: 1 }] },
    ),
  );
  const herb = flow.sharedMaterials.find((row) => row.id === 'item-10262');
  assert.equal(herb.required, 2);
  assert.equal(herb.owned, 1);
  assert.equal(herb.missing, 1);
  assert.equal(herb.steps.length, 2);
  const done = flowSnapshot(
    profile(),
    ref([
      { id: 11077, step: 4 },
      { id: 11078, step: 1 },
      { id: 11052, step: 1 },
      { id: 11054, step: 1 },
    ]),
  );
  assert.equal(done.sharedMaterials.length, 0);
});

test('phase changes name the departing companion and consequential guide branches name their actions and costs', () => {
  const licheng = flowSnapshot(profile(), ref([{ id: 5580, step: 1 }]));
  assert(licheng.changes.some((row) => /瑶姬.*离队/.test(row.consequence)));
  assert(
    licheng.guide.find((row) => row.id === 'hepu-sandtable').steps.some((row) => /猴儿林.*去年花/.test(row)),
  );
  assert(!licheng.opportunities.some((row) => row.id === 'licheng-team-departure'));
  const banquet = flowSnapshot(profile(), ref([{ id: 5850, step: 1 }])).warnings.find(
    (row) => row.id === 'qiluo-window',
  );
  assert(banquet.choices.some((row) => /白锦.*羽毛.*冷无情.*翼卫/.test(row.effect)));
  assert(
    banquet.choices.some((row) => /苦老/.test(row.label) && /火云神掌.*没有玄阳离火功/.test(row.effect)),
  );
});
