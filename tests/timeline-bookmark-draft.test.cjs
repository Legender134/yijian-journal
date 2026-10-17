'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const { Timeline } = require(path.join(root, 'src/core/timeline.cjs'));
const { Activity } = require(path.join(root, 'src/core/activity.cjs'));
const { syntheticSave } = require(path.join(root, 'tests/fixtures.cjs'));
const mainSource = fs.readFileSync(path.join(root, 'src/main.cjs'), 'utf8');
const rendererSource = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
function section(source, start, end) {
  const a = source.indexOf(start),
    b = source.indexOf(end, a);
  assert(a >= 0 && b > a);
  return source.slice(a, b);
}
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-bookmark-draft-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert(path.basename(dir).startsWith('yijian-bookmark-draft-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const saves = path.join(dir, 'synthetic', 'SaveGames');
  fs.mkdirSync(saves, { recursive: true });
  const bytes = syntheticSave({ full: true, seconds: 100 });
  fs.writeFileSync(path.join(saves, '1.sav'), bytes);
  const timeline = new Timeline(path.join(dir, 'history'));
  timeline.configure(saves, false, 10);
  const record = timeline.record(bytes, 'manual');
  timeline.updateNode(record.id, { label: '正式名称', note: '正式备注' });
  const activity = new Activity(dir),
    draft = { label: '尚未提交的名称', note: '草稿备注 <保留原文>' };
  activity.draft(record.id, draft);
  let update;
  vm.runInNewContext(section(mainSource, "    handle('timeline-update',", "    handle('timeline-release',"), {
    handle: (name, fn) => {
      assert.equal(name, 'timeline-update');
      update = fn;
    },
    timeline,
    activity,
    broadcast: () => {},
    overview: () => ({ activity: activity.get() }),
  });
  const inputs = {
    '#timeline-label': { value: draft.label },
    '#timeline-note': { value: draft.note },
    '#node-draft-status': {},
  };
  const context = vm.createContext({
    currentDrawer: {
      type: 'timeline',
      data: {
        record: timeline.inspect(record.id).record,
        draft: { ...draft },
        observedDraft: activity.get().drafts[record.id],
      },
    },
    document: { querySelector: (selector) => inputs[selector] },
    overlay: { querySelectorAll: () => [] },
    environment: { activity: activity.get() },
    nodeDraftQueue: Promise.resolve(),
    pendingNodeDrafts: new Map(),
    pendingNodeDraftBases: new Map(),
    pendingNodeDraftOwners: new Map(),
    refreshingTimelineNodes: new Set(),
    compact: false,
    handbookSuspended: false,
    submittingNodes: new Set(),
    toast: () => {},
    render: () => {},
    nodeControlsDisabled: () => {},
    timelineViews: { preview: (value) => value },
    showOverlay: () => {},
    rememberDrawer: (value) => {
      context.currentDrawer = value;
    },
    call: async (method, id, value, expected, expectedDraft) => {
      if (method === 'nodeDraft') {
        if (value != null) timeline.checkNodeVersion(id, expected);
        activity.draft(id, value, expectedDraft);
        return activity.get();
      }
      if (method === 'timelineUpdate') return update({}, id, value, expected, expectedDraft);
      if (method === 'timelineInspect')
        return {
          ...timeline.inspect(id),
          draft: activity.get().drafts[id],
          observedDraft: activity.get().drafts[id] || null,
        };
      throw Error('Unexpected API ' + method);
    },
  });
  vm.runInContext(
    section(rendererSource, 'function removePendingNodeDraft(', '\nfunction nodeControlsDisabled('),
    context,
  );
  vm.runInContext(section(rendererSource, 'function captureNodeDraft()', '\nconst orderedGoals'), context);
  const branch = section(rendererSource, "    case 'timeline-bookmark':", "    case 'shortcuts-save':");
  const act = async (action, retain = false) => {
    context.action = action;
    context.id = record.id;
    context.target = { dataset: retain ? { retain: 'true' } : {} };
    await vm.runInContext('(async () => { switch (action) {\n' + branch + '\n} })()', context);
    assert.deepEqual(fs.readFileSync(path.join(saves, '1.sav')), bytes);
    return timeline.inspect(record.id).record;
  };
  return { act, timeline, activity, dir, record, draft, context };
}
test('bookmark toggles preserve the separate unsaved name and note through persistence and reopening', async (t) => {
  const s = setup(t);
  for (const expected of [false, true]) {
    const record = await s.act('timeline-bookmark');
    assert.equal(record.bookmarked, expected);
    assert.equal(record.label, '正式名称');
    assert.equal(record.note, '正式备注');
    const restored = new Activity(s.dir).get().drafts[s.record.id];
    assert.equal(restored.label, s.draft.label);
    assert.equal(restored.note, s.draft.note);
    assert.equal(s.context.currentDrawer.data.draft.label, s.draft.label);
  }
});
test('explicit name and note save commits that draft and then clears its recovery copy', async (t) => {
  const s = setup(t),
    record = await s.act('timeline-edit-save');
  assert.equal(record.label, s.draft.label);
  assert.equal(record.note, s.draft.note);
  assert.equal(record.bookmarked === true || (record.kind === 'manual' && record.bookmarked !== false), true);
  assert.equal(new Activity(s.dir).get().drafts[s.record.id], undefined);
  assert.equal(s.context.currentDrawer.data.draft, undefined);
});
test('save and bookmark explicitly commits both edits and long-term retention', async (t) => {
  const s = setup(t);
  await s.act('timeline-bookmark');
  const record = await s.act('timeline-edit-save', true);
  assert.equal(record.bookmarked, true);
  assert.equal(record.label, s.draft.label);
  assert.equal(record.note, s.draft.note);
  assert.equal(new Activity(s.dir).get().drafts[s.record.id], undefined);
});
