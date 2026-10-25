'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createFlowProjector, flowSnapshot } = require('../src/core/flow.cjs');
const { encyclopedia } = require('../src/core/game-data.cjs');
const guide = require('../src/data/flow-guide.cjs');
const contracts = require('../src/data/live-choice-contracts.json');
const world = require('../src/data/world-index.json');
const game = require('../src/data/game-index.json');
const codex = require('../src/data/codex-details.json');

const profile = { id: 'synthetic-wanjie-huainan', referenceMode: 'latest' };
const specs = [
  { id: 'wanjie-ask-before-fighting-choice', root: 5700, lead: 5704, step: 5707, buttons: ['询问原委', '直接动手'], next: [5708, 5709] },
  { id: 'wanjie-cooperate-choice', root: 5700, lead: 5704, step: 5710, buttons: ['同意', '拒绝'], next: [5711, 5712] },
  { id: 'huainan-dream-cure-choice', root: 18000, lead: 18002, step: 18022, buttons: ['拒绝解蛊', '同意解蛊'], next: [18023, 18035] },
];
const ids = specs.map((row) => row.id);
const rules = guide.rules.filter((row) => ids.includes(row.id));
const byId = (id) => rules.find((row) => row.id === id);
const saved = (quests, extra = {}) => ({
  name: 'Synthetic.sav', hash: 'synthetic-wanjie-huainan',
  metadata: { quests, inventory: [], ...extra },
});
const reference = (spec, publicLead = true) => saved([
  { id: spec.root, step: 1 },
  ...(publicLead ? [{ id: spec.lead, step: 1 }] : []),
  { id: spec.step, step: 1 },
], { trackingQuest: spec.step });
const projected = (nativeChoices = codex) => createFlowProjector({
  world, game, guide: { sources: guide.sources, rules }, nativeChoices,
}).flowSnapshot;
const rowIn = (flow, id) => flow.decisions.find((row) => row.id === id);
function absent(flow, id, context = '') {
  for (const channel of ['decisions', 'warnings', 'advice', 'changes', 'opportunities'])
    assert(!flow[channel].some((row) => row.id === id), `${channel}: ${id} ${context}`);
  assert(flow.guide.some((row) => row.id === id), 'resolved choices remain available as reference');
}

test('the three previously unprojected choices bind exact same-Build owners and complete native buttons', () => {
  assert.equal(rules.length, 3);
  for (const spec of specs) {
    const rule = byId(spec.id);
    const hidden = codex.hiddenSteps[spec.step];
    const contract = contracts.contracts.find((row) => row.questId === spec.step);
    assert.equal(rule.questId, spec.root);
    assert.equal(rule.requireActiveRoot, true);
    assert.equal(rule.requireDecisionWindow, true);
    assert.deepEqual(rule.chapterRoots, []);
    assert.deepEqual(rule.trackedDecisionSteps, [spec.step]);
    assert.deepEqual(rule.coveredChoiceSteps, [spec.step]);
    assert.equal(hidden.ownerId, spec.root);
    assert.deepEqual(hidden.ownerPath, [spec.root]);
    assert.equal(hidden.relatedQuestId, spec.root);
    assert.deepEqual(hidden.choices.map((row) => row.text), spec.buttons);
    assert(hidden.choices.every((row) => !row.requirements.length));
    assert.deepEqual(hidden.choices.map((row) => row.actions.filter((action) => action.type === 'JumpStep').map((action) => action.id)), spec.next.map((id) => [id]));
    assert.equal(contract.rootQuestId, spec.root);
    assert.equal(contract.ruleId, spec.id);
    assert.equal(contract.npcPolicy, 'contextual');
    assert.deepEqual(contract.options, spec.buttons.map((text, choiceIndex) => ({ text, choiceIndex })));
    assert(rule.sourceIds.some((id) => guide.sources[id].version === `Build ${world.build}`));
    const input = reference(spec);
    const before = JSON.stringify(input);
    assert(rowIn(flowSnapshot(profile, input), spec.id), `the reported missing ${spec.step} now projects`);
    assert.equal(JSON.stringify(input), before);
  }
});

test('the first Wanjie warning arrives at 5704, then yields to the exact cooperation dialog', () => {
  const first = specs[0];
  assert.deepEqual(byId(first.id).decisionSteps, [5704]);
  assert.deepEqual(byId(specs[1].id).decisionSteps, []);
  assert.deepEqual(byId(specs[2].id).decisionSteps, []);
  const early = projected()(profile, saved([{ id: 5700, step: 1 }, { id: 5704, step: 1 }]));
  assert.deepEqual(early.decisions.map((row) => row.id), [first.id]);
  const next = projected()(profile, reference(specs[1]));
  assert.deepEqual(next.decisions.map((row) => row.id), [specs[1].id]);
  for (const spec of specs.slice(1)) {
    absent(projected()(profile, saved([{ id: spec.root, step: 1 }, { id: spec.lead, step: 1 }])), spec.id);
  }
});

for (const spec of specs) {
  test(`${spec.step} requires its active root, exact tracked hidden row and canonical ownership`, () => {
    const project = projected();
    const input = reference(spec, false);
    assert(rowIn(project(profile, input), spec.id));
    const scenarios = [
      [],
      [{ id: spec.root, step: 1 }],
      [{ id: spec.step, step: 1 }],
      [{ id: 999999, step: 1 }, { id: spec.step, step: 1 }],
      ...[0, 2, 3, 4, 99].map((step) => [{ id: spec.root, step }, { id: spec.step, step: 1 }]),
      ...[0, 2, 3, 4, 99].map((step) => [{ id: spec.root, step: 1 }, { id: spec.step, step }]),
    ];
    for (const quests of scenarios)
      absent(project(profile, saved(quests, { trackingQuest: spec.step, mapName: spec.root === 5700 ? '万劫窟' : '百药谷' })), spec.id, JSON.stringify(quests));
    for (const trackingQuest of [undefined, spec.lead, 999999, String(spec.step)])
      absent(project(profile, saved(input.metadata.quests, { trackingQuest })), spec.id, `tracking=${trackingQuest}`);
    absent(projected(null)(profile, input), spec.id, 'no hidden-row proof');
    for (const hidden of [
      { ...codex.hiddenSteps[spec.step], ownerPath: [] },
      { ...codex.hiddenSteps[spec.step], ownerId: spec.root === 5700 ? 18000 : 5700 },
      { ...codex.hiddenSteps[spec.step], relatedQuestId: 999999 },
    ]) absent(projected({ hiddenSteps: { [spec.step]: hidden } })(profile, input), spec.id, 'wrong hidden ownership');
    for (const selected of [
      { ...profile, referenceMode: 'none' },
      { ...profile, referenceMode: 'slot', saveSlot: 'Missing.sav' },
    ]) absent(project(selected, input), spec.id);
    absent(project(profile, { name: 'Unreadable.sav', metadata: {} }), spec.id);
  });
}

test('resolved choices and every known later branch retire even with a stale active lead', () => {
  for (const spec of specs) {
    const input = reference(spec);
    for (const step of [2, 4]) {
      const quests = input.metadata.quests.map((row) => row.id === spec.step ? { ...row, step } : row);
      absent(projected()(profile, saved(quests, { trackingQuest: spec.step })), spec.id, `own state=${step}`);
    }
    for (const id of byId(spec.id).untilAnyStarted)
      for (const step of [1, 2, 4])
        absent(projected()(profile, saved([...input.metadata.quests, { id, step }], { trackingQuest: spec.step })), spec.id, `later ${id}=${step}`);
    for (const id of byId(spec.id).untilAnyRecorded || [])
      for (const step of [0, 1, 2, 3, 4, 99])
        absent(projected()(profile, saved([...input.metadata.quests, { id, step }], { trackingQuest: spec.step })), spec.id, `recorded ${id}=${step}`);
  }
});

test('the cooperation requirement survives both alternative paths reaching the same return step', () => {
  const id = 'wanjie-yaoji-hidden-cave';
  const quests = [{ id: 5700, step: 1 }, { id: 5720, step: 1 }];
  for (const alternative of [5709, 5712]) {
    const input = saved([...quests, { id: alternative, step: 4 }, { id: 5713, step: 4 }, { id: 5714, step: 4 }]);
    absent(flowSnapshot(profile, input), id, 'self-mining does not establish 5719');
    for (const spec of specs.slice(0, 2)) absent(flowSnapshot(profile, input), spec.id);
  }
  assert(rowIn(flowSnapshot(profile, saved([...quests, { id: 5719, step: 4 }])), id));
  absent(flowSnapshot(profile, saved([...quests, { id: 5719, step: 4 }, { id: 5722, step: 0 }])), id);
  assert.match(byId(specs[0].id).choices[0].effect, /下一次.*选择.*仅询问还没有完成合作/);
  assert.match(byId(specs[1].id).choices[0].effect, /完成战斗、回报.*才.*合作回报条件.*尚未触发.*未推进离洞后续/);
  for (const spec of specs.slice(0, 2)) {
    const rule = byId(spec.id);
    assert.match(rule.choices[1].effect, /战斗.*胜利.*自行.*不经过.*合作回报/);
    assert.doesNotMatch(rule.choices.map((row) => row.effect).join(''), /永久|绝版|唯一来源|当场.*丹方/);
  }
});

test('Huainan rewards remain attached to four separate completion steps and two exclusive routes', () => {
  const rule = byId(specs[2].id);
  const raw = (id) => codex.hiddenSteps[id] || codex.quests[id];
  const rewards = {
    18030: [{ type: 'CItem', id: 136, value: 3 }, { type: 'CItem', id: 10315, value: 1 }],
    18031: [{ type: 'CMoney', id: 1, value: 10000 }, { type: 'CItem', id: 10570, value: 1 }, { type: 'CItem', id: 156, value: 10 }],
    18035: [{ type: 'CItem', id: 136, value: 2 }, { type: 'CItem', id: 114, value: 2 }, { type: 'CItem', id: 10463, value: 1 }],
    18036: [{ type: 'CMoney', id: 1, value: 5000 }, { type: 'CItem', id: 156, value: 5 }],
  };
  for (const [id, expected] of Object.entries(rewards))
    for (const difficulty of raw(id).finish)
      assert.deepEqual(difficulty.filter((row) => ['CItem', 'CMoney'].includes(row.type) && row.value > 0), expected);
  for (const difficulty of raw(18027).finish) {
    assert(!difficulty.some((row) => ['CItem', 'CMoney'].includes(row.type) && row.value > 0));
    for (const id of [18030, 18031]) assert(difficulty.some((row) => row.type === 'CQuestStep' && row.id === id && row.value === 1));
  }
  assert(raw(18036).finish[0].some((row) => row.type === 'CItem' && row.id === 10463 && row.value === -1));
  assert(raw(18036).finish[0].some((row) => row.type === 'CItem' && row.id === 10464 && row.value === -1));
  const refuse = rule.choices[0].effect;
  const agree = rule.choices[1].effect;
  assert.match(refuse, /完成白首不相离才开启.*完成雅姑对话得没药×1、武学感悟×3.*完成寨阿龙对话得龙骨×1、铜钱10000、蜂王浆×10/);
  assert.match(refuse, /开启对话时尚未领取/);
  assert.match(agree, /完成这段剧情时得武学感悟×2、乙木丹×2及槐花×1.*再交出槐花与银梳、完成交付时得铜钱5000、蜂王浆×5/);
  assert.doesNotMatch(refuse, /乙木丹|5000|必得|当场/);
  assert.doesNotMatch(agree, /10000|没药|龙骨|蜂王浆×10|必得|当场/);
  assert.doesNotMatch(JSON.stringify(rule), /三日|永久死亡|全局最优/);
});

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
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
  return result.replace(/&(amp|lt|gt|quot|#39);/g, (_, key) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[key]);
}
const moduleUrls = new Map();
function rendererUrl(name) {
  if (moduleUrls.has(name)) return moduleUrls.get(name);
  let source = fs.readFileSync(path.join(__dirname, '../src/renderer', name), 'utf8');
  source = source.replace(/from '(\.\.?\/[^']+)'/g, (_, dependency) => 'from ' + JSON.stringify(rendererUrl(path.posix.join(path.posix.dirname(name), dependency))));
  const url = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  moduleUrls.set(name, url);
  return url;
}
const views = Promise.all([import(rendererUrl('flow-views.js')), import(rendererUrl('entity-references.js'))]).then(([{ createFlowViews }, { createEntityReferences }]) => {
  const index = encyclopedia();
  const refs = createEntityReferences({ index: () => index, esc, picture: () => '', icon: () => '', qualityText: { html: (_, label) => label } });
  return createFlowViews({ esc, act: refs.button, richText: (value, targets) => refs.text(value, 'flow-quest', targets), icon: () => '', pill: esc, when: esc });
});

test('main and companion first layers name an action and a concrete benefit or tradeoff, with detail folded', async () => {
  const render = await views;
  const visible = [];
  for (const spec of specs) {
    const row = rowIn(flowSnapshot(profile, reference(spec)), spec.id);
    for (const compact of [false, true]) {
      const html = render.choice(row, { compact });
      const lead = visibleText(html);
      visible.push({ id: spec.id, compact, text: lead });
      assert(lead.includes(row.recommendation.hint));
      assert.doesNotMatch(lead, /5719|18035|18036|资料来源|Build|永久|LV_|铜钱10000|蜂王浆×10/);
      assert(!lead.includes(row.choices[0].effect));
      assert(!lead.includes(row.recommendation.tradeoff));
      assert.equal((html.match(/<details class="flow-choice-details"/g) || []).length, 1);
      const expanded = visibleText(html.replace('<details class="flow-choice-details"', '<details open class="flow-choice-details"'));
      assert(expanded.includes(row.choices[0].effect));
      assert(expanded.includes(row.choices[1].effect));
      assert(html.includes('<summary>资料来源</summary>'));
      const known = new Set([...game.entries, ...world.people, ...world.maps].map((entry) => entry.id));
      for (const holder of [row.recommendation, ...row.choices])
        for (const targets of Object.values(holder.targets || {}))
          for (const target of targets) {
            assert(known.has(target.id), `exact target ${target.id}`);
            assert(html.includes(`data-entity-id="${target.id}"`), `shared entity link ${target.id}`);
          }
    }
  }
  assert.match(visible[0].text, /询问原委.*同意合作.*密洞.*四转洗髓丹.*丹方/);
  assert.match(visible[2].text, /同意.*击败匪首.*回折万劫窟密洞.*瑶姬.*丹方/);
  assert.match(visible[4].text, /拒绝解蛊.*重聚.*乙木丹×2.*同意解蛊.*完成其剧情/);
});

const routeId = 'huainan-dream-flower-comb-route';
const route = guide.rules.find((row) => row.id === routeId);
const beforeCollection = () => saved([{ id: 18000, step: 1 }, { id: 18002, step: 1 }]);

test('Huainan first warns before either ground interaction while preserving the original flower objective for fallback', () => {
  assert.equal(route.questId, 18000);
  assert.equal(route.requireActiveRoot, true);
  assert.equal(route.requireDecisionWindow, true);
  assert.deepEqual(route.decisionSteps, [18002]);
  assert.deepEqual(route.chapterRoots, []);
  assert.equal(route.trackedDecisionSteps, undefined);
  assert.equal(route.coveredChoiceSteps, undefined);
  assert.equal(world.maps.find((row) => row.id === 'place-903').key, 'LV_903_P');
  assert.equal(world.people.find((row) => row.id === 'npc-8506').name, '飞蝎使-娜乌');
  const input = beforeCollection();
  const original = JSON.stringify(input);
  const flow = flowSnapshot(profile, input);
  assert(rowIn(flow, routeId));
  assert(!rowIn(flow, specs[2].id), 'the later cure dialog is still a different window');
  const current = flow.active.find((row) => row.gameId === 18000).steps.find((row) => row.id === 'quest-18002');
  assert.equal(current.nextAction, '前往百药谷东侧，寻找白色的槐花');
  assert(rowIn(flowSnapshot(profile, saved([...input.metadata.quests, { id: 18006, step: 4 }])), routeId), 'the tree introduction does not choose a collectible');
  assert.equal(JSON.stringify(input), original);
});

test('the flower and comb route needs both active records and does not infer a window from a map or tracking alone', () => {
  for (const quests of [
    [], [{ id: 18000, step: 1 }], [{ id: 18002, step: 1 }],
    [{ id: 5700, step: 1 }, { id: 18002, step: 1 }],
    ...[0, 2, 3, 4, 99].map((step) => [{ id: 18000, step }, { id: 18002, step: 1 }]),
    ...[0, 2, 3, 4, 99].map((step) => [{ id: 18000, step: 1 }, { id: 18002, step }]),
  ]) absent(flowSnapshot(profile, saved(quests, { trackingQuest: 18002, mapName: '百药谷' })), routeId, JSON.stringify(quests));
  for (const selected of [
    { ...profile, referenceMode: 'none' },
    { ...profile, referenceMode: 'slot', saveSlot: 'Missing.sav' },
  ]) absent(flowSnapshot(selected, beforeCollection()), routeId);
  absent(flowSnapshot(profile, { name: 'Unreadable.sav', metadata: {} }), routeId);
});

test('ground interaction starts retire the early route, while an arbitrary 18007 or 18008 record does not mean a comb was selected', () => {
  assert(route.untilAnyStarted.includes(18003), 'the flower actor dispatches 18003');
  assert(route.untilAnyStarted.includes(18010), 'the stone-pile actor dispatches 18010 before the later cure choice');
  assert.deepEqual(route.untilAnyComplete, [18007, 18008]);
  assert.equal(route.untilAnyRecorded, undefined);
  for (const id of route.untilAnyStarted)
    for (const step of [1, 2, 4])
      absent(flowSnapshot(profile, saved([...beforeCollection().metadata.quests, { id, step }])), routeId, `${id}=${step}`);
  for (const id of [18007, 18008]) {
    absent(flowSnapshot(profile, saved([...beforeCollection().metadata.quests, { id, step: 4 }])), routeId, 'scene visibility closes only on completion');
    for (const step of [0, 1, 2, 3, 99])
      assert(rowIn(flowSnapshot(profile, saved([...beforeCollection().metadata.quests, { id, step }])), routeId), `${id}=${step} is not proof of either selected route`);
  }
  const later = flowSnapshot(profile, reference(specs[2]));
  assert(rowIn(later, specs[2].id));
  absent(later, routeId, 'the precise cure dialog replaces the old collection advice');
});

test('the early route keeps flower hand-in rewards separate, states the Nawu and victory requirements, and creates no native flower or comb buttons', () => {
  const flower = codex.hiddenSteps[18003];
  const handIn = codex.quests[18004];
  for (const actions of flower.finish) {
    for (const id of [18002, 18007, 18008]) assert(actions.some((row) => row.type === 'CQuestStep' && row.id === id && row.value === 4));
    assert(actions.some((row) => row.type === 'CItem' && row.id === 10463 && row.value === 1));
    assert(actions.some((row) => row.type === 'JumpStep' && row.id === 18004 && row.value === 1));
  }
  for (const actions of handIn.finish) {
    assert.deepEqual(actions.filter((row) => ['CItem', 'CMoney'].includes(row.type) && row.value > 0), [
      { type: 'CMoney', id: 1, value: 1000 }, { type: 'CItem', id: 156, value: 2 },
    ]);
    assert(actions.some((row) => row.type === 'CQuestStep' && row.id === 18000 && row.value === 4));
  }
  assert.match(route.choices[0].effect, /胜利且娜乌在队才继续/);
  assert.match(route.choices[1].effect, /完成交付后得铜钱1000、蜂王浆×2.*结束本任务/);
  assert.match(route.uncertainty, /战斗失败.*娜乌不在队.*归还银梳并返回拾花/);
  assert.doesNotMatch(route.choices[1].effect, /乙木丹|武学感悟|龙骨|10000|5000|永久|全局绝版/);
  assert(!contracts.contracts.some((row) => [18002, 18003, 18007, 18008, 18010].includes(row.questId)));
  const invented = flowSnapshot(profile, null, '', { dialogue: { schema: 1, sequence: 1, questId: 18002, npcId: 0, options: [{ index: 1, text: '花' }, { index: 2, text: '梳子' }] } });
  assert.equal(invented.liveDialogue.matched, false);
  assert.deepEqual(invented.decisions, []);
});

test('both panels first explain the actual stone-pile interaction and preserve precise links with route details folded', async () => {
  const render = await views;
  const flow = flowSnapshot(profile, beforeCollection());
  const row = rowIn(flow, routeId);
  for (const compact of [false, true]) {
    const panel = render.panel(flow, { compact });
    const front = visibleText(panel);
    assert.match(front, /带娜乌到百药谷东侧槐树右侧石堆.*E「探查此处」找银梳.*战胜雅姑.*重聚或解蛊/);
    assert.match(front, /先拾花会走快速交差，跳过本次银梳后续/);
    assert.doesNotMatch(front, /铜钱1000|蜂王浆×2|18003|18007|18010|Build|LV_903/);
    const html = render.choice(row, { compact });
    const expanded = visibleText(html.replace('<details class="flow-choice-details"', '<details open class="flow-choice-details"'));
    assert.match(expanded, /先拾取树左下的槐花.*石堆交互.*战斗胜利且娜乌在队/);
    assert.match(expanded, /完成交付后得铜钱1000、蜂王浆×2/);
    for (const id of ['npc-8506', 'npc-12700', 'place-903', 'place-901', 'item-10464', 'item-10463', 'item-156'])
      assert(html.includes(`data-entity-id="${id}"`), id);
  }
});

test('losing the comb encounter or winning without Nawu falls back to the flower objective without repeating the comb recommendation', async () => {
  const render = await views;
  for (const outcome of [18011, 18015]) {
    const input = saved([
      ...beforeCollection().metadata.quests,
      { id: 18010, step: 4 }, { id: outcome, step: 4 }, { id: 18012, step: 4 },
    ], { trackingQuest: 18002 });
    const flow = flowSnapshot(profile, input);
    absent(flow, routeId, `fallback ${outcome}`);
    absent(flow, specs[2].id, 'the cure choice was not reached');
    const current = flow.active.find((row) => row.gameId === 18000).steps.find((row) => row.id === 'quest-18002');
    assert.equal(current.nextAction, '前往百药谷东侧，寻找白色的槐花');
    for (const compact of [false, true])
      assert.doesNotMatch(visibleText(render.panel(flow, { compact })), /带娜乌到百药谷|探查此处.*找银梳|银梳路线需/);
  }
});
