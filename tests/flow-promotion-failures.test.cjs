'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { flowSnapshot, createFlowProjector } = require('../src/core/flow.cjs');
const guide = require('../src/data/flow-guide.cjs');
const contracts = require('../src/data/flow-window-contracts.json');
const world = require('../src/data/world-index.json');
const game = require('../src/data/game-index.json');
const { syntheticSave } = require('./fixtures.cjs');
const { readMetadata } = require('../src/core/save-reader.cjs');
const { enrich } = require('../src/core/game-data.cjs');
const specs = [
  {
    id: 'senior-active-quests',
    key: 'seniorPromotionFailures',
    main: 5242,
    stage: 5243,
    bridge: 5243,
    retry: 5316,
    complete: 5317,
    roots: [11945, 14052, 14053, 14054, 14055, 14065],
  },
  {
    id: 'elite-active-quests',
    key: 'elitePromotionFailures',
    main: 5304,
    stage: 5305,
    bridge: 5305,
    retry: 5322,
    complete: 5323,
    roots: [14072, 14073, 14074, 14075, 14090, 13824, 12400, 12230],
  },
  {
    id: 'chief-active-quests',
    key: 'chiefPromotionFailures',
    main: 5980,
    stage: 6260,
    bridge: 6260,
    retry: 6263,
    complete: 6261,
    roots: [
      11825, 11840, 11855, 11867, 11875, 11885, 11895, 11910, 11920, 12000, 12015, 12020, 12030, 11405, 12120,
      13500, 13510, 12780, 12815, 12880, 12915, 12935, 13000, 13280, 13290, 13300, 12575, 30140, 30150, 30360,
      12110,
    ],
  },
];
const profile = { id: 'promotion-test', referenceMode: 'latest' };
const reference = (pairs, tracking) => ({
  name: 'Synthetic.sav',
  hash: 'synthetic',
  metadata: { quests: pairs.map(([id, step]) => ({ id, step })), inventory: [], trackingMainQuest: tracking },
});
const warning = (flow, spec) => flow.warnings.find((r) => r.id === spec.id);
const current = (spec, pairs = [], stage = spec.stage) =>
  flowSnapshot(profile, reference([[spec.main, 1], [stage, 1], ...pairs], spec.main));

test('promotion failures retain the complete native arrays, unnamed roots, completion and retry provenance', () => {
  assert.equal(
    specs.reduce((sum, spec) => sum + spec.roots.length, 0),
    45,
  );
  for (const spec of specs) {
    const window = contracts.windows[spec.key];
    const expected = spec.main === 5980 ? [...spec.roots.slice(0, -1), 30380, 30692] : spec.roots;
    assert.deepEqual(window.activeFailures.questIds, expected);
    assert.equal(window.completionQuestId, spec.complete);
    assert.equal(window.normalCompletion.requiredStep, 4);
    assert(window.normalCompletion.stoppedSequenceDoesNotFinish);
    assert(window.normalCompletion.losingFightDoesNotEnterFailures);
    assert.equal(window.activeFailures.requiredStep, 1);
    assert.equal(window.activeFailures.failedStep, 2);
    const rule = guide.rules.find((r) => r.id === spec.id);
    assert.equal(rule.uncertainty, undefined);
    assert(
      !/根任务|状态1|无进度|未证明/.test(
        [rule.warning, rule.recommendation.reason, ...rule.advanceEffects.map((r) => r.effect)].join(' '),
      ),
    );
  }
  const chief = contracts.windows.chiefPromotionFailures;
  assert.deepEqual(chief.activeFailures.unnamedQuestIds, [30380, 30692]);
  assert.equal(chief.activeFailures.teamRemoval.questId, 12110);
  assert.equal(chief.activeFailures.teamRemoval.npcId, 17012);
  assert.equal(chief.activeFailures.teamRemoval.permanentRecruitmentLossProved, false);
  assert.equal(chief.retry.ownerQuestId, 5850);
  assert.deepEqual(chief.retry.requirements, [{ type: 'PreQuest', id: 6263, value: 1 }]);
  assert.deepEqual(chief.retry.action, { type: 'JumpStep', id: 6261, value: 4 });
  const pins = contracts.assets.filter((r) =>
    /(?:Quest_(5314|5317|5320|5323|5982)|FL_JieKou)\.(uasset|uexp)$/.test(r.path),
  );
  assert.equal(pins.length, 12);
  assert(pins.every((r) => /^[a-f0-9]{64}$/.test(r.sha256)));
  assert(!contracts.assets.some((r) => /Quest_5351\./.test(r.path)));
  assert.equal(
    contracts.windows.seniorPromotionFailures.normalCompletion.challengeBlueprint,
    '/Game/JH/Maps/WuDang/Quest/Quest_5314.Quest_5314_C',
  );
  assert.equal(
    contracts.windows.elitePromotionFailures.normalCompletion.challengeBlueprint,
    '/Game/JH/Maps/WuDang/Quest/Quest_5320.Quest_5320_C',
  );
  assert.equal(
    chief.activeFailures.teamRemoval.teamActionBlueprint,
    '/Game/JH/Core/Quest/FL_JieKou.FL_JieKou_C',
  );
  assert(
    !warning(
      current(specs[2], [
        [30380, 1],
        [30692, 1],
      ]),
      specs[2],
    ),
    'unnamed roots are metadata only',
  );
});

test('all 45 named roots are current risks only at root step1, including when a child remains active', () => {
  for (const spec of specs)
    for (const id of spec.roots) {
      const child = world.quests.find((r) => r.parentId === id);
      for (const step of [undefined, 0, 1, 2, 3, 4]) {
        const pairs = [...(step === undefined ? [] : [[id, step]]), ...(child ? [[child.gameId, 1]] : [])];
        const ref = reference([[spec.main, 1], [spec.stage, 1], ...pairs], spec.main);
        const before = JSON.stringify(ref);
        const flow = flowSnapshot(profile, ref);
        assert.equal(!!warning(flow, spec), step === 1, `${spec.id}/${id}/${step}`);
        if (step === 1) {
          assert.deepEqual(
            warning(flow, spec).affectedTasks.map((r) => r.questId),
            [id],
          );
          assert(warning(flow, spec).compactWarning.includes(warning(flow, spec).affectedTasks[0].name));
          assert.match(warning(flow, spec).affectedTasks[0].effect, /正常晋升结算.*失败/);
        }
        assert.equal(JSON.stringify(ref), before, 'projection never mutates synthetic quest records');
      }
    }
});

test('every verified contribution, chief preparation and actual retry step opens its own reminder', () => {
  for (const spec of specs) {
    for (const stage of contracts.windows[spec.key].stageSteps) {
      const flow = current(spec, [[spec.roots[0], 1]], stage);
      assert(warning(flow, spec), `${spec.id}: ${stage}`);
    }
    // Another tracked main cannot suppress the actual retry's active saved step.
    const retry = flowSnapshot(
      profile,
      reference(
        [
          [5020, 1],
          [spec.retry, 1],
          [spec.roots[0], 1],
        ],
        5020,
      ),
    );
    assert(warning(retry, spec), `${spec.id}: retry without tracked promotion main`);
    // Merely tracking the promotion main is insufficient to invent a decision window.
    assert(
      !warning(
        flowSnapshot(
          profile,
          reference(
            [
              [spec.main, 1],
              [spec.roots[0], 1],
            ],
            spec.main,
          ),
        ),
        spec,
      ),
    );
  }
});

test('only the verified contribution/reply completion bridges an active own main until the challenge is recorded', () => {
  for (const spec of specs) {
    const pairs = [
      [spec.main, 1],
      [spec.bridge, 4],
      [spec.roots[0], 1],
    ];
    assert(warning(flowSnapshot(profile, reference(pairs, spec.main)), spec));
    for (const rootStep of [undefined, 0, 2, 3, 4]) {
      const other = [
        [spec.bridge, 4],
        [spec.roots[0], 1],
        ...(rootStep === undefined ? [] : [[spec.main, rootStep]]),
      ];
      assert(
        !warning(flowSnapshot(profile, reference(other)), spec),
        `${spec.id}: no active own main ${rootStep}`,
      );
    }
    assert(
      !warning(
        flowSnapshot(
          profile,
          reference(
            [
              [spec.main, 1],
              [spec.bridge, 0],
              [spec.roots[0], 1],
            ],
            spec.main,
          ),
        ),
        spec,
      ),
    );
    assert(
      !warning(
        flowSnapshot(
          profile,
          reference(
            [
              [spec.main, 1],
              [spec.bridge, 2],
              [spec.roots[0], 1],
            ],
            spec.main,
          ),
        ),
        spec,
      ),
    );
    assert(
      !warning(
        flowSnapshot(
          profile,
          reference(
            [
              [spec.main, 1],
              [spec.bridge, 3],
              [spec.roots[0], 1],
            ],
            spec.main,
          ),
        ),
        spec,
      ),
    );
  }
});

test('chief wait/retry keeps risks through6261 states0/1/2/3, and only actual completion retires them', () => {
  const spec = specs[2];
  for (const stage of [undefined, 0, 1, 2, 3]) {
    const pairs = [
      [5980, 1],
      [6260, 4],
      [6263, 1],
      [12110, 1],
      [12780, 1],
      ...(stage === undefined ? [] : [[6261, stage]]),
    ];
    const ref = reference(pairs, 5980);
    const before = JSON.stringify(ref);
    const flow = flowSnapshot(profile, ref);
    assert(warning(flow, spec), `6261=${stage}`);
    assert.deepEqual(
      warning(flow, spec).affectedTasks.map((r) => r.questId),
      [12780, 12110],
    );
    assert.equal(JSON.stringify(ref), before);
  }
  const finished = reference(
    [
      [5980, 1],
      [6260, 4],
      [6263, 1],
      [6261, 4],
      [12110, 1],
      [12113, 4],
      [12780, 1],
    ],
    5980,
  );
  const before = JSON.stringify(finished);
  const flow = flowSnapshot(profile, finished);
  for (const key of ['warnings', 'changes', 'advice', 'decisions', 'opportunities'])
    assert(!flow[key].some((r) => r.id === spec.id), key);
  assert(flow.guide.some((r) => r.id === spec.id));
  assert.equal(JSON.stringify(finished), before, 'retiring a warning does not simulate game-side failure');
});

test('normal completion retires every promotion reminder despite stale preparation records', () => {
  for (const spec of specs) {
    const flow = current(spec, [[spec.complete, 4], ...spec.roots.map((id) => [id, 1])]);
    for (const key of ['warnings', 'changes', 'advice', 'decisions', 'opportunities'])
      assert(!flow[key].some((r) => r.id === spec.id), `${spec.id}/${key}`);
  }
});

test('Lv Xianer departure attaches only to the step1 Four Families root and never promises permanent loss', () => {
  const spec = specs[2];
  for (const step of [undefined, 0, 1, 2, 3, 4]) {
    const flow = current(spec, [[12000, 1], ...(step === undefined ? [] : [[12110, step]])]);
    const row = warning(flow, spec);
    assert(row);
    assert.equal(JSON.stringify(row.affectedTasks).includes('吕仙儿'), step === 1);
    assert.equal(row.compactWarning.includes('吕仙儿离队'), step === 1);
    assert(!/永久无法招募|未证明/.test(JSON.stringify(row)));
  }
});

test('elite and chief pickup references state the separately proved active-root risk without weakening other acceptance guards', () => {
  for (const rule of guide.rules.filter((r) => /^(elite|chief)-pickup-/.test(r.id))) {
    const effect = rule.advanceEffects[0];
    assert.equal(effect.scope, 'accept');
    assert.match(effect.acceptedEffect, /进行中的.*会在.*晋升正常结算时失败；请先完成/);
    assert(
      !/没有证明.*失败|已接任务保留原状态|这不表示已接任务失败|已接的当前轮次不据此判失败/.test(
        JSON.stringify(rule),
      ),
    );
    assert.equal(effect.questId, rule.pickupWindow.stepId);
    assert.equal(rule.uncertainty, undefined);
    const projected = current(rule.id.startsWith('elite') ? specs[1] : specs[2], [
      [rule.questId, 1],
      [effect.questId, 1],
    ]).guide.find((r) => r.id === rule.id);
    assert.equal(projected.affectedTasks[0].effect, effect.acceptedEffect);
  }
  for (const rule of guide.rules.filter((r) => !/^(elite|chief)-pickup-/.test(r.id)))
    for (const effect of rule.advanceEffects || []) assert.equal(effect.acceptedEffect, undefined, rule.id);
  const root = 11945;
  const make = (effect) =>
    createFlowProjector({
      world,
      game,
      guide: {
        sources: {},
        rules: [{ id: 'guard-test', questId: root, untilAnyStarted: [], advanceEffects: [effect] }],
      },
    }).flowSnapshot(profile, reference([[root, 1]]));
  const effect = { questId: root, scope: 'accept', effect: 'unaccepted effect' };
  assert.match(make(effect).guide[0].affectedTasks[0].effect, /已有进行中记录.*没有证明.*失败/);
  assert.equal(
    make({ ...effect, acceptedEffect: 'explicit accepted proof' }).guide[0].affectedTasks[0].effect,
    'explicit accepted proof',
  );
  assert.equal(
    make({ ...effect, scope: 'continue', acceptedEffect: 'explicit accepted proof' }).guide[0]
      .affectedTasks[0].effect,
    'unaccepted effect',
  );
});

test('future challenge effects keep their exact pickup step while active-root risks remain independent', () => {
  const flow = current(specs[1], [
    [13824, 1],
    [13825, 1],
  ]);
  const next = flow.warnings.find((r) => r.id === 'elite-pickup-13826');
  assert(next);
  assert.equal(next.pickupRetired, false);
  assert.equal(next.affectedTasks[0].questId, 13826);
  assert.match(next.affectedTasks[0].effect, /这一轮尚未接取.*不再满足接取条件/);
  assert.equal(
    next.affectedTasks[0].effect,
    guide.rules.find((r) => r.id === next.id).advanceEffects[0].effect,
  );
  assert.deepEqual(
    warning(flow, specs[1]).affectedTasks.map((r) => r.questId),
    [13824],
  );
  const later = current(specs[1], [
    [13824, 1],
    [13825, 4],
    [13826, 1],
  ]);
  assert.deepEqual(later.guide.find((r) => r.id === 'elite-pickup-13825').affectedTasks, []);
  assert.equal(later.guide.find((r) => r.id === 'elite-pickup-13826').affectedTasks[0].questId, 13826);
  assert.deepEqual(
    warning(later, specs[1]).affectedTasks.map((r) => r.questId),
    [13824],
  );
});

test('offline progress keeps the conditional complete named lists, without generating current risks', () => {
  const offline = flowSnapshot({ ...profile, referenceMode: 'none' }, null);
  assert.equal(offline.available, false);
  for (const spec of specs) {
    const row = offline.guide.find((r) => r.id === spec.id);
    assert.deepEqual(
      row.affectedTasks.map((r) => r.questId),
      spec.roots,
    );
    assert.equal(row.uncertainty, undefined);
    assert(row.affectedTasks.every((effect) => /仍在进行.*失败/.test(effect.effect)));
    assert(!offline.warnings.some((r) => r.id === spec.id));
    assert(!offline.changes.some((r) => r.id === spec.id));
    assert(!JSON.stringify(row).includes('任务名称待核对'));
  }
});

test('synthetic save reading and main, compact, summary and offline rendering expose names and expanded evidence', async () => {
  const { createFlowViews } = await import(
    pathToFileURL(path.join(__dirname, '../src/renderer/flow-views.js')).href
  );
  const views = createFlowViews({
    esc: String,
    act: (_a, label) => label,
    icon: () => '',
    pill: String,
    when: String,
  });
  for (const spec of specs) {
    const bytes = syntheticSave({
      full: true,
      trackingMainQuest: spec.main,
      trackingQuest: spec.retry,
      quests: [
        [spec.main, 1],
        [spec.retry, 1],
        [spec.roots[0], 1],
      ].map(([id, step]) => ({ id, step })),
    });
    const before = Buffer.from(bytes);
    const metadata = enrich(readMetadata(bytes, { details: true }));
    assert.deepEqual(bytes, before);
    const flow = flowSnapshot(profile, { name: 'Synthetic.sav', hash: 'synthetic', metadata });
    const row = warning(flow, spec);
    assert(row);
    for (const mode of [{}, { compact: true }, { summary: true }]) {
      const html = views.panel(flow, mode);
      assert(html.includes(row.compactWarning), `${spec.id}: names directly in current warning`);
      assert(html.includes('data-flow-affected'));
      assert(html.includes('正常晋升结算'));
      assert(!/已接任务保留原状态|已接的当前轮次不据此判失败/.test(html));
    }
  }
  const offline = flowSnapshot({ ...profile, referenceMode: 'none' }, null);
  const html = views.panel(offline);
  assert(!html.includes('无进度时为条件性完整名单'));
  assert(!html.includes('data-flow-warning='));
  assert(
    !/任务名称待核对/.test(
      specs.map((s) => offline.guide.find((r) => r.id === s.id).affectedTasks.map((r) => r.name)).join(' '),
    ),
  );
  for (const step of [undefined, 0, 1, 2, 3, 4]) {
    const flow = current(specs[2], [[12000, 1], ...(step === undefined ? [] : [[12110, step]])]);
    for (const mode of [{}, { compact: true }, { summary: true }]) {
      const html = views.panel(flow, mode);
      const preview = warning(flow, specs[2]).compactWarning;
      assert(html.includes(preview));
      assert.equal(preview.includes('四大武家（吕仙儿离队）'), step === 1);
    }
  }
});
