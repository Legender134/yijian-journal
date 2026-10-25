'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { flowSnapshot } = require('../src/core/flow.cjs');
const guide = require('../src/data/flow-guide.cjs');
const world = require('../src/data/world-index.json');
const choiceId = 'early-sun-homesickness-choice';
const honeyId = 'sun-honey-delivery';
const flowerId = 'sun-begonia-return';
const profile = { id: 'synthetic-sun', referenceMode: 'latest' };
const reference = (pairs, extra = {}) => ({
  name: 'Synthetic.sav',
  hash: 'synthetic-sun',
  metadata: { quests: pairs.map(([id, step]) => ({ id, step })), inventory: [], ...extra },
});
const current = (pairs, extra, selected = profile) => flowSnapshot(selected, reference(pairs, extra));
const scope = (flow) => ({
  ...flow,
  guide: flow.guide.filter((row) => [choiceId, honeyId, flowerId].includes(row.id)),
  advice: flow.advice.filter((row) => [honeyId, flowerId].includes(row.id)),
  opportunities: [],
  warnings: [],
  changes: [],
  chapter: null,
  chapters: [],
});
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const views = import(pathToFileURL(path.join(__dirname, '../src/renderer/flow-views.js')).href).then(
  ({ createFlowViews }) =>
    createFlowViews({
      esc,
      act: (action, label, cls, id) =>
        `<button class="${esc(cls)}" data-action="${esc(action)}" data-id="${esc(id)}">${label}</button>`,
      icon: esc,
      pill: esc,
      when: esc,
    }),
);

test('the actual Sun Lao choice gives concise current rewards and a specific later payoff', async () => {
  const row = current([
    [5059, 4],
    [11060, 1],
    [11061, 1],
  ]).decisions.find((entry) => entry.id === choiceId);
  assert(row);
  assert.match(row.recommendation.reason, /秋海棠.*二转洗髓丹.*武学感悟/);
  assert.match(row.recommendation.tradeoff, /600铜钱.*铁匠好感\+10.*仍有药谷取蜜分支/);
  assert.match(row.choices[0].effect, /辛金丸、乙木丹、武学笔记各1.*孙老好感\+10/);
  assert.match(row.choices[1].effect, /600铜钱.*铁匠好感\+10/);
  assert.equal(row.uncertainty, undefined);
  for (const compact of [false, true]) {
    const html = (await views).choice(row, { compact });
    const brief = html.slice(0, html.indexOf('<details'));
    assert.match(brief, /返乡取丹药.*送花换铜钱与铁匠好感/);
    assert.doesNotMatch(brief, /600|好感\+10/);
    assert.match(html, /600铜钱/);
    assert.match(html, /秋海棠/);
    assert.match(html, /data-action="flow-quest"[^>]*data-id="quest-11060"/);
    assert.doesNotMatch(html, /2024|较新表|旧版|v1\.24|10273|永久锁死/);
  }
});

test('early completion leaves honey as an optional distant lead, without current delivery advice or decisions', () => {
  for (const pairs of [
    [
      [11060, 4],
      [11062, 4],
    ],
    [
      [11060, 4],
      [11063, 4],
    ],
  ]) {
    const flow = current(pairs, { mapName: '梧桐村' });
    assert(!flow.advice.some((row) => [honeyId, flowerId].includes(row.id)));
    assert(!flow.decisions.some((row) => [honeyId, flowerId].includes(row.id)));
    const lead = flow.opportunities.find((row) => row.questId === 11685);
    assert(lead);
    assert.match(lead.pickup.place, /南疆.*石屏村/);
    assert.match(lead.pickup.action, /龙桑加.*药谷取蜜/);
  }
});

test('Sun Lao does not appear from an early chapter before half-lotus delivery, and remains available later or already active', () => {
  const rule = guide.rules.find((entry) => entry.id === choiceId);
  assert.deepEqual(rule.chapterRoots, []);
  assert.deepEqual(rule.afterAllComplete, [5059]);
  for (const main of [5020, 5780]) {
    for (const status of [undefined, 0, 1, 2, 3, 4]) {
      const flow = current([[main, 1], ...(status === undefined ? [] : [[5059, status]])]);
      assert.equal(
        flow.advice.some((row) => row.id === choiceId),
        status === 4,
        `${main}:${status}`,
      );
      assert(!flow.decisions.some((row) => row.id === choiceId));
    }
  }
  for (const anchors of [[], [[5059, 4]]]) {
    const flow = current([[11060, 1], [11061, 1], ...anchors]);
    assert(
      flow.decisions.some((row) => row.id === choiceId),
      'an actual active choice keeps its recommendation',
    );
  }
  for (const status of [2, 4]) {
    const flow = current([
      [5059, 4],
      [11060, 1],
      [11061, status],
    ]);
    assert(!flow.decisions.some((row) => row.id === choiceId));
    assert(!flow.advice.some((row) => row.id === choiceId));
    assert(flow.guide.some((row) => row.id === choiceId));
  }
});

test('either accepted honey step gives the same current collection and return instructions', async () => {
  for (const stepId of [11686, 11687]) {
    const pairs = [[11060, 4], ...(stepId === 11686 ? [[11062, 4]] : []), [11685, 1], [stepId, 1]];
    const saved = reference(pairs, { mapName: '石屏村', inventory: [{ id: 10332, count: 2 }] });
    const untouched = structuredClone(saved);
    const flow = flowSnapshot(profile, saved);
    const row = flow.guide.find((entry) => entry.id === honeyId);
    assert(row);
    assert.equal(row.activeRule, true);
    assert.equal(row.warning, undefined);
    assert.match(row.steps.join(' '), /石屏村向西.*百药谷.*蜂群.*回石屏村.*龙桑加/);
    assert.doesNotMatch(row.steps.join(' '), /秋海棠|睹物思乡|10273/);
    assert(!flow.decisions.some((entry) => entry.id === honeyId));
    assert(!flow.advice.some((entry) => entry.id === honeyId));
    assert(!flow.advice.some((entry) => entry.id === flowerId));
    assert.deepEqual(saved, untouched);
    for (const compact of [false, true]) {
      const html = (await views).panel(scope(flow), { compact });
      assert.doesNotMatch(html, /data-flow-suggestion="sun-honey-delivery"/);
      assert.match(html, /data-flow-rule="sun-honey-delivery"/);
      assert.match(html, /data-action="flow-quest"[^>]*data-id="quest-11685"/);
      assert.match(html, /<details[^>]*><summary>做法与影响<\/summary>/);
      assert.doesNotMatch(html, /item-10273|物品 #10273/);
    }
  }
});

test('a saved begonia delivery leads back to Sun Lao with the actual hand-in rewards', async () => {
  for (const pairs of [
    [[11689, 1]],
    [
      [11685, 4],
      [11686, 4],
      [11688, 1],
      [11689, 1],
    ],
  ]) {
    const flow = current(pairs, { mapName: '石屏村', inventory: [{ id: 10371, count: 1 }] });
    const row = flow.guide.find((entry) => entry.id === flowerId);
    assert(row);
    assert.equal(row.warning, undefined);
    assert.match(row.steps.join(' '), /秋海棠×1.*梧桐村孙老/);
    assert.match(row.steps.join(' '), /孙老好感\+20.*金疮药×5.*二转洗髓丹×1.*三品宁神丹×2.*武学感悟×1/);
    assert(!flow.advice.some((entry) => entry.id === honeyId));
    assert(!flow.decisions.some((entry) => entry.id === flowerId));
    assert(!flow.advice.some((entry) => entry.id === flowerId));
    const step = flow.active
      .find((entry) => entry.gameId === 11688)
      .steps.find((entry) => entry.id === 'quest-11689');
    assert.equal(step.targets.materialState, 'ready');
    assert.match(step.nextAction, /孙老.*交付|交给.*孙/);
    assert(step.targets.people.some((person) => person.ids.includes(10001)));
    for (const compact of [false, true]) {
      const html = (await views).panel(scope(flow), { compact });
      assert.doesNotMatch(html, /data-flow-suggestion="sun-begonia-return"/);
      assert.match(html, /data-flow-rule="sun-begonia-return"/);
      assert.match(html, /data-action="flow-quest"[^>]*data-id="quest-11688"/);
      assert.match(html, /data-action="database-detail"[^>]*data-id="npc-10001"/);
    }
  }
});

test('completed or failed roots and delivery steps retire current tasks while historical guides remain', () => {
  for (const [root, children, id] of [
    [11685, [11686, 11687], honeyId],
    [11688, [11689], flowerId],
  ]) {
    for (const status of [2, 4]) {
      for (const pairs of [
        [
          [root, status],
          [children[0], 1],
        ],
        ...children.map((child) => [[child, status]]),
      ]) {
        const flow = current(pairs);
        for (const list of [flow.advice, flow.decisions, flow.warnings, flow.opportunities])
          assert(!list.some((row) => row.id === id), JSON.stringify(pairs));
        assert(flow.guide.some((row) => row.id === id));
        assert(!flow.active.some((row) => row.gameId === root), JSON.stringify(pairs));
      }
    }
  }
});

test('both follow-ups use ordinary families and the existing public quest identities', () => {
  for (const [id, questId] of [
    [honeyId, 11685],
    [flowerId, 11688],
  ]) {
    const row = guide.rules.find((entry) => entry.id === id);
    assert.equal(row.questId, questId);
    assert.equal(row.decisionSteps, undefined);
    assert.equal(row.warning, undefined);
    assert.deepEqual(row.chapterRoots, []);
    assert.deepEqual(row.afterAllComplete, []);
    assert(world.quests.some((entry) => entry.id === `quest-${questId}`));
    for (const selected of [
      { ...profile, referenceMode: 'none' },
      { ...profile, referenceMode: 'slot', saveSlot: 'Other.sav' },
    ]) {
      const flow = current(
        [
          [11686, 1],
          [11689, 1],
        ],
        {},
        selected,
      );
      assert(!flow.advice.some((entry) => entry.id === id));
      assert(!flow.decisions.some((entry) => entry.id === id));
      assert(flow.guide.some((entry) => entry.id === id));
    }
  }
});

test('shared honey route reaches the codex and missing materials, while stock 0/4/5 switches the real objective', () => {
  const material = require('../src/data/material-guide.cjs').items[10332];
  assert.equal(material.routes.length, 1);
  const route = material.routes[0];
  assert.equal(route.kind, 'drop');
  assert.equal(route.placeId, 'place-903');
  assert.equal(route.label, '百药谷·击败蜜蜂');
  assert.equal(route.efficiency, undefined);
  assert.doesNotMatch(route.detail, /60|100|概率|刷新|未知|未核实/);
  const index = require('../src/core/game-data.cjs').encyclopedia();
  const codex = index.entries
    .find((entry) => entry.id === 'item-10332')
    .gatheringRoutes.find((entry) => entry.placeId === 'place-903');
  assert.equal(codex.detail, route.detail);
  assert.equal(codex.label, route.label);
  assert.deepEqual(codex.sourceIds, route.sourceIds);
  const objectives = require('../src/data/task-objective-guide.json');
  for (const stepId of [11686, 11687]) {
    assert.deepEqual(Object.keys(objectives[stepId]).sort(), ['evidenceQuestIds', 'instruction']);
    for (const count of [0, 4, 5]) {
      const flow = current([[11060, 4], ...(stepId === 11686 ? [[11062, 4]] : []), [11685, 1], [stepId, 1]], {
        inventory: [{ id: 10332, count }],
      });
      const step = flow.active
        .find((entry) => entry.gameId === 11685)
        .steps.find((entry) => entry.id === 'quest-' + stepId);
      const missing = step.materials.find((entry) => entry.id === 'item-10332');
      assert.equal(missing.missing, Math.max(0, 5 - count));
      const sameRoute = missing.routes.find(
        (entry) => entry.placeId === route.placeId && entry.kind === route.kind,
      );
      assert(sameRoute);
      assert.equal(sameRoute.label, route.label);
      assert.equal(sameRoute.detail, route.detail);
      assert.deepEqual(sameRoute.sourceIds, route.sourceIds);
      if (count < 5) {
        assert.equal(step.targets.materialState, 'missing');
        assert.equal(step.nextAction, '前往百药谷收集蜂蜜');
        assert(
          step.targets.places.some(
            (place) =>
              place.id === route.placeId &&
              place.purpose === 'material-source' &&
              place.materialIds.includes(10332),
          ),
        );
        assert(!step.targets.people.some((person) => person.ids.includes(12702)));
      } else {
        assert.equal(step.targets.materialState, 'ready');
        assert.equal(step.nextAction, '向龙桑加交付');
        assert(step.targets.people.some((person) => person.ids.includes(12702) && person.role === '交付'));
        assert(!step.targets.places.some((place) => place.purpose === 'material-source'));
        assert(step.targets.places.some((place) => place.name === '石屏村' && place.purpose === 'turn-in'));
      }
    }
  }
});
