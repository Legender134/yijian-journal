'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { flowSnapshot } = require('../src/core/flow.cjs');
const { encyclopedia } = require('../src/core/game-data.cjs');
const guide = require('../src/data/flow-guide.cjs');
const world = require('../src/data/world-index.json');
const game = require('../src/data/game-index.json');
const codex = require('../src/data/codex-details.json');

const profile = { id: 'synthetic-choice-coverage', referenceMode: 'latest' };
const saved = (quests = [], extra = {}) => ({
  name: 'Synthetic.sav',
  hash: 'synthetic-choice-coverage',
  metadata: { quests, inventory: [], ...extra },
});
const active = (root, step, extra = {}) =>
  saved([{ id: root, step: 1 }, ...(step ? [{ id: step, step: 1 }] : [])], extra);
const narrow = [
  { id: 'murder-clue-continue-choice', root: 11272, step: 11276, after: 11278 },
  { id: 'gusu-wonton-food-record-choice', root: 11427, step: 11430, before: 11429, after: 11463 },
  { id: 'lost-heirloom-return-choice', root: 13415, step: 13416 },
];
const curated = [
  {
    id: 'early-jingyin-weapon-choice',
    root: 5074,
    step: 5076,
    consequence: /当场武器.*山寨宝箱.*装备.*秘籍/,
  },
  {
    id: 'jinli-coin-before-accepting',
    extra: { mapName: '津鲤村' },
    consequence: /接取一方后.*另一条委托.*不能接/,
  },
  {
    id: 'chenlinxi-critical-choice',
    root: 12075,
    step: 12078,
    consequence: /好感≥70.*陈麟熙离场.*灭门之案.*失败/,
  },
  { id: 'bai-jin-rescue-route', root: 12030, step: 12033, consequence: /白锦身亡.*霹雳雷火弹.*绝笔图鉴/ },
  { id: 'chengyu-stay-choice', root: 5820, step: 5821, consequence: /送走程钰.*失去.*对话.*切磋/ },
  { id: 'golden-scorpion-choice', root: 16000, step: 16006, consequence: /不能兼得.*挂坠.*截脉三式/ },
  { id: 'kongliang-choice', root: 12280, step: 12293, consequence: /放弃.*漫天花雨/ },
  { id: 'changsheng-formation-choice', root: 8499, step: 8536, consequence: /第二战速杀.*不保证获奖/ },
  { id: 'changsheng-rescue-choice', root: 8830, step: 8831, consequence: /油尽灯枯.*好感.*不保证全员存活/ },
  { id: 'ending-commitment', root: 20000, warning: true, consequence: /答应清虚任掌门.*关闭天机宫.*救商颂/ },
  { id: 'tianji-rebuild-choice', root: 24020, step: 24062, consequence: /回绝.*商颂身亡.*掌门承诺/ },
  { id: 'xungu-night-breakout-choice', root: 5500, step: 5514 },
  { id: 'xungu-find-yaoji-choice', root: 5500, step: 5536 },
  { id: 'tianlong-hidden-passage-chests', root: 5600, step: 5647 },
  ...narrow,
];

const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c],
  );
const unescape = (value) =>
  value.replace(
    /&(amp|lt|gt|quot|#39);/g,
    (_, key) =>
      ({
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        '#39': "'",
      })[key],
  );
const textOnly = (html) => unescape(html.replace(/<[^>]*>/g, ''));
// Keep closed details' summaries visible, including the staged warning summary.
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
    picture: (id) => `<span data-picture="${esc(id)}"></span>`,
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

test('the three new prompts bind the real step, root, options and same-build actions', () => {
  for (const entry of narrow) {
    const row = guide.rules.find((rule) => rule.id === entry.id);
    assert.equal(world.quests.find((q) => q.gameId === entry.step).parentId, entry.root);
    assert.equal(row.questId, entry.root);
    assert.deepEqual(row.decisionSteps, [entry.step]);
    assert.equal(row.requireDecisionWindow, true);
    assert.deepEqual(
      row.choices.map((choice) => choice.label),
      codex.quests[entry.step].choices.map((choice) => choice.text),
    );
    assert(codex.quests[entry.step].choices.every((choice) => choice.requirements.length === 0));
    assert(row.sourceIds.some((id) => guide.sources[id].version === `Build ${world.build}`));
  }
  assert.deepEqual(codex.quests[11276].choices[1].actions, [{ type: 'RQuest', id: 11272, value: 0 }]);
  assert.deepEqual(world.quests.find((q) => q.gameId === 13416).requirements, [
    { type: 'Item', id: 10358, value: 1, name: '赤血珊瑚' },
  ]);
});

for (const entry of narrow) {
  test(`${entry.id} appears only at its saved active step, and retires on outcome or closure`, () => {
    const reference = active(entry.root, entry.step);
    const before = JSON.stringify(reference);
    assert(flowSnapshot(profile, reference).decisions.some((row) => row.id === entry.id));
    assert.equal(JSON.stringify(reference), before, 'projection never changes the synthetic reference');
    const records = [
      [],
      [{ id: entry.root, step: 1 }],
      ...[0, 2, 3, 4].map((step) => [
        { id: entry.root, step: 1 },
        { id: entry.step, step },
      ]),
      ...[2, 3, 4].map((step) => [
        { id: entry.root, step },
        { id: entry.step, step: 1 },
      ]),
      ...[5074, 5454, 5680, 5820, 20000, 24020].map((id) => [
        { id, step: 1 },
        { id: entry.root, step: 1 },
      ]),
    ];
    if (entry.before)
      records.push([
        { id: entry.root, step: 1 },
        { id: entry.before, step: 1 },
      ]);
    if (entry.after)
      records.push([...reference.metadata.quests, { id: entry.after, step: entry.after === 11463 ? 4 : 1 }]);
    for (const quests of records) {
      const flow = flowSnapshot(profile, saved(quests));
      for (const channel of ['decisions', 'warnings', 'advice', 'changes', 'opportunities'])
        assert(!flow[channel].some((row) => row.id === entry.id), `${channel}: ${JSON.stringify(quests)}`);
      assert(
        flow.guide.some((row) => row.id === entry.id),
        'the reference remains searchable',
      );
    }
    for (const selected of [
      { ...profile, referenceMode: 'none' },
      { ...profile, referenceMode: 'slot', saveSlot: 'Missing.sav' },
    ])
      assert(!flowSnapshot(selected, reference).decisions.some((row) => row.id === entry.id));
    assert(
      !flowSnapshot(profile, { name: 'Unreadable.sav', metadata: {} }).decisions.some(
        (row) => row.id === entry.id,
      ),
    );
  });
}

test('wonton choices separate the extra food record from the common finish reward and link exact items', async () => {
  const view = await views;
  const flow = flowSnapshot(profile, active(11427, 11430));
  const row = flow.decisions.find((entry) => entry.id === 'gusu-wonton-food-record-choice');
  const [comfort, divert] = codex.quests[11430].choices;
  assert(comfort.actions.some((a) => a.type === 'CItem' && a.id === 10410 && a.value === 1));
  assert(!divert.actions.some((a) => a.type === 'CItem'));
  for (const finish of codex.quests[11430].finish) {
    assert(finish.some((a) => a.type === 'CItem' && a.id === 163 && a.value === 1));
    assert(!finish.some((a) => a.type === 'CItem' && a.id === 10410));
  }
  assert.equal(game.entries.find((item) => item.id === 'item-10410').name, '萧家食录');
  assert.equal(game.entries.find((item) => item.id === 'item-163').name, '二十四气馄饨');
  const html = view.choice(row, { compact: true });
  assert.match(visibleText(html), /安慰.*萧家食录1份.*两项完成均得二十四气馄饨1份/);
  const front = html.slice(0, html.indexOf('<details class="flow-choice-details"'));
  for (const id of ['item-10410', 'item-163']) assert(front.includes(`data-entity-id="${id}"`));
  assert.match(row.choices[1].effect, /不发萧家食录.*仍给二十四气馄饨×1/);
  assert.doesNotMatch(textOnly(html), /唯一来源|成就必[须需]|永久失去/);
});

test('heirloom choices preserve the shared money, extra medicinal ingredients and coral hand-in requirement', async () => {
  const view = await views;
  const flow = flowSnapshot(profile, active(13415, 13416));
  const row = flow.decisions.find((entry) => entry.id === 'lost-heirloom-return-choice');
  const [returned, priced] = codex.quests[13416].choices;
  for (const choice of [returned, priced])
    assert(choice.actions.some((a) => a.type === 'CMoney' && a.id === 1 && a.value === 5000));
  for (const [id, name] of [
    [10297, '犀角'],
    [10296, '沉香'],
  ]) {
    assert(returned.actions.some((a) => a.type === 'CItem' && a.id === id && a.value === 1));
    assert(!priced.actions.some((a) => a.type === 'CItem' && a.id === id));
    const item = game.entries.find((entry) => entry.id === `item-${id}`);
    assert.equal(item.name, name);
    assert.equal(item.type, '药材');
  }
  const html = view.choice(row, { compact: true });
  assert.match(visibleText(html), /交出赤血珊瑚1份.*犀角、沉香各1份.*均为5000/);
  assert.doesNotMatch(textOnly(html), /丹药|无损|最优线/);
  for (const id of ['item-10297', 'item-10296']) assert(html.includes(`data-entity-id="${id}"`));
  assert(html.includes('data-entity-id="npc-19303"'));
  const task = flow.active.find((entry) => entry.gameId === 13415);
  assert.equal(task.steps[0].id, 'quest-13416');
  assert(task.steps[0].people.some((person) => person.id === 'npc-19303'));
  for (const finish of codex.quests[13416].finish)
    assert(finish.some((action) => action.type === 'CItem' && action.id === 10358 && action.value === -1));
  assert.match(textOnly(view.panel(flow, { compact: true })), /赤血珊瑚/);
});

test('the murder clue warning names task-list removal before expansion without claiming permanent loss', async () => {
  const view = await views;
  const row = flowSnapshot(profile, active(11272, 11276)).decisions.find(
    (entry) => entry.id === 'murder-clue-continue-choice',
  );
  const html = view.choice(row, { compact: true });
  assert.match(visibleText(html), /帮忙找线索.*就此作罢.*从任务列表移除本任务及关联步骤/);
  assert.match(textOnly(html), /重接条件未确认/);
  assert.doesNotMatch(textOnly(html), /永久|不能重接|主线失败/);
});

test('all seventeen curated prompts show one short reason before expansion and preserve their full tradeoffs', async () => {
  const view = await views;
  const expected = new Set(curated.map((entry) => entry.id));
  assert.deepEqual(
    new Set(guide.rules.filter((row) => row.recommendation?.reasonBrief).map((row) => row.id)),
    expected,
  );
  for (const entry of curated) {
    const reference = entry.root ? active(entry.root, entry.step, entry.extra) : saved([], entry.extra);
    const flow = flowSnapshot(profile, reference);
    const row = flow[entry.warning ? 'warnings' : 'decisions'].find((rule) => rule.id === entry.id);
    assert(row, `${entry.id} must reach its existing active display`);
    const value = row.recommendation;
    const length = [...value.reasonBrief].length;
    assert(length >= 15 && length <= 35, `${entry.id}: ${length} characters`);
    assert.notEqual(value.reasonBrief, value.action);
    assert.notEqual(value.reasonBrief, value.caution || row.compactWarning);
    assert.notEqual(value.reasonBrief, value.reason);
    const html = view.panel(flow, { compact: true });
    const visible = visibleText(html);
    assert.equal(
      visible.split(value.reasonBrief).length - 1,
      1,
      `${entry.id} reason appears once by default`,
    );
    assert.equal(
      textOnly(html).split(value.reasonBrief).length - 1,
      1,
      `${entry.id} does not repeat the brief inside details`,
    );
    assert(!visible.includes(value.reason), `${entry.id} keeps its full explanation folded`);
    assert(!visible.includes(value.tradeoff), `${entry.id} keeps its full tradeoff folded`);
    const full = textOnly(html);
    assert(full.includes(value.reason));
    assert(full.includes(value.tradeoff));
    for (const choice of row.choices) assert(full.includes(choice.label) && full.includes(choice.effect));
    for (const source of row.sources) {
      assert(source.url);
      assert(html.includes(`data-id="${esc(source.id)}"`));
      assert(full.includes(source.title));
    }
    if (entry.consequence) assert.match(visible, entry.consequence, entry.id);
    if (!entry.warning) {
      const card = view.choice(row, { compact: true });
      const at = card.indexOf('<details class="flow-choice-details"');
      assert(card.indexOf('flow-reason-brief') < at);
      assert(!card.slice(at, card.indexOf('>', at)).includes(' open'));
      assert.match(card, new RegExp(`data-persist-detail="flow-choice-${entry.id}"`));
    }
  }
});

test('opt-in short reasons leave other advice and existing conditions, materials and live detail keys intact', async () => {
  const view = await views;
  const flow = flowSnapshot(profile, active(5074, 5076));
  const row = flow.decisions.find((entry) => entry.id === 'early-jingyin-weapon-choice');
  const enriched = {
    ...row,
    live: true,
    liveSequence: 17,
    conditions: [{ text: '需先核对当前剧情', status: 'unknown' }],
    recommendation: {
      ...row.recommendation,
      materialLabel: '备料核对',
      materials: [{ id: 'item-10297', name: '犀角', required: 1, owned: 0, routes: [] }],
    },
  };
  const card = view.choice(enriched, { compact: true });
  assert.match(card, /data-persist-detail="flow-choice-early-jingyin-weapon-choice-17"/);
  assert.match(textOnly(card), /需先核对当前剧情/);
  assert.match(visibleText(card), /备料核对.*犀角/);
  assert.equal(visibleText(card).split(row.recommendation.reasonBrief).length - 1, 1);
  const ordinary = flow.guide.find((rule) => rule.id === 'early-rain-money-choice');
  assert(ordinary.recommendation.reason && !ordinary.recommendation.reasonBrief);
  assert(!view.choice(ordinary).includes('flow-reason-brief'));
});
