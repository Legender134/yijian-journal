'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const world = require('../src/data/world-index.json');
const game = require('../src/data/game-index.json');
const contracts = require('../src/data/npc-interactions.json');
const { createNpcProgressProjector } = require('../src/core/npc-progress.cjs');
const { encyclopedia } = require('../src/core/game-data.cjs');
const project = createNpcProgressProjector({ world, game, contracts });
const ids = [8500, 9001, 10011, 10309, 19112];
const attributes = {
  1: 100,
  2: 100,
  3: 100,
  4: 100,
  5: 40,
  44: 100,
  27: 1,
  48: 1,
  61: 1,
  63: 1,
  65: 1,
  67: 1,
};
const personState = (id, inventory = []) => ({
  id,
  inventory,
  skills: [],
  attributes: { ...attributes, 27: 5 },
  rawFriendliness: 90,
  visible: true,
  mapKey: 'LV_25_P',
  level: 20,
});
const metadata = (npcs, quests = []) => ({
  combat: { format: 14, player: { attributes, skills: [] }, npcStates: npcs },
  inventory: [],
  quests,
});
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const helpers = {
  esc,
  act: (action, label, _className, id) =>
    `<button data-action="${action}" data-id="${esc(id)}">${label}</button>`,
  icon: () => '',
  iconButton: () => '',
  picture: () => '',
  pill: esc,
  notice: esc,
  empty: esc,
  qualityText: { html: (_id, name) => esc(name), label: () => '', name: (_entry, name) => esc(name) },
};

test('public social NPC variants remain distinct and their observed private bags supersede templates', () => {
  const index = encyclopedia();
  for (const id of ids) {
    const entry = index.entries.find((e) => e.id === 'npc-' + id);
    assert(entry, 'Missing public social identity ' + id);
    assert(entry.functions.includes('Compare'));
    assert(entry.npcFacts.fixedItems.length);
    assert(/^[a-f0-9]{20}\.png$/.test(index.images[entry.id]), 'Use the exact exported portrait');
    assert(Object.hasOwn(contracts.people, id));
  }
  const forms = [8500, 10011].map((id) => index.entries.find((e) => e.gameId === id && e.kind === '人物'));
  assert.deepEqual(
    forms.map((e) => [e.name, e.npcFacts.level]),
    [
      ['江小彤', 60],
      ['江小彤', 5],
    ],
  );
  assert.notEqual(index.images[forms[0].id], index.images[forms[1].id]);
  const input = metadata(ids.map((id, i) => personState(id, [{ id: 10201, count: i + 1 }])));
  const before = structuredClone(input);
  let data = project(input);
  assert.deepEqual(
    data.people.map((p) => p.npcId).sort((a, b) => a - b),
    ids,
  );
  for (let i = 0; i < ids.length; i++) {
    const p = data.people.find((p) => p.npcId === ids[i]);
    assert.deepEqual(
      p.remainingItems.map((i) => [i.id, i.count]),
      [[10201, i + 1]],
    );
    if (ids[i] !== 9001)
      assert.equal(p.gift.status, 'unmet', 'No gift entry is not a missing affinity estimate');
  }
  assert.deepEqual(input, before);
  input.combat.npcStates.find((n) => n.id === 8500).inventory = [];
  data = project(input);
  assert.equal(data.people.find((p) => p.npcId === 8500).collection, 'cleared');
  assert.deepEqual(data.people.find((p) => p.npcId === 8500).remainingItems, []);
  assert.equal(project(metadata([])).people.length, 0, 'Unobserved variants never count as cleared');
});

test('missing operation entries are explicit before observation and suppress unusable gift actions', async () => {
  const { createGameViews } = await import('../src/renderer/game-views.js');
  const view = createGameViews(helpers),
    index = encyclopedia();
  const progress = project(metadata(ids.map((id) => personState(id, [{ id: 10201, count: 2 }]))));
  const reference = { metadata: { npcProgress: progress } };
  for (const id of ids) {
    const entry = index.entries.find((e) => e.id === 'npc-' + id);
    const html = view.detail(index, entry.id, 1, reference);
    if (!entry.functions.includes('Gift')) {
      assert.match(html, /赠礼：暂无入口/);
      assert.doesNotMatch(
        html,
        /data-action="database-gifts"|data-action="journey-gift-dialog"|赠礼境界待确认|礼物至少/,
      );
      const unseen = view.detail(index, entry.id);
      assert.match(unseen, /npc-unavailable-entry[^>]*>[^<]*赠礼[^<]*暂无入口/);
    }
    if (!entry.functions.includes('Consult')) {
      assert.match(html, /请教：暂无入口/);
      assert.doesNotMatch(html, /待请教 \d+ 项/);
    }
    if (!entry.hobbies.length) assert.doesNotMatch(html, /data-action="database-gifts"/);
  }
});

test('story navigation labels never replace the exact hidden friendship condition', async () => {
  const { createWorldViews } = await import('../src/renderer/world-views.js');
  const view = createWorldViews(helpers),
    index = encyclopedia();
  const named = new Set(world.quests.map((q) => q.gameId));
  const cases = world.people.flatMap((person) =>
    person.friendshipLocks.flatMap((lock) =>
      lock.requirements
        .filter((r) => ['PreQuest', 'NoQuest'].includes(r.type) && !named.has(r.id))
        .map((condition) => ({ person, condition })),
    ),
  );
  assert.equal(cases.length, 19);
  for (const { person, condition } of cases) {
    assert.doesNotMatch(condition.name, /任务步骤\s*#|任务\s*#/);
    const states = new Map(
      person.friendshipLocks.flatMap((l) =>
        l.requirements.filter((r) => r.type === 'PreQuest').map((r) => [r.id, r.value]),
      ),
    );
    if (condition.relatedQuestId) states.set(condition.relatedQuestId, 4);
    states.set(condition.id, 0);
    const input = metadata(
      [personState(person.gameId)],
      [...states].map(([id, step]) => ({ id, step })),
    );
    const blocked = project(input).people[0];
    const check = blocked.friendship.checks.find((c) => c.id === condition.id);
    assert(check);
    assert.equal(check.status, 'unmet', 'Completed owner story cannot release a different hidden step');
    assert.equal(check.entityId, condition.relatedQuestId ? 'quest-' + condition.relatedQuestId : null);
    if (condition.type === 'PreQuest' && condition.value === 4 && condition.relatedQuestId) {
      assert.match(check.text, /相关步骤尚未完成/);
      input.quests.find((q) => q.id === condition.relatedQuestId).step = 0;
      assert.match(
        project(input).people[0].friendship.checks.find((c) => c.id === condition.id).text,
        /完成后解锁/,
      );
      input.quests.find((q) => q.id === condition.relatedQuestId).step = 4;
    }
    const html = view.requirementRows([condition], index, { reference: { metadata: input } });
    if (condition.relatedQuestId) assert(html.includes('data-id="quest-' + condition.relatedQuestId + '"'));
    assert.doesNotMatch(
      html,
      /存档：已完成|现场：已完成/,
      'Owner status must not be presented as hidden-step status',
    );
    input.quests.find((q) => q.id === condition.id).step = condition.value;
    assert.equal(project(input).people[0].friendship.cap, 100);
    delete input.quests;
    assert.equal(project(input).people[0].friendship.value, null);
  }
});

test('compact NPC details keep current location and every private item without empty static disclosures', async () => {
  const { createGameViews } = await import('../src/renderer/game-views.js');
  const view = createGameViews(helpers),
    index = encyclopedia();
  const progress = project(
    metadata([
      personState(
        10038,
        [100034, 100312, 134, 10201, 133].map((id) => ({ id, count: 1 })),
      ),
    ]),
  );
  const reference = { metadata: { npcProgress: progress } };
  let html = view.detail(index, 'npc-10038', 1, reference);
  assert(html.indexOf('codex-person-place') < html.indexOf('data-npc-progress="10038"'));
  assert(html.indexOf('npc-private-preview') < html.indexOf('npc-template-npc-10038'));
  assert.match(html, /其余私物 · 2 种/);
  for (const item of progress.people[0].remainingItems)
    assert(html.includes('data-id="item-' + item.id + '"'));
  assert.doesNotMatch(html, /<details[^>]*\sopen/);
  const noTemplate = structuredClone(index);
  noTemplate.entries.find((e) => e.id === 'npc-10038').npcFacts = null;
  html = view.detail(noTemplate, 'npc-10038', 1, reference);
  assert.doesNotMatch(html, /npc-template-npc-10038/);
});

test('NPC search shows matches in other tabs and keeps the query when opening that tab', async () => {
  const { createNpcProgressViews } = await import('../src/renderer/npc-progress-views.js');
  const view = createNpcProgressViews(helpers);
  const data = project(metadata([personState(10038, [{ id: 100034, count: 1 }])]));
  const row = data.people[0];
  const filtered = { ...data, remaining: [], learning: [], locked: [row], cleared: [] };
  const html = view.page(filtered, { tab: 'remaining', query: '寒铁' });
  assert.match(html, /当前分类没有匹配/);
  assert.match(html, /data-action="npc-progress-tab" data-id="locked"/);
  assert.match(html, /受限 · 1/);
  const switched = view.page(filtered, { tab: 'locked', query: '寒铁' });
  assert.match(switched, /data-npc-progress-card="10038"/);
  assert.match(switched, /value="寒铁"/);
});

test('item trade details fold without hiding a usage cap, including missing numeric data', async () => {
  const { createGameViews } = await import('../src/renderer/game-views.js');
  const view = createGameViews(helpers),
    index = encyclopedia();
  const item = index.entries.find((e) => e.kind === '物品' && e.useLimit > 0);
  for (const missingStats of [false, true]) {
    const copy = structuredClone(index);
    if (missingStats) copy.entries.find((e) => e.id === item.id).stats = null;
    const html = view.detail(copy, item.id);
    const folded = html.indexOf('<details class="detail-block item-trade-details"');
    assert(folded > 0);
    assert(html.slice(0, folded).includes('使用次数上限 ' + item.useLimit + ' 次'));
    assert.doesNotMatch(html, /<details[^>]*item-trade-details[^>]*\sopen/);
    assert(html.slice(folded).includes(item.buyPrice.toLocaleString('zh-CN', { maximumFractionDigits: 2 })));
    assert(html.slice(folded).includes(item.sellPrice.toLocaleString('zh-CN', { maximumFractionDigits: 2 })));
  }
});


test('Bu Weiyue initial fan mastery remains visible without becoming a current teaching opportunity', async () => {
  const { createGameViews } = await import('../src/renderer/game-views.js');
  const index = encyclopedia(), view = createGameViews(helpers);
  const person = index.entries.find(e => e.id === 'npc-19830');
  assert.deepEqual(person.skills.map(s => s.id),
    ['skill-477', 'skill-478', 'skill-479', 'skill-480', 'skill-851', 'skill-750', 'skill-899']);
  assert.deepEqual(person.skills[3], { id: 'skill-480', level: 10 });
  assert.match(view.detail(index, person.id), /初始武学.*data-id="skill-480">青云扇法 · 10<\/button>/s);
  assert.equal(contracts.skills[480].openForPlayer, false);
  for (const origin of ['saved', 'live']) {
    const actor = personState(19830);
    actor.skills = [{ id: 480, level: 10 }, { id: 477, level: 10 }];
    const input = metadata([actor]);
    if (origin === 'live') input.combat.origin = origin;
    const before = structuredClone(input);
    const result = project(input);
    const learning = result.people[0].learning.filter(s => s.kind === 'martial');
    assert(!learning.some(s => s.id === 480));
    assert(learning.some(s => s.id === 477));
    assert.deepEqual(input, before);
    input.combat.player.skills = [{ id: 477, level: 1 }];
    assert.equal(project(input).people[0].learning.filter(s => s.kind === 'martial').length, 0);
    actor.skills = [];
    input.combat.player.skills = [];
    assert.equal(project(input).people[0].learning.filter(s => s.kind === 'martial').length, 0);
    input.combat.npcStates = [];
    assert.equal(project(input).people.length, 0);
  }
});
