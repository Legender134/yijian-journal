'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );
const views = import(pathToFileURL(path.join(__dirname, '../src/renderer/duel-views.js')).href).then(
  ({ createDuelViews }) =>
    createDuelViews({
      esc,
      pill: esc,
      act: (action, label, cls, id) =>
        `<button class="${esc(cls)}" data-action="${esc(action)}" data-id="${esc(id)}">${label}</button>`,
    }),
);

// Read what a user can see before opening any native details elements.
function collapsedText(html) {
  const details = [];
  let result = '';
  for (const [token] of html.matchAll(/<[^>]*>|[^<]+/g)) {
    if (/^<details\b/.test(token)) details.push(false);
    else if (/^<summary\b/.test(token)) details[details.length - 1] = true;
    else if (/^<\/summary>/.test(token)) details[details.length - 1] = false;
    else if (/^<\/details>/.test(token)) details.pop();
    else if (!token.startsWith('<') && details.every(Boolean)) result += token;
  }
  return result;
}

const opponent = () => ({
  id: 'synthetic-duel',
  personId: 'npc-3',
  name: '合成对手',
  place: '测试村客栈二楼',
  level: 30,
  rewards: [
    { itemId: 5, name: '测试兵器', method: '切磋私物', probability: '掉落概率待核对，不保证首胜获得。' },
    { itemId: 6, name: '测试武学', method: '武学请教' },
    { itemId: 7, name: '测试丹方', method: '剧情奖励', condition: '合成剧情条件完成后取得。' },
  ],
  preparation: '完整攻略参考。',
  recommendation: { action: '完整收集路线。', reason: '完整收益理由。', tradeoff: '完整收益取舍。' },
  readiness: {
    status: 'prepare',
    label: '先补准备',
    action: '挑战前先休息回复气血，再穿戴现有防具，观察人物私物与切磋条件。',
    reason: '保存状态仍有明确准备缺口。',
    checks: [
      { id: 'skill-8', label: '可选招式', status: 'unmet', optional: true, detail: '可选成长尚未完成。' },
      { id: 'health', label: '气血', status: 'unmet', detail: '存档气血约 30%', next: '休息回复后再保存。' },
      { id: 'armor', label: '防具', status: 'unmet', detail: '存档未装备鞋靴', next: '先穿上现成鞋靴。' },
    ],
    growth: '完整成长路径。',
    basis: '最近一次保存依据，不等于能够获胜。',
  },
  uncertainty: '人物在场仍须核对。',
  sources: [{ id: 'synthetic-source', title: '合成来源', author: '测试作者', version: '测试版本' }],
});
const flowFor = (row) => ({
  reference: { name: 'Synthetic.sav' },
  duels: {
    available: true,
    candidates: [row],
    guide: [row],
    reason: '按已保存主线匹配人物阶段，不能认定当前可以挑战。',
    combatLimit: '未读取实时面板，静态等级不能换算胜率。',
    difficultyName: '测试难度',
  },
});

test('compact defaults prioritize actionable facts and fold explanations without clipping them', async () => {
  const row = opponent();
  const html = (await views).page(flowFor(row), { compact: true, scope: 'synthetic' });
  const visible = collapsedText(html);
  assert.match(visible, /合成对手.*初始等级 30.*测试村客栈二楼.*测试兵器.*切磋私物.*测试武学.*武学请教/s);
  assert.match(visible, /等 3 项.*先补准备 · 气血：存档气血约 30%/s);
  assert.doesNotMatch(
    visible,
    /测试丹方|可选成长|存档未装备鞋靴|挑战前先休息|保存状态仍有|完整成长|合成来源|测试难度|已整理/,
  );
  for (const detail of [
    row.readiness.action,
    row.readiness.reason,
    row.readiness.growth,
    row.readiness.basis,
    row.recommendation.action,
    row.recommendation.reason,
    row.recommendation.tradeoff,
    row.uncertainty,
  ]) {
    assert(html.includes(detail), `${detail} remains complete inside details`);
  }
  assert.match(html, /测试丹方.*剧情奖励.*合成剧情条件完成后取得/s);
  assert.match(html, /掉落概率待核对，不保证首胜获得/);
  assert.match(html, /合成来源.*测试作者.*测试版本/s);
  assert.match(html, /静态等级不能换算胜率/);
  assert.doesNotMatch(html, /未列人物不代表没有重要物品/);
  assert.match(html, /duel-card-synthetic-synthetic-duel/);
  assert.match(html, /duel-info-synthetic-synthetic-duel/);
  assert.doesNotMatch(html, /<details[^>]*\sopen(?:[\s=>])/);
});

test('compact readiness preserves unknown facts and visible incomplete prerequisites', async () => {
  const row = opponent();
  row.readiness = {
    status: 'verify',
    label: '到场核对',
    action: '先在游戏里核对尚未读取的角色记录。',
    checks: [{ id: 'health', label: '气血', status: 'unknown', detail: '未读到已保存的气血比例' }],
  };
  row.conditions = [
    { id: 'quest-9', name: '未完成剧情', status: 'unmet' },
    { id: 'quest-10', name: '未知剧情', status: 'unknown' },
  ];
  const html = (await views).page(flowFor(row), { compact: true });
  const visible = collapsedText(html);
  assert.match(visible, /到场核对 · 气血待核对/);
  assert.doesNotMatch(visible, /未读到已保存/);
  assert.match(visible, /前置未完成 · 前置待核对/);
  assert.doesNotMatch(visible, /已记录|准备完成|能打|必胜/);
  assert.match(html, /未完成剧情<\/button>：尚未完成/);
  assert.match(html, /未知剧情<\/button>：记录待核对/);
  assert.match(html, /前置条件未确认/);
});

test('deferred challenges keep the level gap as their key preparation rather than implying a refill is enough', async () => {
  const row = opponent();
  row.readiness.status = 'defer';
  row.readiness.label = '建议暂缓';
  row.readiness.action = '对手等级差较大，先推进低风险任务，再回头核对。';
  row.readiness.checks.push({
    id: 'level',
    label: '等级参考',
    status: 'unmet',
    detail: '存档宇文逸 25 级；静态模板 70 级，相差 45 级',
  });
  const html = (await views).page(flowFor(row), { compact: true });
  assert.match(collapsedText(html), /建议暂缓 · 等级参考：存档宇文逸 25 级；静态模板 70 级，相差 45 级/);
  assert.doesNotMatch(collapsedText(html), /存档气血约 30%/);
  assert(html.includes(row.readiness.action));
});

test('missing readiness and rewards remain explicitly unknown in the collapsed card', async () => {
  const row = opponent();
  delete row.readiness;
  row.rewards = [];
  row.conditions = [{ id: 'quest-10', name: '未知剧情', status: 'unknown' }];
  const html = (await views).page(flowFor(row), { compact: true });
  assert.match(collapsedText(html), /先观察当前私物.*准备待核对.*前置待核对/s);
  assert.doesNotMatch(collapsedText(html), /没有收益|已满足|准备完成|可以挑战/);
});

test('fallback preparation stays complete and all compact interpolations stay escaped', async () => {
  const row = opponent();
  row.readiness.checks = [];
  const view = await views;
  const html = view.page(flowFor(row), { compact: true });
  assert(collapsedText(html).includes(row.readiness.action));
  row.readiness.action = '';
  row.readiness.checks = [
    { optional: true, status: 'unmet', next: '仅供可选成长' },
    { status: 'unmet', next: '先穿上已有防具。' },
  ];
  assert.match(collapsedText(view.page(flowFor(row), { compact: true })), /先补准备：先穿上已有防具。/);
  row.readiness.checks[1].detail = '<img onerror="bad">';
  row.name = '<script>bad</script>';
  assert.doesNotMatch(view.page(flowFor(row), { compact: true }), /<img onerror|<script>bad/);
});

test('other phases and page coverage remain folded while empty saved-state status stays visible', async () => {
  const row = opponent();
  const flow = flowFor(row);
  flow.duels.guide.push({ ...opponent(), id: 'other-phase', name: '其他阶段人物' });
  const view = await views;
  const html = view.page(flow, { compact: true });
  assert.match(collapsedText(html), /其他阶段 · 1 人.*依据与覆盖/s);
  assert.doesNotMatch(collapsedText(html), /其他阶段人物|不能据此判断|测试难度|未列人物/);
  assert.match(html, /其他阶段人物/);
  assert.ok(html.includes(flow.duels.reason));
  flow.duels.candidates = [];
  assert.match(collapsedText(view.page(flow, { compact: true })), /当前阶段暂无已整理线索/);
  flow.duels.available = false;
  assert.match(collapsedText(view.page(flow, { compact: true })), /尚未对照可读存档/);
});

test('the main page retains its full readiness and collection presentation', async () => {
  const row = opponent();
  const html = (await views).page(flowFor(row));
  const visible = collapsedText(html);
  assert.match(visible, /本阶段比武与重要收益.*合成对手.*初始等级 30.*测试村客栈二楼/s);
  assert(visible.includes(row.readiness.action));
  assert(visible.includes(row.readiness.reason));
  assert.match(visible, /测试兵器.*切磋私物.*测试武学.*武学请教.*测试丹方.*剧情奖励/s);
  assert.match(html, /合成来源.*测试作者.*测试版本/s);
  assert.doesNotMatch(html, /duel-compact-card/);
});
