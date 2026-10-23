'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
const start = source.indexOf('function saveReviewActions('),
  end = source.indexOf('function savesPage()', start);
assert(start > 0 && end > start);
const files = [
  { name: '1.sav', metadata: { mapName: '梧桐村' }, modifiedAt: '2026-10-16T04:00:00Z' },
  { name: '2.sav', metadata: { mapName: '武当派' }, modifiedAt: '2026-10-15T04:00:00Z' },
];
function render(selected, rows = files, compact = true, sourceFiles = rows) {
  const context = vm.createContext({
    readableSaves: () => rows,
    defaultReference: () => selected,
    environment: { saves: { files: sourceFiles } },
    act: (action, label, cls, id) => `<button data-action="${action}" data-id="${id}">${label}</button>`,
    esc: (value) => String(value),
    when: (value) => String(value),
  });
  vm.runInContext(source.slice(start, end), context);
  return context.saveReviewActions(compact);
}
test('save review and comparison use the selected fixed progress without changing it or exposing it in the normal heading', () => {
  const before = JSON.stringify(files),
    html = render('2.sav');
  assert.match(html, /data-action="save-detail" data-id="2.sav">进度回顾/);
  assert.match(html, /data-action="save-compare" data-id="2.sav">比较进度/);
  const heading = html.slice(0, html.indexOf('<details'));
  assert.doesNotMatch(heading.replace(/<[^>]+>/g, ''), /\.sav|2026|参照|所属/);
  assert.match(html, /data-action="save-detail" data-id="1.sav">回顾/);
  assert.equal(JSON.stringify(files), before);
});
test('missing fixed progress never silently reviews another save; empty and single-save libraries remain useful', () => {
  const html = render('missing.sav');
  assert.match(html, /所选进度暂不可读/);
  assert.doesNotMatch(html.slice(0, html.indexOf('<details')), /data-action="save-detail"/);
  assert.match(html, /data-id="1.sav">回顾/);
  assert.match(html, /data-id="2.sav">回顾/);
  assert.equal(render('', []), '');
  const unavailable = render('missing.sav', []);
  assert.match(unavailable, /所选进度暂不可读/);
  assert.doesNotMatch(unavailable, /data-action="save-detail"|save-compare|missing\.sav/);
  assert.match(render('', [], true, [{ name: '1.sav' }]), /进度暂不可读，可先备份原文件/);
  assert.equal(render('', [], false, [{ name: '1.sav' }]), '');
  assert.match(render('', [files[0]]), /data-id="1.sav">进度回顾/);
  assert.doesNotMatch(render('', [files[0]]), /save-compare|<details/);
  assert.doesNotMatch(render('2.sav', files, false), /compact-save-history/);
});

const modalStart = source.indexOf('function saveSlotModal('),
  modalEnd = source.indexOf('function searchModal(', modalStart);
const handleStart = source.indexOf('async function handle('),
  switchStart = source.indexOf('  switch (action)', handleStart),
  caseStart = source.indexOf("    case 'save-slot':", switchStart),
  caseEnd = source.indexOf("    case 'save-slot-save':", caseStart);
assert(modalStart > 0 && modalEnd > modalStart && caseEnd > caseStart);
const stale = [
  { name: '1.sav', metadata: { mapName: '梧桐村' } },
  { name: '3.sav', metadata: { mapName: '武当派' } },
];
const fresh = [
  { name: '1.sav', metadata: { mapName: '梧桐村' } },
  { name: '3.sav', metadata: null },
];
function harness() {
  const pending = [],
    modals = [],
    context = vm.createContext({
      environment: { saves: { files: stale } },
      currentDrawer: null,
      handbookRequest: 0,
      refreshRequest: 0,
      refreshReadingsPending: false,
      handbookSuspended: false,
      overlay: { firstChild: null },
      profileValue: { id: 'one', saveSlot: '2.sav' },
      profile: () => context.profileValue,
      call: async (method) => {
        assert.equal(method, 'refresh');
        return new Promise((resolve, reject) => pending.push({ resolve, reject }));
      },
      modal: (_title, _description, html) => modals.push(html),
      esc: String,
      act: () => '',
      hours: () => '',
      when: () => '',
    });
  vm.runInContext(
    source.slice(modalStart, modalEnd) +
      source.slice(handleStart, switchStart) +
      '  switch (action) {\n' +
      source.slice(caseStart, caseEnd) +
      '  }\n}',
    context,
  );
  context.refresh = async () => {
    await context.call('refresh');
  };
  return {
    context,
    pending,
    modals,
    open: () => context.handle('save-slot', '', { dataset: {}, closest: () => null }),
  };
}
test('progress picker uses its own fresh scan when an overlapping refresh invalidates the shared refresh', async () => {
  const h = harness(),
    start = source.indexOf('async function refresh(background'),
    end = source.indexOf('async function handle(', start);
  vm.runInContext(source.slice(start, end), h.context);
  const opening = h.open();
  assert.equal(h.pending.length, 1);
  h.context.refresh(true);
  assert.equal(h.pending.length, 2);
  h.pending[0].resolve({ saves: { files: fresh } });
  await opening;
  assert.equal(h.modals.length, 1);
  assert.doesNotMatch(h.modals[0], /<option value="3\.sav"/);
  assert.equal(h.context.environment.saves.files, stale);
});
test('late progress-picker scan success or failure cannot reopen a replaced or left context', async () => {
  for (const reason of ['navigation', 'profile', 'overlay', 'handoff'])
    for (const failure of [false, true]) {
      const h = harness(),
        opening = h.open();
      assert.equal(h.pending.length, 1);
      if (reason === 'navigation') h.context.handbookRequest++;
      if (reason === 'profile') h.context.profileValue = { id: 'two' };
      if (reason === 'overlay') h.context.overlay.firstChild = { newModal: true };
      if (reason === 'handoff') h.context.handbookSuspended = true;
      if (failure) h.pending[0].reject(new Error('late scan failure'));
      else h.pending[0].resolve({ saves: { files: fresh } });
      await opening;
      assert.equal(h.modals.length, 0, reason + ' ' + failure);
    }
});
test('progress-picker fresh snapshot omits unreadable alternatives and retains the exact unavailable selected slot', () => {
  const h = harness();
  h.context.saveSlotModal(fresh);
  assert.equal(h.modals.length, 1);
  assert.doesNotMatch(h.modals[0], /<option value="3\.sav"/);
  assert.match(h.modals[0], /<option value="2\.sav" selected>2\.sav · 当前不可读/);
  assert.match(h.modals[0], /<option value="1\.sav"/);
});
