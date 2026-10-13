'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const act = (action, label, cls, id) =>
  `<button class="${esc(cls)}" data-action="${esc(action)}" data-id="${esc(id)}">${label}</button>`;
const options = { esc, act, pill: esc, icon: esc, when: esc };
const views = import(pathToFileURL(path.join(__dirname, '../src/renderer/flow-views.js')).href).then(
  ({ createFlowViews }) => createFlowViews(options),
);
const current = (materials = []) => ({
  available: true,
  active: [
    {
      id: 'quest-1',
      name: '合成测试任务',
      kind: 'Secondary',
      steps: [
        {
          id: 'quest-2',
          name: '采药步骤',
          nextAction: '把药草交给测试人物',
          description: '查看药草交付条件',
          people: [{ id: 'npc-3', name: '测试人物', role: '交付' }],
          places: [{ id: 'place-4', name: '测试村', evidence: 'description-mention' }],
          materials,
          requirements: [{ text: '前置待核对', status: 'unknown' }],
        },
      ],
    },
  ],
});
const material = (extra = {}) => ({
  id: 'item-5',
  name: '测试药草',
  required: 5,
  owned: 2,
  missing: 3,
  routes: [{ kind: 'gather', detail: '测试山坡', efficiency: '效率待核对' }],
  ...extra,
});
function detailsWithClass(html, className) {
  return [...html.matchAll(/<details\b([^>]*)>/g)]
    .filter(([, attributes]) =>
      (attributes.match(/\bclass="([^"]*)"/)?.[1] || '').split(/\s+/).includes(className),
    )
    .map((match) => {
      const start = match.index + match[0].length;
      let depth = 1,
        end;
      for (const tag of html.slice(start).matchAll(/<\/?details\b[^>]*>/g)) {
        depth += tag[0].startsWith('</') ? -1 : 1;
        if (!depth) {
          end = start + tag.index;
          break;
        }
      }
      assert.notEqual(end, undefined, `${className} has a matching closing tag`);
      const content = html.slice(start, end);
      const summary = content.match(/^<summary>([\s\S]*?)<\/summary>/);
      assert(summary, `${className} has a summary before its folded content`);
      return { opening: match[0], summary: summary[1], body: content.slice(summary[0].length) };
    });
}

test('a pending choice shows conditional material stock and sources without declaring the branch active', async () => {
  const { flowSnapshot } = require('../src/core/flow.cjs');
  const view = await views;
  for (const owned of [0, 3, 9, null]) {
    const flow = flowSnapshot(
      { id: 'synthetic', referenceMode: 'latest' },
      {
        name: '1.sav',
        hash: 'a'.repeat(64),
        metadata: {
          quests: [11002, 11005].map((id) => ({ id, step: 1 })),
          ...(owned === null ? {} : { inventory: [{ id: 10201, count: owned }] }),
          trackingQuest: 11005,
        },
      },
    );
    assert.equal(flow.active[0].steps[0].materials.length, 0);
    assert.equal(flow.sharedMaterials.length, 0);
    const requirement = flow.decisions[0].recommendation.materials[0];
    assert.equal(requirement.required, 4);
    assert.equal(requirement.owned, owned);
    assert.equal(requirement.missing, owned === null ? null : Math.max(0, 4 - owned));
    for (const html of [view.panel(flow, { compact: true }), view.taskMaterials(flow)]) {
      assert.match(html, /仅选重锻时备料/);
      assert.match(html, /主要来源/);
      assert.match(html, owned === null ? /库存待核对/ : new RegExp(`需 4 · 持有 ${owned}`));
    }
    const compact = view.panel(flow, { compact: true });
    const visible = compact.split('<details')[0];
    assert.match(visible, /flow-recommended-action">樵夫：推荐重锻旧斧/);
    assert.match(visible, /铁矿石.*需 4.*后山山洞附近采集 → 村西铁匠/s);
    assert.doesNotMatch(visible, /flow-choice-location|为什么：|取舍：/);
    assert.equal(detailsWithClass(compact, 'flow-material-details').length, 0);
    const [details] = detailsWithClass(compact, 'flow-choice-details');
    assert.doesNotMatch(details.opening, /\bopen(?:\s|=|>)/);
    assert.match(details.body, /仅选重锻时备料.*主要来源.*flow-choice-location.*梧桐村.*铁匠/s);
  }
  for (const branch of [11007, 11010]) {
    const flow = flowSnapshot(
      { id: 'synthetic', referenceMode: 'latest' },
      {
        name: '1.sav',
        metadata: {
          inventory: [{ id: 10201, count: 3 }],
          quests: [
            { id: 11002, step: 1 },
            { id: 11005, step: 4 },
            { id: branch, step: 1 },
          ],
        },
      },
    );
    assert.equal(flow.decisions.length, 0);
    assert.doesNotMatch(view.taskMaterials(flow), /仅选重锻时备料/);
    assert.equal(flow.active[0].steps[0].materials.length, branch === 11010 ? 1 : 0);
  }
});

test('shared task inventory is counted once in companion materials and action summaries', async () => {
  const { flowSnapshot } = require('../src/core/flow.cjs');
  const view = await views;
  for (const owned of [1, 2]) {
    const flow = flowSnapshot(
      { id: 'synthetic', referenceMode: 'latest' },
      {
        name: '1.sav',
        hash: 'a'.repeat(64),
        modifiedAt: '2026-10-13T00:00:00Z',
        metadata: {
          quests: [11052, 11054, 11077, 11078].map((id) => ({ id, step: 1 })),
          inventory: [{ id: 10262, count: owned }],
          trackingQuest: 11054,
        },
      },
    );
    const materials = view.taskMaterials(flow);
    assert.match(materials, new RegExp(`合计需 2 · 持有 ${owned} · 还差 ${2 - owned}`));
    const cards = [
      ...materials.matchAll(/<div class="flow-material"><div class="row between">[\s\S]*?<\/span><\/div>/g),
    ]
      .map((match) => match[0])
      .filter((card) => card.includes('item-10262'));
    assert.equal(cards.length, 2);
    assert(cards.every((card) => card.includes(owned === 1 ? '多任务合计缺 1' : '合计持有量已足')));
    const compact = view.panel(flow, { compact: true });
    assert.match(compact, owned === 1 ? /多任务合计缺 1/ : /合计持有量已足/);
    if (owned === 1) assert.doesNotMatch(cards.join(''), /持有量已足/);
  }
});

test('the main material page retains the same task demand before personal crafting tools', async () => {
  const fs = require('node:fs'),
    vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const start = source.indexOf('function materialPage('),
    end = source.indexOf('function handbookPresentation(', start);
  const flow = current([material()]);
  const context = {
    profile: () => ({ craftPlans: [], craftList: [] }),
    act,
    esc,
    when: esc,
    currentFlow: () => flow,
    flowViews: await views,
    journeyTrashViews: { entry: () => '' },
    recipeDiscoveryViews: { entry: () => '' },
    materialViews: { page: () => '<section>个人制作管理</section>' },
    gameIndex: {},
    materialView: {},
    readableSaves: () => [],
    allocationLedger: () => '',
    companionViews: { materials: () => '' },
    companionData: {},
  };
  vm.createContext(context);
  vm.runInContext(
    source.slice(start, end) + '\nthis.main=materialPage;this.companion=compactMaterialsPage;',
    context,
  );
  for (const html of [context.main(), context.companion()]) {
    assert.match(html, /data-flow-task-materials.*合成测试任务.*需 5 · 持有 2 · 缺 3/s);
    assert.match(html, /data-flow-quest="quest-1"/);
    assert(html.indexOf('当前任务备料') < html.indexOf('个人制作管理') || html.includes('我的制作'));
  }
});

test('compact current action exposes person, place and saved quantities before opening any details', async () => {
  const html = (await views).panel(current([material()]), { compact: true });
  const lead = html.slice(html.indexOf('data-flow-now'), html.indexOf('<details'));
  assert.match(lead, /data-id="npc-3"[^>]*>测试人物/);
  assert.match(lead, /data-id="place-4"[^>]*>测试村/);
  assert.match(lead, /data-id="item-5"[^>]*>测试药草/);
  assert.match(lead, /需 5 · 持有 2 · 缺 3/);
  assert.equal(
    (html.match(/>合成测试任务<\/button>/g) || []).length,
    1,
    'expanding the details does not repeat the root heading',
  );
  assert.equal(
    (html.match(/把药草交给测试人物/g) || []).length,
    1,
    'the lead action is not repeated in full-step details',
  );
  assert.match(html, /测试山坡.*效率待核对/s, 'route details remain available');
  assert.match(html, /前置待核对/, 'conditions remain available');
});

test('unknown or invalid saved material values never become zero or sufficient stock', async () => {
  for (const extra of [
    { owned: null, missing: 0 },
    { owned: -1, missing: -1 },
    { required: undefined, missing: 0 },
    { missing: NaN },
  ]) {
    const html = (await views).panel(current([material(extra)]), { compact: true });
    assert.match(html, /缺口待核对/);
    assert.doesNotMatch(html, /持有量已足|持有 -1|缺 -1|需 undefined/);
  }
  const unknown = (await views).panel(current([material({ required: null, owned: null, missing: null })]), {
    compact: true,
  });
  assert.match(unknown, /需求数量待核对 · 库存待核对 · 缺口待核对/);
  const zero = (await views).panel(current([material({ owned: 0, missing: 5 })]), { compact: true });
  assert.match(zero, /需 5 · 持有 0 · 缺 5/);
});

test('folded full steps retain parallel current actions and the main view retains its complete task heading', async () => {
  const flow = current([material()]);
  flow.active[0].steps.push({
    id: 'quest-6',
    name: '另一路交付',
    nextAction: '把另一种材料交给第二位测试人物',
    people: [{ id: 'npc-7', name: '第二位测试人物' }],
    materials: [material({ id: 'item-8', name: '另一种测试材料', required: 1, owned: 1, missing: 0 })],
  });
  const view = await views;
  const compact = view.panel(flow, { compact: true });
  assert.match(
    compact,
    /另一路交付.*把另一种材料交给第二位测试人物.*data-id="npc-7".*另一种测试材料.*需 1 · 持有 1 · 持有量已足/s,
  );
  const main = view.panel(flow);
  assert.match(main, /<h3>.*合成测试任务.*<h4>采药步骤<\/h4>/s);
  assert.match(main, /把药草交给测试人物.*data-id="npc-3".*需 5 · 持有 2 · 缺 3/s);
});

test('compact choice keeps the action and caution visible while folding its complete reasons and tradeoffs', async () => {
  const view = await views;
  for (const lead of [
    { summary: '先核对测试选择', hint: '先与同伴商议', expected: '先核对测试选择' },
    { hint: '先与同伴商议', compact: { action: '简短协作行动' }, expected: '先与同伴商议' },
    { compact: { action: '简短协作行动' }, expected: '简短协作行动' },
    { expected: '和同伴协作' },
  ]) {
    const { expected, ...recommendation } = lead;
    const flow = {
      decisions: [
        {
          id: 'synthetic-choice',
          name: '合成选择',
          recommendation: {
            ...recommendation,
            action: '和同伴协作',
            caution: '先确认同伴在队，奖励要求 24 回合内完成两战。',
            reason: '保留测试奖励目标',
            goal: '收集路线',
            tradeoff: '奖励仍须在 24 回合内完成两战；其他路线收益不同。',
            materials: [
              material({
                routes: [
                  {
                    kind: 'gather',
                    detail: '测试山坡采集点',
                    personId: 'npc-11',
                    placeId: 'place-10',
                    efficiency: '采集效率待确认',
                    sources: [{ id: 'synthetic-material-source', title: '材料路线依据' }],
                  },
                ],
              }),
            ],
            materialSources: { 'item-5': '测试山坡采集点 → 测试村铁匠' },
          },
          warning: '先核对条件',
          conditions: [{ text: '同伴在队情况待核对', status: 'unknown' }],
          choices: [{ label: '协作', effect: '同伴参加测试战斗' }],
          sources: [{ id: 'synthetic-source', title: '合成来源' }],
        },
      ],
    };
    const html = view.panel(flow, { compact: true });
    const visible = html.slice(html.indexOf('data-flow-decision'), html.indexOf('<details'));
    assert.equal(visible.match(/class="flow-recommended-action">([^<]*)<\/p>/)?.[1], expected);
    assert.match(visible, /class="flow-caution">先确认同伴在队，奖励要求 24 回合内完成两战。/);
    assert.match(visible, /测试药草.*需 5 · 持有 2 · 缺 3.*测试山坡采集点 → 测试村铁匠/s);
    assert.doesNotMatch(visible, /保留测试奖励目标|收集路线|其他路线收益不同|同伴参加测试战斗|合成来源/);
    assert.doesNotMatch(visible, /data-id="npc-11"|data-id="place-10"|采集效率待确认|材料路线依据/);
    assert.equal(detailsWithClass(html, 'flow-material-details').length, 0);
    const details = detailsWithClass(html, 'flow-choice-details');
    assert.equal(details.length, 1);
    assert.doesNotMatch(details[0].opening, /\bopen(?:\s|=|>)/);
    assert.match(details[0].summary, /为什么这样选.*各选项影响/);
    assert.match(
      details[0].body,
      /和同伴协作.*保留测试奖励目标.*收集路线.*24 回合内完成两战；其他路线收益不同。/s,
    );
    assert.match(details[0].body, /测试药草.*需 5 · 持有 2 · 缺 3.*主要来源.*测试山坡采集点/s);
    assert.match(details[0].body, /data-id="npc-11".*data-id="place-10".*采集效率待确认.*材料路线依据/s);
    assert.match(details[0].body, /先核对条件.*同伴在队情况待核对.*同伴参加测试战斗.*合成来源/s);
    assert.match(
      view.panel(flow),
      /和同伴协作.*保留测试奖励目标.*收集路线.*其他路线收益不同.*同伴参加测试战斗/s,
    );
  }
});

test('compact advancement retains each distinct deadline and its own affected task effect', async () => {
  const warnings = [
    {
      id: 'before-choice',
      name: '测试选择截止',
      deadlineLabel: '确认队伍选择前',
      affectedTasks: [{ questId: 10, name: '测试同伴任务', effect: '必须先交付，错过本次分支。' }],
    },
    {
      id: 'before-closure',
      name: '测试闭关截止',
      deadlineLabel: '开启闭关修炼前',
      affectedTasks: [{ questId: 11, name: '测试毒物交付', effect: '先交指定材料才能获得对应经脉点。' }],
    },
  ];
  const html = (await views).panel({ ...current(), warnings }, { compact: true });
  const [risks] = detailsWithClass(html, 'flow-compact-risks');
  assert(risks);
  assert.match(risks.opening, /\bopen(?:\s|=|>)/);
  assert.match(risks.summary, /推进前核对 · 2 项/s);
  assert.doesNotMatch(risks.summary, /错过本次分支|对应经脉点|data-flow-impact/);
  const windows = detailsWithClass(risks.body, 'flow-risk-window');
  assert.equal(windows.length, 2);
  for (const [index, warning] of warnings.entries()) {
    const window = windows[index],
      affected = warning.affectedTasks[0];
    assert.doesNotMatch(window.opening, /\bopen(?:\s|=|>)/);
    assert(window.body.includes(warning.deadlineLabel));
    assert(window.summary.includes(affected.name));
    assert(window.summary.includes(affected.effect));
    assert(window.body.includes(`data-flow-impact="${warning.id}"`));
    assert(window.body.includes(`data-id="quest-${affected.questId}"`));
    assert(window.body.includes(affected.name));
    assert(window.body.includes(affected.effect));
    assert(!window.body.includes(warnings[1 - index].affectedTasks[0].effect));
  }
  assert.equal((risks.body.match(/触发：/g) || []).length, 2);
  assert(html.indexOf('<section class="flow-risks">') < html.indexOf('data-flow-now'));
  const main = (await views).panel({ ...current(), warnings });
  for (const warning of warnings) assert(main.includes(warning.affectedTasks[0].effect));
});

test('only explicit identical deadlines share a heading, without losing any named consequence', async () => {
  const warnings = [
    {
      id: 'one',
      name: '第一项',
      deadlineLabel: '闭关前',
      affectedTasks: [{ name: '第一份交付', effect: '第一份具体影响' }],
    },
    {
      id: 'two',
      name: '第二项',
      deadlineLabel: '闭关前',
      affectedTasks: [{ name: '第二份交付', effect: '第二份具体影响' }],
    },
    { id: 'unknown-one', name: '未知窗口一', warning: '分别核对截止' },
    { id: 'unknown-two', name: '未知窗口二', warning: '分别核对截止' },
  ];
  const html = (await views).panel({ warnings }, { compact: true });
  const [risks] = detailsWithClass(html, 'flow-compact-risks');
  assert.match(risks.summary, /推进前核对 · 4 项/s);
  const windows = detailsWithClass(risks.body, 'flow-risk-window');
  assert.equal(windows.length, 3, 'unknown windows stay separate even when their warning prose matches');
  assert.equal(windows.filter((window) => window.body.includes('闭关前')).length, 1);
  assert.match(windows[0].summary, /第一份交付.*第一份具体影响.*第二份交付.*第二份具体影响/s);
  assert.match(
    windows[0].body,
    /data-flow-impact="one".*第一份交付.*第一份具体影响.*data-flow-impact="two".*第二份交付.*第二份具体影响/s,
  );
  for (const [index, warning] of warnings.slice(2).entries()) {
    const window = windows[index + 1];
    assert(window.body.includes(warning.name));
    assert(window.body.includes(`data-flow-impact="${warning.id}"`));
    assert(window.body.includes(warning.warning));
    assert(!window.body.includes(warnings[index === 0 ? 3 : 2].id));
  }
  assert(windows.every((window) => !/\bopen(?:\s|=|>)/.test(window.opening)));
});

test('task materials uses saved active steps only with quantities and expandable route evidence', async () => {
  const flow = current([material()]);
  flow.opportunities = [
    { id: 'quest-99', name: '未接任务', materials: [material({ name: '不应计入的物品' })] },
  ];
  const html = (await views).taskMaterials(flow);
  assert.match(html, /当前任务备料.*合成测试任务.*采药步骤.*测试药草.*需 5 · 持有 2 · 缺 3/s);
  assert.match(html, /<details[^>]*><summary>效率、来源依据与其他获取路线<\/summary>.*效率待核对/s);
  assert.doesNotMatch(html, /不应计入的物品/);
  assert.match((await views).taskMaterials(current()), /当前已识别的进行中步骤暂无可展示的材料需求/);
  assert.match((await views).taskMaterials({ available: true }), /暂无可识别进行中步骤/);
  const offline = (await views).taskMaterials({ ...flow, available: false, reason: '固定参照暂不可读' });
  assert.match(offline, /固定参照暂不可读/);
  assert.doesNotMatch(offline, /需 5|持有量已足/);
  assert.match((await views).taskMaterials(null), /当前任务与持有数量待核对/);
});

test('compact materials show quantities and a source brief while their links and evidence stay expandable', async () => {
  const flow = current([
    material({
      routes: [
        { kind: 'merchant', detail: '替代商人线索', alternative: true, personId: 'npc-12' },
        {
          kind: 'gather',
          detail: '合成后山山洞采集点',
          placeId: 'place-10',
          personId: 'npc-11',
          efficiency: '合成效率尚待核对',
          sources: [{ id: 'synthetic-route-source', title: '合成采集依据' }],
        },
        { kind: 'drop', detail: '其他主要路线', sources: [{ title: '合成掉落依据' }] },
      ],
    }),
  ]);
  const view = await views;
  for (const [html, compact] of [
    [view.panel(flow, { compact: true }), true],
    [view.taskMaterials(flow, { compact: true }), true],
    [view.taskMaterials(flow), false],
  ]) {
    const cutoff = html.indexOf('<details');
    assert(cutoff > 0, 'full route evidence remains folded');
    const visible = html.slice(0, cutoff);
    const folded = html.slice(cutoff);
    assert.match(visible, /测试药草.*需 5 · 持有 2 · 缺 3.*合成后山山洞采集点/s);
    if (compact) {
      assert.match(visible, /class="flow-source-brief">合成后山山洞采集点<\/p>/);
      assert.doesNotMatch(visible, /data-id="place-10"|data-id="npc-11"|主要来源/);
      const details = detailsWithClass(html, 'flow-material-details');
      assert.equal(details.length, 1);
      assert.doesNotMatch(details[0].opening, /\bopen(?:\s|=|>)/);
      assert.equal(details[0].summary, '数量与获取详情');
      assert.match(details[0].body, /需 5 · 持有 2 · 缺 3.*主要来源.*采集.*合成后山山洞采集点/s);
      assert.match(details[0].body, /data-action="world-place" data-id="place-10"/);
      assert.match(details[0].body, /data-action="database-detail" data-id="npc-11"/);
    } else {
      assert.match(visible, /主要来源.*采集.*合成后山山洞采集点/s);
      assert.match(visible, /data-action="world-place" data-id="place-10"/);
      assert.match(visible, /data-action="database-detail" data-id="npc-11"/);
      assert.equal(detailsWithClass(html, 'flow-material-details').length, 0);
    }
    assert.doesNotMatch(visible, /合成效率|合成采集依据|其他主要路线|替代商人线索/);
    assert.match(folded, /合成效率尚待核对.*合成采集依据.*其他主要路线.*合成掉落依据/s);
    assert.match(folded, /flow-material-alternatives.*可达与库存待核对.*替代商人线索.*data-id="npc-12"/s);
    assert.equal((visible.match(/合成后山山洞采集点/g) || []).length, 1);
    assert.equal((html.match(/合成后山山洞采集点/g) || []).length, compact ? 2 : 1);
    assert.match(html, /来源线索不保证当前可达或有货/);
  }
});

test('missing primary material routes stay explicitly unknown even when alternative merchants exist', async () => {
  const view = await views;
  for (const routes of [
    [],
    [{ kind: 'merchant', detail: '库存未知的替代商人', alternative: true, personId: 'npc-12' }],
  ]) {
    const flow = current([material({ owned: null, missing: null, routes })]);
    for (const [html, compact] of [
      [view.panel(flow, { compact: true }), true],
      [view.taskMaterials(flow, { compact: true }), true],
      [view.taskMaterials(flow), false],
    ]) {
      const visible = html.split('<details')[0];
      assert.match(visible, /需 5 · 库存待核对 · 缺口待核对/s);
      assert.match(visible, compact ? /flow-source-brief">来源待核对/ : /暂无已知主要来源/);
      assert.doesNotMatch(visible, /库存未知的替代商人|data-id="npc-12"|持有量已足/);
      if (compact) {
        const [details] = detailsWithClass(html, 'flow-material-details');
        assert.doesNotMatch(details.opening, /\bopen(?:\s|=|>)/);
        assert.match(details.body, /库存待核对 · 缺口待核对.*暂无已知主要来源/s);
      }
      if (routes.length) {
        assert.match(html, /<details.*其他商人线索.*可达与库存待核对.*库存未知的替代商人/s);
      }
    }
  }
});

test('compact duel summary exposes the actual next preparation and preserves separate reward methods', async () => {
  const { createDuelViews } = await import(
    pathToFileURL(path.join(__dirname, '../src/renderer/duel-views.js')).href
  );
  const view = createDuelViews(options);
  const row = {
    id: 'synthetic-duel',
    name: '测试对手',
    place: '测试村',
    level: 30,
    rewards: [
      { itemId: 5, name: '测试武器', method: '切磋私物' },
      { itemId: 6, name: '测试武学', method: '武学请教' },
    ],
    readiness: {
      label: '先补准备',
      action: '先回满气血；装备兵器之后再观察切磋按钮。',
      checks: [],
      reason: '保存状态仍有缺口',
    },
  };
  const html = view.page({ duels: { candidates: [row] } }, { compact: true });
  const summary = html.slice(
    html.indexOf('data-persist-detail="duel-card-'),
    html.indexOf('</summary>', html.indexOf('data-persist-detail="duel-card-')),
  );
  assert.match(summary, /先补准备：先回满气血；装备兵器之后再观察切磋按钮/);
  assert.match(summary, /测试武器.*切磋私物.*测试武学.*武学请教/s);
  row.readiness.action = '';
  row.readiness.checks = [
    { optional: true, status: 'unmet', next: '可选成长' },
    { status: 'unmet', next: '先穿上已有防具' },
  ];
  assert.match(
    view.page({ duels: { candidates: [row] } }, { compact: true }),
    /duel-readiness-preview">先补准备：先穿上已有防具/,
  );
  row.readiness.action = '<img onerror="bad">';
  assert.doesNotMatch(view.page({ duels: { candidates: [row] } }, { compact: true }), /<img onerror/);
});

test('reading an old choice cannot open a different choice after the saved stage changes', async () => {
  const view = await views;
  const choice = (id) => ({ id, name: id, recommendation: { action: '合成推荐', reason: '合成原因' } });
  const keys = (html) =>
    [...html.matchAll(/<details\b[^>]*class="flow-choice-details"[^>]*data-persist-detail="([^"]+)"/g)].map(
      (match) => match[1],
    );
  const before = keys(view.panel({ decisions: [choice('choice-a')] }, { compact: true }));
  const after = keys(view.panel({ decisions: [choice('choice-b')] }, { compact: true }));
  const reordered = keys(
    view.panel({ decisions: [choice('choice-b'), choice('choice-a')] }, { compact: true }),
  );
  assert.equal(before.length, 1);
  assert.equal(after.length, 1);
  assert.notEqual(before[0], after[0], 'a new choice has no saved open state from the previous one');
  assert.deepEqual(
    reordered,
    [after[0], before[0]],
    'the same choice keeps its own reading state when ordering changes',
  );
});

test('compact disclosure state follows advice, task and material identities across stage changes', async () => {
  const view = await views;
  const keys = (html, summary) =>
    [...html.matchAll(/<details\b([^>]*)><summary>([\s\S]*?)<\/summary>/g)]
      .filter((match) => match[2] === summary)
      .map((match) => match[1].match(/data-persist-detail="([^"]+)"/)?.[1]);
  const advice = (id) => ({ id, recommendation: { hint: id, action: '合成行动', reason: '合成理由' } });
  const before = keys(view.panel({ advice: [advice('old')] }, { compact: true }), '做法与理由');
  const after = keys(view.panel({ advice: [advice('new')] }, { compact: true }), '做法与理由');
  assert(before[0] && after[0]);
  assert.notEqual(before[0], after[0]);
  const reordered = keys(
    view.panel({ advice: [advice('new'), advice('old')] }, { compact: true }),
    '做法与理由',
  );
  assert.deepEqual(reordered, [after[0], before[0]]);
  const flow = current([material(), material({ id: 'item-6', name: '第二材料' })]);
  const initial = keys(view.taskMaterials(flow, { compact: true }), '数量与获取详情');
  flow.active[0].steps[0].materials.reverse();
  assert.deepEqual(
    keys(view.taskMaterials(flow, { compact: true }), '数量与获取详情'),
    [...initial].reverse(),
  );
  flow.active[0].steps[0].id = 'quest-7';
  assert(
    keys(view.taskMaterials(flow, { compact: true }), '数量与获取详情').every(
      (key) => !initial.includes(key),
    ),
  );
});

test('critical branch losses and prerequisites remain outside the collapsed choice explanation', async () => {
  const view = await views;
  const rules = require('../src/data/flow-guide.cjs').rules;
  for (const [id, expected] of [
    ['early-woodcutter-axe-choice', /换新.*武学笔记.*不能兼得/],
    ['kongliang-choice', /放弃.*漫天花雨/],
    ['golden-scorpion-choice', /不能兼得.*挂坠.*截脉三式/],
    ['bai-jin-rescue-route', /霹雳雷火弹.*绝笔.*不能同次兼得/],
    ['changsheng-rescue-choice', /剧情.*好感.*不保证全员存活/],
    ['mowen-thankyou-gift-choice', /3000.*六博.*战斗/],
    ['chenlinxi-critical-choice', /60且低于70.*其他好感组合未确认/],
  ]) {
    const row = rules.find((entry) => entry.id === id);
    assert(row, id);
    const html = view.panel({ decisions: [row] }, { compact: true });
    const visible = html.slice(0, html.indexOf('<details'));
    assert.match(visible, expected, id);
    const detail = detailsWithClass(html, 'flow-choice-details')[0];
    assert(detail.body.includes(row.recommendation.reason), id + ' retains the full reason');
  }
});

test('default late-stage risk summaries expose every irreversible route before opening the details', async () => {
  const { flowSnapshot } = require('../src/core/flow.cjs');
  const view = await views;
  for (const main of [20000, 5980]) {
    const flow = flowSnapshot(
      { id: 'synthetic', referenceMode: 'slot', saveSlot: '2.sav' },
      {
        name: '2.sav',
        hash: 'a'.repeat(64),
        metadata: {
          trackingMainQuest: main,
          trackingQuest: main,
          quests: [{ id: main, step: 1 }],
          inventory: [],
        },
      },
    );
    const html = view.panel(flow, { compact: true });
    const [risks] = detailsWithClass(html, 'flow-compact-risks');
    assert.match(risks.opening, /\bopen(?:\s|=|>)/);
    const rows = detailsWithClass(risks.body, 'flow-risk-window');
    const visible = rows.map((row) => row.summary).join('\n');
    assert.match(visible, /清虚.*掌门.*关闭天机宫.*救商颂/);
    if (main === 20000) {
      assert.match(visible, /阎浮镇.*放弃调查.*关闭查明真相/);
      assert.match(visible, /小彤.*林地.*两个宝箱.*离开不返/);
      assert.match(visible, /元启.*天剑宗.*存亡/);
    }
    assert(rows.every((row) => !/\bopen(?:\s|=|>)/.test(row.opening)));
    for (const warning of flow.warnings) {
      assert(visible.includes(warning.compactWarning), warning.id);
      assert(risks.body.includes(warning.warning), warning.id + ' preserves the full qualification');
    }
  }
});

test('crossed windows ask for verification instead of repeating the pre-deadline action', async () => {
  const row = {
    id: 'crossed',
    name: '合成接取任务',
    deadlineReached: true,
    compactWarning: '推进前接取合成任务',
    warning: '已出现边界记录，但不证明任务已失败',
  };
  const html = (await views).panel({ warnings: [row] }, { compact: true });
  const [window] = detailsWithClass(html, 'flow-risk-window');
  assert.match(window.summary, /合成接取任务.*窗口已推进.*能否继续须核对/);
  assert.doesNotMatch(window.summary, /推进前接取|已经失败|永久错过/);
  assert(window.body.includes(row.warning));
});
