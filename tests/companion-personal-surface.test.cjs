'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
const code = source.slice(
  source.indexOf('function compactPage()'),
  source.indexOf('async function showEntityChoice('),
);
function render({ profile = {}, data = {}, undo = null } = {}) {
  const current = {
    id: 'synthetic',
    stage: 0,
    stageConfirmed: false,
    checks: {},
    goals: [],
    notes: '',
    ...profile,
  };
  const context = {
    route: 'home',
    document: { body: { classList: { add: () => {}, toggle: () => {} } } },
    companionMode: 'expanded',
    headings: {},
    companionData: data,
    companionViews: {
      frame: (html) => html,
      actions: () => '<div>个人行动</div>',
      materials: () => '<div>制作计划</div>',
    },
    healthAlert: () => '',
    pending: () => [],
    compactUndo: undo,
    profile: () => current,
    currentFlow: () => ({}),
    flowViews: { panel: () => '<section data-flow-now>当前流程</section>' },
    state: { settings: {} },
    orderedGoals: () => current.goals,
    goalDone: (g) => !!g.done,
    esc: (v) => String(v ?? ''),
    act: (a, l) => `<button data-action="${a}">${l}</button>`,
    iconButton: () => '',
    stageTitle: () => '初入江湖',
    checkRow: () => '',
  };
  vm.createContext(context);
  vm.runInContext(code + '\nthis.render=compactPage;', context);
  return context.render();
}
test('a fresh companion keeps the current workflow and omits an empty personal-planning group', () => {
  for (const data of [{}, { nextActions: [{ id: 'automatic-current-task', kind: 'quest' }] }]) {
    const html = render({ data });
    assert.match(html, /当前流程/);
    assert.doesNotMatch(html, /flow-personal|暂无目标|制作计划|手动阶段的精选清单/);
  }
});
test('actual goals, notes and explicit manual tracking retain the personal controls', () => {
  for (const profile of [
    { goals: [{ id: 'one', title: '想学的招式' }] },
    { notes: '明日回武当' },
    { stageConfirmed: true },
    { checks: { one: { status: 'done' } } },
  ])
    assert.match(render({ profile }), /flow-personal/);
});
test('completed crafting and itinerary records remain accessible even without pending goals', () => {
  for (const data of [
    { materials: { recipes: [{ id: 1000 }] }, materialsCompleted: true },
    { itinerary: { steps: [{ id: 'step' }], status: 'ended' } },
    { nextActions: [{ id: 'gift' }] },
  ])
    assert.match(render({ data }), /flow-personal/);
});
test('the last manual completion can still be undone when no other personal entry remains', () => {
  const html = render({ undo: { profileId: 'synthetic', title: '采药' } });
  assert.match(html, /flow-personal/);
  assert.match(html, /compact-undo/);
});
