'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path');
const { encyclopedia } = require('../src/core/game-data.cjs');
const read = (name) => fs.readFileSync(path.join(__dirname, '../src/renderer', name), 'utf8');
const dataURL = (source) => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const moduleURL = (name) =>
  dataURL(
    read(name).replace(
      /from '(\.\/[^']+)'/g,
      (_, dependency) => 'from ' + JSON.stringify(moduleURL(dependency.slice(2))),
    ),
  );
const loaded = import(moduleURL('world-views.js'));
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
test('unknown scene characters keep their place context without exposing raw identifiers', async () => {
  const { createWorldViews } = await loaded;
  const view = createWorldViews({
    esc,
    act: (action, label) => `<button data-action="${action}">${label}</button>`,
    pill: esc,
    notice: esc,
    icon: () => '',
    iconButton: () => '',
    when: esc,
    empty: esc,
    picture: () => '',
  });
  const index = encyclopedia();
  const html = view.questDetail(index, 'quest-5509', { reference: null }, true);
  assert.match(html, /前往城北的将军府献书/);
  assert.match(html, /关联地点/);
  assert.match(html, /未收录人物/);
  assert.doesNotMatch(html, /角色 #|30008|36751|36658/);
});

test('quest and place queries disclose invalid syntax and recover without changing selected reference or filters', async () => {
  const { createWorldViews } = await loaded;
  const viewFactory = createWorldViews({
    esc,
    act: () => '',
    pill: esc,
    notice: esc,
    icon: () => '',
    iconButton: () => '',
    when: esc,
    empty: (title, body) => esc(title + ' ' + body),
    picture: () => '',
  });
  const index = encyclopedia();
  for (const kind of ['quests', 'places']) {
    const view = {
      kind,
      query: '',
      status: 'all',
      roots: false,
      page: 0,
      referenceName: '',
      follow: false,
      reference: null,
    };
    for (const query of ['(武当', '名称:', '"未闭合', 'unknown:value', '武当 or']) {
      view.query = query;
      const before = structuredClone(view);
      const html = viewFactory.page(index, view, []);
      assert.match(html, /id="world-search-error" role="alert"/);
      assert.match(html, /aria-invalid="true" aria-describedby="world-search-error"/);
      assert.ok(html.includes(esc(query)));
      assert.ok(!html.includes('没有匹配的线索'));
      assert.ok(!html.includes('class="database-card'));
      assert.deepEqual(view, before);
    }
    view.query = '武当';
    const recovered = viewFactory.page(index, view, []);
    assert.match(recovered, /class="database-card/);
    assert.ok(!recovered.includes('world-search-error'));
    assert.ok(!recovered.includes('aria-invalid="true"'));
    view.query = '不存在的地方或任务';
    assert.match(viewFactory.page(index, view, []), /没有匹配的线索/);
  }
});

test('public task mentions use one namesake chooser instead of indistinguishable character buttons', async () => {
  const { createWorldViews } = await loaded;
  const view = createWorldViews({
    esc,
    pill: esc,
    notice: esc,
    icon: () => '',
    iconButton: () => '',
    when: esc,
    empty: esc,
    picture: () => '',
    act: (action, label, cls, id) => `<button data-action="${action}" data-id="${esc(id)}">${label}</button>`,
  });
  const index = encyclopedia();
  for (const [id, name] of [
    ['quest-5218', '道通'],
    ['quest-5239', '道通'],
    ['quest-5230', '莫弃'],
  ]) {
    const html = view.questDetail(index, id, { reference: null }, true);
    const mentions = html.slice(html.indexOf('task-mentions'));
    assert.equal(
      (mentions.match(new RegExp('data-action="entity-choice" data-id="name:' + name + '"', 'g')) || [])
        .length,
      1,
    );
  }
});
