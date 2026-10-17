'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const { Timeline } = require(path.join(root, 'src/core/timeline.cjs')),
  { Activity } = require(path.join(root, 'src/core/activity.cjs')),
  { syntheticSave } = require(path.join(root, 'tests/fixtures.cjs'));
const main = fs.readFileSync(path.join(root, 'src/main.cjs'), 'utf8'),
  renderer = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
function section(source, start, end) {
  const a = source.indexOf(start),
    b = source.indexOf(end, a);
  assert(a >= 0 && b > a);
  return source.slice(a, b);
}
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-node-concurrency-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert(path.basename(dir).startsWith('yijian-node-concurrency-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const saves = path.join(dir, 'SaveGames');
  fs.mkdirSync(saves);
  const bytes = syntheticSave({ full: true, seconds: 100 });
  fs.writeFileSync(path.join(saves, '1.sav'), bytes);
  const timeline = new Timeline(path.join(dir, 'history'));
  timeline.configure(saves, false, 10);
  const node = timeline.record(bytes, 'manual');
  timeline.updateNode(node.id, { label: '原名称', note: '原备注' });
  const activity = new Activity(dir),
    handlers = {};
  const globals = {
    handle: (name, fn) => {
      handlers[name] = fn;
    },
    timeline,
    activity,
    broadcast: () => {},
    overview: () => ({ activity: activity.get() }),
  };
  vm.runInNewContext(section(main, "    handle('node-draft',", "    handle('quit-ready',"), globals);
  vm.runInNewContext(
    section(main, "    handle('timeline-update',", "    handle('timeline-release',"),
    globals,
  );
  const envelope =
    (fn) =>
    async (...args) => {
      try {
        return { ok: true, data: await fn(...args) };
      } catch (error) {
        return { ok: false, error: error.message, code: error.code };
      }
    };
  const fields = {
    '#timeline-label': { value: '原名称' },
    '#timeline-note': { value: '原备注' },
    '#node-draft-status': {},
  };
  const controls = [
    ...Object.entries(fields)
      .filter(([key]) => key !== '#node-draft-status')
      .map(([key, value]) =>
        Object.assign(value, { key, matches: (selector) => selector.includes(key), isConnected: true }),
      ),
    ...['timeline-edit-save', 'timeline-bookmark', 'timeline-draft-discard'].map((action) => ({
      action,
      matches: (selector) => selector.includes('[data-action="' + action + '"]'),
      isConnected: true,
    })),
  ];
  const calls = [],
    notes = [],
    context = vm.createContext({
      currentDrawer: {
        type: 'timeline',
        data: { record: timeline.inspect(node.id).record, observedDraft: null },
      },
      compact: false,
      handbookSuspended: false,
      handbookRequest: 0,
      detailRequest: 0,
      route: 'saves',
      environment: { activity: activity.get() },
      nodeDraftQueue: Promise.resolve(),
      pendingNodeDrafts: new Map(),
      pendingNodeDraftBases: new Map(),
      pendingNodeDraftOwners: new Map(),
      refreshingTimelineNodes: new Set(),
      submittingNodes: new Set(),
      document: { querySelector: (selector) => fields[selector] },
      overlay: { querySelectorAll: () => controls, firstElementChild: {} },
      state: { activeProfileId: 'p', profiles: [{ id: 'p', notes: '原随手记' }] },
      profile: () => context.state.profiles.find((p) => p.id === context.state.activeProfileId),
      mutation: async (command) => {
        notes.push(structuredClone(command));
        context.state.profiles.find((p) => p.id === command.profileId).notes = command.value;
      },
      saveNote: async () => {},
      act: (action, label, cls, id) => `<button data-action="${action}" data-id="${id}">${label}</button>`,
      esc: (value) => String(value).replaceAll('<', '&lt;'),
      toast: () => {},
      render: () => {},
      timelineViews: { preview: (value) => value },
      rememberDrawer: (value) => {
        context.captureNodeDraft();
        context.currentDrawer = value;
      },
      showOverlay: (value) => {
        context.rendered = value;
        fields['#timeline-label'].value = value.draft?.label ?? value.record.label ?? '';
        fields['#timeline-note'].value = value.draft?.note ?? value.record.note ?? '';
        context.nodeControlsDisabled(value.record.id, false);
      },
      modal: (...args) => {
        context.modalArgs = args;
        context.currentDrawer = null;
      },
      api: {
        nodeDraft: envelope((id, value, expected, expectedDraft) => {
          calls.push({ method: 'nodeDraft', id, value, expected });
          return handlers['node-draft']({}, id, value, expected, expectedDraft);
        }),
        timelineUpdate: envelope((id, value, expected, expectedDraft) => {
          calls.push({ method: 'timelineUpdate', id, value, expected });
          return handlers['timeline-update']({}, id, value, expected, expectedDraft);
        }),
        timelineInspect: envelope((id) => ({ ...timeline.inspect(id), draft: activity.get().drafts[id] })),
      },
    });
  vm.runInContext(
    section(renderer, 'function removePendingNodeDraft(', '\nasync function prepareQuit('),
    context,
  );
  vm.runInContext(section(renderer, 'function captureNodeDraft()', '\nconst orderedGoals'), context);
  vm.runInContext(section(renderer, 'async function call(method,', '\nfunction toast('), context);
  const branches =
    section(renderer, "    case 'timeline-reload':", "    case 'node-draft-review':") +
    section(renderer, "    case 'timeline-bookmark':", "    case 'shortcuts-save':") +
    section(renderer, "    case 'timeline-draft-discard':", "    case 'reserve-save':");
  const act = async (action, id = node.id) => {
    context.action = action;
    context.id = id;
    context.target = { dataset: {} };
    await vm.runInContext('(async()=>{switch(action){' + branches + '}})()', context);
    assert.deepEqual(fs.readFileSync(path.join(saves, '1.sav')), bytes);
  };
  const base = () => {
    const r = timeline.inspect(node.id).record;
    return { label: r.label || '', note: r.note || '' };
  };
  const externalSave = (note) => handlers['timeline-update']({}, node.id, { label: '原名称', note }, base());
  return {
    dir,
    timeline,
    node,
    activity,
    handlers,
    context,
    fields,
    controls,
    calls,
    notes,
    act,
    base,
    externalSave,
  };
}
function handoffHarness(s, direction) {
  const c = s.context,
    sent = [],
    noop = () => {},
    asyncNoop = async () => {};
  Object.assign(c, {
    compact: direction === 'send',
    captureJournalDraft: noop,
    captureIntentDrafts: noop,
    flushJournalDrafts: asyncNoop,
    flushIntentDrafts: asyncNoop,
    closeOverlay: () => {
      c.detailRequest++;
      c.currentDrawer = null;
    },
    npcProgressView: {},
    worldView: {},
    materialView: {},
    refresh: asyncNoop,
    restoreHandbookPresentation: noop,
    drawerHistory: [],
    openHandbookDetail: async (value) => {
      sent.push(value);
      return false;
    },
    handbookReadingContext: () => ({
      profileId: 'p',
      route: 'saves',
      detail: { type: 'timeline', id: s.node.id },
    }),
    root: { querySelector: () => null },
  });
  c.api.window = async (action, value) => {
    assert.equal(action, 'main');
    sent.push(value);
    return { ok: true };
  };
  if (direction === 'send') {
    vm.runInContext(
      'this.handoff=async()=>{const action="main";switch(action){' +
        section(renderer, "    case 'main':", "    case 'window-minimize':") +
        '}};',
      c,
    );
  } else {
    vm.runInContext(
      section(renderer, 'async function receiveHandbookContext(', '\nasync function openHandbookDetail(') +
        '\nthis.handoff=()=>receiveHandbookContext({profileId:"p",route:"saves",query:"",detail:{type:"timeline",id:"incoming-node"}});',
      c,
    );
  }
  return { run: () => c.handoff(), sent };
}

for (const direction of ['send', 'receive']) {
  for (const recovery of ['node-pending-to-note', 'node-pending-discard']) {
    test(`${direction} handoff resumes after ${recovery} with a recovered or closed editor`, async (t) => {
      for (const closed of [false, true]) {
        const s = setup(t);
        s.fields['#timeline-note'].value = '本地冲突输入';
        s.externalSave('另一窗口正式新备注');
        await assert.rejects(s.context.captureNodeDraft(), (e) => e.code === 'TIMELINE_NODE_CHANGED');
        await s.act('timeline-reload');
        await s.act(recovery);
        assert.equal(s.context.pendingNodeDrafts.size, 0);
        assert.equal(s.fields['#timeline-note'].value, '另一窗口正式新备注');
        if (closed) s.context.currentDrawer = null;
        const handoff = handoffHarness(s, direction);
        await handoff.run();
        assert.equal(handoff.sent.length, 1);
        assert.equal(handoff.sent[0].detail.id, direction === 'send' ? s.node.id : 'incoming-node');
        assert.equal(s.timeline.inspect(s.node.id).record.note, '另一窗口正式新备注');
        assert.equal(s.activity.get().drafts[s.node.id], undefined);
        if (recovery === 'node-pending-to-note')
          assert.match(s.context.state.profiles[0].notes, /本地冲突输入/);
      }
    });
  }
  test(`${direction} handoff still refuses unresolved current node input`, async (t) => {
    const s = setup(t);
    s.fields['#timeline-note'].value = '尚未恢复的本地输入';
    s.externalSave('另一窗口正式新备注');
    await assert.rejects(s.context.captureNodeDraft(), (e) => e.code === 'TIMELINE_NODE_CHANGED');
    const handoff = handoffHarness(s, direction);
    await assert.rejects(handoff.run(), (e) => e.code === 'TIMELINE_NODE_CHANGED');
    assert.equal(handoff.sent.length, 0);
    assert.equal(s.context.pendingNodeDrafts.get(s.node.id).note, '尚未恢复的本地输入');
    assert.equal(s.context.handbookSuspended, false);
    assert.equal(s.timeline.inspect(s.node.id).record.note, '另一窗口正式新备注');
  });
}

test('a stale second window cannot overwrite a formally saved newer node', (t) => {
  const s = setup(t),
    base = s.base();
  s.externalSave('主窗正式新备注');
  assert.throws(
    () => s.handlers['timeline-update']({}, s.node.id, { note: '随行旧备注' }, base),
    (e) => e.code === 'TIMELINE_NODE_CHANGED',
  );
  assert.equal(s.timeline.inspect(s.node.id).record.note, '主窗正式新备注');
});
test('stale autosave is refused before it can resurrect a cleared or different draft', (t) => {
  const s = setup(t),
    base = s.base();
  s.externalSave('主窗正式新备注');
  assert.throws(
    () => s.handlers['node-draft']({}, s.node.id, { label: '旧名称', note: '旧输入' }, base),
    (e) => e.code === 'TIMELINE_NODE_CHANGED',
  );
  assert.equal(s.activity.get().drafts[s.node.id], undefined);
  s.activity.draft(s.node.id, { label: '新草稿名称', note: '另一个编辑区的新草稿' });
  const before = s.activity.get();
  assert.throws(() => s.handlers['node-draft']({}, s.node.id, { label: '旧名称', note: '旧输入' }, base));
  assert.deepEqual(s.activity.get(), before);
});
test('valid bounded versions permit draft and formal save while bookmark-only updates preserve the draft', (t) => {
  const s = setup(t),
    base = s.base();
  s.handlers['node-draft']({}, s.node.id, { label: '我的新名称', note: '我的输入' }, base);
  s.handlers['timeline-update']({}, s.node.id, { bookmarked: false }, base);
  assert.equal(s.activity.get().drafts[s.node.id].note, '我的输入');
  s.handlers['timeline-update']({}, s.node.id, { label: '我的新名称', note: '我的输入' }, base);
  assert.equal(s.activity.get().drafts[s.node.id], undefined);
  assert.equal(s.timeline.inspect(s.node.id).record.note, '我的输入');
  const current = s.timeline.inspect(s.node.id).record;
  for (const invalid of [
    null,
    [],
    {},
    { label: '原名称', note: 0 },
    { label: 'x'.repeat(81), note: '' },
    { label: '', note: 'x'.repeat(501) },
    { label: '', note: '', extra: true },
  ])
    assert.throws(() => s.timeline.updateNode(s.node.id, { note: '不应写入' }, invalid), /版本信息无效/);
  assert.deepEqual(s.timeline.inspect(s.node.id).record, current);
});
test('suspended handoff does not recapture the old companion DOM, and return reloads the authoritative saved note', async (t) => {
  const s = setup(t);
  s.context.compact = true;
  s.context.handbookSuspended = true;
  s.fields['#timeline-note'].value = '随行转交前输入';
  s.context.currentDrawer.data.draft = { label: '原名称', note: '随行转交前输入' };
  s.externalSave('主窗正式新备注');
  await s.context.captureNodeDraft();
  assert.equal(s.calls.length, 0);
  s.context.handbookSuspended = false;
  await s.context.reloadTimelineDrawer();
  assert.equal(s.fields['#timeline-note'].value, '主窗正式新备注');
  assert.equal(s.context.currentDrawer.data.draft, undefined);
  assert.equal(s.activity.get().drafts[s.node.id], undefined);
  assert.equal(s.calls.length, 0);
});
test('conflicting local input stays separate from the fresh record and can be transferred without overwriting it', async (t) => {
  const s = setup(t);
  s.fields['#timeline-label'].value = '随行未保存名称';
  s.fields['#timeline-note'].value = '随行未保存 <原文>';
  s.externalSave('主窗正式新备注');
  await assert.rejects(s.context.captureNodeDraft(), (e) => e.code === 'TIMELINE_NODE_CHANGED');
  assert.equal(s.context.pendingNodeDrafts.get(s.node.id).note, '随行未保存 <原文>');
  assert.match(s.fields['#node-draft-status'].innerHTML, /核对并保留输入/);
  await s.act('timeline-reload');
  assert.equal(s.context.currentDrawer.data.record.note, '主窗正式新备注');
  assert.equal(s.context.currentDrawer.data.draftConflict.note, '随行未保存 <原文>');
  assert.equal(s.fields['#timeline-note'].disabled, true);
  await s.act('node-pending-to-note');
  assert.equal(s.notes[0].profileId, 'p');
  assert.equal(s.notes[0].value, '原随手记\n\n节点未保存输入\n随行未保存名称\n随行未保存 <原文>');
  assert.equal(s.context.pendingNodeDrafts.size, 0);
  assert.equal(s.context.pendingNodeDraftBases.size, 0);
  assert.equal(s.timeline.inspect(s.node.id).record.note, '主窗正式新备注');
  assert.equal(s.fields['#timeline-note'].disabled, false);
});
test('discarding only the conflicting local input leaves another window disk draft intact', async (t) => {
  const s = setup(t),
    old = s.base();
  s.externalSave('主窗正式新备注');
  s.activity.draft(s.node.id, { label: '新草稿', note: '主窗另一份草稿' });
  s.context.pendingNodeDrafts.set(s.node.id, { label: '旧输入', note: '旧输入' });
  s.context.pendingNodeDraftBases.set(s.node.id, old);
  await s.context.reloadTimelineDrawer();
  await s.act('node-pending-discard');
  assert.equal(s.context.pendingNodeDrafts.size, 0);
  assert.equal(s.activity.get().drafts[s.node.id].note, '主窗另一份草稿');
  assert.equal(s.fields['#timeline-note'].value, '主窗另一份草稿');
});
test('pending input remains recoverable after its original node is no longer readable', async (t) => {
  const s = setup(t),
    id = 'missing-node';
  s.context.pendingNodeDrafts.set(id, { label: '失联节点名称', note: '保留原文' });
  s.context.pendingNodeDraftBases.set(id, { label: '', note: '' });
  await s.act('node-pending-review', id);
  assert.match(s.context.modalArgs[2], /失联节点名称.*保留原文/s);
  assert.match(s.context.modalArgs[3], /node-pending-to-note/);
  await s.act('node-pending-to-note', id);
  assert.match(s.notes[0].value, /失联节点名称\n保留原文/);
  assert.equal(s.context.pendingNodeDrafts.has(id), false);
});
test('preload forwards only the explicit version context through the existing narrow API', () => {
  let exposed;
  const calls = [];
  const ipc = { invoke: (...args) => calls.push(args), on: () => {}, removeListener: () => {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src/preload.cjs'), 'utf8'), {
    require: (name) => {
      assert.equal(name, 'electron');
      return {
        contextBridge: {
          exposeInMainWorld: (name, value) => {
            assert.equal(name, 'journal');
            exposed = value;
          },
        },
        ipcRenderer: ipc,
      };
    },
  });
  const base = { label: '原名称', note: '原备注' };
  exposed.nodeDraft('node', { label: '新', note: '输入' }, base);
  exposed.timelineUpdate('node', { note: '正式' }, base);
  assert.deepEqual(
    calls.map((call) => call.slice(0, 2)),
    [
      ['journal:node-draft', 'node'],
      ['journal:timeline-update', 'node'],
    ],
  );
  assert.equal(calls[0][3], base);
  assert.equal(calls[1][3], base);
});

test('same-formal-version foreign drafts cannot be cleared by a stale formal save, and both inputs remain recoverable', async (t) => {
  const s = setup(t);
  s.fields['#timeline-note'].value = '窗口 A 输入';
  await s.context.captureNodeDraft();
  const observed = s.context.currentDrawer.data.observedDraft;
  s.handlers['node-draft']({}, s.node.id, { label: '原名称', note: '窗口 B 输入' }, s.base(), observed);
  await s.act('timeline-edit-save');
  assert.equal(s.timeline.inspect(s.node.id).record.note, '原备注');
  assert.equal(s.activity.get().drafts[s.node.id].note, '窗口 B 输入');
  assert.equal(s.context.currentDrawer.data.draftConflict.note, '窗口 A 输入');
  assert.equal(s.fields['#timeline-note'].value, '窗口 B 输入');
  await s.act('node-pending-to-note');
  assert(s.notes[0].value.includes('窗口 A 输入'));
  assert.equal(s.activity.get().drafts[s.node.id].note, '窗口 B 输入');
  await s.act('timeline-edit-save');
  assert.equal(s.timeline.inspect(s.node.id).record.note, '窗口 B 输入');
  assert.equal(s.activity.get().drafts[s.node.id], undefined);
});
test('same-formal-version foreign autosave blocks a stale local autosave without replacing either input', async (t) => {
  const s = setup(t);
  s.fields['#timeline-note'].value = '窗口 A 先前草稿';
  await s.context.captureNodeDraft();
  const observed = s.context.currentDrawer.data.observedDraft;
  s.handlers['node-draft']({}, s.node.id, { label: '原名称', note: '窗口 B 新草稿' }, s.base(), observed);
  s.fields['#timeline-note'].value = '窗口 A 后续输入';
  await assert.rejects(s.context.captureNodeDraft(), (e) => e.code === 'TIMELINE_DRAFT_CHANGED');
  assert.equal(s.activity.get().drafts[s.node.id].note, '窗口 B 新草稿');
  assert.equal(s.context.pendingNodeDrafts.get(s.node.id).note, '窗口 A 后续输入');
  await s.act('timeline-reload');
  assert.equal(s.context.currentDrawer.data.draftConflict.note, '窗口 A 后续输入');
  await s.act('node-pending-discard');
  assert.equal(s.activity.get().drafts[s.node.id].note, '窗口 B 新草稿');
});
test('discarding an old visible draft does not delete another window newer disk draft', async (t) => {
  const s = setup(t);
  s.fields['#timeline-note'].value = '窗口 A 草稿';
  await s.context.captureNodeDraft();
  const observed = s.context.currentDrawer.data.observedDraft;
  s.handlers['node-draft']({}, s.node.id, { label: '原名称', note: '窗口 B 保留草稿' }, s.base(), observed);
  await s.act('timeline-draft-discard');
  assert.equal(s.activity.get().drafts[s.node.id].note, '窗口 B 保留草稿');
  assert.equal(s.fields['#timeline-note'].value, '窗口 B 保留草稿');
  assert.equal(s.timeline.inspect(s.node.id).record.note, '原备注');
});
test('rapid queued edits advance their own acknowledged draft version instead of conflicting with themselves', async (t) => {
  const s = setup(t);
  s.fields['#timeline-note'].value = '输入一';
  const first = s.context.captureNodeDraft();
  s.fields['#timeline-note'].value = '输入二';
  const second = s.context.captureNodeDraft();
  await Promise.all([first, second]);
  assert.equal(s.activity.get().drafts[s.node.id].note, '输入二');
  assert.equal(s.context.pendingNodeDrafts.size, 0);
  assert.equal(s.context.pendingNodeDraftOwners.size, 0);
});
test('draft versions are bounded, validate exact shape and refuse a stale delete without writes', (t) => {
  const s = setup(t),
    draft = { label: '原名称', note: '草稿' };
  s.activity.draft(s.node.id, draft, null);
  const current = s.activity.get().drafts[s.node.id];
  for (const bad of [
    [],
    {},
    { label: 'x', note: 'n' },
    { ...current, extra: true },
    { ...current, at: 'x' },
    { ...current, label: 'x'.repeat(81) },
  ])
    assert.throws(() => s.activity.draft(s.node.id, null, bad));
  assert.throws(
    () => s.activity.draft(s.node.id, null, null),
    (e) => e.code === 'TIMELINE_DRAFT_CHANGED',
  );
  assert.equal(s.activity.get().drafts[s.node.id].note, '草稿');
  s.activity.draft(s.node.id, null, current);
  assert.equal(s.activity.get().drafts[s.node.id], undefined);
});

test('preload forwards the observed draft alongside the formal record without adding a broader API', () => {
  let exposed;
  const calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src/preload.cjs'), 'utf8'), {
    require: (name) => {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld: (_name, value) => (exposed = value) },
        ipcRenderer: { invoke: (...args) => calls.push(args), on: () => {}, removeListener: () => {} },
      };
    },
  });
  const record = { label: '名称', note: '正式' },
    observed = { label: '名称', note: '草稿', at: 100 };
  exposed.nodeDraft('node', { label: '新', note: '输入' }, record, observed);
  exposed.timelineUpdate('node', { note: '保存' }, record, observed);
  assert.equal(calls[0][0], 'journal:node-draft');
  assert.equal(calls[1][0], 'journal:timeline-update');
  for (const call of calls) {
    assert.equal(call[3], record);
    assert.equal(call[4], observed);
  }
});

test('quit stops at a draft conflict and exposes recovery while keeping the other window disk draft', async (t) => {
  const s = setup(t);
  s.fields['#timeline-note'].value = '窗口 A 输入';
  await s.context.captureNodeDraft();
  const observed = s.context.currentDrawer.data.observedDraft;
  s.handlers['node-draft']({}, s.node.id, { label: '原名称', note: '窗口 B 草稿' }, s.base(), observed);
  await s.act('timeline-edit-save');
  Object.assign(s.context, {
    captureJournalDraft: () => {},
    captureIntentDrafts: () => {},
    flushJournalDrafts: async () => {},
    flushIntentDrafts: async () => {},
    pendingJournalDrafts: new Map(),
    pendingIntentDrafts: new Map(),
    drafts: new Map(),
    quitIntent: false,
  });
  vm.runInContext(
    section(renderer, 'async function prepareQuit()', '\nfunction captureNodeDraft()'),
    s.context,
  );
  assert.equal(await s.context.prepareQuit(), false);
  assert.match(s.context.modalArgs[3], /node-pending-review/);
  assert.equal(s.context.pendingNodeDrafts.get(s.node.id).note, '窗口 A 输入');
  assert.equal(s.activity.get().drafts[s.node.id].note, '窗口 B 草稿');
});

test('late successful or failed pending-input reviews cannot reverse closing, navigation, profile changes or another modal', async (t) => {
  for (const outcome of ['success', 'failure']) {
    for (const action of [
      'close-and-navigate',
      'new-modal',
      'profile-change',
      'handbook-handoff',
      'replaced-input',
    ]) {
      const s = setup(t),
        input = { label: '保留名称', note: '保留原文 <不改写>' };
      s.context.pendingNodeDrafts.set(s.node.id, input);
      let finish;
      s.context.api.timelineInspect = () =>
        new Promise((resolve) => {
          finish = resolve;
        });
      const work = s.act('node-pending-review');
      if (action === 'close-and-navigate') {
        s.context.detailRequest++;
        s.context.currentDrawer = null;
        s.context.route = 'database';
      } else if (action === 'new-modal') {
        s.context.overlay.firstElementChild = { newModal: true };
      } else if (action === 'profile-change') {
        s.context.state.profiles.push({ id: 'other', notes: '' });
        s.context.state.activeProfileId = 'other';
      } else if (action === 'handbook-handoff') {
        s.context.handbookRequest++;
      } else s.context.pendingNodeDrafts.set(s.node.id, { label: '更新名称', note: '较新输入' });
      const pending = s.context.pendingNodeDrafts.get(s.node.id),
        drawer = s.context.currentDrawer;
      finish(
        outcome === 'success'
          ? { ok: true, data: s.timeline.inspect(s.node.id) }
          : { ok: false, error: '合成节点暂不可读' },
      );
      await work;
      assert.equal(s.context.currentDrawer, drawer, action + '/' + outcome);
      assert.equal(s.context.rendered, undefined, action + '/' + outcome);
      assert.equal(s.context.modalArgs, undefined, action + '/' + outcome);
      assert.equal(s.context.pendingNodeDrafts.get(s.node.id), pending);
      assert.equal(s.timeline.inspect(s.node.id).record.note, '原备注');
    }
  }
});
test('the newest pending-input review wins while an earlier result or error cannot replace it', async (t) => {
  for (const olderOutcome of ['success', 'failure']) {
    const s = setup(t),
      input = { label: '保留名称', note: '待核对输入' };
    s.context.pendingNodeDrafts.set(s.node.id, input);
    const requests = [];
    s.context.api.timelineInspect = () => new Promise((resolve) => requests.push(resolve));
    const older = s.act('node-pending-review'),
      newer = s.act('node-pending-review');
    requests[1]({ ok: true, data: s.timeline.inspect(s.node.id) });
    await newer;
    const drawer = s.context.currentDrawer,
      rendered = s.context.rendered;
    assert.equal(drawer.type, 'timeline');
    assert.equal(drawer.data.draft.note, input.note);
    requests[0](
      olderOutcome === 'success'
        ? { ok: true, data: s.timeline.inspect(s.node.id) }
        : { ok: false, error: '较早请求失败' },
    );
    await older;
    assert.equal(s.context.currentDrawer, drawer);
    assert.equal(s.context.rendered, rendered);
    assert.equal(s.context.modalArgs, undefined);
    assert.equal(s.context.pendingNodeDrafts.get(s.node.id), input);
  }
});
