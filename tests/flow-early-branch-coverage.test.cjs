'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createFlowProjector, flowSnapshot } = require('../src/core/flow.cjs');
const { encyclopedia } = require('../src/core/game-data.cjs');
const guide = require('../src/data/flow-guide.cjs');
const world = require('../src/data/world-index.json');
const game = require('../src/data/game-index.json');
const codex = require('../src/data/codex-details.json');

const profile = { id: 'synthetic-early-branches', referenceMode: 'latest' };
const saved = (quests = [], extra = {}) => ({
  name: 'Synthetic.sav',
  hash: 'synthetic-early-branches',
  metadata: { quests, inventory: [], ...extra },
});
const active = (root, step, extra = {}) =>
  saved(
    [
      { id: root, step: 1 },
      { id: step, step: 1 },
    ],
    extra,
  );
const branches = [
  {
    id: 'xungu-night-breakout-choice',
    root: 5500,
    publicStep: 5514,
    hiddenStep: 5516,
    before: 5512,
    after: [5517, 5518, 5519, 5525],
  },
  {
    id: 'xungu-find-yaoji-choice',
    root: 5500,
    publicStep: 5536,
    hiddenStep: 5538,
    before: 5532,
    after: [5539, 5540, 5541, 5542, 5543, 5550, 5551],
  },
];
const collectionId = 'tianlong-hidden-passage-chests';
const newIds = [...branches.map((row) => row.id), collectionId];
const rules = guide.rules.filter((row) => newIds.includes(row.id));
const content = { sources: guide.sources, rules };
const project = (nativeChoices) =>
  createFlowProjector({ world, game, guide: content, nativeChoices }).flowSnapshot;
const rowIn = (flow, id) => flow.decisions.find((row) => row.id === id);
function absent(flow, id, detail = '') {
  for (const channel of ['decisions', 'warnings', 'advice', 'changes', 'opportunities'])
    assert(!flow[channel].some((row) => row.id === id), `${channel}: ${id} ${detail}`);
  assert(
    flow.guide.some((row) => row.id === id),
    'the reference remains searchable',
  );
}

const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );
const unescape = (value) =>
  value.replace(
    /&(amp|lt|gt|quot|#39);/g,
    (_, key) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[key],
  );
function visibleText(html) {
  const details = [];
  let result = '';
  for (const [token] of html.matchAll(/<[^>]*>|[^<]+/g)) {
    if (/^<details\b/.test(token)) details.push({ open: /\sopen(?:\s|>|=)/.test(token), summary: false });
    else if (/^<\/details/.test(token)) details.pop();
    else if (/^<summary\b/.test(token) && details.length) details.at(-1).summary = true;
    else if (/^<\/summary/.test(token) && details.length) details.at(-1).summary = false;
    else if (!token.startsWith('<') && details.every((row) => row.open || row.summary)) result += token;
  }
  return unescape(result);
}
const moduleUrls = new Map();
function rendererUrl(name) {
  if (moduleUrls.has(name)) return moduleUrls.get(name);
  let source = fs.readFileSync(path.join(__dirname, '../src/renderer', name), 'utf8');
  source = source.replace(
    /from '(\.\.?\/[^']+)'/g,
    (_, dependency) =>
      'from ' + JSON.stringify(rendererUrl(path.posix.join(path.posix.dirname(name), dependency))),
  );
  const url = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  moduleUrls.set(name, url);
  return url;
}
const views = Promise.all([
  import(rendererUrl('flow-views.js')),
  import(rendererUrl('entity-references.js')),
]).then(([{ createFlowViews }, { createEntityReferences }]) => {
  const index = encyclopedia();
  const references = createEntityReferences({
    index: () => index,
    esc,
    picture: () => '',
    icon: () => '',
    qualityText: { html: (_, label) => label },
  });
  return createFlowViews({
    esc,
    act: references.button,
    richText: (value, targets) => references.text(value, 'flow-quest', targets),
    icon: () => '',
    pill: esc,
    when: esc,
  });
});

test('early branch rules bind exact public context, tracked hidden choice, root and source Build', () => {
  assert.equal(rules.length, 3);
  for (const branch of branches) {
    const rule = rules.find((row) => row.id === branch.id);
    assert.equal(world.quests.find((row) => row.gameId === branch.publicStep).parentId, branch.root);
    assert.equal(
      world.quests.find((row) => row.gameId === branch.hiddenStep),
      undefined,
    );
    assert.equal(codex.hiddenSteps[branch.hiddenStep].ownerId, branch.root);
    assert.deepEqual(rule.decisionSteps, [branch.publicStep]);
    assert.deepEqual(rule.trackedDecisionSteps, [branch.hiddenStep]);
    assert.deepEqual(rule.coveredChoiceSteps, [branch.hiddenStep]);
    assert.equal(rule.requireDecisionWindow, true);
    assert.equal(rule.requireActiveRoot, true);
    assert.deepEqual(
      rule.choices.map((row) => row.label),
      codex.hiddenSteps[branch.hiddenStep].choices.map((row) => row.text),
    );
    assert(rule.sourceIds.some((id) => guide.sources[id].version === `Build ${world.build}`));
    assert(!guide.pickupQuests.some((row) => row.gameId === branch.hiddenStep));
  }
  assert.deepEqual(
    codex.hiddenSteps[5516].choices.map((row) => row.actions),
    [[{ type: 'JumpStep', id: 5517, value: 4 }], [{ type: 'JumpStep', id: 5519, value: 4 }]],
  );
  assert.deepEqual(
    codex.hiddenSteps[5538].choices.map((row) => row.actions),
    [
      [
        { type: 'JumpStep', id: 5539, value: 4 },
        { type: 'CQuestStep', id: 5538, value: 4 },
      ],
      [
        { type: 'JumpStep', id: 5541, value: 4 },
        { type: 'CQuestStep', id: 5538, value: 4 },
      ],
    ],
  );
});

for (const branch of branches) {
  test(`${branch.id} follows only active public context or its exact tracked active hidden step`, () => {
    assert(rowIn(flowSnapshot(profile, active(branch.root, branch.publicStep)), branch.id));
    const reference = active(branch.root, branch.hiddenStep, { trackingQuest: branch.hiddenStep });
    const before = JSON.stringify(reference);
    assert(rowIn(flowSnapshot(profile, reference), branch.id));
    assert.equal(JSON.stringify(reference), before, 'projection never modifies the synthetic source');
    assert(
      rowIn(
        flowSnapshot(
          profile,
          saved([...reference.metadata.quests, { id: branch.publicStep, step: 4 }], {
            trackingQuest: branch.hiddenStep,
          }),
        ),
        branch.id,
      ),
      'an actual tracked dialog can follow its completed visible context',
    );
    for (const trackingQuest of [undefined, branch.publicStep, 999999, String(branch.hiddenStep)])
      absent(flowSnapshot(profile, active(branch.root, branch.hiddenStep, { trackingQuest })), branch.id);
    const scenarios = [
      [],
      [{ id: branch.root, step: 1 }],
      [
        { id: branch.root, step: 1 },
        { id: branch.before, step: 1 },
      ],
      [
        { id: branch.root, step: 1 },
        { id: 999999, step: 1 },
      ],
      ...[branch.publicStep, branch.hiddenStep].flatMap((id) => [
        [{ id, step: 1 }],
        ...[0, 2, 3, 4, 99].map((step) => [
          { id: branch.root, step: 1 },
          { id, step },
        ]),
        ...[0, 2, 3, 4, 99].map((step) => [
          { id: branch.root, step },
          { id, step: 1 },
        ]),
      ]),
    ];
    for (const quests of scenarios)
      absent(
        flowSnapshot(profile, saved(quests, { trackingQuest: branch.hiddenStep, mapName: '峋谷关' })),
        branch.id,
        JSON.stringify(quests),
      );
    for (const after of branch.after)
      for (const step of [1, 2, 4])
        absent(
          flowSnapshot(
            profile,
            saved([...reference.metadata.quests, { id: branch.publicStep, step: 1 }, { id: after, step }], {
              trackingQuest: branch.hiddenStep,
            }),
          ),
          branch.id,
          `successor ${after}=${step}`,
        );
    for (const selected of [
      { ...profile, referenceMode: 'none' },
      { ...profile, referenceMode: 'slot', saveSlot: 'Missing.sav' },
    ])
      absent(flowSnapshot(selected, reference), branch.id);
    absent(flowSnapshot(profile, { name: 'Unreadable.sav', metadata: {} }), branch.id);
  });

  test(`${branch.id} never falls back to global hidden facts or accepts malformed ownership`, () => {
    const reference = active(branch.root, branch.hiddenStep, { trackingQuest: branch.hiddenStep });
    absent(project(undefined)(profile, reference), branch.id);
    absent(project({})(profile, reference), branch.id);
    const hidden = codex.hiddenSteps[branch.hiddenStep];
    assert(rowIn(project({ hiddenSteps: { [branch.hiddenStep]: hidden } })(profile, reference), branch.id));
    for (const changed of [
      { ...hidden, ownerPath: undefined },
      { ...hidden, ownerPath: [] },
      { ...hidden, ownerPath: [5600] },
      { ...hidden, ownerId: 5600 },
      { ...hidden, relatedQuestId: 999999 },
      { ...hidden, relatedQuestId: 5600, ownerPath: [5500, 5600] },
    ])
      absent(project({ hiddenSteps: { [branch.hiddenStep]: changed } })(profile, reference), branch.id);
  });
}

test('branch front text explains the risk and +20 belongs to the completed search, not the button', async () => {
  const view = await views;
  const night = rowIn(flowSnapshot(profile, active(5500, 5516, { trackingQuest: 5516 })), branches[0].id);
  const yaoji = rowIn(flowSnapshot(profile, active(5500, 5538, { trackingQuest: 5538 })), branches[1].id);
  assert.match(visibleText(view.choice(night)), /突出重围.*放下兵器.*坐牢.*三场/);
  assert.match(visibleText(view.choice(yaoji)), /先找瑶姬.*完成.*好感\+20/);
  assert.match(yaoji.choices[0].effect, /完成寻找剧情时瑶姬好感\+20/);
  assert.match(yaoji.recommendation.tradeoff, /不会立即到账.*不保证.*结局/);
  assert.equal(world.npcNames[17115], '瑶姬');
  assert.deepEqual(yaoji.recommendation.targets.people, [{ id: 'npc-17115', name: '瑶姬' }]);
  assert.match(view.choice(yaoji), /data-entity-id="npc-17115"/);
  for (const row of [night, yaoji]) {
    const flow = flowSnapshot(
      profile,
      active(5500, row.trackedDecisionSteps[0], { trackingQuest: row.trackedDecisionSteps[0] }),
    );
    const html = view.panel(flow);
    assert(
      !html.includes(`data-flow-native-choice="${row.trackedDecisionSteps[0]}"`),
      'curation covers only the exact hidden choice',
    );
    assert.doesNotMatch(visibleText(view.choice(row)), /Build|CYHD|未实机|原表|构建|资料说明/);
  }
});

test('dark passage collection follows only the two active exploration steps and retires before later events', () => {
  for (const current of [5647, 5652]) {
    const reference = active(5600, current, { mapName: '天龙帮暗道' });
    assert(rowIn(flowSnapshot(profile, reference), collectionId));
    const scenarios = [
      [],
      [{ id: 5600, step: 1 }],
      [{ id: current, step: 1 }],
      ...[5656, 5642, 5643].map((id) => [
        { id: 5600, step: 1 },
        { id, step: 1 },
      ]),
      ...[0, 2, 3, 4, 99].map((step) => [
        { id: 5600, step: 1 },
        { id: current, step },
      ]),
      ...[0, 2, 3, 4, 99].map((step) => [
        { id: 5600, step },
        { id: current, step: 1 },
      ]),
      ...[5653, 5654, 5655, 5657].flatMap((id) =>
        [1, 2, 4].map((step) => [...reference.metadata.quests, { id, step }]),
      ),
    ];
    for (const quests of scenarios)
      absent(
        flowSnapshot(profile, saved(quests, { mapName: '天龙帮暗道' })),
        collectionId,
        JSON.stringify(quests),
      );
  }
  absent(
    flowSnapshot(
      profile,
      saved([
        { id: 5600, step: 1 },
        { id: 5647, step: 1 },
        { id: 5652, step: 4 },
      ]),
    ),
    collectionId,
    'a stale exploration step cannot reopen the completed final preparation',
  );
  const afterFirstSegment = saved(
    [
      { id: 5600, step: 1 },
      { id: 5647, step: 4 },
      { id: 5652, step: 1 },
    ],
    { questsComplete: true },
  );
  assert(
    rowIn(flowSnapshot(profile, afterFirstSegment), collectionId),
    'completed travel is not proof of six opened chests',
  );
});

test('the six chest entries use exact map and item identities and render their rewards inside details', async () => {
  const rule = rules.find((row) => row.id === collectionId);
  assert.equal(world.maps.find((row) => row.id === 'place-308').key, 'LV_TLB_P1');
  assert.deepEqual(rule.recommendation.targets.places, [{ id: 'place-308', name: '天龙帮暗道' }]);
  assert.deepEqual(rule.choices, [], 'collection stops are not dialog options');
  assert.deepEqual(
    rule.collectionStops.map((row) => row.gatherId).sort(),
    [1281, 1282, 1283, 1284, 1285, 1286],
  );
  // These finite identities and quantities were independently read from the installed Build's
  // six map actor DefIds and Gathers; test execution uses no installed-game or private input.
  const rewards = {
    1281: [
      [10264, 2],
      [10271, 2],
      [10278, 2],
      [2019, 1],
    ],
    1282: [
      [10224, 1],
      [10222, 1],
      [113, 1],
      [116, 1],
    ],
    1283: [
      [121, 1],
      [10297, 1],
      [100244, 1],
    ],
    1284: [
      [159, 3],
      [10208, 3],
      [139, 2],
    ],
    1285: [
      [10053, 1],
      [10100, 1],
      [9017, 1],
      [133, 3],
    ],
    1286: [
      [10178, 1],
      [10160, 1],
      [10292, 1],
    ],
  };
  const view = await views;
  const row = rowIn(flowSnapshot(profile, active(5600, 5652)), collectionId);
  const html = view.choice(row, { compact: true });
  const front = visibleText(html);
  assert.match(front, /追上曹煜天前.*六箱.*一次性/);
  assert.match(front, /六处宝箱与奖励/);
  assert.doesNotMatch(front, /尖刺机关|双排地火|杂物堆|犀角|铅锭|Build|原表|构建/);
  assert.equal((html.match(/data-flow-collection-stops/g) || []).length, 1);
  const expanded = visibleText(
    html.replace('<details class="flow-choice-details"', '<details open class="flow-choice-details"'),
  );
  assert.match(expanded, /尖刺机关左侧/);
  assert.doesNotMatch(expanded, /推荐做法：|为什么：|适合：/);
  assert.match(expanded, /路线与资料/);
  for (const stop of row.collectionStops) {
    assert(html.includes(`data-gather-id="${stop.gatherId}"`));
    const expected = rewards[stop.gatherId].map(([id, quantity]) => {
      const item = game.entries.find((entry) => entry.id === `item-${id}`);
      assert.equal(item.kind, '物品');
      assert(stop.effect.includes(`${item.name}×${quantity}`));
      assert(html.includes(`data-entity-id="item-${id}"`));
      return { id: item.id, name: item.name };
    });
    assert.deepEqual(stop.targets.items, expected);
  }
  assert.match(row.collectionStops.find((stop) => stop.gatherId === 1283).label, /尖刺机关左侧/);
  assert.match(row.collectionStops.find((stop) => stop.gatherId === 1284).label, /双排地火机关中段/);
  assert.match(
    row.collectionStops.find((stop) => stop.gatherId === 1282).label,
    /第二场杂兵战后.*杂物堆左边/,
  );
  assert.match(row.uncertainty, /步骤结束不表示宝箱已收齐/);
  assert.match(row.recommendation.tradeoff, /不能判断哪些箱已开/);
  assert.doesNotMatch(html, /本次已收齐|宝箱已全部|永久绝版|唯一来源/);
});
