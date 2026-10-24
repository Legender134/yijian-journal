'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { project } = require('../scripts/build-codex-details.cjs');
const { encyclopedia } = require('../src/core/game-data.cjs');
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const helpers = {
  esc,
  act: (action, label, cls, id) => `<button data-action="${action}" data-id="${esc(id)}">${label}</button>`,
  icon: () => '',
  iconButton: () => '',
  picture: () => '',
  pill: esc,
  notice: esc,
  empty: esc,
  qualityText: { quality: (e) => e.quality, label: () => '', name: (_e, name) => esc(name) },
};
test('codex source projection preserves difficulty and option alternatives and rejects ambiguous identities', () => {
  const game = { build: '21798996', entries: [{ gameId: 100, id: 'skill-100', kind: '武学', name: '剑法' }] };
  const world = { quests: [{ gameId: 10, id: 'quest-10', name: '任务', parentId: 0 }] };
  const row = {
    QuestId: 10,
    Name: '任务',
    OwnerQuestId: 0,
    FinishedActions: [{ Type: 'EActionType::CItem', Id: 1000, Num: 1 }],
    FinishedActionsForDifficulty: [{ Type: 'EActionType::CItem', Id: 1000, Num: 2 }],
    FinishedActionsForHell: [],
    OptionText1: '保留',
    OptionActions1: [{ Type: 'EActionType::CItem', Id: 1000, Num: -1 }],
  };
  const skill = {
    Id: 100,
    ViewName: '剑法',
    LvUpAction1: [{ Type: 'EActionType::CAttr', Id: 17, Num: 0.4 }],
    LevelUnLockReqs: [{ Level: 4, Reqs: [{ Type: 'ERequirementType::Item', Id: 10466, Num: 1 }] }],
  };
  const data = project([{ ...row, Name: null }, row], [skill], game, world);
  assert.deepEqual(
    data.quests[10].finish.map((a) => a[0]?.value),
    [1, 2, undefined],
  );
  assert.equal(data.quests[10].choices[0].actions[0].value, -1);
  assert.equal(data.skills[100].growth[0][0].value, 0.4);
  assert.deepEqual(data.skills[100].levelUnlockRequirements, [
    { level: 4, requirements: [{ type: 'Item', id: 10466, value: 1 }] },
  ]);
  assert.throws(() => project([row, row], [skill], game, world), /identity mismatch/);
  assert.throws(
    () => project([row], [{ ...skill, ViewName: '同编号不同武学' }], game, world),
    /identity mismatch/,
  );
});

test('the four limited martial arts expose their exact breakthrough condition without changing learning gates', async () => {
  const { createGameViews } = await import('../src/renderer/game-views.js');
  const index = encyclopedia();
  const view = createGameViews(helpers);
  const cases = [
    [872, 5, 'PreQuest', 17355, 4],
    [877, 5, 'Item', 13877, 1],
    [884, 4, 'Item', 10466, 1],
    [894, 8, 'PreQuest', 26000, 4],
  ];
  for (const [id, level, type, target, count] of cases) {
    const requirement = index.codex.skills[id].levelUnlockRequirements[0];
    assert.equal(requirement.level, level);
    assert.equal(requirement.requirements[0].type, type);
    assert.equal(requirement.requirements[0].id, target);
    assert.equal(requirement.requirements[0].value, count);
    const html = view.detail(index, `skill-${id}`);
    assert.match(html, /修炼突破/);
    assert.match(html, new RegExp(`突破 ${level} 级`));
    assert.doesNotMatch(html, new RegExp(`升到 ${level} 级|消耗.*item-${target}`));
    if (type === 'Item') assert(html.includes(`data-id="item-${target}"`));
    else {
      assert.match(html, /剧情解锁/);
      assert.doesNotMatch(html, /剧情记录 #|剧情条件 #/);
    }
  }
  assert.doesNotMatch(view.detail(index, 'skill-101'), /修炼突破/);
});
test('real task effects connect reward item, hand-in costs, recipient and exact step without summing branches', async () => {
  const { createCodexDetailViews } = await import('../src/renderer/codex-detail-views.js');
  const index = encyclopedia(),
    views = createCodexDetailViews(helpers);
  const root = index.world.quests.find((q) => q.gameId === 11077);
  const html = views.quest(index, root, null);
  assert.match(html, /quest-11078/);
  assert.match(html, /item-13853/);
  assert.match(html, /npc-10125/);
  assert.match(html, /好感 \+10/);
  assert.match(html, /item-10262/);
  assert.equal((html.match(/item-13853/g) || []).length, 1, 'identical difficulty rows render once');
  assert(!html.includes(' open'), 'outcome spoilers are collapsed');
  assert.match(
    views.item(
      index,
      index.entries.find((e) => e.id === 'item-13853'),
    ),
    /quest-11078/,
  );
  const herb = views.item(
    index,
    index.entries.find((e) => e.id === 'item-10262'),
  );
  assert.match(herb, /data-action="world-place" data-id="place-22"/);
  assert.match(herb, /material:material-wiki-03/);
});
test('skill detail includes proven affinity, base cost, growth and exact learning routes without inventing readiness', async () => {
  const { createGameViews } = await import('../src/renderer/game-views.js');
  const index = encyclopedia();
  const html = createGameViews(helpers).detail(index, 'skill-101');
  assert.match(html, /好感 60/);
  assert.match(html, /基础消耗 1300 武学点/);
  assert.match(html, /可能减免/);
  assert.match(html, /各级属性提升/);
  assert.match(html, /请教线索/);
  assert.doesNotMatch(html, />可请教</);
  const { createCodexDetailViews } = await import('../src/renderer/codex-detail-views.js');
  const skill = index.entries.find((e) => e.id === 'skill-101');
  const progress = {
    people: [{ npcId: 10016, consult: { status: 'met' }, learning: [{ entityId: skill.id, status: 'met' }] }],
  };
  const views = createCodexDetailViews(helpers);
  assert.match(views.skill(index, skill, progress), /保存时状态/);
  assert.match(views.skill(index, skill, progress, 'live'), />可请教</);
  assert(
    views.skill(index, skill, progress, 'live').indexOf('npc-10016') <
      views.skill(index, skill, progress, 'live').indexOf('npc-5003'),
  );
  assert.doesNotMatch(views.skill(index, skill, progress, 'live'), /保存时状态/);
  progress.people[0].learning[0].status = 'unmet';
  assert.doesNotMatch(views.skill(index, skill, progress, 'live'), />可请教</);
  const addedTeacher = index.entries.find(
    (e) => e.kind === '人物' && e.functions?.includes('Consult') && !e.skills?.some((s) => s.id === skill.id),
  );
  progress.people = [
    {
      npcId: addedTeacher.gameId,
      consult: { status: 'met' },
      learning: [{ entityId: skill.id, status: 'met' }],
    },
  ];
  assert.match(views.skill(index, skill, progress, 'live'), new RegExp('data-id="' + addedTeacher.id + '"'));
  const all = index.entries.filter((e) => e.kind === '武学');
  for (const e of all) assert(index.codex.skills[e.gameId], e.id);
});
test('unified codex browses quests and scenes, keeps every search result and dispatches typed links', async () => {
  const { createGameViews } = await import('../src/renderer/game-views.js');
  const index = encyclopedia(),
    view = createGameViews(helpers);
  assert.match(
    view.page(index, '养生秘术', '全部', '全部', 0),
    /data-action="world-quest" data-id="quest-11077"/,
  );
  assert.match(view.page(index, '洛村', '地点', '全部', 0), /data-action="world-place"/);
  assert.match(view.page(index, '', '任务', '任务步骤', 0), /codex-result/);
  assert.match(view.page(index, '', '任务', '全部', 0), /图鉴种类/);
  assert.doesNotMatch(
    view.page(index, '', '任务', '全部', 0),
    /data-id="quest-11078"/,
    'child instructions remain in task detail unless searched or requested',
  );
});

test('codex searches share canonical identities and task status across every page', async () => {
  const { createGameViews, codexEntries, CODEX_PAGE_SIZE } = await import('../src/renderer/game-views.js');
  const { compileSearch, compareSearchTitles } = await import('../src/renderer/search-query.js');
  const index = encyclopedia(),
    view = createGameViews(helpers);
  const statuses = new Map([
    [5200, '进行中'],
    [5201, '已完成'],
  ]);
  const entries = codexEntries(index, statuses);
  assert.equal(new Set(entries.map((e) => e.id)).size, entries.length);
  for (const query of ['剑', '种类:任务 状态:进行中', '种类:任务 类型:主线', '种类:地点 洛村']) {
    const expected = entries.filter(compileSearch(query)).sort(compareSearchTitles(query));
    assert(expected.length, query);
    const ids = [];
    for (let page = 0; page < Math.ceil(expected.length / CODEX_PAGE_SIZE); page++) {
      const html = view.page(index, query, '全部', '全部', page, statuses);
      assert(html.includes(`role="status">${expected.length} 项`), query);
      ids.push(
        ...[
          ...html.matchAll(/class="database-card codex-result" data-action="[^"]+" data-id="([^"]+)"/g),
        ].map((match) => match[1]),
      );
    }
    assert.deepEqual(
      ids,
      expected.map((e) => e.id),
      query,
    );
  }
  assert.deepEqual(
    entries.filter(compileSearch('种类:任务 状态:进行中')).map((e) => e.id),
    ['quest-5200'],
  );
});
