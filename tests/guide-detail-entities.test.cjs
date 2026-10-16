'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const catalog = require('../src/data/catalog.cjs');
const { encyclopedia } = require('../src/core/game-data.cjs');

const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const moduleUrl = (name) => {
  const source = fs
    .readFileSync(path.join(__dirname, '../src/renderer', name), 'utf8')
    .replace(
      /from '(\.\.?\/[^']+)'/g,
      (_, dependency) =>
        'from ' + JSON.stringify(moduleUrl(path.posix.join(path.posix.dirname(name), dependency))),
    );
  return 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
};
const referencesModule = import(moduleUrl('entity-references.js'));
const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
const start = app.indexOf('function showDetail(');
const end = app.indexOf('function modal(', start);
assert(start >= 0 && end > start, 'guide detail renderer exists');

async function harness({ record, index = encyclopedia(), spoiler = 'details', saved = {} } = {}) {
  const { createEntityReferences } = await referencesModule;
  const entityReferences = createEntityReferences({
    index: () => index,
    esc,
    picture: (id) => `<span data-picture="${esc(id)}"></span>`,
    icon: () => '',
    qualityText: { html: (_id, label) => label },
  });
  const entries = record
    ? [record, ...catalog.entries.filter((row) => row.id !== record.id)]
    : catalog.entries;
  const profile = { checks: {}, favorites: [], ...saved };
  const button = (action, label, cls = '', id = '') =>
    `<button class="${esc(cls)}" data-action="${esc(action)}" data-id="${esc(id)}">${label}</button>`;
  const context = {
    catalog,
    entityReferences,
    entry: (id) => entries.find((row) => row.id === id),
    source: (id) => catalog.sources.find((row) => row.id === id),
    profile: () => profile,
    state: { settings: { spoiler } },
    currentDrawer: null,
    drawerId: null,
    revealed: false,
    esc,
    icon: () => '',
    act: button,
    iconButton: (action, _icon, label, id, cls) => button(action, esc(label), cls, id),
    pill: (label) => `<span>${esc(label)}</span>`,
    notice: (label) => `<aside>${esc(label)}</aside>`,
    rememberDrawer: (value) => {
      context.currentDrawer = value;
    },
    showOverlay: (html, drawer) => {
      context.html = html;
      context.isDrawer = drawer;
    },
  };
  vm.createContext(context);
  vm.runInContext(app.slice(start, end) + '\nthis.open = showDetail;', context);
  return context;
}

test('public curated guide titles, locations and revealed steps use shared entity links', async () => {
  const view = await harness();
  view.open('wei-training');
  const title = view.html.match(/<h1>([\s\S]*?)<\/h1>/)[1];
  const location = view.html.match(/<div class="row small muted">([\s\S]*?)<\/div>/)[1];
  const steps = view.html.match(/<ol class="steps">([\s\S]*?)<\/ol>/)[1];
  assert.match(title, /data-action="database-detail" data-id="npc-10047" data-entity-id="npc-10047"/);
  for (const id of ['place-58', 'place-41']) {
    assert(location.includes(`data-action="world-place" data-id="${id}" data-entity-id="${id}"`));
  }
  for (const id of ['npc-10047', 'place-58', 'item-10248', 'place-41']) {
    assert(steps.includes(`data-entity-id="${id}"`), id);
    assert(steps.includes(`data-picture="${id}"`), id + ' uses shared artwork');
  }
  assert.match(steps, /class="text-btn entity-inline pictured-link entity-link"/);
  assert.match(steps, /class="entity-link-label"/);
  assert.equal(view.isDrawer, true);
});

test('guide prose safely escapes HTML and leaves unknown names plain while retaining namesake choices', async () => {
  const record = {
    ...catalog.entries.find((row) => row.id === 'wei-training'),
    title: '<script>卫霍</script>',
    location: '<img onerror="bad">阎浮镇',
    hint: '卫霍找莫弃与未收录旅人 & <iframe src="bad">',
    steps: ['<svg onload="bad">铁木</svg>交给莫弃；未知地点没有资料。'],
  };
  const view = await harness({
    record,
    index: {
      entries: [
        { id: 'npc-1', name: '卫霍', kind: '人物' },
        { id: 'npc-2', name: '莫弃', kind: '人物' },
        { id: 'npc-3', name: '莫弃', kind: '人物' },
        { id: 'item-4', name: '铁木', kind: '物品' },
      ],
      world: { maps: [{ id: 'place-5', key: 'synthetic', name: '阎浮镇' }], quests: [] },
    },
  });
  view.open(record.id);
  const hint = view.html.match(/<p class="intro">([\s\S]*?)<\/p>/)[1];
  const steps = view.html.match(/<ol class="steps">([\s\S]*?)<\/ol>/)[1];
  assert.doesNotMatch(view.html, /<(?:script|img|iframe|svg)\b/);
  assert.match(view.html, /&lt;script&gt;|&lt;\/script&gt;/);
  assert.match(view.html, /&lt;img onerror=&quot;bad&quot;&gt;/);
  assert.match(hint, /&amp; &lt;iframe src=&quot;bad&quot;&gt;/);
  assert.match(steps, /&lt;svg onload=&quot;bad&quot;&gt;/);
  for (const text of [hint, steps]) {
    assert.match(text, /data-action="entity-choice" data-id="name:莫弃" data-entity-id="name:莫弃"/);
    assert.doesNotMatch(text, /data-id="npc-[23]"/);
  }
  assert.match(hint, /与未收录旅人 &amp;/);
  assert.match(steps, /；未知地点没有资料。/);
  assert.doesNotMatch(view.html, /data-(?:id|entity-id)="(?:name:)?(?:未收录旅人|未知地点)"/);
});

test('folded guide metadata keeps sources reachable and preserves checkpoints, spoiler choice and actions', async () => {
  const record = {
    ...catalog.entries.find((row) => row.id === 'wei-training'),
    checkpoint: '离开前完成关键对话',
  };
  const view = await harness({
    record,
    spoiler: 'hints',
    saved: { checks: { [record.id]: 'done' }, favorites: [record.id] },
  });
  view.open(record.id);
  const metadata = view.html.match(
    /<details\b([^>]*)><summary>资料来源与参考阶段<\/summary>([\s\S]*?)<\/details>/,
  );
  assert(metadata, 'reference metadata remains expandable');
  assert.doesNotMatch(metadata[1], /\bopen(?:\s|=|$)/);
  assert(metadata[2].includes(esc(catalog.stages[record.stage].title)));
  assert.match(metadata[2], /data-action="source" data-id="wei"/);
  assert(metadata[2].includes(esc(catalog.sources.find((row) => row.id === 'wei').title)));
  assert.match(metadata[2], /版本与前置选择可能改变触发条件/);
  const mainContent = view.html.slice(0, metadata.index);
  assert.match(mainContent, /核对节点：离开前完成关键对话/);
  assert.match(mainContent, /data-action="reveal"/);
  assert.doesNotMatch(mainContent, /<ol class="steps">|data-entity-id="item-10248"|参考标签|非完整攻略/);
  const actions = view.html.slice(view.html.indexOf('<div class="drawer-actions">'));
  assert.match(actions, /data-action="check"[^>]*>已完成 · 撤销/);
  assert.match(actions, /data-action="favorite"[^>]*>取消收藏/);
  assert.match(actions, /data-action="skip"/);
  assert.match(mainContent, /data-action="detail" data-id="wei-huo"/);
  view.open(record.id, true, true);
  assert.match(view.html, /<ol class="steps">/);
  assert.match(view.html, /data-entity-id="item-10248"/);
  assert.doesNotMatch(view.html, /data-action="reveal"/);
});

test('curated checklist, index cards and favorites keep entity previews available before opening a guide', async () => {
  const view = await harness({ saved: { favorites: ['wei-training'], goals: [] } });
  const entry = catalog.entries.find((row) => row.id === 'wei-training');
  Object.assign(view, {
    gameImages: { person: () => '' },
    kindIcon: () => 'book',
    pageHeader: () => '',
    journeyTrashViews: { entry: () => '' },
    orderedGoals: () => [],
    goalDone: () => false,
    goalRow: () => '',
    noteBlock: () => '',
    compact: false,
    empty: () => '',
  });
  for (const [name, endName] of [
    ['checkRow', 'pageHeader'],
    ['entryRow', 'matchesQuery'],
    ['entryCard', 'itemGoal'],
    ['goalsPage', 'nodeDraftPanel'],
  ]) {
    const start = app.indexOf('function ' + name + '(');
    const end = app.indexOf('function ' + endName + '(', start);
    vm.runInContext(app.slice(start, end), view);
    const html = name === 'goalsPage' ? view[name]() : view[name](entry);
    for (const id of ['npc-10047', 'place-58', 'place-41'])
      assert(html.includes('data-entity-id="' + id + '"'), name + ': ' + id);
    assert.doesNotMatch(html, /<button[^>]*class="check-title"[^>]*>[\s\S]*?<button/);
    assert(html.includes('data-action="detail"'), name + ' retains full guide navigation');
  }
});
