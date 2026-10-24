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

test('hidden outcomes require a unique owner path and retain independent choices and unknown action boundaries', async () => {
  const { createCodexDetailViews } = await import('../src/renderer/codex-detail-views.js');
  const entry = { gameId: 10, id: 'quest-10', name: '任务', parentId: 0 };
  const next = { gameId: 11, id: 'quest-11', name: '后续步骤', parentId: 10 };
  const item = { gameId: 1000, id: 'item-1000', kind: '物品', name: '奖励' };
  const game = { build: '21798996', entries: [item] };
  const reward = { Type: 'EActionType::CItem', Id: 1000, Num: 1 };
  const raw = [
    { QuestId: 10, OwnerQuestId: 0, Name: '任务' },
    { QuestId: 11, OwnerQuestId: 10, Name: '后续步骤' },
    { QuestId: 20, OwnerQuestId: 10, Name: null },
    {
      QuestId: 21,
      OwnerQuestId: 20,
      Name: null,
      RequestRequirements: [{ Type: 'ERequirementType::PreQuest', Id: 11, Num: 4 }],
      FinishedActions: [reward],
      FinishedActionsForDifficulty: [{ ...reward, Num: 2 }],
      FinishedActionsForHell: [reward],
      OptionText1: '继续',
      OptionActions1: [{ Type: 'EActionType::JumpStep', Id: 11, Num: 1 }],
      OptionText2: '未知影响',
      OptionActions2: [{ Type: 'EActionType::FutureComposite', Id: 1000, Num: 99, Actions: [reward] }],
      OptionRequirements2: [{ Type: 'ERequirementType::Item', Id: 1000, Num: 2 }],
    },
    { QuestId: 30, OwnerQuestId: 999, FinishedActions: [reward] },
    { QuestId: 40, OwnerQuestId: 41, FinishedActions: [reward] },
    { QuestId: 41, OwnerQuestId: 40, FinishedActions: [reward] },
    { QuestId: 50, OwnerQuestId: 10, FinishedActions: [reward] },
    { QuestId: 50, OwnerQuestId: 10, FinishedActions: [reward] },
    { QuestId: 60, OwnerQuestId: 50, FinishedActions: [reward] },
  ];
  const original = JSON.stringify(raw);
  const codex = project(raw, [], game, { quests: [entry, next] });
  assert.deepEqual(Object.keys(codex.hiddenSteps), ['21']);
  assert.deepEqual(codex.hiddenSteps[21].ownerPath, [20, 10]);
  assert.equal(codex.hiddenSteps[21].relatedQuestId, 10);
  assert.equal(codex.hiddenSteps[21].name, undefined, 'internal rows acquire no invented title');
  assert.equal(codex.hiddenSteps[21].choices[1].actions[0].type, 'FutureComposite');
  assert.equal(JSON.stringify(raw), original);
  const index = { ...game, world: { quests: [entry, next] }, codex };
  const view = createCodexDetailViews(helpers);
  const html = view.quest(index, entry, null);
  assert.match(html, /相关剧情结算/);
  assert.match(html, /<summary>资料来源<\/summary><p>游戏任务表 · 原始步骤 21/);
  assert.match(html, /选择「继续」/);
  assert.match(html, /quest-11/);
  assert.match(html, /选择「未知影响」/);
  assert.match(html, /后续影响需结合剧情判断/);
  assert.match(html, /此步骤出现条件/);
  assert.doesNotMatch(html, /quest-21|FutureComposite|\+99/);
  assert.doesNotMatch(html, /<h4>[^<]*#|<summary>[^<]*#|相关剧情步骤 #/);
  const source = view.item(index, item);
  assert.match(source, /普通 ×1 · 困难 ×2 · 极难 ×1/);
  assert.doesNotMatch(source, /×4|×99|未知影响/);
  assert.equal(
    codex.source.inputs.quests,
    undefined,
    'complete-table provenance cannot reuse the selected-row pin',
  );
  assert.equal(
    codex.source.inputs.questsFullTableData,
    'f1ddf79d01d5d143512ce55b1007b19cd8dc5c57c48ff00cb3ee396f5ef5fecf',
  );
});

test('same-build hidden choices and rewards are available through their public owner without assuming root completion', async () => {
  const { createCodexDetailViews } = await import('../src/renderer/codex-detail-views.js');
  const index = encyclopedia(),
    view = createCodexDetailViews(helpers);
  const quest = (id, reference = null) =>
    view.quest(
      index,
      index.world.quests.find((q) => q.gameId === id),
      reference,
    );
  const item = (id) =>
    view.item(
      index,
      index.entries.find((e) => e.id === `item-${id}`),
    );
  const hidden = index.codex.hiddenSteps;
  assert.equal(hidden[12313].relatedQuestId, 12310);
  assert.deepEqual(
    hidden[12313].choices.map((c) => c.text),
    ['去', '不去'],
  );
  assert(hidden[12313].choices[0].actions.some((a) => a.type === 'CYHD' && a.id === 10804 && a.value === 20));
  assert(
    hidden[12313].choices[1].actions.some((a) => a.type === 'JumpStep' && a.id === 12317 && a.value === 4),
  );
  const yanxia = quest(12310);
  assert.match(yanxia, /选择「去」/);
  assert.match(yanxia, /选择「不去」/);
  assert.match(yanxia, /data-quest-step="12316"/);
  for (const id of [13160, 100227, 135]) assert.match(yanxia, new RegExp(`item-${id}`));
  assert.match(item(13160), /quest-12310/);
  assert.match(item(13160), /data-quest-step="12316"/);
  assert.doesNotMatch(yanxia, /data-id="quest-12313"|data-id="quest-12316"/);
  const saiwai = quest(12030);
  assert.match(saiwai, /data-quest-step="12040"/);
  assert.match(saiwai, /quest-12041/);
  assert.match(saiwai, /item-13512/);
  assert.match(saiwai, /item-13560/);
  assert.match(item(13512), /data-quest-step="12040"/);
  assert.equal(quest(12030, { metadata: { quests: [{ id: 12030, step: 4 }] } }), saiwai);
  for (const id of [13863, 13463]) {
    assert.match(quest(12090), new RegExp(`item-${id}`));
    assert.match(item(id), /data-quest-step="12098"/);
  }
  const pili = item(13875);
  assert.match(pili, /data-quest-step="16210"/);
  assert.match(pili, /data-quest-steps="16210,16211"/);
  assert.equal((pili.match(/×1/g) || []).length, 1);
  assert.match(pili, /2 处独立剧情结算/);
  assert.doesNotMatch(pili, /×2|×6/);
  assert.match(pili, /不同分支不累计/);
});

test('random item actions resolve item templates and guild contribution remains an independent reward', async () => {
  const { createCodexDetailViews } = await import('../src/renderer/codex-detail-views.js');
  const index = encyclopedia(),
    view = createCodexDetailViews(helpers);
  const fire = index.world.quests.find((q) => q.gameId === 32761);
  const actions = index.codex.quests[32761].finish;
  assert(actions.every((rows) => rows.some((a) => a.type === 'ARandItem' && a.id === 1077 && a.value === 1)));
  const html = view.quest(index, fire, null);
  assert.match(html, /item-1077/);
  assert.match(html, /随机词条/);
  assert.equal((html.match(/item-1077/g) || []).length, 1);
  for (const id of [10316, 10222, 10232]) assert.match(html, new RegExp(`item-${id}`));
  const source = view.item(
    index,
    index.entries.find((e) => e.id === 'item-1077'),
  );
  assert.match(source, /quest-32761/);
  assert.match(source, /完成获得 ×1（随机词条）/);
  assert.doesNotMatch(source, /掉落池|×3/);
  const honor = view.quest(
    index,
    index.world.quests.find((q) => q.gameId === 13801),
    null,
  );
  assert.equal((honor.match(/门派贡献 \+600/g) || []).length, 1);
  assert(index.codex.quests[13825].events[0].success.some((a) => a.type === 'CGuildHonor' && a.value === 10));
  const event = view.quest(
    index,
    index.world.quests.find((q) => q.gameId === 13825),
    null,
  );
  assert.match(event, /剧情事件成功后/);
  assert.doesNotMatch(event, /<summary>剧情事件 1/);
  assert.match(event, /门派贡献 \+10/);
});

test('codex builder rejects an incomplete quest export before replacing shipped data', (t) => {
  const fs = require('node:fs'),
    os = require('node:os'),
    path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-codex-source-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'incomplete-table.json');
  fs.writeFileSync(input, '[]');
  const output = path.join(__dirname, '../src/data/codex-details.json');
  const before = fs.readFileSync(output);
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, '../scripts/build-codex-details.cjs'), input, 'unused-skills.json'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Codex source hash mismatch/);
  assert.deepEqual(fs.readFileSync(output), before);
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
test('hidden pill absence conditions retain the actual item and strict native ItemMax comparison', async () => {
  const { createCodexDetailViews } = await import('../src/renderer/codex-detail-views.js');
  const { createWorldViews } = await import('../src/renderer/world-views.js');
  const index = encyclopedia();
  const worldViews = createWorldViews(helpers);
  index.renderRequirements = worldViews.requirementRows;
  const condition = index.codex.hiddenSteps[11743].finishingRequirements.find(
    (row) => row.type === 'ItemMax',
  );
  assert.deepEqual(condition, { type: 'ItemMax', id: 165, value: 1 });
  const entry = index.world.quests.find((row) => row.gameId === 11735);
  const html = createCodexDetailViews(helpers).quest(index, entry, {
    metadata: { inventory: [{ id: 165, count: 2 }] },
  });
  const step = html.split('data-quest-step="11743"')[1].split('class="codex-outcome-step"')[0];
  assert.match(step, /物品要求/);
  assert.match(step, /data-action="database-detail" data-id="item-165">九炼熊蛇丸/);
  assert.match(step, /未持有/);
  assert.match(step, /未满足/);
  assert.doesNotMatch(step, /数量条件待确认|资料条件 · 1|已满足|至少|至多|最多/);
  const missing = worldViews.requirementRows([{ type: 'ItemMax', id: 999999, value: 1 }], index, {});
  assert.match(missing, /未收录物品/);
  assert.doesNotMatch(missing, /data-id="item-999999"/);
});

test('quest outcomes expose actual attribute costs and life experience without adding difficulty alternatives', async () => {
  const { createCodexDetailViews } = await import('../src/renderer/codex-detail-views.js');
  const index = encyclopedia();
  const view = createCodexDetailViews(helpers);
  const detail = (id) =>
    view.quest(
      index,
      index.world.quests.find((row) => row.gameId === id),
      null,
    );
  const performer = detail(11447);
  for (const [step, choice, loss] of [
    [11453, '吃九盆', 5],
    [11455, '再吃三盆', 2],
    [11456, '拼了', 5],
  ]) {
    const section = performer.split(`data-quest-step="${step}"`)[1].split('class="codex-outcome-step"')[0];
    const option = section.split(`<summary>选择「${choice}」</summary>`)[1].split('</details>')[0];
    assert.match(option, new RegExp(`气血上限 <strong>-${loss} 点</strong>`));
  }
  assert.deepEqual(index.itemStats.attributes[68], {
    key: 'GatheringExp',
    name: '采集经验',
    unit: '点',
    scale: 1,
    precision: 2,
  });
  assert.match(detail(5054), /采集经验 <strong>\+10 点<\/strong>/);
  const alchemy = detail(6256);
  assert.match(alchemy, /炼丹经验 <strong>\+800 点<\/strong>/);
  assert.equal((alchemy.match(/炼丹经验/g) || []).length, 1);
  assert.doesNotMatch(alchemy, /\+2,400|\+2400/);
  assert.match(detail(11110), /钓鱼经验 <strong>\+300 点<\/strong>/);
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
