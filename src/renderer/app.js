import {
  compileSearch,
  compareSearchTitles,
  searchFilterFields,
  searchFilterSuggestions,
  insertSearchFilter,
} from './search-query.js';
import { createSearchHelpViews } from './search-help-views.js';
import { createGameViews } from './game-views.js';
import { createComparisonViews } from './comparison-views.js';
import { createWorldViews } from './world-views.js';
import { createMaterialViews, craftMoneyNotice } from './material-views.js';
import { createResourcePriorityViews } from './resource-priority-views.js';
import { createRecipeDiscoveryViews } from './recipe-discovery-views.js';
import { createProtectionViews } from './protection-views.js';
import { createBackupViews } from './backup-views.js';
import { createJourneyViews, itineraryPlaceLabel } from './journey-views.js';
import { createJourneyTrashViews } from './journey-trash-views.js';
import { projectItemUsage } from './item-usage.js';
import { createItemUsageViews } from './item-usage-views.js';
import { createEventJournalViews } from './event-journal-views.js';
import {
  createIntentDraftViews,
  readIntentValues,
  writeIntentValues,
  intentTarget,
} from './intent-draft-views.js';
import { createGiftPicker, giftStock } from './gift-picker.js';
import { createPlacePicker } from './place-picker.js';
import { createGameImages } from './game-images.js';
import { createQualityText } from './quality.js';
import { createTimelineViews } from './timeline-views.js';
import { createCompanionViews } from './companion-view.js';
const api = window.journal;
const compact = new URLSearchParams(location.search).has('compact');
const root = document.querySelector('#app'),
  overlay = document.querySelector('#overlay');
let catalog,
  gameIndex,
  state,
  environment,
  version,
  route = 'home',
  filter = 'current',
  kind = '全部',
  query = '',
  drawerId = null,
  revealed = false,
  lastFocus = null;
let searchSuggestions = [],
  searchSuggestionIndex = -1;
function renderSearchSuggestions() {
  const container = overlay.querySelector('#global-filter-suggestions'),
    input = overlay.querySelector('#global-search');
  if (!container || !input) return;
  container.innerHTML = searchHelpViews.suggestions(searchSuggestions, searchSuggestionIndex);
  input.setAttribute('aria-expanded', String(searchSuggestions.length > 0));
  if (searchSuggestions.length && searchSuggestionIndex >= 0)
    input.setAttribute('aria-activedescendant', 'search-filter-option-' + searchSuggestionIndex);
  else input.removeAttribute('aria-activedescendant');
}
function applySearchSuggestion(suggestion) {
  const input = overlay.querySelector('#global-search');
  if (!input) return;
  if (!suggestion) {
    toast('搜索内容最多 200 字，请先简化条件', true);
    return;
  }
  input.value = suggestion.query;
  input.focus();
  input.setSelectionRange(suggestion.caret, suggestion.caret);
  showSearchResults(input.value);
}
let databaseKind = '物品',
  databaseType = '全部',
  databasePage = 0,
  databaseId = null,
  selectedSave = null,
  referenceSaveName,
  referenceSave = null,
  detailRequest = 0;
let refreshRequest = 0;
let backupPreviewRequest = 0,
  backupRestorePending = false;
let protectionExportRequest = 0;
let startingAssistance = false;
let assistanceError = '';
let referenceFollow;
let nodeDraftQueue = Promise.resolve();
let quitIntent = false;
let compactUndo = null;
let companionData = null,
  companionMode = 'expanded',
  companionVisible = true,
  companionRequest = 0;
const pendingNodeDrafts = new Map();
const pendingJournalDrafts = new Map();
const pendingIntentDrafts = new Map(),
  intentDraftVersions = new Map(),
  intentDraftSaved = new Map();
const itineraryIntentEditors = new Map();
let activeIntentEditor = null,
  intentDraftQueue = Promise.resolve(),
  intentDraftTimer;
let intentDraftConfirmation = null;
let readingScaleQueue = Promise.resolve();
function changeReadingScale(direction) {
  const next = readingScaleQueue
    .catch(() => {})
    .then(async () => {
      const sizes = [100, 110, 125, 150],
        current = state.settings.readingScale || 100;
      const value =
        direction === 'reset'
          ? 100
          : direction === 'in'
            ? sizes.find((size) => size > current) || 150
            : sizes.findLast((size) => size < current) || 100;
      if (value !== current) await mutation({ type: 'settings', value: { readingScale: value } });
    });
  readingScaleQueue = next;
  return next;
}
function intentEditorKey(fieldId, profileId = profile().id) {
  return profileId + '\u0000' + fieldId;
}
function availableIntentDrafts(p = profile()) {
  const rows = new Map((p.intentDrafts || []).map((row) => [row.id, row]));
  for (const [id, value] of pendingIntentDrafts)
    if (value.profileId === p.id)
      rows.set(id, {
        ...rows.get(id),
        ...value,
        revision: intentDraftVersions.get(id) ?? value.expectedRevision,
        pending: true,
        updatedAt: value.capturedAt,
      });
  return [...rows.values()].sort((a, b) =>
    String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')),
  );
}
function intentEditor(kind, targetId, context = {}, row = null, scope = overlay) {
  const value = {
    id: row?.id || crypto.randomUUID(),
    kind,
    targetId,
    context: structuredClone(context),
    profileId: profile().id,
    expectedTarget: structuredClone(intentTarget(profile(), kind, targetId, context)),
    scope,
    initial: JSON.stringify(readIntentValues(kind, scope)),
    persisted: !!row && !row.pending,
  };
  intentDraftVersions.set(value.id, row?.revision || row?.expectedRevision || 0);
  if (value.persisted) intentDraftSaved.set(value.id, value.initial);
  return value;
}
function activateIntentEditor(kind, targetId, context = {}, row = null) {
  activeIntentEditor = intentEditor(kind, targetId, context, row);
  const dialog = overlay.querySelector('.modal');
  dialog?.classList.add('personal-intent-editor');
  dialog
    ?.querySelector('.modal-footer')
    ?.insertAdjacentHTML(
      'beforebegin',
      '<p id="intent-draft-status" class="save-note" role="status">输入后会自动暂存；正式保存才加入当前安排。</p>',
    );
  for (const button of dialog?.querySelectorAll('[data-action="close-overlay"]') || []) {
    if (button.closest('.modal-footer')) button.textContent = '暂存并关闭';
    button.setAttribute('aria-label', '暂存并关闭');
  }
  dialog
    ?.querySelector('.modal-footer')
    ?.insertAdjacentHTML(
      'beforeend',
      (['goal', 'journey-todo', 'journey-gift', 'craft-plan'].includes(kind)
        ? act(
            'intent-draft-copy',
            kind === 'goal' &&
              (itemGoal(activeIntentEditor.expectedTarget) || Object.hasOwn(row?.values || {}, 'quantity'))
              ? '另存此目标的编辑草稿'
              : '另存为新草稿',
            'text-btn',
            activeIntentEditor.id,
          )
        : '') +
        act('intent-draft-recheck', '重新核对原安排…', 'text-btn', activeIntentEditor.id) +
        act('intent-draft-discard', '放弃草稿…', 'text-btn', activeIntentEditor.id),
    );
}
function captureIntentEditor(editor, force = false) {
  if (!editor || !editor.scope?.isConnected || editor.submitting || editor.committed) return;
  const values = readIntentValues(editor.kind, editor.scope),
    signature = JSON.stringify(values);
  if (!force && !editor.persisted && signature === editor.initial) return;
  if (
    signature === intentDraftSaved.get(editor.id) ||
    signature === pendingIntentDrafts.get(editor.id)?.signature
  )
    return;
  pendingIntentDrafts.set(editor.id, {
    type: 'intent-draft-put',
    id: editor.id,
    kind: editor.kind,
    targetId: editor.targetId,
    context: editor.context,
    values,
    expectedRevision: intentDraftVersions.get(editor.id) || 0,
    expectedTarget: editor.expectedTarget,
    profileId: editor.profileId,
    signature,
    capturedAt: new Date().toISOString(),
  });
  if (editor === activeIntentEditor) {
    const status = overlay.querySelector('#intent-draft-status');
    if (status) status.textContent = '正在暂存这些编辑…';
  }
  clearTimeout(intentDraftTimer);
  intentDraftTimer = setTimeout(
    () =>
      flushIntentDrafts().catch((error) => {
        const status = overlay.querySelector('#intent-draft-status');
        if (status) status.textContent = '暂存未完成，编辑仍保留：' + error.message;
        toast('安排草稿未保存：' + error.message, true);
      }),
    300,
  );
}
function captureIntentDrafts(force = false) {
  captureIntentEditor(activeIntentEditor, force);
  for (const editor of itineraryIntentEditors.values())
    if (editor.profileId === profile()?.id) captureIntentEditor(editor);
}
function flushIntentDrafts(onlyId = null) {
  clearTimeout(intentDraftTimer);
  const task = intentDraftQueue
    .catch(() => {})
    .then(async () => {
      const failures = [];
      for (const id of onlyId ? [onlyId] : [...pendingIntentDrafts.keys()]) {
        try {
          while (pendingIntentDrafts.has(id)) {
            const captured = pendingIntentDrafts.get(id);
            const { signature, capturedAt, expectedTarget, ...command } = captured;
            command.expectedRevision = intentDraftVersions.get(id) || 0;
            if (!command.expectedRevision) command.expectedTarget = expectedTarget;
            const next = await mutation(command);
            const saved = next.profiles
              .find((row) => row.id === command.profileId)
              ?.intentDrafts?.find((row) => row.id === id);
            if (!saved) throw Error('安排草稿保存结果缺失，编辑仍保留');
            intentDraftVersions.set(id, saved.revision);
            intentDraftSaved.set(id, signature);
            if (pendingIntentDrafts.get(id) === captured) pendingIntentDrafts.delete(id);
            for (const editor of [activeIntentEditor, ...itineraryIntentEditors.values()])
              if (editor?.id === id) editor.persisted = true;
            render(true);
            if (activeIntentEditor?.id === id) {
              const status = overlay.querySelector('#intent-draft-status');
              if (status && !pendingIntentDrafts.has(id))
                status.textContent = '这些编辑已暂存在本机，关闭或重启后可继续。';
            }
          }
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) throw failures[0];
    });
  intentDraftQueue = task;
  return task;
}
async function commitIntentEditor(editor) {
  if (!editor || editor.profileId !== profile().id) throw Error('请重新打开当前周目的安排');
  captureIntentEditor(editor, true);
  await flushIntentDrafts(editor.id);
  const current = state.profiles
    .find((p) => p.id === editor.profileId)
    ?.intentDrafts?.find((row) => row.id === editor.id);
  if (!current) throw Error('请先找回当前编辑的安排草稿');
  editor.submitting = true;
  try {
    await mutation({
      type: 'intent-draft-commit',
      id: editor.id,
      expectedDraft: structuredClone(current),
      profileId: editor.profileId,
    });
    editor.committed = true;
    pendingIntentDrafts.delete(editor.id);
  } catch (error) {
    editor.submitting = false;
    throw error;
  }
}
let journalDraftQueue = Promise.resolve();
let journalDraftTimer;
const journalDraftVersions = new Map();
const journalDraftSaved = new Map();
function captureJournalDraft(force = false) {
  const form = document.querySelector('#journal-entry-form');
  if (!form || form.dataset.committed === 'true' || form.dataset.submitting === 'true') return;
  const value = eventJournalViews.readDraft(form);
  const signature = JSON.stringify(value);
  if (!force && signature === form.dataset.initial && !form.dataset.draftPersisted) return;
  if (
    signature === journalDraftSaved.get(value.id) ||
    signature === pendingJournalDrafts.get(value.id)?.signature
  )
    return;
  pendingJournalDrafts.set(value.id, { ...value, signature });
  const status = document.querySelector('#journal-draft-status');
  if (status) status.textContent = '正在暂存到本机…';
  clearTimeout(journalDraftTimer);
  journalDraftTimer = setTimeout(
    () => flushJournalDrafts().catch((error) => toast('记录草稿未保存：' + error.message, true)),
    300,
  );
}
function flushJournalDrafts() {
  clearTimeout(journalDraftTimer);
  const task = journalDraftQueue
    .catch(() => {})
    .then(async () => {
      while (pendingJournalDrafts.size) {
        const id = pendingJournalDrafts.keys().next().value;
        const value = pendingJournalDrafts.get(id);
        const { signature, ...intent } = value;
        const revision = journalDraftVersions.get(id) ?? intent.revision;
        const next = await mutation({ ...intent, revision });
        const saved = next.profiles
          .find((p) => p.id === intent.profileId)
          ?.journalDrafts?.find((d) => d.id === id);
        if (!saved) throw Error('草稿保存结果缺失，编辑仍保留');
        journalDraftVersions.set(id, saved.revision);
        const form = document.querySelector('#journal-entry-form');
        if (form?.dataset.draftId === id) {
          form.dataset.draftRevision = saved.revision;
          form.dataset.draftPersisted = 'true';
        }
        // Only acknowledge this exact captured value. Later keystrokes remain queued.
        if (pendingJournalDrafts.get(id) === value) pendingJournalDrafts.delete(id);
        journalDraftSaved.set(id, JSON.stringify({ ...intent, revision: saved.revision }));
        render(true);
        const status = document.querySelector('#journal-draft-status');
        if (form?.dataset.draftId === id && status && !pendingJournalDrafts.has(id))
          status.textContent = '草稿已保存在本机；关闭或查资料后可在江湖记录中继续写。';
      }
    });
  journalDraftQueue = task;
  return task;
}
function availableJournalDrafts(p = profile()) {
  const rows = new Map((p.journalDrafts || []).map((draft) => [draft.id, draft]));
  for (const [id, pending] of pendingJournalDrafts)
    if (pending.profileId === p.id)
      rows.set(id, {
        ...rows.get(id),
        ...pending,
        links: pending.links.map(
          (link) => rows.get(id)?.links?.find((old) => old.type === link.type && old.id === link.id) || link,
        ),
        revision: journalDraftVersions.get(id) ?? pending.revision,
        pending: true,
      });
  return [...rows.values()].sort((a, b) =>
    String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')),
  );
}
function openJournalEditor(entry = null, draft = null) {
  const p = profile();
  showOverlay(
    eventJournalViews.editDialog(p, entry, journalIndex(), {
      draft,
      draftId: draft?.id || crypto.randomUUID(),
    }),
    true,
  );
  const form = document.querySelector('#journal-entry-form');
  if (form) {
    form.dataset.initial = JSON.stringify(eventJournalViews.readDraft(form));
    if (draft && !draft.pending) journalDraftSaved.set(draft.id, form.dataset.initial);
    journalDraftVersions.set(form.dataset.draftId, Number(form.dataset.draftRevision));
  }
}
const submittingNodes = new Set();
let timelineLoadInFlight = false;
function nodeControlsDisabled(id, disabled) {
  if (currentDrawer?.type !== 'timeline' || currentDrawer.data.record.id !== id) return;
  for (const control of overlay.querySelectorAll(
    '#timeline-label,#timeline-note,[data-action="timeline-edit-save"],[data-action="timeline-bookmark"],[data-action="timeline-draft-discard"]',
  ))
    control.disabled = disabled;
}
async function flushNodeDrafts() {
  await nodeDraftQueue.catch(() => {});
  for (const [id, value] of pendingNodeDrafts) {
    environment.activity = await call('nodeDraft', id, value);
    if (pendingNodeDrafts.get(id) === value) pendingNodeDrafts.delete(id);
  }
}
async function prepareQuit() {
  await captureNodeDraft().catch(() => {});
  captureJournalDraft();
  captureIntentDrafts();
  try {
    await flushNodeDrafts();
    await flushJournalDrafts();
    await flushIntentDrafts();
    await Promise.all([...drafts.keys()].map(saveNote));
    return true;
  } catch (error) {
    modal(
      pendingIntentDrafts.size
        ? '仍有个人安排未暂存'
        : pendingJournalDrafts.size
          ? '仍有记录草稿未保存'
          : pendingNodeDrafts.size
            ? '仍有节点草稿未保存'
            : '仍有笔记未保存',
      esc(error.message),
      '<p>请先保留并处理未保存的编辑。已有磁盘草稿会保留；只有明确放弃后才会退出。</p>',
      pendingNodeDrafts.size || pendingJournalDrafts.size || pendingIntentDrafts.size
        ? `${pendingIntentDrafts.size ? act('intent-drafts', '保留并查看安排草稿', 'btn primary') : ''}${pendingJournalDrafts.size ? act('journal-drafts', '保留并查看记录草稿', 'btn primary') : ''}<button class="btn danger" data-action="window-quit-discard"${quitIntent ? ' disabled' : ''}>放弃未保存的编辑并退出</button>`
        : '',
    );
    return false;
  }
}
function captureNodeDraft() {
  if (currentDrawer?.type !== 'timeline') return nodeDraftQueue;
  const label = document.querySelector('#timeline-label'),
    note = document.querySelector('#timeline-note');
  if (!label || !note) return nodeDraftQueue;
  const { record } = currentDrawer.data;
  const value = { label: label.value, note: note.value };
  const existing = pendingNodeDrafts.get(record.id) || environment.activity?.drafts[record.id];
  if (existing?.label === value.label && existing?.note === value.note) return nodeDraftQueue;
  if (value.label === (record.label || '') && value.note === (record.note || '') && !currentDrawer.data.draft)
    return nodeDraftQueue;
  currentDrawer.data.draft = value;
  pendingNodeDrafts.set(record.id, value);
  nodeDraftQueue = nodeDraftQueue
    .catch(() => {})
    .then(() => call('nodeDraft', record.id, value))
    .then((data) => {
      environment.activity = data;
      if (pendingNodeDrafts.get(record.id) === value) pendingNodeDrafts.delete(record.id);
      const status = document.querySelector('#node-draft-status');
      if (currentDrawer?.data?.record?.id === record.id && status)
        status.textContent = '草稿已保存在本机；正式保存后才会更新节点。';
    });
  nodeDraftQueue.catch((e) => toast('节点草稿未保存：' + e.message, true));
  return nodeDraftQueue;
}
const orderedGoals = () =>
  [...profile().goals].sort(
    (a, b) => Number(goalDone(a)) - Number(goalDone(b)) || Number(!!b.pinned) - Number(!!a.pinned),
  );
function goalStatus(g) {
  const completedPlan =
    g.source?.type === 'planner' &&
    profile().craftPlans?.find((plan) => plan.id === g.source.id && plan.done === true);
  if (completedPlan)
    return { tracked: false, done: true, planDone: true, label: '制作计划已完成（个人记录）' };
  const data = compact
    ? companionData?.goalProgress
    : environment?.goalProfileId === profile().id
      ? environment.goalProgress
      : null;
  const tracked = g.source?.type === 'quest' && g.progressMode !== 'manual';
  const progress = data?.[g.id];
  return tracked
    ? {
        ...progress,
        tracked,
        done: g.done || progress?.status === 'complete',
        automaticDone: !g.done && progress?.status === 'complete',
        label: progress?.label || '任务进度待核对',
      }
    : { tracked: false, done: g.done, label: '手动管理' };
}
const goalDone = (g) => goalStatus(g).done;
function planningTotals(ref) {
  if (ref?.planning?.profileId === profile().id) return ref.planning.totals;
  const totals = { ...(profile().reservations || {}) };
  const records = new Map((ref?.metadata?.quests || []).map((q) => [q.id, q]));
  for (const owner of profile().allocations || []) {
    const quest = gameIndex.world.quests.find((q) => q.id === owner.questId);
    if (records.get(quest?.gameId)?.step === 4) continue;
    for (const [id, count] of Object.entries(owner.items)) totals[id] = (totals[id] || 0) + count;
  }
  return totals;
}
const latestReference = () => readableSaves()[0]?.name || '';
const defaultFollow = () => profile().referenceMode !== 'none' && !profile().saveSlot;
let timelineView = { query: '', kind: 'all', page: 0 };
let shortcutDrafts = {};
let noteTimer,
  mutationQueue = Promise.resolve(),
  composing = false;
const drafts = new Map();
const noteVersions = new Map();
const pendingNoteClears = new Map();
const noteSaves = new Map();
let currentDrawer = null;
let comparisonState = null;
let worldView = {
  kind: 'quests',
  query: '',
  status: 'all',
  roots: true,
  page: 0,
  referenceName: undefined,
  reference: null,
};
let materialView = { query: '', referenceName: undefined, result: null, onlyMissing: false };
let craftPlanDraft = null;
let journalView = { query: '', from: '', to: '', kind: '', tag: '', page: 1 };
let journalRemoveDraft = null;
let journalTrashConfirmation = null;
let journalRevisionConfirmation = null;
let noteRestoreConfirmation = null;
let backupRenameDraft = null;
let historyJournalView = { query: '', from: '', to: '', kind: '', tag: '', page: 1 };
function historyJournalProfile() {
  return protectionView.history?.journal.profiles.find((p) => p.id === protectionView.journalProfileId);
}
const backupView = { query: '', kind: 'all', from: '', to: '', page: 0, selected: [] };
const historyBackupView = { query: '', kind: 'all', from: '', to: '', page: 0 };
const protectionView = {
  archives: [],
  retainedUnverifiedArchives: [],
  omittedArchives: [],
  loaded: false,
  history: null,
  archivePage: 0,
  nodePage: 0,
  backupId: '',
  busy: false,
  label: '',
  error: '',
};
let protectionRequest = 0;
let journeyView = { query: '', place: '', completed: false };
let journeyTrashView = { open: false, query: '', page: 1 },
  journeyTrashConfirmation = null;
let itineraryClearConfirmation = null;
const historicalJourneyTrashViews = new Map();
const itineraryFormDrafts = new Map();
function itineraryDraftKey(id) {
  return profile().id + '\u0000' + id;
}
function itineraryDraftValue(id, fallback) {
  const draft = availableIntentDrafts().find((row) => intentFieldId(row) === id);
  return (
    itineraryFormDrafts.get(itineraryDraftKey(id)) ??
    (draft ? (draft.values.name ?? draft.values.placeId) : fallback)
  );
}
function clearItineraryDraft(id) {
  itineraryFormDrafts.delete(itineraryDraftKey(id));
  itineraryIntentEditors.delete(intentEditorKey(id));
}
function intentFieldId(row) {
  if (row.kind === 'itinerary-name') return 'journey-itinerary-name';
  if (row.kind !== 'itinerary-choice') return '';
  const context = row.context;
  return (
    'itinerary-' +
    (context.mode === 'place' ? 'change' : context.mode) +
    '-' +
    (context.mode === 'continue' ? context.ownerId + '-' : '') +
    context.actionId
  );
}
function syncItineraryIntentEditors() {
  for (const field of root.querySelectorAll('[data-itinerary-draft]')) {
    const key = intentEditorKey(field.id),
      old = itineraryIntentEditors.get(key);
    const scope =
      field.id === 'journey-itinerary-name'
        ? field.closest('details')
        : field.closest('[data-itinerary-choice]');
    if (old && !old.committed) {
      const untouched =
        !old.persisted &&
        !old.submitting &&
        !pendingIntentDrafts.has(old.id) &&
        old.scope &&
        JSON.stringify(readIntentValues(old.kind, old.scope)) === old.initial;
      old.scope = scope;
      if (untouched) {
        old.expectedTarget = structuredClone(intentTarget(profile(), old.kind, old.targetId, old.context));
        old.initial = JSON.stringify(readIntentValues(old.kind, scope));
      }
      continue;
    }
    const row = availableIntentDrafts().find((draft) => intentFieldId(draft) === field.id);
    if (row) {
      itineraryIntentEditors.set(key, intentEditor(row.kind, row.targetId, row.context, row, scope));
      continue;
    }
    if (field.id === 'journey-itinerary-name')
      itineraryIntentEditors.set(key, intentEditor('itinerary-name', '', {}, null, scope));
    else {
      const button = scope?.querySelector('[data-action^="journey-itinerary-"]');
      if (!button) continue;
      const mode = button.dataset.action.slice('journey-itinerary-'.length),
        ownerId = button.dataset.id;
      const actionId = mode === 'continue' ? button.dataset.targetId : ownerId;
      const plan = compact ? companionData : environment.journey;
      const label =
        plan?.actions?.find((action) => action.id === actionId)?.title ||
        scope.querySelector('strong')?.textContent ||
        scope.closest('article')?.querySelector('h3,strong')?.textContent ||
        '行程场景选择';
      const context = { mode, actionId, ...(mode !== 'add' ? { ownerId } : {}), label: label.slice(0, 360) };
      itineraryIntentEditors.set(
        key,
        intentEditor('itinerary-choice', mode === 'add' ? actionId : ownerId, context, null, scope),
      );
    }
  }
}
async function openIntentDraft(row) {
  if (row.kind === 'journey-place' && !gameIndex.world.maps.some((place) => place.id === row.targetId)) {
    modal(
      '原地点未在当前资料中收录',
      '完整草稿仍保留，待核对资料后再安排。',
      intentDraftViews.detail(row, gameIndex),
      act('intent-draft-discard', '放弃这份草稿…', 'text-btn', row.id),
    );
    return;
  }
  if (row.kind.startsWith('journey-')) {
    journeyDialog(row.kind.slice(8), row.targetId, row);
    return;
  }
  if (row.kind === 'goal') {
    goalModal(row.targetId, row);
    return;
  }
  if (row.kind === 'craft-plan') {
    craftPlanModal(
      row.targetId,
      row.context.list,
      row.values.addGoal,
      row.values.name,
      row.context.choices,
      row,
    );
    return;
  }
  closeOverlay();
  route = 'journey';
  journeyView = { query: '', place: '', completed: true };
  const fieldId = intentFieldId(row);
  itineraryFormDrafts.set(intentEditorKey(fieldId), row.values.name ?? row.values.placeId);
  itineraryIntentEditors.delete(intentEditorKey(fieldId));
  render();
  const field = document.getElementById(fieldId);
  if (!field) {
    modal(
      '原行动需要重新核对',
      '这份选择仍保留。当前行动清单已变化，请核对来源后再安排。',
      intentDraftViews.detail(row, gameIndex),
      act('intent-draft-discard', '放弃这份草稿…', 'text-btn', row.id),
    );
    return;
  }
  const scope =
    row.kind === 'itinerary-name' ? field.closest('details') : field.closest('[data-itinerary-choice]');
  writeIntentValues(row.kind, row.values, scope);
  itineraryIntentEditors.set(
    intentEditorKey(fieldId),
    intentEditor(row.kind, row.targetId, row.context, row, scope),
  );
  for (const details of root.querySelectorAll('details')) if (details.contains(field)) details.open = true;
  field.scrollIntoView({ block: 'center' });
  field.focus();
}
let journeyDraft = null;
let resourcePriorityDraft = null,
  resourcePriorityRequest = 0;
let craftCompletionDraft = null;
let recipeDiscoveryView = {
  options: {
    query: '',
    craft: '',
    learned: 'learned',
    view: 'supported',
    page: 1,
    pageSize: 8,
    quantities: {},
  },
  result: null,
  busy: false,
  error: '',
  targetPlanId: '',
};
let recipeDiscoveryRequest = 0,
  recipeDiscoveryTimer,
  recipeDiscoveryNeedsRefresh = false;
let worldRequest = 0,
  materialRequest = 0;
const drawerHistory = [];
let lastSearchQuery = '';
function rememberDrawer(view, replace = false) {
  captureNodeDraft();
  if (currentDrawer && !replace) {
    if (currentDrawer.type === 'database') {
      const field = document.querySelector('#recipe-quantity');
      currentDrawer.quantity = field && Number(field.value) > 0 ? Number(field.value) : 1;
      currentDrawer.referenceName = referenceSaveName;
      currentDrawer.follow = referenceFollow;
    }
    if (currentDrawer.type === 'search') {
      currentDrawer.query = document.querySelector('#global-search')?.value || '';
      currentDrawer.scroll = document.querySelector('#global-results')?.scrollTop || 0;
    }
    drawerHistory.push(currentDrawer);
    if (drawerHistory.length > 30) drawerHistory.shift();
  }
  currentDrawer = view;
}
const paths = {
  home: 'M3 10 12 3l9 7M5 9v11h5v-6h4v6h5V9',
  scroll:
    'M7 3h12v15a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-2h12v2a3 3 0 0 0 3 3M7 3a3 3 0 0 0-3 3v3h6V6a3 3 0 0 0-3-3M10 8h5m-5 4h5',
  book: 'M12 5v16M3 4c3-1 6-1 9 1 3-2 6-2 9-1v15c-3-1-6-1-9 1-3-2-6-2-9-1Z',
  bag: 'M7 7h10l3 13H4ZM9 7V5a3 3 0 0 1 6 0v2M9 12h6',
  archive: 'M3 4h18v4H3ZM5 8v12h14V8M10 12h4',
  settings:
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4',
  search: 'm21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  star: 'm12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.3-5.7-3-5.7 3 1.1-6.3-4.6-4.5 6.4-.9Z',
  check: 'm5 12 4 4L19 6',
  plus: 'M12 5v14M5 12h14',
  close: 'm6 6 12 12M6 18 18 6',
  arrow: 'M5 12h14m-5-5 5 5-5 5',
  chevron: 'm9 5 7 7-7 7',
  leaf: 'M20 3C8 2 2 7 5 15c4 8 15 2 15-12ZM4 21 15 10',
  pin: 'm9 3 6 0-1 5 4 4v2h-5v7l-2-2v-5H6v-2l4-4Z',
  external: 'M14 3h7v7m0-7L11 13M10 3H4v17h17v-7',
  folder: 'M3 5h6l2 3h10v12H3Z',
  clock: 'M12 8v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  shield: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6ZM8 12l3 3 5-6',
  info: 'M12 11v6m0-10v.2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  feather: 'm4 20 9-9M5 15C1 4 19 1 21 3c-1 8-8 16-14 14M9 13h6',
  download: 'M12 3v12m-5-5 5 5 5-5M4 15v6h16v-6',
  upload: 'M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6',
  refresh: 'M20 7V3l-3 3A8 8 0 1 0 3 15M20 3v6h-6',
  sword: 'm4 20 3-3m-3-3 6 6M7 14 18 3h3v3L10 17',
  game: 'M7 8h10c3 0 5 9 3 11-1 1-3-2-4-3H8c-1 1-3 4-4 3C2 17 4 8 7 8ZM8 11v5m-2-2h4m5-2h.1m2 2h.1',
  minus: 'M5 12h14',
  maximize: 'M5 5h14v14H5Z',
  edit: 'm4 16 12-12 4 4L8 20H4ZM13 7l4 4',
  trash: 'M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7',
  lock: 'M6 10h12v11H6ZM8 10V6a4 4 0 0 1 8 0v4',
  person: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M4 21v-2a8 8 0 0 1 16 0v2',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
};
const icon = (name) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.book}"/></svg>`;
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const profile = () => state.profiles.find((p) => p.id === state.activeProfileId);
const stage = () => catalog.stages[profile().stage];
const stageTitle = () => (profile().stageConfirmed === false ? '尚未标记主线阶段' : stage().title);
const entry = (id) => catalog.entries.find((e) => e.id === id);
const source = (id) => catalog.sources.find((s) => s.id === id);
const bytes = (n) =>
  n >= 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : n < 1024
      ? `${n} B`
      : `${Math.round(n / 1024)} KB`;
const when = (t) => {
  const d = new Date(t);
  return Number.isNaN(d.getTime())
    ? '时间未知'
    : d.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
};
const hours = (n) => `${Math.floor(n / 3600)} 时 ${Math.floor((n % 3600) / 60)} 分`;
const kindIcon = (k) =>
  ({ 队友: 'person', 支线: 'scroll', 武学: 'sword', 装备: 'bag', 玩法: 'leaf' })[k] || 'book';
const gameImages = createGameImages({ index: () => gameIndex, icon, esc });
const picture = gameImages.picture;
const qualityText = createQualityText({ index: () => gameIndex, esc });
const giftPicker = createGiftPicker({ esc, act: (...args) => act(...args), picture, qualityText });
const placePicker = createPlacePicker({ esc, act: (...args) => act(...args) });
const companionViews = createCompanionViews({
  esc,
  icon,
  act: (...args) => act(...args),
  iconButton: (...args) => iconButton(...args),
  picture,
  qualityText,
});
async function refreshCompanion() {
  if (!compact) return;
  const request = ++companionRequest;
  const data = await call('companionSnapshot');
  if (request !== companionRequest || data.profileId !== profile().id) return;
  const changed = JSON.stringify(companionData) !== JSON.stringify(data);
  companionData = data;
  if (changed) render(true);
}
document.addEventListener(
  'error',
  (event) => {
    if (event.target instanceof HTMLImageElement && event.target.classList.contains('game-image')) {
      event.target.closest('.game-picture')?.classList.add('image-unavailable');
    }
  },
  true,
);
const act = (action, label, cls = 'btn', id = '', glyph = '') =>
  `<button type="button" class="${cls}${action === 'database-detail' && id ? ' pictured-link' : ''}" data-action="${action}"${id ? ` data-id="${esc(id)}"` : ''}>${action === 'database-detail' && id ? picture(id) + '<span>' + qualityText.html(id, label) + '</span>' : (glyph ? icon(glyph) : '') + label}</button>`;
const iconButton = (action, glyph, title, id = '', cls = '') =>
  `<button class="icon-btn ${cls}" data-action="${action}"${id ? ` data-id="${esc(id)}"` : ''} aria-label="${esc(title)}" title="${esc(title)}">${icon(glyph)}</button>`;
const pill = (label, style = '') => `<span class="pill ${style}">${esc(label)}</span>`;
const empty = (title, description, action = '') =>
  `<div class="empty">${icon('leaf')}<h3>${esc(title)}</h3><p>${esc(description)}</p>${action}</div>`;
const notice = (message, info = false) =>
  `<div class="notice ${info ? 'info' : ''}">${icon('info')}<span>${esc(message)}</span></div>`;
const headings = {
  home: '江湖总览',
  checklist: '流程防漏',
  library: '江湖索引',
  database: '百物图鉴',
  world: '任务与地点',
  materials: '备料清单',
  goals: '行囊目标',
  saves: '存档匣',
  settings: '手札设置',
  archives: '离线档案',
  journey: '这一程做什么',
  journal: '江湖记录',
  'recipe-discovery': '用现有材料找配方',
};
const gameViews = createGameViews({
  esc,
  icon,
  act,
  pill,
  empty,
  notice,
  bytes,
  when,
  hours,
  iconButton,
  picture,
  qualityText,
});
const comparisonViews = createComparisonViews({
  esc,
  icon,
  act,
  pill,
  notice,
  when,
  hours,
  iconButton,
  picture,
});
const worldViews = createWorldViews({ esc, act, pill, notice, icon, iconButton, when, empty, picture });
const materialViews = createMaterialViews({ esc, act, pill, notice, icon, iconButton, when, empty });
const searchHelpViews = createSearchHelpViews({ esc, fields: searchFilterFields });
const backupViews = createBackupViews({ esc, act, pill, icon, iconButton, empty, when, bytes });
const protectionViews = createProtectionViews({
  backupViews,
  historyBackupView,
  draftHistory: (p) => intentDraftViews.panel(p.intentDrafts || [], gameIndex, true, p.id),
  journeyTrashHistory: (p) =>
    p.journeyTrash?.length
      ? journeyTrashViews.panel(p, journalIndex(), historicalJourneyTrashViews.get(p.id) || {}, true)
      : '',
  journalPage: (p, v) =>
    historyJournalView.revisions
      ? eventJournalViews.revisions(p, { ...historyJournalView, readOnly: true })
      : historyJournalView.trash
        ? eventJournalViews.trash(p, { ...historyJournalView, readOnly: true }, journalIndex())
        : eventJournalViews.drafts(p.journalDrafts || [], true) +
          eventJournalViews.page(p, { ...historyJournalView, readOnly: true }, journalIndex()),
  esc,
  act,
  pill,
  iconButton,
  notice,
  empty,
  when,
  bytes,
  hours,
  name: (id) => {
    const entry = gameIndex?.entries.find((e) => e.id === id);
    if (entry?.kind === '物品' && entry.quality) return `${entry.name}（${entry.quality}色品质）`;
    return (
      entry?.name ||
      gameIndex?.world.maps.find((p) => p.id === id)?.name ||
      catalog?.entries.find((e) => e.id === id)?.title
    );
  },
});
const journeyViews = createJourneyViews({
  esc,
  act,
  pill,
  icon,
  notice,
  empty,
  when,
  draftValue: itineraryDraftValue,
});
const resourcePriorityViews = createResourcePriorityViews({ esc, act, notice, when });
const recipeDiscoveryViews = createRecipeDiscoveryViews({ esc, act, pill, notice, empty, when });
const eventJournalViews = createEventJournalViews({
  esc,
  act,
  pill,
  icon,
  notice,
  empty,
  when,
  getIndex: () => journalIndex(),
});
const intentDraftViews = createIntentDraftViews({ esc, act, when });
const journeyTrashViews = createJourneyTrashViews({ esc, act, when });
const itemUsageViews = createItemUsageViews({ esc, act, when });
const journalIndex = () => ({ entries: gameIndex.entries, world: gameIndex.world, guides: catalog.entries });
function journalPage() {
  if (journalView.revisions) return eventJournalViews.revisions(profile(), journalView);
  if (journalView.trash) return eventJournalViews.trash(profile(), journalView, journalIndex());
  return (
    eventJournalViews.drafts(availableJournalDrafts()) +
    eventJournalViews.page(profile(), journalView, journalIndex())
  );
}
const timelineViews = createTimelineViews({
  esc,
  icon,
  act,
  pill,
  notice,
  hours,
  bytes,
  iconButton,
  qualityText,
});
function backupStatus() {
  return !state.settings.autoBackup
    ? '未开启'
    : environment.health?.backupStatus === 'paused'
      ? '已暂停 · 时间线正在接管'
      : environment.autoError
        ? '已停止 · 请核对错误'
        : '正在检查变化';
}
function shortcutSettings() {
  const s = environment.shortcuts || {
    values: { save: 'Control+Alt+S', history: 'Control+Alt+H' },
    errors: {},
    active: {},
  };
  return `<section class="card"><h2 class="mb">后台与快捷键</h2><div class="setting-row"><div><h3>关闭窗口后继续自动保存</h3><p>${environment.health?.background ? '关闭主窗口后留在系统托盘。双击托盘图标可打开手札；正常退出会等待正在进行的存读档完成。' : '托盘未启用，关闭主窗口将退出。自动保存需要手札运行。'}</p></div>${act('window-quit', '退出手札', 'btn', '', 'close')}</div><p class="small muted mb">保存快捷键静默保存并收藏当前进度；历史快捷键打开存档匣。读档仍需预览和确认。Ctrl+Alt+J 开关随行小窗。</p><div class="shortcut-fields">${[
    ['save', '保存进度'],
    ['history', '打开历史'],
  ]
    .map(
      ([key, title]) =>
        `<label>${title}<input id="shortcut-${key}" data-persist="true" class="input" maxlength="40" value="${esc(shortcutDrafts[key] ?? s.values[key])}" placeholder="Ctrl+Alt+S"><span class="small muted">${esc(s.errors[key] || (s.active[key] ? '已启用' : s.values[key] ? '未注册' : '已停用'))}</span></label>`,
    )
    .join(
      '',
    )}${act('shortcuts-save', '应用快捷键', 'btn', '', 'check')}</div><div class="setting-row"><div><h3>系统通知反馈</h3><p>手动保存完成或保存故障时给出静音系统通知；自动保存成功始终不提示。默认关闭。</p></div><button class="switch ${state.settings.saveFeedback ? 'on' : ''}" role="switch" aria-label="系统通知反馈" aria-checked="${!!state.settings.saveFeedback}" data-action="save-feedback"></button></div><p class="small muted">桌面「逸剑风云决 · 存档守护」同时打开游戏和手札。托盘角标：绿色表示存档保护就绪，黄色表示等待或暂停，红色表示故障；悬停可查看具体状态。</p><p class="small muted">支持 Ctrl+Alt+字母或 F1–F12，可加 Shift；留空停用。快捷键被占用时保留原设置。</p></section>`;
}
function updateHealth(h) {
  environment.health = h;
  const ready =
    !timelineLoadInFlight &&
    h.timeline?.ready &&
    !h.timeline.busy &&
    !h.timeline.pending &&
    !h.timeline.quiescing;
  for (const el of document.querySelectorAll('[data-save-ready], #timeline-load-button'))
    el.disabled = !ready;
  const loadReason = document.querySelector('#timeline-load-readiness');
  if (loadReason)
    loadReason.textContent = timelineLoadInFlight
      ? '正在确认或执行读档。确认后会等待当前保存结束，再保护进度并读档；关闭预览不会取消已确认的读档。'
      : ready
        ? '游戏当前可保存，可保护进度后读档。'
        : '暂不可读档：' + (h.timeline?.reason || '请等待游戏连接并回到可保存状态');
  const loadButton = document.querySelector('#timeline-load-button');
  if (loadButton)
    loadButton.innerHTML =
      icon('refresh') + (timelineLoadInFlight ? '确认或读档处理中…' : '保护当前进度并读档');
  const dismiss = loadButton && document.querySelector('.drawer-actions [data-action="close-overlay"]');
  if (dismiss) dismiss.textContent = timelineLoadInFlight ? '关闭预览（不取消读档）' : '先不读档';
  if (h.timeline) Object.assign(environment.timeline, h.timeline);
  for (const el of document.querySelectorAll('[data-save-health]')) el.innerHTML = timelineViews.chip(h);
}
const readableSaves = () => environment.saves.files.filter((f) => f.metadata);
const defaultReference = () =>
  profile().referenceMode === 'none' ? '' : profile().saveSlot || latestReference();
function resetPlanningViews() {
  recipeDiscoveryRequest++;
  clearTimeout(recipeDiscoveryTimer);
  recipeDiscoveryNeedsRefresh = true;
  recipeDiscoveryView = {
    options: {
      query: '',
      craft: '',
      learned: 'learned',
      view: 'supported',
      page: 1,
      pageSize: 8,
      quantities: {},
    },
    result: null,
    busy: false,
    error: '',
    targetPlanId: '',
  };
  worldRequest++;
  materialRequest++;
  worldView = {
    kind: 'quests',
    query: '',
    status: 'all',
    roots: true,
    page: 0,
    referenceName: undefined,
    reference: null,
  };
  materialView = { query: '', referenceName: undefined, result: null, onlyMissing: false };
  referenceFollow = undefined;
}
function worldPage() {
  return worldViews.page(gameIndex, worldView, readableSaves());
}
function materialPage() {
  const p = profile(),
    selected = p.craftPlans?.find((x) => x.id === p.activeCraftPlanId);
  const draftReservation = selected?.done
    ? `<p class="save-note">正在查看已完成计划，编辑清单不再预留材料。重新打开该计划后，按原先的预留规则核对。</p>${act('craft-plan-complete', '重新打开这份计划', 'btn soft', selected.id, 'refresh')}`
    : act(
        'craft-draft-reserve',
        p.reserveCraftDraft === false ? '为编辑清单保留材料' : '编辑清单已保留材料 · 点击释放',
        'text-btn',
        '',
        'shield',
      );
  const rows = (p.craftPlans || [])
    .map(
      (plan) =>
        `<div class="backup-row" data-craft-plan-id="${esc(plan.id)}"><div class="spacer"><h3>${esc(plan.name)}</h3><p>${plan.list.length} 种配方 · ${plan.done ? '个人已制作完成 · 用料已释放' : plan.reserved === false ? '尚未预留材料' : '按本周目规则预留'} · ${when(plan.updatedAt)}</p></div>${act('craft-plan-open', '打开', 'btn', plan.id, 'book')}${act('craft-plan-complete', plan.done ? '重新打开计划' : '完成整份计划…', 'btn soft', plan.id, plan.done ? 'refresh' : 'check')}${act('craft-plan-copy', '另存一份', 'text-btn', plan.id, 'plus')}${!plan.done ? act('craft-plan-reserve', plan.reserved === false ? '保留材料' : '释放计划用量', 'text-btn', plan.id, 'shield') : ''}${iconButton('craft-plan-remove', 'trash', '移除制作计划 ' + plan.name, plan.id)}</div>`,
    )
    .join('');
  const plans = `<section class="card mb"><div class="card-header"><h2>我的制作计划</h2>${(p.craftList || []).length ? act('craft-plan-dialog', selected ? '保存为新计划' : '保存当前清单', 'btn soft', '', 'plus') + (selected ? act('craft-plan-dialog', '更新「' + selected.name + '」', 'btn', selected.id, 'edit') : '') : ''}</div><p class="save-note">每份计划独立保存配方和次数；核对库存时使用所选存档。完成整份计划后释放它的用料，可重新打开；不会修改游戏库存或独立勾选的目标。</p>${draftReservation}${rows || '<p class="small muted">先添加配方，再保存第一份计划。</p>'}${p.previousCraftList ? act('craft-draft-restore', '找回上一次编辑清单 · ' + p.previousCraftList.length + ' 种配方', 'text-btn', '', 'refresh') : ''}</section>`;
  return (
    journeyTrashViews.entry(p) +
    recipeDiscoveryViews.entry() +
    materialViews.page(gameIndex, p, materialView, readableSaves(), plans) +
    allocationLedger()
  );
}
function recipeDiscoveryPage() {
  const view = recipeDiscoveryView;
  return recipeDiscoveryViews.page(
    view.result && { ...view.result, filters: view.options },
    view,
    gameIndex,
    profile(),
  );
}
function planningIntentSignature() {
  const p = profile();
  return JSON.stringify([
    p.craftList || [],
    p.reservations || {},
    p.allocations || [],
    p.craftPlans || [],
    p.activeCraftPlanId,
    p.reserveCraftDraft,
    p.craftChoices || {},
    p.journey,
    p.goals,
    p.resourcePriority || [],
  ]);
}
function recipeDiscoverySourceSignature(snapshot) {
  return JSON.stringify([
    snapshot.goalProfileId,
    snapshot.allocations?.referenceIdentity || null,
    snapshot.allocations?.inventoryAvailable,
  ]);
}
function invalidateRecipeDiscovery() {
  ++recipeDiscoveryRequest;
  clearTimeout(recipeDiscoveryTimer);
  recipeDiscoveryNeedsRefresh = true;
  const view = recipeDiscoveryView;
  view.reading = false;
  view.busy = !!view.adding;
  if (view.result) view.result = { ...view.result, scopeToken: null };
  view.error = '来源或计划已变化，正在重新核对；旧结果暂不能加入。';
}
async function refreshRecipeDiscovery(changes = {}) {
  clearTimeout(recipeDiscoveryTimer);
  const view = recipeDiscoveryView,
    profileId = profile().id,
    request = ++recipeDiscoveryRequest;
  view.options = { ...view.options, ...changes };
  recipeDiscoveryNeedsRefresh = false;
  view.reading = true;
  view.busy = true;
  view.error = '';
  if (route === 'recipe-discovery') render(true);
  try {
    const result = await call('recipeDiscovery', view.options);
    if (
      request !== recipeDiscoveryRequest ||
      view !== recipeDiscoveryView ||
      profile().id !== profileId ||
      result.profileId !== profileId
    )
      return;
    view.result = result;
    view.options.page = result.pagination.page;
  } catch (e) {
    if (request === recipeDiscoveryRequest && view === recipeDiscoveryView) view.error = e.message;
  } finally {
    if (request === recipeDiscoveryRequest && view === recipeDiscoveryView) {
      view.reading = false;
      view.busy = !!view.adding;
      if (route === 'recipe-discovery') render(true);
    }
  }
}
function craftPlanModal(
  id = '',
  list = profile().craftList || [],
  addGoal = false,
  name = '',
  choices = profile().craftChoices || {},
  savedDraft = null,
) {
  const plan = profile().craftPlans?.find((x) => x.id === id);
  craftPlanDraft = {
    id,
    profileId: profile().id,
    list: list.map((line) => ({ ...line })),
    choices: { ...choices },
  };
  modal(
    plan ? '更新制作计划' : '保存制作计划',
    '配方和制作次数会独立保存，修改编辑清单不会改变其他计划。',
    `<div class="field"><label for="craft-plan-name">计划名称</label><input id="craft-plan-name" maxlength="80" value="${esc(name || plan?.name || '出发前的制作计划')}" placeholder="例如：武当山出发前的装备"></div><p>${list.length} 种配方</p><label><input id="craft-plan-goal" type="checkbox" ${addGoal ? 'checked' : ''}> 同时加入行囊目标</label><label><input id="craft-plan-reserved" type="checkbox" ${(plan ? plan.reserved !== false : profile().reserveCraftDraft !== false) ? 'checked' : ''}> 为计划保留材料，赠礼时扣除</label>`,
    act('craft-plan-save', '保存计划', 'btn primary', '', 'check'),
  );
  document.querySelector('#craft-plan-name')?.focus();
  if (savedDraft) writeIntentValues('craft-plan', savedDraft.values, overlay);
  activateIntentEditor(
    'craft-plan',
    id,
    { list: craftPlanDraft.list, choices: craftPlanDraft.choices },
    savedDraft,
  );
}
function materialBudgetContext() {
  const view = materialView;
  const referenceName =
    view.referenceName === undefined ? undefined : view.follow ? '@latest' : view.referenceName || '';
  const ready =
    view.result &&
    !view.loading &&
    view.profileId === profile().id &&
    JSON.stringify(view.resultList) === JSON.stringify(profile().craftList || []) &&
    view.resultChoices === JSON.stringify(profile().craftChoices || {}) &&
    view.resultIntent === planningIntentSignature() &&
    (view.result.reference?.name || '') === (view.referenceName || '');
  return {
    summary: ready
      ? view.result.sharedBudget
      : referenceName === undefined && environment.goalProfileId === profile().id
        ? environment.allocations
        : null,
    referenceName,
  };
}
function allocationLedger() {
  const { summary } = materialBudgetContext();
  return `<section class="card mt"><h2>物资用途</h2><p class="save-note">手动保留与各项任务用量分别记录并合计扣除，赠礼和制作使用同一份可用库存。先满足手动留用，再按任务记录顺序展示已分配量。已完成任务的预留仍保留记录，切换到较早存档会重新核对。</p>${
    (profile().allocations || [])
      .map((owner) => {
        const progress = summary?.owners?.find((a) => a.questId === owner.questId);
        const name = gameIndex.world.quests.find((q) => q.id === owner.questId)?.name || owner.questId;
        return `<details class="detail-block"><summary>${esc(name)} · ${esc(progress?.status || '进度待核对 · 继续保留')}</summary>${act('world-quest', '查看任务', 'text-btn', owner.questId, 'book')}${Object.entries(
          owner.items,
        )
          .map(([id, count]) => {
            const assigned = progress?.itemAllocations?.find((a) => a.id === Number(id));
            return `<div class="row wrap"><span class="spacer">${esc(gameViews.byId(gameIndex, 'item-' + id)?.name || id)}</span><span class="small muted">${progress?.complete ? '本参照已完成 · 不占用' : assigned?.allocated === null || !assigned ? '分配量待核对' : '已分配 ' + assigned.allocated + ' · 预留还缺 ' + assigned.missing}</span><label class="quantity-label">保留 <input id="allocation-${owner.questId}-${id}" type="number" min="0" max="999999" step="1" value="${count}" aria-label="${esc(name)}保留数量"></label>${act('allocation-edit', '保存', 'btn', owner.questId + ':' + id, 'check')}</div>`;
          })
          .join(
            '',
          )}${act('allocation-remove', '释放这项任务的预留', 'text-btn', owner.questId, 'trash')}</details>`;
      })
      .join('') || '<p class="small muted">在任务所需物品旁点击预留，即可按任务记录用途。</p>'
  }</section>${resourcePriorityViews.entry(summary)}${craftBudgetLedger(summary)}`;
}
function renderResourcePriorityDialog() {
  const draft = resourcePriorityDraft;
  if (!draft) return;
  modal(
    '先支持哪项打算',
    '',
    resourcePriorityViews.editor(draft, gameIndex),
    draft.loading || !draft.preview
      ? '<button class="btn primary" disabled>确认这份顺序</button>'
      : act('resource-priority-save', '确认这份顺序', 'btn primary', '', 'check'),
  );
  overlay.querySelector('.modal')?.classList.add('resource-priority-modal');
}
async function previewResourcePriority(order, initial = false, context = null) {
  if (initial) {
    closeOverlay();
    resourcePriorityDraft = {
      profileId: profile().id,
      order: [...order],
      referenceName: context?.referenceName,
      labels: Object.fromEntries((context?.summary?.priorityOwners || []).map((row) => [row.id, row.name])),
      preview: null,
      loading: true,
      error: '',
    };
  }
  const draft = resourcePriorityDraft;
  if (!draft) return;
  const token = ++resourcePriorityRequest;
  draft.order = [...order];
  draft.loading = true;
  draft.error = '';
  renderResourcePriorityDialog();
  try {
    const result = await call('resourcePriorityPreview', draft.profileId, order, draft.referenceName);
    if (
      token !== resourcePriorityRequest ||
      resourcePriorityDraft !== draft ||
      profile().id !== draft.profileId
    )
      return;
    draft.order = [...order];
    draft.preview = result;
    draft.labels = {
      ...draft.labels,
      ...Object.fromEntries(result.changes.map((row) => [row.id, row.name])),
    };
  } catch (e) {
    if (token !== resourcePriorityRequest || resourcePriorityDraft !== draft) return;
    draft.preview = null;
    draft.error = e.message;
  } finally {
    if (token === resourcePriorityRequest && resourcePriorityDraft === draft) {
      draft.loading = false;
      renderResourcePriorityDialog();
    }
  }
}
function craftBudgetLedger(summary) {
  if (!summary?.crafts?.length) return '';
  return `<section class="card mt"><h2>制作计划已占用的库存</h2>${craftMoneyNotice(summary, esc)}<p class="save-note">${esc(summary.processingNotice || '制作与赠礼共用有限库存。')}</p><p class="small">全部用途：直接材料还差 ${summary.directMissingTotal ?? '待核对'} 件 · 按加工安排的原料还差 ${summary.baseMaterialMissingTotal ?? '待核对'} 件。两个数量分别表示直接材料与展开原料，不能相加。</p>${summary.crafts
    .map(
      (
        plan,
        i,
      ) => `<details class="detail-block"><summary>${i + 1}. ${esc(plan.name)}</summary>${plan.materials.map((m) => `<div class="world-rule"><span>${esc(m.name)}</span><span>直接需 ${m.count} · ${m.missing === null ? '库存待核对' : '已分配 ' + m.allocation.reduce((sum, a) => sum + a.count, 0) + ' · 还缺 ' + m.missing}</span></div>`).join('')}
    ${plan.processing ? `<h3>加工另占用的真实库存</h3>${plan.processingAllocation.map((a) => `<div class="world-rule"><span>${act('database-detail', esc(gameViews.byId(gameIndex, 'item-' + a.id)?.name || a.id), 'text-btn', 'item-' + a.id)}</span><span>${a.count} 件</span></div>`).join('') || '<p class="small muted">没有另外分配加工原料</p>'}<p class="small">原料端点还缺 ${plan.processing.rawMissingTotal ?? '待核对'} 件 · 先加工 ${plan.processing.workRemaining.processing} 次 · 再制作 ${plan.processing.workRemaining.final} 次</p><p class="save-note">预计产物尚须完成制作，不算当前库存，不会供其他计划或赠礼使用。</p>` : ''}
    ${plan.id === '@draft' ? act('craft-draft-reserve', '释放编辑清单用量', 'text-btn', '', 'shield') : plan.id === '@recipe-goals' ? act('nav', '管理制作目标', 'text-btn', 'goals', 'target') : act('craft-plan-reserve', '释放这份计划用量', 'text-btn', plan.id, 'shield')}</details>`,
    )
    .join('')}</section>`;
}
function invalidateMaterials() {
  materialRequest++;
  materialView.result = null;
  materialView.loading = false;
  materialView.error = '';
}
async function loadWorldReference(name) {
  const view = worldView,
    profileId = profile().id,
    token = ++worldRequest;
  if (name !== undefined) view.follow = name === '@latest';
  view.follow ??= defaultFollow();
  view.referenceName = view.follow
    ? latestReference()
    : name === undefined
      ? (view.referenceName ?? defaultReference())
      : name;
  view.reference = null;
  view.error = '';
  view.loading = !!view.referenceName;
  render(true);
  try {
    const ref = view.referenceName ? await call('saveDetails', view.referenceName) : null;
    if (token !== worldRequest || view !== worldView || profileId !== profile().id) return;
    view.reference = ref;
  } catch (e) {
    if (token === worldRequest && view === worldView) view.error = e.message;
  } finally {
    if (token === worldRequest && view === worldView) {
      view.loading = false;
      render(true);
      if (currentDrawer?.type === 'world-quest' || currentDrawer?.type === 'world-place') {
        currentDrawer.reference = view.reference;
        currentDrawer.referenceName = view.referenceName;
        currentDrawer.follow = view.follow;
        const html =
          currentDrawer.type === 'world-quest'
            ? worldViews.questDetail(
                gameIndex,
                currentDrawer.id,
                view,
                state.settings.spoiler === 'details',
                profile().allocations?.find((a) => a.questId === currentDrawer.id)?.items,
              )
            : worldViews.placeDetail(gameIndex, currentDrawer.id, view);
        if (html) showOverlay(html, true, true);
      }
    }
  }
}
async function showWorldDetail(id, type = 'quest', replace = false) {
  const token = ++detailRequest;
  if (currentDrawer?.type === 'database' && referenceSaveName !== undefined) {
    worldView.referenceName = referenceSaveName;
    worldView.follow = referenceFollow;
    worldView.reference = referenceSave;
    worldView.error = '';
  }
  if (currentDrawer?.type === 'save' && selectedSave) {
    worldView.referenceName = selectedSave.name;
    worldView.follow = false;
    worldView.reference = selectedSave;
  }
  if (worldView.referenceName === undefined || worldView.loading) await loadWorldReference();
  if (token !== detailRequest) return;
  const canonical = type === 'quest' && !String(id).startsWith('quest-') ? `quest-${id}` : id;
  const html =
    type === 'quest'
      ? worldViews.questDetail(
          gameIndex,
          canonical,
          worldView,
          state.settings.spoiler === 'details',
          profile().allocations?.find((a) => a.questId === canonical)?.items,
        )
      : worldViews.placeDetail(gameIndex, canonical, worldView);
  if (!html) throw Error('这条任务或地点资料不可用');
  referenceSaveName = worldView.referenceName;
  referenceFollow = worldView.follow;
  referenceSave = worldView.reference;
  rememberDrawer(
    {
      type: `world-${type}`,
      id: canonical,
      referenceName: worldView.referenceName,
      follow: worldView.follow,
      reference: worldView.reference,
      error: worldView.error,
    },
    replace,
  );
  showOverlay(html, true);
}
async function calculateMaterials() {
  if ([...document.querySelectorAll('.craft-count')].some((n) => !n.checkValidity()))
    throw Error('请先填写 1 至 999 的整数制作次数');
  const view = materialView,
    token = ++materialRequest,
    profileId = profile().id;
  const list = (profile().craftList || []).map((line) => ({ ...line }));
  const choices = JSON.stringify(profile().craftChoices || {});
  const intent = planningIntentSignature();
  view.follow ??= defaultFollow();
  if (view.follow) view.referenceName = latestReference();
  view.referenceName ??= defaultReference();
  const name = view.referenceName;
  const follow = view.follow;
  view.result = null;
  view.error = '';
  view.loading = true;
  render(true);
  try {
    const result = await call('materialPlan', list, name);
    if (
      token !== materialRequest ||
      materialView !== view ||
      profile().id !== profileId ||
      JSON.stringify(list) !== JSON.stringify(profile().craftList || []) ||
      choices !== JSON.stringify(profile().craftChoices || {}) ||
      intent !== planningIntentSignature() ||
      view.referenceName !== name ||
      view.follow !== follow
    )
      return;
    view.result = result;
    view.resultList = list;
    view.resultChoices = choices;
    view.resultIntent = intent;
    view.profileId = profileId;
  } catch (e) {
    if (token === materialRequest && materialView === view) view.error = e.message;
  } finally {
    if (token === materialRequest && materialView === view) {
      view.loading = false;
      render(true);
    }
  }
}
function showComparison(rightName = '', previous = null) {
  const files = environment.saves.files.filter((f) => f.metadata);
  if (!files.length) throw Error('请先连接至少一份可读取的游戏存档');
  comparisonState = previous || {
    left: files.find((f) => f.name !== (rightName || files[0].name))?.name || files[0].name,
    right: rightName || files[0].name,
    result: null,
    query: '',
    questQuery: '',
    filter: 'all',
  };
  if (
    !files.some((f) => f.name === comparisonState.left) ||
    !files.some((f) => f.name === comparisonState.right)
  ) {
    comparisonState = {
      ...comparisonState,
      left: files[1]?.name || files[0].name,
      right: files[0].name,
      result: null,
    };
  }
  rememberDrawer({ type: 'comparison', data: comparisonState }, currentDrawer?.type === 'comparison');
  showOverlay(comparisonViews.shell(files, comparisonState), true);
  if (comparisonState.result) comparisonViews.populate(comparisonState.result, gameIndex, comparisonState);
}
async function readComparison() {
  const view = comparisonState,
    token = ++detailRequest;
  if (!view || !document.querySelector('#compare-left')) return;
  view.left = document.querySelector('#compare-left').value;
  view.right = document.querySelector('#compare-right').value;
  view.result = null;
  const status = document.querySelector('#compare-status'),
    container = document.querySelector('#comparison-result');
  status.textContent = '正在读取两份记录…';
  container.innerHTML = '';
  container.setAttribute('aria-busy', 'true');
  try {
    const result = await call('compareSaves', view.left, view.right);
    if (token !== detailRequest || comparisonState !== view) return;
    view.result = result;
    container.innerHTML = comparisonViews.result(result, view);
    comparisonViews.populate(result, gameIndex, view);
    status.textContent = '已完成只读对比';
  } catch (error) {
    if (token === detailRequest && comparisonState === view) {
      status.textContent = '比较未完成';
      container.innerHTML = notice(error.message);
      throw error;
    }
  } finally {
    container.removeAttribute('aria-busy');
  }
}
function databaseView() {
  return gameViews.page(gameIndex, query, databaseKind, databaseType, databasePage);
}
async function showDatabaseDetail(id, quantity = 1, giftPage) {
  const sameDrawer = currentDrawer?.type === 'database' && currentDrawer.id === id;
  databaseId = id;
  const e = gameViews.byId(gameIndex, id),
    token = ++detailRequest,
    profileId = profile().id,
    planningSignature = planningIntentSignature();
  let referenceError = '';
  if (!e) return;
  if (['配方', '人物', '物品'].includes(e.kind)) {
    referenceFollow ??= defaultFollow();
    if (referenceFollow) referenceSaveName = latestReference();
    if (referenceSaveName === undefined) referenceSaveName = defaultReference();
    referenceSave = null;
    if (referenceSaveName)
      try {
        referenceSave = await call('saveDetails', referenceSaveName, e.kind === '配方' ? id : undefined);
      } catch (error) {
        referenceError = error.message;
        toast(`未能读取对照存档：${error.message}`, true);
      }
  }
  if (token !== detailRequest || profileId !== profile().id) return;
  if (e.kind === '物品' && planningSignature !== planningIntentSignature())
    return showDatabaseDetail(id, quantity, giftPage);
  const quantityField = sameDrawer && e.kind === '配方' ? document.querySelector('#recipe-quantity') : null;
  const rawQuantity = quantityField?.value;
  const validQuantity = quantityField && quantityField.checkValidity() && Number(rawQuantity) >= 1;
  if (validQuantity) quantity = Number(rawQuantity);
  const html = gameViews.detail(
    { ...gameIndex, guideEntries: catalog.entries, renderRequirements: worldViews.requirementRows },
    id,
    quantity,
    reservableReference(referenceSave),
    environment.saves.files.filter((f) => f.metadata),
    referenceSaveName || '',
    referenceFollow,
    profile().reservations || {},
    giftPage ?? (currentDrawer?.id === id ? currentDrawer.giftPage || 0 : 0),
    planningTotals(referenceSave),
    e.kind === '物品'
      ? itemUsageViews.detail(
          projectItemUsage(id, {
            profile: profile(),
            reference: referenceSave,
            gameIndex,
            error: referenceError,
          }),
        )
      : '',
  );
  if (html) {
    rememberDrawer(
      {
        type: 'database',
        id,
        quantity,
        referenceName: referenceSaveName,
        follow: referenceFollow,
        giftPage: giftPage ?? (currentDrawer?.id === id ? currentDrawer.giftPage || 0 : 0),
        planningSignature,
      },
      currentDrawer?.type === 'database' && currentDrawer.id === id,
    );
    showOverlay(html, true, sameDrawer);
    if (quantityField && !validQuantity) {
      document.querySelector('#recipe-quantity').value = rawQuantity || '';
      document.querySelector('#recipe-materials').innerHTML = notice(
        '填写 1 至 999 的整数制作次数后查看材料与预计总产物。',
      );
      document.querySelector('#recipe-quantity').setCustomValidity('制作次数须为 1 至 999');
    }
  }
}
function recipeQuantity() {
  const field = document.querySelector('#recipe-quantity'),
    n = Number(field?.value ?? '1');
  if (field?.validity.badInput || !Number.isSafeInteger(n) || n < 1 || n > 999)
    throw Error('制作次数须为 1 至 999');
  return n;
}
function reservableReference(ref) {
  if (!Array.isArray(ref?.metadata.inventory)) return ref;
  const remaining = planningTotals(ref);
  return {
    ...ref,
    metadata: {
      ...ref.metadata,
      inventory: ref.metadata.inventory.map((i) => {
        const reserved = Math.min(i.count, remaining[i.id] || 0);
        remaining[i.id] = (remaining[i.id] || 0) - reserved;
        return { ...i, count: Math.max(0, i.count - reserved) };
      }),
    },
  };
}
function backupPreviewScope() {
  return JSON.stringify([route, state.activeProfileId, state.settings.savePath]);
}
function backupPreviewCurrent(view, request, owner, scope) {
  return (
    request === backupPreviewRequest &&
    currentDrawer === view &&
    overlay.firstChild === owner &&
    scope === backupPreviewScope()
  );
}
function showBackupPreview(view, replace = false, preserve = false) {
  rememberDrawer(view, replace);
  const b = view.data;
  if (view.status !== 'verified') {
    const busy = view.status === 'checking' || view.status === 'restoring';
    showOverlay(
      `<section class="drawer save-drawer" role="dialog" aria-modal="true" aria-label="备份预览" data-backup-preview-state="${view.status}"><div class="drawer-head"><span class="small muted">存档匣 / 备份预览</span>${iconButton('close-overlay', 'close', '关闭详情')}</div><div class="drawer-body"><h1>${esc(b.label || '完整备份')}</h1>${b.createdAt ? `<p class="small muted">创建于 ${when(b.createdAt)}</p>` : ''}<div role="status">${notice(view.error || (view.status === 'checking' ? '正在重新校验副本并比较当前存档…' : '正在核对恢复请求。旧预览已失效，请等待本次结果。'), busy)}</div><p class="save-note">重新校验与预览成功后，才可再次恢复。</p>${act('backup-folder', '打开这份副本', 'btn', b.id, 'folder')}</div><div class="drawer-actions">${busy ? '' : act('backup-preview', '重新校验并预览', 'btn primary', b.id, 'refresh')}${act('close-overlay', '关闭预览', 'btn')}</div></section>`,
      true,
      preserve,
    );
    return;
  }
  const c = b.comparison,
    status = { unchanged: '一致', changed: '将覆盖', missing: '将补回', unknown: '未对照' };
  showOverlay(
    `<section class="drawer save-drawer" role="dialog" aria-modal="true" aria-label="备份预览" data-backup-preview-state="verified"><div class="drawer-head"><span class="small muted">存档匣 / 备份预览</span>${iconButton('close-overlay', 'close', '关闭详情')}</div><div class="drawer-body"><div class="tag-row">${pill('校验已通过', 'green')}${pill(`${b.files.length} 个文件`)}</div><h1>${esc(b.label)}</h1><p class="small muted">创建于 ${when(b.createdAt)}</p><div class="detail-block"><h3>与当前存档的区别</h3>${c.available ? `<div class="comparison-grid"><div><strong>${c.changed}</strong><span>内容不同</span></div><div><strong>${c.missing}</strong><span>当前缺少</span></div><div><strong>${c.unchanged}</strong><span>完全一致</span></div></div><p class="save-note">恢复会覆盖备份中的同名文件；当前目录中额外的 ${c.extra} 个文件会保留。比较基于打开此预览时的文件内容。</p>` : notice(c.error || '连接对应存档目录后，可以比较文件差异。', true)}</div><div class="detail-block"><h3>这份副本里的存档</h3><div class="backup-file-list">${b.files.map((f) => `<div><span class="spacer"><strong>${esc(f.name)}${f.metadata ? ` · ${esc(f.metadata.mapName)}` : ''}</strong><small>${f.metadata ? hours(f.metadata.playSeconds) + ' · ' : ''}${when(f.modifiedAt)} · ${bytes(f.bytes)}</small></span>${pill(status[f.status], f.status === 'changed' ? 'orange' : f.status === 'unchanged' ? 'green' : '')}</div>`).join('')}</div></div><p class="small muted mono">原目录：${esc(b.source)}</p><div class="row mt">${act('backup-rename', '修改备份名称', 'btn', b.id, 'edit')}${act('backup-folder', '打开这份副本', 'btn', b.id, 'folder')}</div></div><div class="drawer-actions">${c.sameSource && !backupRestorePending ? act('restore', '恢复这份存档', 'btn primary', b.id, 'refresh') : act('close-overlay', '关闭预览', 'btn primary')}${act('close-overlay', '先不恢复', 'btn')}</div></section>`,
    true,
    preserve,
  );
}
function invalidateBackupPreview(message) {
  ++backupPreviewRequest;
  if (currentDrawer?.type !== 'backup') return;
  const view = currentDrawer;
  view.data = { id: view.data.id, label: view.data.label, createdAt: view.data.createdAt };
  view.status = 'invalid';
  view.error = message;
  showBackupPreview(view, true, true);
}
async function inspectBackupPreview(id) {
  const previous = currentDrawer?.type === 'backup' && currentDrawer.data.id === id;
  const b = (previous && currentDrawer.data) || environment.backups.find((b) => b.id === id) || { id };
  const view = {
    type: 'backup',
    data: { id, label: b.label, createdAt: b.createdAt },
    status: 'checking',
  };
  showBackupPreview(view, previous, previous);
  const request = backupPreviewRequest,
    owner = overlay.firstChild,
    scope = backupPreviewScope();
  try {
    const inspected = await call('inspectBackup', id);
    if (!backupPreviewCurrent(view, request, owner, scope)) return;
    if (backupRestorePending) {
      invalidateBackupPreview('恢复请求仍在处理。请等待本次结果后重新校验并预览。');
      return;
    }
    view.data = inspected;
    view.status = 'verified';
    view.scope = scope;
    showBackupPreview(view, true, true);
  } catch (error) {
    if (!backupPreviewCurrent(view, request, owner, scope)) return;
    invalidateBackupPreview('无法校验这份副本：' + error.message);
  }
}
async function restoreBackupPreview(id) {
  const view = currentDrawer;
  if (
    backupRestorePending ||
    view?.type !== 'backup' ||
    view.status !== 'verified' ||
    view.scope !== backupPreviewScope() ||
    view.data.id !== id ||
    !view.data.comparison.sameSource
  )
    return;
  backupRestorePending = true;
  view.data = { id, label: view.data.label, createdAt: view.data.createdAt };
  view.status = 'restoring';
  showBackupPreview(view, true, true);
  const request = backupPreviewRequest,
    owner = overlay.firstChild,
    scope = backupPreviewScope();
  try {
    const result = await call('restore', id);
    if (result.cancelled) {
      if (backupPreviewCurrent(view, request, owner, scope))
        invalidateBackupPreview('已取消恢复，旧预览已失效。请重新校验后再恢复。');
      return;
    }
    if (scope === backupPreviewScope()) environment = result.environment;
    if (backupPreviewCurrent(view, request, owner, scope)) closeOverlay();
    render(true);
    toast(`已恢复 ${result.restored} 个文件，恢复前副本已保留`);
  } catch (error) {
    if (!backupPreviewCurrent(view, request, owner, scope)) return;
    invalidateBackupPreview('恢复未完成，旧预览已失效：' + error.message);
  } finally {
    backupRestorePending = false;
  }
}
async function call(method, ...args) {
  const result = await api[method](...args);
  if (!result.ok) {
    const error = new Error(result.error);
    for (const key of ['code', 'reasonCode', 'backupId', 'directory', 'diagnostic'])
      if (typeof result[key] === 'string') error[key] = result[key];
    if (typeof result.published === 'boolean') error.published = result.published;
    if (method === 'exportProtection' && result.exportResult) error.exportResult = result.exportResult;
    throw error;
  }
  if (method === 'timelineInspect' && pendingNodeDrafts.has(args[0]))
    result.data.draft = pendingNodeDrafts.get(args[0]);
  return result.data;
}
function toast(text, error = false, recoveryAction = '') {
  const div = document.createElement('div');
  div.className = `toast${error ? ' error' : ''}`;
  div.innerHTML = `${icon(error ? 'info' : 'check')}<span>${esc(text)}</span>${recoveryAction}`;
  if (recoveryAction) div.style.pointerEvents = 'auto';
  const container = document.querySelector('#toasts');
  container.append(div);
  while (container.children.length > 2) container.firstElementChild.remove();
  setTimeout(() => div.remove(), error || recoveryAction ? 7000 : 3300);
}
function mutation(command) {
  const profileId = profile().id;
  const task = mutationQueue.then(async () => {
    const previousIntents = planningIntentSignature();
    const previousBasket = JSON.stringify(profile().craftList || []);
    const next = await call('mutate', { ...command, profileId: command.profileId || profileId });
    state = next;
    const intentsChanged = previousIntents !== planningIntentSignature();
    if (intentsChanged) invalidateRecipeDiscovery();
    if (
      intentsChanged ||
      previousBasket !== JSON.stringify(profile().craftList || []) ||
      command.type === 'reserve-set' ||
      command.type.startsWith('task-reserve') ||
      command.type.startsWith('craft-plan-') ||
      (command.type === 'journey-trash-restore' && command.expectedTrash?.kind === 'craft-plan') ||
      command.type === 'resource-priority-set' ||
      command.type === 'craft-draft-reserve'
    )
      invalidateMaterials();
    if (['profile-add', 'profile-switch', 'save-slot'].includes(command.type)) {
      journalView = { query: '', from: '', to: '', kind: '', tag: '', page: 1 };
      resetPlanningViews();
      referenceSaveName = undefined;
      referenceSave = null;
      await refresh();
    } else if (intentsChanged && route === 'recipe-discovery') await refresh();
    render(true);
    return next;
  });
  mutationQueue = task.catch(() => {});
  return task;
}
function saveNote(id = profile().id) {
  clearTimeout(noteTimer);
  if (noteSaves.has(id)) return noteSaves.get(id);
  if (!drafts.has(id)) return Promise.resolve();
  const task = Promise.resolve()
    .then(async () => {
      while (drafts.has(id)) {
        const value = drafts.get(id);
        const version = noteVersions.get(id);
        const cleared = pendingNoteClears.get(id) || [];
        try {
          await mutation({
            type: 'note',
            value,
            clearedValues: cleared.map((row) => row.body),
            profileId: id,
          });
        } catch (e) {
          const el = profile().id === id && document.querySelector('#note-status');
          if (el) el.textContent = '保存失败，内容仍在编辑区；清空前的文字会在重试时保留';
          toast(e.message, true);
          throw e;
        }
        const remaining = (pendingNoteClears.get(id) || []).filter((row) => !cleared.includes(row));
        if (remaining.length) pendingNoteClears.set(id, remaining);
        else pendingNoteClears.delete(id);
        const current = noteVersions.get(id) === version && drafts.get(id) === value;
        if (current) drafts.delete(id);
        const el = profile().id === id && document.querySelector('#note-status');
        if (el && current) el.textContent = '已保存到本机';
      }
    })
    .finally(() => noteSaves.delete(id));
  noteSaves.set(id, task);
  return task;
}
function noteBlock() {
  return `<div class="note-paper"><div class="row between wrap"><h3>江湖随手记</h3>${act('navigate', '逐条记录与回顾', 'text-btn', 'journal', 'feather')}</div><textarea id="note" data-persist="note" data-profile-id="${esc(profile().id)}" maxlength="20000" aria-label="江湖随手记" placeholder="上次停在何处？下次想做什么？\n给未来的自己留句话。">\n${esc(drafts.get(profile().id) ?? profile().notes)}</textarea><div id="note-status" class="note-footer">${drafts.has(profile().id) ? '正在保存…' : '只存在这台电脑 · 自动保存'}</div>${act('note-history', '找回旧内容 · ' + (profile().noteRevisions?.length || 0), 'text-btn', '', 'archive')}<details class="small"><summary>旧内容保留规则</summary><p class="save-note">自动保留最近 20 份非空旧内容；连续编辑每隔 5 分钟留一份，清空或恢复前立即保留。更早的内容可通过导出手札备份另行保存。</p></details></div>`;
}
function showNoteHistory(returnContext = null) {
  const rows = profile().noteRevisions || [];
  modal(
    '随手记旧内容',
    '清空或改写前保留的文字按周目独立保存；最近 20 份可预览并放回随手记。',
    `<section data-note-history>${rows.map((row) => `<details class="detail-block" data-note-revision="${esc(row.id)}"><summary>${when(row.replacedAt)} · ${esc(row.body.slice(0, 80))}</summary><p class="preserve-text">${esc(row.body)}</p>${act('note-restore-preview', '把这份旧内容放回随手记…', 'btn', row.id, 'refresh')}</details>`).join('') || empty('尚无旧内容', '编辑已有随手记或清空时，会自动保留之前的非空文字。')}</section>`,
    '',
  );
  if (returnContext) {
    for (const detail of overlay.querySelectorAll('[data-note-revision]'))
      detail.open = returnContext.opened.includes(detail.dataset.noteRevision);
    overlay
      .querySelector(
        `[data-note-revision="${CSS.escape(returnContext.id)}"] [data-action="note-restore-preview"]`,
      )
      ?.focus({ preventScroll: true });
    overlay.querySelector('.modal').scrollTop = returnContext.scroll;
  }
}
function pending() {
  if (profile().stageConfirmed === false) return [];
  const p = profile();
  return catalog.entries
    .filter((e) => e.checklist && !p.checks[e.id] && e.stage <= p.stage)
    .sort((a, b) => Number(!!b.checkpoint) - Number(!!a.checkpoint) || b.stage - a.stage);
}
function checkRow(e) {
  const done = profile().checks[e.id] === 'done';
  return `<div class="check-row ${done ? 'done' : ''}"><button class="check ${done ? 'checked' : ''}" data-action="check" data-id="${e.id}" aria-label="${done ? '取消完成' : '标记完成'} ${esc(e.title)}">${done ? icon('check') : ''}</button><div class="check-body"><button class="check-title" data-action="detail" data-id="${e.id}">${esc(e.title)}</button><div class="check-description">${esc(e.location)}</div></div>${e.checkpoint ? pill('核对时机', 'orange') : pill(e.kind)}</div>`;
}
function pageHeader(eyebrow, title, sub, buttons = '') {
  return `<div class="page-header"><div><div class="eyebrow">${eyebrow}</div><h1 class="serif">${title}</h1><p>${sub}</p></div><div class="row">${buttons}</div></div>`;
}
function landscape() {
  return `<svg class="landscape" viewBox="0 0 650 250" preserveAspectRatio="xMaxYMax slice" aria-hidden="true"><circle cx="499" cy="77" r="36" fill="#f6f0d6"/><path d="M135 229 239 87 261 108 319 34 368 107 391 77 430 133 482 96 529 157 583 89 650 173V250H100Z" fill="#ccd5bc"/><path d="m225 209 86-132 25 45 15-8 42 55 51-38 38 45 31-17 80 43 47-72 33 40v80H190Z" fill="#b9c8a7"/><path d="M0 243 101 226 173 210 267 191 310 196 378 180 438 206 473 205 522 177 596 172 650 189V250H0Z" fill="#a3b992"/><path d="M277 250c85-57 88-13 149-44 35-18 75 11 111-8 40-22 78-4 113-19v71" fill="#819e75"/><path d="m421 198 29-21 7-38 3 38 21 18-23-8-37 11m17-29 18-16 3-25 3 28 13 11-16-5Z" fill="#64815f"/><path d="M511 236c17-18 29-23 39-24" fill="none" stroke="#c3ccb0" stroke-width="2"/><path d="m250 99 6 3 8-2m-54 28 5 3 8-1m184-91 6 3 7-1" fill="none" stroke="#94a28a" stroke-width="1.5"/><path d="m575 212 11-9h29l12 9-11-3h-29Z" fill="#486b54"/><path d="M589 210h22v14h-22ZM585 225h31" fill="#5e7b60" stroke="#4c6b54" stroke-width="2"/></svg>`;
}
function homeHero() {
  const r = environment.recent;
  return `<section class="hero ${r ? 'has-save' : ''}"><div class="hero-copy"><div class="eyebrow">${r ? (environment.preferredSave ? '这一程的存档 · ' : '最近留下的江湖 · ') + esc(r.name) : '此去江湖 · 心中有数'}</div><h1>${r ? '上次，停在' + esc(r.mapName) + '。' : '走自己的路，<br>不错过在意的人。'}</h1><p>${r ? esc(r.mainQuest || '继续这一程的探索') + '<br>' + when(r.modifiedAt) + ' · ' + hours(r.playSeconds) : '记下此刻的进度，留意沿途的相遇。<br>每一件小事，都可以慢慢完成。'}</p><div class="row">${r ? act('save-detail', '回顾这份存档', 'btn primary', r.name, 'book') : act('navigate', '先查人物与物品', 'btn primary', 'database', 'book')}${act('navigate', '查看流程清单', 'text-btn', 'checklist', 'arrow')}</div></div>${landscape()}${r?.thumbnail ? `<div class="hero-memory"><img src="${r.thumbnail}" alt="最近存档的游戏场景"><span>这一程的片刻</span></div>` : '<div class="hero-seal">一剑一程<br>一页江湖</div>'}</section>`;
}
function startPanel() {
  const connected = !!state.settings.savePath && environment.saves.files.length > 0;
  const readable = environment.saves.files.some((f) => f.metadata);
  const enabled = environment.timeline?.enabled;
  const warning = environment.health?.protection?.warning;
  const sourceUnavailable =
    !!state.settings.savePath &&
    !!environment.saves.error &&
    !enabled &&
    !environment.timeline?.error &&
    !environment.timeline?.pending &&
    !environment.timeline?.busy &&
    !environment.timeline?.quiescing &&
    !environment.recovery &&
    !environment.health?.quitting;
  const detectedSource =
    sourceUnavailable && environment.detected.length === 1 ? environment.detected[0] : '';
  const pathIssue = environment.timeline?.pathIssue || '';
  const preparationFailed = !!assistanceError && !enabled && !warning;
  const supported = environment.game.installed && environment.game.build === gameIndex.build && !pathIssue;
  const offered = state.settings.offerAutoSaveOnStart !== false;
  const action = sourceUnavailable
    ? detectedSource
      ? 'reconnect-detected'
      : 'choose-saves'
    : warning
      ? 'navigate'
      : !pathIssue && (preparationFailed || (connected && supported && !enabled && offered))
        ? 'start-assistance'
        : 'launch';
  const title = sourceUnavailable
    ? '先前的存档目录暂不可用'
    : warning
      ? '有一项存档保护需要核对'
      : preparationFailed
        ? '自动存档暂未准备好'
        : enabled
          ? '自动存档已开启，继续出发吧'
          : connected
            ? environment.recent
              ? '已读到你的进度，可以直接用了'
              : '查询与备份已准备好，可以直接用了'
            : '先逛江湖，手札会帮你留意进度';
  const message = sourceUnavailable
    ? `图鉴、攻略和已有备份仍可使用。${detectedSource ? '已找到本机存档，点击即可重新连接。' : environment.detected.length > 1 ? '检测到了多个账户，可在下面选一次；也可重新选择目录。' : '可以直接重新选择本机存档目录。'}`
    : warning
      ? environment.health.protection.reason
      : preparationFailed
        ? assistanceError + '。查询与已有备份仍然可用。'
        : enabled
          ? '进入游戏存档后自动留住进度；查询、备料和历史都已准备好。'
          : connected
            ? `${readable ? '存档回顾、任务查询和备料现在就能使用。' : '已找到存档文件，但暂时无法读取进度和库存。图鉴、任务资料与完整备份仍可使用；可在游戏里重新保存后刷新，或核对存档目录与游戏版本。'}${state.settings.autoBackup ? '完整备份已自动开启。' : '沿用你之前的备份设置。'}${supported ? (offered ? '点击开始游戏，可一次开启自动存档。' : '开始游戏会直接启动；自动存档可稍后开启。') : ''}`
            : environment.detected.length > 1
              ? '检测到多个账户，登录 Steam 后会自动识别；也可以在这里选一次账户。'
              : environment.journalRecovery?.needsSaveConfirmation
                ? '手札已经恢复，图鉴、记录和规划可直接使用。请先明确选择本机存档目录，再接入已保存进度。'
                : '图鉴和攻略可以直接查。游戏里保存一次后，手札会自动寻找本机存档。';
  return `<section class="card mb start-panel" aria-label="直接开始"><div class="row between wrap"><div class="spacer"><h2>${icon('shield')} ${title}</h2><p class="small muted">${esc(message)}</p></div><button class="btn primary" data-action="${action}" ${sourceUnavailable ? (detectedSource ? `data-id="${esc(detectedSource)}"` : '') : warning ? 'data-id="saves"' : ''} ${startingAssistance ? 'disabled' : ''}>${icon(sourceUnavailable ? 'folder' : warning ? 'shield' : 'game')}${startingAssistance ? '正在准备…' : sourceUnavailable ? (detectedSource ? '重新连接存档' : '重新选择存档目录') : warning ? '查看存档匣' : preparationFailed && !pathIssue ? '重新准备' : '开始游戏'}</button>${sourceUnavailable || warning || (preparationFailed && !pathIssue) ? act('launch', '开始游戏', 'btn', '', 'game') : ''}${act('navigate', '查询图鉴', 'btn', 'database', 'book')}</div>${!connected && environment.detected.length > 1 ? `<label class="small">这次使用的账户 <select id="detected-save" class="input" aria-label="选择游戏账户"><option value="">自动识别 Steam 账户</option>${environment.detected.map((p) => `<option value="${esc(p)}">账户 ${esc(p.split(/[\\/]/).at(-2))}</option>`).join('')}</select></label>` : ''}<details data-persist-detail="home-start"><summary>想慢慢探索时，再看看这些</summary><p class="small muted">默认跟随最近保存的进度，开启游戏内轻提示并保持静音。备料、收藏、笔记和显示位置都可以以后再调整。${pathIssue ? esc(pathIssue) : connected && !supported ? '当前游戏的自动存档尚未适配，存档回顾和完整备份仍可使用。' : '自动存档首次开启只需确认一次，之后沿用；更换账户或游戏版本时会重新核对。'}</p><div class="row wrap">${connected && supported && !enabled ? act('start-assistance', '开启自动存档', 'text-btn', '', 'shield') : ''}${act('navigate', '查看存档与历史', 'text-btn', 'saves', 'clock')}${act('navigate', '调整偏好', 'text-btn', 'settings', 'settings')}${!connected ? act('choose-saves', '手动找存档', 'text-btn', '', 'folder') : ''}</div></details></section>`;
}
function recoveryConnectionNotice() {
  if (!environment.journalRecovery?.needsSaveConfirmation) return '';
  return `<section class="card mb" aria-label="恢复后的本机连接"><h2>手札已恢复，请重新确认本机连接</h2><p>原来的资料和连接记录已保留。旧机器的存档目录与自动存读档授权没有沿用；离线查询、记录和规划现在就能用。</p><div class="row wrap">${act('choose-saves', '选择本机存档目录', 'btn primary', '', 'folder')}${act('folder', '查看保留的原始资料', 'btn', 'data', 'folder')}</div><p class="save-note">选择目录后可核对本机已保存进度。原生自动存读档仍需要你另行启用与确认。</p></section>`;
}
function homePage() {
  const p = profile(),
    done = Object.values(p.checks).filter((v) => v === 'done').length,
    list = pending().slice(0, 4),
    recent = environment.saves.files.find((f) => f.metadata),
    chosenItinerary = environment.journey?.profileId === p.id && environment.journey.itinerary?.steps.length;
  return `${recoveryConnectionNotice()}${pageHeader('A PERSONAL JIANGHU JOURNAL', '少侠，别来无恙。', '把琐事交给手札，把心思留给江湖。')}
    ${chosenItinerary ? homeJourney() + startPanel() : startPanel() + homeJourney()}${recipeDiscoveryViews.entry()}${intentDraftViews.panel(availableIntentDrafts(), gameIndex)}
    ${environment.preferredSaveMissing ? notice(`当前周目指定的 ${environment.preferredSave} 暂时不可读。请重新选择默认回顾存档；不会自动改用其他槽位。`, true) : ''}
    ${homeHero()}
    <div class="home-save-choice"><span class="small muted">${profile().referenceMode === 'none' ? '本周目仅查资料，尚未绑定游戏存档' : profile().saveSlot ? '本周目默认回顾：' + esc(profile().saveSlot) : '默认回顾：最近修改的可读存档'}</span><div class="row">${act('save-slot', '选择回顾存档', 'text-btn', '', 'edit')}${act('refresh', '刷新存档', 'text-btn', '', 'refresh')}</div></div>
    <div class="stat-grid"><div class="stat"><div><div class="stat-label">已完成的精选清单</div><div class="stat-value">${done}<span>/ ${catalog.entries.filter((e) => e.checklist).length} 项</span></div></div><div class="stat-icon">${icon('scroll')}</div></div><div class="stat"><div><div class="stat-label">行囊里的收藏</div><div class="stat-value">${p.favorites.length}<span>条线索</span></div></div><div class="stat-icon">${icon('star')}</div></div><div class="stat"><div><div class="stat-label">已留存的存档副本</div><div class="stat-value">${environment.timeline?.indexError ? '—' : environment.timeline?.count || 0}<span>${environment.timeline?.indexError ? '时间线历史数量待核对' : '个时间线节点'} · ${environment.backups.length} 份完整备份</span></div></div><div class="stat-icon">${icon('archive')}</div></div></div>
    <div class="dashboard-grid"><div class="stack">${environment.recent?.activeQuests?.length ? `<section class="card"><div class="card-header"><h2>存档里的进行中任务</h2>${pill(environment.recent.pendingTasks + ' 项', 'green')}</div>${environment.recent.activeQuests.map((q) => `<div class="check-row"><div class="check-body"><button class="check-title" data-action="save-quest-jump" data-id="${q.id}">${esc(q.name)}</button><p class="check-description">${q.activeSteps?.length ? '当前步骤：' + q.activeSteps.map((s) => esc(s.name)).join('、') + '<br>主任务记录：' + esc(q.status) + ' · ' : ''}来自 ${esc(environment.recent.name)} · 点开查看记录</p></div>${iconButton('save-quest-jump', 'chevron', '查看这项任务的存档记录', String(q.id))}</div>`).join('')}<p class="save-note">只反映已经保存的任务状态；游戏内的新变化请先保存后刷新。</p></section>` : ''}${profile().stageConfirmed === false ? `<details class="home-optional" data-persist-detail="home-stage"><summary>以后再整理精选提醒</summary><p class="small muted">想查看按阶段整理的精选清单时，可以标记主线阶段。图鉴、任务资料现在就能查询，完整备份可在存档匣管理。</p><div class="row">${act('stage', '标记主线阶段', 'btn soft', '', 'edit')}${act('navigate', '先看全部清单', 'text-btn', 'checklist', 'arrow')}</div></details>` : `<section class="card"><div class="card-header"><h2>继续前，留意这些</h2><span class="small muted">按手动阶段整理</span></div>${list.length ? list.map(checkRow).join('') : empty('这一阶段的精选条目已处理', '可切换阶段，或添加你自己的目标。')}${act('navigate', '查看全部清单', 'text-btn', 'checklist', 'arrow')}</section>`}<section class="card"><div class="card-header"><h2>下一步想做</h2>${act('goal-add', '记一件事', 'text-btn', '', 'plus')}</div>${
      orderedGoals()
        .filter((g) => !goalDone(g))
        .slice(0, 2)
        .map(goalRow)
        .join('') ||
      empty(
        '给下一次出发留个目标',
        '找一本武学、见一位故人，或只是去一个没去过的地方。',
        act('goal-add', '添加我的第一个目标', 'btn soft', '', 'plus'),
      )
    }</section></div><div class="stack">${noteBlock()}<section class="card"><div class="card-header"><h2>存档守护</h2>${icon('shield')}</div><div class="home-protection"><span data-save-health>${timelineViews.chip(environment.health)}</span><p class="small muted">${environment.timeline?.indexError ? '时间线历史数量待核对' : `${environment.timeline?.count || 0} 个时间线节点 · ${bytes(environment.timeline?.bytes || 0)}`}<br>${environment.backups.length} 份完整保护副本 · ${bytes(environment.backups.reduce((sum, b) => sum + b.bytes, 0))}</p><div class="row wrap">${environment.timeline?.latest ? act('timeline-preview', '查看最近可靠记录', 'btn soft', environment.timeline.latest.id, 'eye') : ''}${act('navigate', '管理自动存读档', 'text-btn', 'saves', 'arrow')}</div></div><div class="save-summary"><div class="save-icon">${icon('archive')}</div><div><h3>${environment.saves.files.length ? `找到 ${environment.saves.files.filter((f) => f.name.endsWith('.sav')).length} 个存档文件` : '等待连接本机存档'}</h3><p>${recent ? `最近存档 · ${when(recent.modifiedAt)}` : environment.saves.files.some((f) => f.metadata) ? '尚未选用可读进度，可在存档回顾中选择参照' : environment.saves.files.length ? '已找到文件，进度暂时无法读取；原文件仍可备份' : '在设置中选择 SaveGames 文件夹'}</p></div></div>${act(environment.saves.files.length ? 'backup' : 'choose-saves', environment.saves.files.length ? '备份当前存档' : '连接存档目录', 'btn wide', '', 'download')}<div class="backup-auto-status"><div class="row">${icon('shield')}<strong>完整自动备份${backupStatus()}</strong>${act('navigate', '管理', 'text-btn', 'saves', 'arrow')}</div><p>这里管理已保存文件的完整备份。游戏内自动保存，请到存档匣的时间线中管理。</p></div><p class="save-note">重要选择前，可以在时间线中点击「立即保存」。</p></section></div></div>
    <div class="status-line"><span class="dot"></span>本地保存 · 无需登录 · ${esc(profile().name)}</div>`;
}
function stageStrip() {
  return `<div class="stage-strip">${catalog.stages.map((s) => `<button class="stage-step ${s.id === profile().stage && profile().stageConfirmed !== false ? 'active' : s.id < profile().stage ? 'past' : ''}" data-action="stage-change" data-id="${s.id}" title="${esc(s.sub)}"><span class="stage-dot">${s.id + 1}</span><span>${s.short}</span></button>`).join('')}</div>`;
}
function checklistPage() {
  const selectedFilter = filter === 'current' && profile().stageConfirmed === false ? 'all' : filter;
  let list = catalog.entries.filter((e) => e.checklist);
  if (selectedFilter === 'current')
    list = list.filter(
      (e) =>
        e.stage === profile().stage || (e.stage < profile().stage && e.checkpoint && !profile().checks[e.id]),
    );
  if (selectedFilter === 'pending') list = list.filter((e) => !profile().checks[e.id]);
  if (selectedFilter === 'done') list = list.filter((e) => profile().checks[e.id] === 'done');
  if (selectedFilter === 'skip') list = list.filter((e) => profile().checks[e.id] === 'skip');
  if (query) list = list.filter(matchesQuery);
  return `${pageHeader('THE JOURNEY', '流程防漏', '在主线向前之前，回头看看值得记住的小事。', act('stage', '调整当前进度', 'btn', '', 'edit'))}${stageStrip()}${notice(profile().stageConfirmed === false ? '尚未标记主线阶段；可先浏览精选提醒并勾选。需要按阶段筛选时，再点「调整当前进度」。' : '阶段由你手动选择。这里只列精选提醒；较早阶段的未处理条目会保留供核对，不代表已经错过。', true)}<div class="toolbar">${[
    ['current', '当前阶段'],
    ['pending', '全部待办'],
    ['done', '已完成'],
    ['skip', '暂不做'],
    ['all', '全部'],
  ]
    .map(
      ([id, label]) =>
        `<button class="chip ${selectedFilter === id ? 'active' : ''}" data-action="filter" data-id="${id}">${label}</button>`,
    )
    .join(
      '',
    )}<span class="spacer"></span>${searchInput('搜索人物、任务或地点')}${pill(`${list.length} 项`)}</div><div class="entry-list">${list.length ? list.map(entryRow).join('') : empty('这里暂时没有条目', '可以切换筛选、清空搜索，或在行囊目标里补充自己的计划。')}</div><p class="scroll-hint">勾选只更新手札记录，不会改变游戏里的任务状态。</p>`;
}
function entryRow(e) {
  const status = profile().checks[e.id];
  return `<article class="entry-row ${status === 'done' ? 'done' : ''}"><button class="check ${status === 'done' ? 'checked' : ''}" data-action="check" data-id="${e.id}" aria-label="${status === 'done' ? '取消完成' : '标记完成'} ${esc(e.title)}">${status === 'done' ? icon('check') : ''}</button><div class="entry-main"><div class="row"><button class="check-title" data-action="detail" data-id="${e.id}"><h3>${esc(e.title)}</h3></button>${e.checkpoint ? pill('时机提醒', 'orange') : ''}${status === 'skip' ? pill('暂不做') : ''}</div><div class="entry-meta"><span>${esc(e.location)}</span><span>·</span><span>${catalog.stages[e.stage].title}</span></div><p class="entry-hint">${esc(e.hint)}</p></div><div class="entry-actions">${iconButton('favorite', 'star', profile().favorites.includes(e.id) ? '取消收藏' : '收藏线索', e.id, `favorite ${profile().favorites.includes(e.id) ? 'on' : ''}`)}${iconButton('detail', 'chevron', '查看线索', e.id)}</div></article>`;
}
function matchesQuery(e) {
  try {
    return compileSearch(query)(e);
  } catch {
    return false;
  }
}
function searchInput(placeholder) {
  return `<label class="search-input">${icon('search')}<input id="list-search" data-persist="list-search" placeholder="${placeholder}" value="${esc(query)}" aria-label="${placeholder}" maxlength="100"></label>`;
}
function libraryPage() {
  const list = catalog.entries.filter(
    (e) => (kind === '全部' || e.kind === kind) && (!query || matchesQuery(e)),
  );
  return `${pageHeader('PEOPLE, PLACES & POSSIBILITIES', '江湖索引', '收藏你在意的线索，等走到那里时再翻开。', pill(`${catalog.entries.length} 条精选线索`))}<div class="toolbar">${['全部', '队友', '支线', '武学', '装备', '玩法'].map((k) => `<button class="chip ${kind === k ? 'active' : ''}" data-action="kind" data-id="${k}">${k}</button>`).join('')}<span class="spacer"></span>${searchInput('搜索姓名、物品、地点')}</div>${list.length ? `<div class="card-grid">${list.map(entryCard).join('')}</div>` : empty('没有找到这条线索', '内置资料是精选集。你可以换个关键词，或添加一个自定义目标。', act('library-search-all', '查全部图鉴与任务', 'btn soft', '', 'search') + act('goal-add', '记为我的目标', 'text-btn', '', 'plus'))}<p class="scroll-hint">资料版本与原文链接可在详情中查看 · 本地卡片可离线浏览</p>`;
}
function entryCard(e) {
  return `<article class="entry-card" tabindex="0" role="button" aria-label="查看 ${esc(e.title)}" data-action="detail" data-id="${e.id}"><div class="entry-card-top"><div class="entry-avatar ${e.kind === '装备' || e.kind === '武学' ? 'equipment' : ''}">${e.kind === '队友' ? gameImages.person(e.title.split(' · ')[0]) || icon('person') : icon(kindIcon(e.kind))}</div>${iconButton('favorite', 'star', profile().favorites.includes(e.id) ? '取消收藏' : '收藏线索', e.id, `favorite ${profile().favorites.includes(e.id) ? 'on' : ''}`)}</div><h3>${esc(e.title)}</h3><p>${esc(e.hint)}</p><div class="entry-card-bottom"><span>${esc(e.location)}</span>${pill(e.kind)}</div></article>`;
}
function itemGoal(g) {
  return g?.source?.type === 'database' && gameViews.byId(gameIndex, g.source.id)?.kind === '物品';
}
function personalGoal(g) {
  return (
    !g?.source ||
    !['quest', 'planner', 'database'].includes(g.source.type) ||
    (g.source.type === 'database' && !['物品', '配方'].includes(gameViews.byId(gameIndex, g.source.id)?.kind))
  );
}
function goalRow(g) {
  const progress = goalStatus(g),
    done = progress.done;
  const tracking =
    g.source?.type === 'quest'
      ? `<p class="small muted">${esc(progress.label)}${progress.source ? ' · ' + esc(progress.source.name) + ' · ' + when(progress.source.modifiedAt) : ''}${progress.reason ? ' · ' + esc(progress.reason) : ''}</p>${act('goal-tracking', progress.tracked ? '改为手动管理' : '按存档自动跟踪', 'text-btn', g.id, 'refresh')}`
      : progress.planDone
        ? `<p class="small muted">${esc(progress.label)} · 用料已释放；你独立勾选的目标状态仍保留。</p>${act('craft-plan-complete', '重新打开制作计划', 'text-btn', g.source.id, 'refresh')}`
        : '';
  const detail = !g.detail
    ? ''
    : g.source?.type === 'quest' && state.settings.spoiler === 'hints'
      ? `<details data-persist-detail="goal-note-${esc(profile().id)}-${esc(g.id)}"><summary>任务备忘 · 可能涉及剧情</summary><p>${esc(g.detail)}</p></details>`
      : `<p>${esc(g.detail)}</p>`;
  const place = gameIndex.world.maps.find((p) => p.id === g.placeId);
  const location = personalGoal(g)
    ? `<p class="small muted">${place ? '地点：' + esc(place.name) + ' · 场景 #' + place.gameId : '地点未定'}</p>${act('goal-place-edit', place ? '修改或移除地点' : '补充地点', 'text-btn', g.id, 'map')}`
    : '';
  return `<div id="goal-${esc(g.id)}" class="goal-row ${done ? 'done' : ''}" tabindex="-1"><button id="goal-toggle-${esc(g.id)}" class="check ${done ? 'checked' : ''}" data-action="goal-toggle" data-id="${g.id}" ${progress.planDone ? 'disabled' : ''} aria-label="${progress.planDone ? '关联制作计划已完成，请先重新打开计划' : progress.automaticDone ? '保留为手动待办' : done ? '取消完成' : '完成目标'} ${esc(g.title)}">${done ? icon('check') : ''}</button><div class="spacer"><h3>${g.pinned ? '<span class="small muted">置顶 · </span>' : ''}${esc(g.title)}</h3>${itemGoal(g) ? `<p class="small muted">收集数量：${g.source.quantity || 1} 件</p>` : ''}${tracking}${detail}${location}${g.source ? act('goal-source', g.source.type === 'planner' ? '重新核对备料清单' : g.source.type === 'quest' ? '查看任务资料与记录' : itemGoal(g) ? '查看物品原资料' : g.source.quantity ? '打开配方，重新核对材料' : '查看原资料', 'text-btn', g.id, 'arrow') : ''}</div>${iconButton('goal-pin', 'pin', (g.pinned ? '取消置顶目标 ' : '置顶目标 ') + g.title, g.id, g.pinned ? 'on' : '')}${iconButton('goal-edit', 'edit', '编辑目标 ' + g.title, g.id)}${iconButton('goal-remove', 'trash', '删除目标 ' + g.title, g.id)}</div>`;
}
function goalsPage() {
  const p = profile();
  return `${pageHeader('PACK LIGHT, GO FAR', '行囊目标', '想学的武功、想见的人，还有下一次出发的理由。', act('goal-add', '添加目标', 'btn primary', '', 'plus'))}${journeyTrashViews.entry(p)}<div class="saved-goals"><div class="stack"><section class="card"><div class="card-header"><h2>我的待办</h2>${pill(`${p.goals.filter((g) => !goalDone(g)).length} 件未完成`)}</div>${
    p.goals.length
      ? orderedGoals().map(goalRow).join('')
      : empty(
          '行囊还很轻',
          '把一个大目标拆成几件小事，走起路来就有了方向。',
          act('goal-add', '写下第一件事', 'btn soft', '', 'plus'),
        )
  }</section><section class="card"><div class="card-header"><h2>收藏的线索</h2>${act('navigate', '去索引看看', 'text-btn', 'library', 'arrow')}</div>${
    p.favorites.length
      ? p.favorites
          .map((id) => entry(id))
          .filter(Boolean)
          .map(
            (e) =>
              `<div class="check-row"><div class="check-body"><button class="check-title" data-action="detail" data-id="${e.id}">${esc(e.title)}</button><p class="check-description">${esc(e.location)} · ${e.kind}</p></div>${iconButton('entry-goal', 'plus', '加入待办', e.id)}${iconButton('favorite', 'star', '取消收藏', e.id, 'favorite on')}</div>`,
          )
          .join('')
      : empty('把线索装进行囊', '在江湖索引中点击星标，就能在这里找到它。')
  }</section></div><div class="stack">${noteBlock()}<div class="notice info">${icon('leaf')}<span>每个周目的清单、收藏和随手记彼此独立。${compact ? '打开完整手札后，可以在左下角切换或新建周目。' + act('main', '打开完整手札', 'text-btn', '', 'external') : '你可以在左下角切换或新建周目。'}</span></div></div></div>`;
}
function nodeDraftPanel() {
  const entries = Object.entries(environment.activity?.drafts || {});
  return entries.length
    ? `<section class="card mb"><details><summary>尚未正式保存的节点草稿 · ${entries.length} 份</summary><p class="save-note">草稿文字保存在本机。节点若已轮换，可把文字转存到当前周目的随手记；草稿不会自动留住游戏存档。</p>${entries.map(([id, v]) => `<div class="backup-row"><div class="spacer"><h3>${esc(v.label || '未命名草稿')}</h3><p>${esc(v.note).slice(0, 160)}</p></div>${act('node-draft-review', '继续或找回草稿', 'btn', id, 'edit')}${iconButton('node-draft-remove', 'trash', '放弃这份草稿', id)}</div>`).join('')}</details></section>`
    : '';
}
function activityPanel() {
  const log = environment.activity;
  return (
    nodeDraftPanel() +
    (log?.warning ? notice(log.warning) : '') +
    (log?.events.length
      ? '<section class="card mb operation-history"><div class="card-header"><h2>' +
        icon('shield') +
        ' 最近操作结果</h2><span class="small muted">保留最近 30 条 · 重启后仍可查看</span></div>' +
        log.events
          .slice(0, 3)
          .map(
            (e) =>
              '<div class="operation-row ' +
              e.level +
              '"><span>' +
              icon(e.level === 'error' ? 'info' : e.level === 'success' ? 'check' : 'clock') +
              '</span><div><strong>' +
              esc(e.message) +
              '</strong><small>' +
              when(e.at) +
              '</small></div></div>',
          )
          .join('') +
        (log.events.length > 3
          ? '<details><summary>其余 ' +
            (log.events.length - 3) +
            ' 条</summary>' +
            log.events
              .slice(3)
              .map((e) => '<p class="small">' + when(e.at) + ' · ' + esc(e.message) + '</p>')
              .join('') +
            '</details>'
          : '') +
        '</section>'
      : '')
  );
}
function timelinePanel() {
  const t = environment.timeline;
  const passive =
    !t.enabled &&
    !t.count &&
    !t.busy &&
    !t.pending &&
    !t.quiescing &&
    !t.error &&
    !environment.health?.timeline?.error;
  const content = timelineViews.page(t, { ...timelineView, recoveryBlocked: !!environment.recovery });
  return passive
    ? `<details class="mb" data-persist-detail="unused-timeline"><summary>游戏内自动存档 · 尚未开启，展开了解</summary><div class="mt">${content}</div></details>`
    : content;
}
function restoreRecoveryBanner() {
  const recovery = environment.recovery;
  if (!recovery) return '';
  const guidance = recovery.error
    ? `<p class="save-note">请先退出游戏，保留当前存档和全部保护副本。手札无法确认上次覆盖到了哪一步，因此会阻止继续恢复或更换存档目录；资料查询和查看副本仍可使用。</p><p class="save-note">需要核对时，请保留备份目录中的恢复记录及副本，并提供下方诊断文字；无需发送存档文件。不要删除恢复记录来绕过核对。</p><details><summary>查看恢复诊断</summary><p class="small mono preserve-text">${esc(recovery.recordPath || '备份目录中的恢复记录')}${recovery.diagnostic ? '\n' + esc(recovery.diagnostic) : ''}</p></details>`
    : '';
  return `<section class="recovery-banner mb" aria-label="存档恢复待核对">${notice(recovery.error || '发现上次未完成的存档恢复。请先退出游戏，再核对并回退到恢复前的安全副本。')}${guidance}<div class="row mt">${recovery.error ? '' : act('recover-restore', '核对并处理恢复中断', 'btn danger', '', 'shield')}${act('folder', '打开备份目录', 'btn', 'backups', 'folder')}${state.settings.savePath ? act('folder', '查看当前存档目录', 'btn', 'saves', 'folder') : ''}</div></section>`;
}
function backupCareBanner() {
  return (environment.backupCare || [])
    .map(
      (pending) =>
        `<section class="recovery-banner mb" aria-label="副本清理待处理">${notice(pending.error || (pending.blocking === false ? '上次清理计划尚未提交，原副本仍保留。' : '上次副本清理尚未完成，导出留底仍可用于恢复。'), pending.blocking !== false)}<p class="save-note">${pending.blocking === false ? '临时记录保留在管理目录，无需执行恢复。可以重新选择副本、导出留底并确认清理。' : pending.canRollback ? '尚未开始删除，可以将全部暂存副本放回列表。' : pending.error ? '管理记录无法核对，请保留全部残留内容。' : '已经开始删除，剩余副本暂存保留；选择原保护包重新校验后才能继续。'}</p><details><summary>查看这批副本 · ${pending.ids?.length || 0} 份</summary>${(pending.backups || []).map((b) => '<p>' + esc(b.label) + ' · ' + when(b.createdAt) + '</p>').join('')}</details><div class="row wrap mt">${pending.canRollback ? act('backup-cleanup-rollback', '放回全部暂存副本', 'btn', pending.id, 'refresh') : ''}${!pending.error && pending.blocking !== false && pending.canFinish !== false ? act('backup-cleanup-finish', '选择原保护包并继续…', 'btn danger', pending.id, 'archive') : ''}${act('folder', '查看管理目录', 'text-btn', 'backups', 'folder')}</div></section>`,
    )
    .join('');
}
function savesPage() {
  const save = environment.saves,
    files = save.files,
    backups = environment.backups;
  return `${pageHeader('A PLACE TO RETURN TO', '存档匣', '重要选择之前，为这一程留一份退路。', `${act('refresh', '刷新', 'btn', '', 'refresh')}${act('backup', '备份当前存档', 'btn primary', '', 'download')}`)}${restoreRecoveryBanner()}${backupCareBanner()}${timelinePanel()}${protectionViews.exportResult(protectionView.exportResultOverride || environment.protectionExportResult)}${protectionViews.controls(protectionView)}${activityPanel()}${environment.game.build && environment.game.build !== gameIndex.build ? notice(`游戏已更新到 Build ${environment.game.build}，手札图鉴资料为 Build ${gameIndex.build}；名称与配方请以游戏内为准。`, true) : ''}${save.error ? notice(save.error) : ''}${files.some((f) => /^\d+\.sav$/i.test(f.name) && !f.metadata) ? notice('部分存档暂时无法读取进度，仍可完整备份原文件。请在游戏里重新保存后刷新，或核对存档目录与游戏版本；没有可读进度时，库存与任务状态不会自动填入。', true) : ''}${environment.autoError ? notice(environment.autoError) : ''}<div class="card mb"><div class="row between"><div class="row"><div class="save-icon">${icon('folder')}</div><div><h3>${files.length ? '已连接本机存档' : '尚未连接存档'}</h3><p class="small muted">${files.length ? '文件会被只读扫描，备份保存在手札的数据目录。' : '选择游戏的 SaveGames 文件夹即可开始。'}</p></div></div><div class="save-stats"><div><strong>${files.filter((f) => /\.sav$/i.test(f.name)).length}</strong><small>存档文件</small></div><div>${environment.recovery ? '<button class="btn" disabled title="请先核对完整存档恢复">更换目录 · 先核对恢复</button>' : act('choose-saves', '更换目录', 'btn')}</div></div></div><div class="separator"></div><div class="row between"><span class="mono muted">${esc(save.path || '等待选择目录')}</span>${save.path ? act('folder', '打开目录', 'text-btn', 'saves', 'external') : ''}</div></div>
 <div class="row between mb"><h2>留存的副本 <span class="small muted">${backups.length ? `· ${backups.length} 份` : ''}</span></h2><div class="row"><span class="small muted">存档变化时自动备份</span><button role="switch" aria-checked="${state.settings.autoBackup}" aria-label="自动备份" class="switch ${state.settings.autoBackup ? 'on' : ''}" data-action="auto-backup"></button></div></div>
 ${backupViews.anomalies(environment.backupAnomalies || [])}${backups.length ? backupViews.page(backups, backupView) : `<div class="card">${empty('还没有备份', '先在游戏内保存，再创建第一份副本。每份备份都会保留原始文件并校验完整性。', act('backup', '创建第一份备份', 'btn soft', '', 'download'))}</div>`}<p class="save-note">原生游戏连接工作时暂停完整自动备份，避免重复复制其他槽位；等待连接或关闭时间线时仍保护文件。关闭时间线后立即检查，之后每分钟核对文件变化；稳定后复制已保存的文件，不会替游戏执行保存。副本不会自动删除。可按名称、类型和日期整理或分批导出；上方完整换机会自动分卷，请一并带走分卷目录。</p>
 <div class="section-heading"><h2>当前存档文件</h2><div class="row"><span class="small muted">共 ${files.length} 个文件 · ${bytes(save.total)}</span>${files.some((f) => f.metadata) ? act('save-compare', '比较两份存档', 'btn', '', 'search') : ''}</div></div>${
   files.length
     ? `<div class="table-wrap"><table class="save-table"><thead><tr><th>文件</th><th>保存时间</th><th>游玩时长</th><th>场景 / 队伍</th><th>大小</th></tr></thead><tbody>${files
         .map(
           (f) =>
             `<tr><td><span class="file-name">${icon('scroll')}${esc(f.name)}</span>${f.name === 'JHSaveConfig.sav' ? '<br><small>存档索引</small>' : f.metadata ? `<br>${act('save-detail', '查看存档回顾', 'text-btn', f.name)}` : ''}</td><td>${when(f.modifiedAt)}</td><td>${f.metadata ? hours(f.metadata.playSeconds) : '—'}</td><td>${
               f.metadata
                 ? `${esc(f.metadata.mapName)}<br><small>${esc(
                     f.metadata.team
                       ?.map((n) => n.name)
                       .slice(0, 3)
                       .join('、') || '',
                   )} ${f.metadata.teamIds?.length > 3 ? `等 ${f.metadata.teamIds.length} 人` : ''}</small>`
                 : /^\d+\.sav$/i.test(f.name)
                   ? '进度暂无法读取'
                   : '—'
             }</td><td><small>${bytes(f.bytes)}</small></td></tr>`,
         )
         .join('')}</tbody></table></div>`
     : empty('还没有读取到文件', '如果游戏已有存档，请在上方连接目录。')
 }
 <p class="save-note">场景、时长和队伍来自存档本身。点击「查看存档回顾」可看缩略图、追踪任务与已学配方。无法解析的版本仍可备份；保存时间取自文件时间。</p>`;
}
function companionSettings() {
  const opacity = state.settings.compactOpacity ?? 0.96;
  const presets = [1, 0.96, 0.85, 0.75, 0.65];
  const options = presets.includes(opacity) ? presets : [...presets, opacity].sort((a, b) => b - a);
  return `<section class="card"><h2 class="mb">游戏内轻提示</h2><div class="setting-row"><div><h3>平时显示一至两条</h3><p>优先显示置顶目标与备料缺口；鼠标穿透，不抢游戏焦点。Alt Tab 离开游戏后隐藏。接入组件连接时，在不可保存的场景及存读档过程中暂停轻提示。</p></div><button class="switch ${state.settings.companionEnabled !== false ? 'on' : ''}" role="switch" aria-checked="${state.settings.companionEnabled !== false}" aria-label="游戏内轻提示" data-action="companion-enabled"></button></div><div class="setting-row"><label for="companion-position">显示位置</label><select id="companion-position" class="input">${[
    ['top-right', '右上角'],
    ['bottom-right', '右下角'],
    ['top-left', '左上角'],
    ['bottom-left', '左下角'],
  ]
    .map(
      ([id, text]) =>
        `<option value="${id}" ${id === (state.settings.companionPosition || 'top-right') ? 'selected' : ''}>${text}</option>`,
    )
    .join(
      '',
    )}</select><label for="companion-opacity">提示透明度</label><select id="companion-opacity" class="input">${options.map((n) => `<option value="${n}" ${n === opacity ? 'selected' : ''}>${Number((n * 100).toFixed(2))}%${presets.includes(n) ? '' : '（当前）'}</option>`).join('')}</select></div><p class="small muted">Ctrl Alt J 展开或收起；Esc 先关闭详情，再收起面板。窗口化与无边框窗口可叠加；独占全屏的可见性取决于系统与游戏。材料来自标明时间的存档，不是实时背包。未连接游戏组件时无法自动识别战斗和对话。</p></section>`;
}
function settingsPage() {
  return `${pageHeader('MAKE IT YOUR OWN', '手札设置', '轻一点，静一点，按你自己的节奏来。')}<div class="stack"><section class="card"><h2 class="mb">阅读与陪伴</h2><div class="setting-row"><div><label for="reading-scale"><strong>界面大小</strong></label><p>文字与按钮一起放大，主窗和小窗共用。Ctrl + 加号 / 减号调整，Ctrl + 0 恢复默认；也可按住 Ctrl 滚动鼠标。</p></div><div class="row wrap"><select id="reading-scale" class="input" aria-label="界面大小">${[100, 110, 125, 150].map((size) => `<option value="${size}"${(state.settings.readingScale || 100) === size ? ' selected' : ''}>${size}%${size === 100 ? ' · 默认' : ''}</option>`).join('')}</select>${act('reading-scale-reset', '恢复默认大小', 'text-btn')}</div></div><div class="setting-row"><div><h3>第一次使用这本手札</h3><p>看看存档回顾、备料、小窗和备份怎么用。</p></div>${act('help', '打开使用说明', 'btn', '', 'book')}</div><div class="setting-row"><div><h3>少剧透提示</h3><p>显示人物名、地点和提醒，详细步骤需要主动展开；不保证完全无剧透。</p></div><button class="switch ${state.settings.spoiler === 'hints' ? 'on' : ''}" role="switch" aria-checked="${state.settings.spoiler === 'hints'}" aria-label="少剧透提示" data-action="spoiler"></button></div><div class="setting-row"><div><h3>随行小窗</h3><p>游戏中显示两条轻提示，按键展开查询与追踪。${environment.shortcutReady ? 'Ctrl + Alt + J 可展开或收起。' : '可使用右侧按钮开关。'}可在下方选择提示位置和透明度。</p></div>${act('compact', '打开随行小窗', 'btn', '', 'pin')}</div><div class="setting-row"><div><h3>当前周目：${esc(profile().name)}</h3><p>每个周目有独立的进度、收藏、目标和笔记。</p></div>${act('profiles', '管理周目', 'btn', '', 'person')}</div></section>
 ${companionSettings()}${shortcutSettings()}<section class="card"><h2 class="mb">本机连接</h2><div class="setting-row"><div><h3>逸剑风云决 ${environment.game.installed ? '· 已找到' : '· 由 Steam 启动'}</h3><p>${esc(environment.game.path || '使用 Steam 游戏入口启动')}${environment.game.build ? ` · Build ${esc(environment.game.build)}` : ''}</p></div>${act('launch', '启动游戏', 'btn', '', 'game')}</div><div class="setting-row"><div><h3>游戏存档目录</h3><p class="mono">${esc(state.settings.savePath || '尚未选择')}</p></div>${act('choose-saves', '选择目录', 'btn', '', 'folder')}</div>${environment.detected.length > 1 ? `<div class="setting-row"><div><h3>检测到多个存档目录</h3><p>请选择你本次游玩的账户目录。</p></div><select id="detected-save" class="input">${environment.detected.map((p) => `<option value="${esc(p)}" ${p === state.settings.savePath ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></div>` : ''}<div class="setting-row"><div><h3>完整自动备份 · ${backupStatus()}</h3><p>原生游戏连接工作或正在存读档时暂停，避免重复复制全部存档；等待连接时仍保护已保存的文件。复制已保存的存档，不会替游戏执行保存。开启后每分钟检查变化，稳定后留存副本；文件没有变化时不重复备份，不会自动删除旧副本。</p></div><button class="switch ${state.settings.autoBackup ? 'on' : ''}" role="switch" aria-checked="${state.settings.autoBackup}" aria-label="自动备份" data-action="auto-backup"></button></div></section>
 ${protectionViews.exportResult(protectionView.exportResultOverride || environment.protectionExportResult)}${protectionViews.controls(protectionView)}<section class="card"><h2 class="mb">记录与数据</h2><div class="setting-row"><div><h3>手札备份</h3><p>导出全部周目的记录。导入前会保留当前手札副本；此功能不包含游戏存档。</p></div><div class="row">${act('import', '导入', 'btn', '', 'upload')}${act('export', '导出手札', 'btn', '', 'download')}</div></div><div class="setting-row"><div><h3>本地数据目录</h3><p class="mono">${esc(environment.userData)}</p></div>${act('folder', '打开', 'btn', 'data', 'folder')}</div><div class="setting-row"><div><h3>游戏存档备份目录</h3><p class="mono">${esc(environment.backupRoot)}</p></div>${act('folder', '打开', 'btn', 'backups', 'folder')}</div></section>
 <section class="card"><div class="card-header"><h2>资料与版本</h2>${pill(`v${version}`)}</div><p class="small muted mb">${esc(catalog.notice)} 本地卡片可离线阅读，原文链接会在默认浏览器打开。本工具是个人非官方助手。</p><div class="source-grid">${catalog.sources.map((s) => `<div class="source-row"><div class="row between"><strong>${esc(s.title)}</strong>${iconButton('source', 'external', '打开资料来源', s.id)}</div><p>${esc(s.author)} · ${esc(s.date)}</p><p>${esc(s.version)}</p></div>`).join('')}</div></section></div>`;
}
function homeJourney() {
  const plan = environment.journey;
  if (!plan || plan.profileId !== profile().id) return '';
  return journeyViews.home(plan);
}
function archivesPage() {
  return (
    protectionViews.exportResult(protectionView.exportResultOverride || environment.protectionExportResult) +
    protectionViews.page(protectionView)
  );
}
function journeyPage() {
  if (journeyTrashView.open) return journeyTrashViews.panel(profile(), journalIndex(), journeyTrashView);
  return (
    journeyTrashViews.entry(profile()) +
    intentDraftViews.panel(availableIntentDrafts(), gameIndex) +
    journeyViews.page(
      environment.journey?.profileId === profile().id ? environment.journey : null,
      journeyView,
      gameIndex,
    )
  );
}
function refreshPlacePicker(page) {
  const view = journeyDraft?.placePicker;
  if (!view) return;
  const field = document.querySelector('#journey-place');
  if (field) view.selectedId = field.value;
  view.query = document.querySelector('#journey-place-search')?.value || '';
  view.page = page || 1;
  const focused = document.activeElement?.id;
  document.querySelector('#journey-place-options').innerHTML = placePicker.options(gameIndex, view);
  writeIntentValues(
    journeyDraft.kind === 'goal' ? 'goal' : 'journey-' + journeyDraft.kind,
    { placeId: view.selectedId },
    overlay,
  );
  if (focused === 'journey-place') document.querySelector('#journey-place').focus();
}
function refreshGiftPicker(kind, page) {
  const view = journeyDraft?.giftPicker?.[kind];
  if (!view) return;
  const target = kind === 'person' ? 'journey-person' : 'journey-item';
  const selectedField = document.querySelector('#' + target);
  if (selectedField) view.selectedId = selectedField.value;
  view.query = document.querySelector('#' + target + '-search')?.value || '';
  if (kind === 'item') {
    view.quality = document.querySelector('#journey-item-quality')?.value || 'all';
    view.personId = journeyDraft.giftPicker.person.selectedId;
    view.preferredOnly = !!document.querySelector('#journey-item-preferred')?.checked;
    view.stockOnly = !!document.querySelector('#journey-item-stock')?.checked;
  }
  view.page = page || 1;
  const focusedId = document.activeElement?.id;
  document.querySelector('#' + target + '-options').innerHTML = giftPicker.options(gameIndex, kind, view);
  writeIntentValues('journey-gift', { [kind === 'person' ? 'npcId' : 'itemId']: view.selectedId }, overlay);
  if (focusedId === target) document.querySelector('#' + target).focus();
}
async function loadGiftStock(draft) {
  if (!document.querySelector('#journey-item-options')) return;
  const request = Symbol('stock');
  draft.stockRequest = request;
  draft.giftPicker.item.stock = null;
  document.querySelector('#journey-item-stock').disabled = true;
  refreshGiftPicker('item', draft.giftPicker.item.page);
  const reference = environment.journey?.profileId === draft.profileId ? environment.journey.reference : null;
  if (!reference || !reference.name) return;
  try {
    const file = await call('saveDetails', reference.name);
    if (
      journeyDraft !== draft ||
      draft.stockRequest !== request ||
      profile().id !== draft.profileId ||
      !document.querySelector('#journey-item-options')
    )
      return;
    if (file.hash !== reference.hash || file.modifiedAt !== reference.modifiedAt) return;
    draft.giftPicker.item.stock = giftStock(file, draft.profileId, draft.id);
    const toggle = document.querySelector('#journey-item-stock');
    if (toggle) toggle.disabled = !draft.giftPicker.item.stock;
    refreshGiftPicker('item', draft.giftPicker.item.page);
  } catch {
    /* A missing or changed reference is shown as unknown, never as empty stock. */
  }
}
function journeyDialog(kind, id = '', savedDraft = null) {
  const p = profile(),
    state = p.journey || { places: [], todos: [], gifts: [] };
  const record =
    kind === 'place'
      ? state.places.find((r) => r.placeId === id)
      : kind === 'todo'
        ? state.todos.find((r) => r.id === id)
        : state.gifts.find((r) => r.id === id);
  journeyDraft = {
    kind,
    profileId: p.id,
    id: savedDraft?.targetId || record?.id,
    record,
    placePicker: {
      selectedId: savedDraft?.values.placeId || record?.placeId || '',
      query: savedDraft?.values.placeQuery || '',
      page: 1,
    },
  };
  let body, title;
  if (kind === 'place') {
    const place = gameIndex.world.maps.find((m) => m.id === id);
    if (!place) throw Error('请选择资料中的地点');
    journeyDraft.placeId = id;
    title = '记下地点：' + place.name;
    body = `<div class="field"><label for="journey-note">在这里想做什么</label><textarea id="journey-note" maxlength="1000">\n${esc(record?.note || '')}</textarea></div><label><input id="journey-favorite" type="checkbox" ${record?.favorite !== false ? 'checked' : ''}> 优先显示这个地点</label><label><input id="journey-done" type="checkbox" ${record?.done ? 'checked' : ''}> 这项地点目标已完成</label>`;
  } else if (kind === 'todo') {
    title = record ? '编辑个人待办' : '添加个人待办';
    body = `<div class="field"><label for="journey-title">待办标题</label><input id="journey-title" maxlength="120" required value="${esc(record?.title || '')}" placeholder="例如：去药铺前先核对炼丹材料"></div><div class="field"><label for="journey-note">补充说明</label><textarea id="journey-note" maxlength="2000">\n${esc(record?.detail || '')}</textarea></div>${placePicker.field(gameIndex, journeyDraft.placePicker)}<label><input id="journey-done" type="checkbox" ${record?.done ? 'checked' : ''}> 这项个人待办已完成</label>`;
  } else {
    const pair = savedDraft
      ? [savedDraft.values.npcId, savedDraft.values.itemId]
      : record
        ? [record.npcId, record.itemId]
        : id.split(':');
    journeyDraft.giftPicker = {
      person: { selectedId: pair[0] || '', query: savedDraft?.values.personQuery || '', page: 1 },
      item: {
        selectedId: pair[1] || '',
        personId: pair[0] || '',
        query: savedDraft?.values.itemQuery || '',
        quality: savedDraft?.values.itemQuality || 'all',
        preferredOnly: savedDraft?.values.preferredOnly || false,
        stockOnly: savedDraft?.values.stockOnly || false,
        page: 1,
      },
    };
    title = record ? '编辑赠礼意图' : '规划一份赠礼';
    body = `${giftPicker.field(gameIndex, 'person', journeyDraft.giftPicker.person)}${giftPicker.field(gameIndex, 'item', journeyDraft.giftPicker.item)}<div class="field"><label for="journey-quantity">件数</label><input id="journey-quantity" type="number" min="1" max="999" step="1" required value="${record?.quantity || 1}"></div>${placePicker.field(gameIndex, journeyDraft.placePicker, '想在什么地点办理')}<div class="field"><label for="journey-note">备注</label><textarea id="journey-note" maxlength="1000">\n${esc(record?.note || '')}</textarea></div><label><input id="journey-done" type="checkbox" ${record?.done ? 'checked' : ''}> 我已经完成这份赠礼</label><p class="save-note">保存后会与任务、制作计划共同分配已有库存。这里只规划赠礼，人物当前可否接受与好感变化须在游戏内确认。</p>`;
  }
  modal(
    title,
    '保存在当前周目，游戏文件和物品不会改变。',
    '<div class="journey-intent-body">' + body + '</div>',
    (record ? act('journey-intent-remove', '移除这项个人记录', 'btn danger') : '') +
      act('journey-intent-save', '保存', 'btn primary', '', 'check'),
  );
  overlay.querySelector('.modal').classList.add('journey-intent-modal');
  if (savedDraft) writeIntentValues('journey-' + kind, savedDraft.values, overlay);
  activateIntentEditor(
    'journey-' + kind,
    kind === 'place' ? id : savedDraft?.targetId || record?.id || '',
    {},
    savedDraft,
  );
  document.querySelector('#journey-title, #journey-note, #journey-person')?.focus();
  if (kind === 'gift') loadGiftStock(journeyDraft);
}
async function loadProtectionList() {
  const token = ++protectionRequest;
  protectionView.history = null;
  protectionView.loaded = false;
  protectionView.error = '';
  render(true);
  try {
    const list = await call('protectionList');
    if (token !== protectionRequest) return;
    protectionView.archives = list;
    protectionView.loaded = true;
  } catch (e) {
    if (token === protectionRequest) protectionView.error = e.message;
  } finally {
    if (token === protectionRequest) render(true);
  }
}
function compactPage() {
  document.body.classList.add('companion');
  document.body.classList.toggle('passive', companionMode === 'hint');
  if (companionMode === 'hint') return companionViews.passive(companionData);
  const ref = companionData?.reference;
  const sourceLine = `<p class="companion-reference">${esc(companionData?.referenceLabel || '正在核对参照')}<br>${ref ? `${esc(ref.mapName)} · ${esc(ref.name)} · ${when(ref.modifiedAt)}（已保存的进度）` : '尚无可读存档，资料查询仍然可用'}</p>${companionData?.error ? notice(companionData.error) : ''}${companionData?.windowError ? notice('窗口跟随暂不可用：' + companionData.windowError) : ''}`;
  if (route === 'materials')
    return companionViews.frame(materialPage(), timelineViews.chip(environment.health));
  if (route === 'recipe-discovery')
    return companionViews.frame(recipeDiscoveryPage(), timelineViews.chip(environment.health));
  if (route === 'saves')
    return companionViews.frame(
      timelineViews.page(environment.timeline, timelineView),
      timelineViews.chip(environment.health),
    );
  if (route === 'journey') return companionViews.frame(journeyPage(), timelineViews.chip(environment.health));
  if (route === 'journal') return companionViews.frame(journalPage(), timelineViews.chip(environment.health));
  if (route === 'world') return companionViews.frame(worldPage(), timelineViews.chip(environment.health));
  if (route === 'goals') return companionViews.frame(goalsPage(), timelineViews.chip(environment.health));
  const list = pending().slice(0, 5);
  const undo =
    compactUndo?.profileId === profile().id
      ? `<div class="notice"><span>已完成：${esc(compactUndo.title)}</span>${act('compact-undo', '撤销这次完成', 'text-btn')}</div>`
      : '';
  const questList = companionData?.quests?.length
    ? `<h3 class="companion-section">存档里的进行中任务</h3>${companionData.quests
        .slice(0, 4)
        .map(
          (q) =>
            `<div class="compact-goal"><strong>${esc(q.name)}</strong>${q.steps.length ? `<p class="small muted">${q.steps.map(esc).join('、')}</p>` : ''}${act('save-quest-jump', '查看已保存记录', 'text-btn', q.id, 'book')}</div>`,
        )
        .join('')}`
    : '';
  const body = `<div class="eyebrow">${esc(profile().name)} · 我的追踪</div>${sourceLine}${companionData?.itinerary?.steps.length ? companionViews.actions(companionData) : ''}${undo}${questList}<h3 class="companion-section">我的目标</h3>${
    orderedGoals()
      .filter((g) => !goalDone(g))
      .map(
        (g) =>
          `<div class="compact-goal"><div class="row"><button class="check" data-action="goal-toggle" data-id="${g.id}" aria-label="完成目标 ${esc(g.title)}"></button><strong>${esc(g.title)}</strong>${iconButton('goal-pin', 'pin', (g.pinned ? '取消优先提示 ' : '优先提示 ') + g.title, g.id)}</div>${g.source ? act('goal-source', '查看当前详情', 'text-btn', g.id, 'book') : ''}${g.detail ? `<details data-compact-detail="${esc(g.id)}"><summary>添加时的备忘（不自动更新）</summary><p class="preserve-text">${esc(g.detail)}</p></details>` : ''}</div>`,
      )
      .join('') || '<p class="small muted">在图鉴或完整手札中添加目标，游玩时会优先提示置顶目标。</p>'
  }${!companionData?.itinerary?.steps.length ? companionViews.actions(companionData) : ''}${companionViews.materials(companionData)}<h3 class="companion-section">${esc(stageTitle())}</h3><p class="small muted">手动阶段的精选清单</p>${list.map(checkRow).join('')}${profile().notes ? `<details class="compact-note" data-compact-detail="note"><summary>江湖随手记</summary><p class="preserve-text">${esc(profile().notes)}</p></details>` : ''}`;
  return companionViews.frame(
    body,
    `<span data-save-health>${timelineViews.chip(environment.health)}</span>`,
  );
}
function render(preserve = false, navigationId = null) {
  if (!catalog || !state || composing) return;
  captureIntentDrafts();
  const replaceRoot = (html) => {
    const note = preserve ? root.querySelector('#note') : null;
    if (!note) {
      root.innerHTML = html;
      return;
    }
    const template = document.createElement('template');
    template.innerHTML = html;
    const next = template.content.querySelector('#note');
    if (!next || note.dataset.profileId !== next.dataset.profileId || note.value !== next.value) {
      root.replaceChildren(template.content);
      return;
    }
    const oldPath = [],
      newPath = [];
    for (let node = note; node !== root; node = node.parentNode) oldPath.unshift(node);
    for (let node = next; node !== template.content; node = node.parentNode) newPath.unshift(node);
    if (
      oldPath.length !== newPath.length ||
      oldPath.some((node, i) => node.nodeName !== newPath[i].nodeName)
    ) {
      root.replaceChildren(template.content);
      return;
    }
    oldPath.unshift(root);
    newPath.unshift(template.content);
    // Chromium discards native undo even if the same textarea is reattached.
    // Keep its entire ancestor chain connected; update only surrounding nodes.
    for (let i = 0; i < oldPath.length - 1; i++) {
      const current = oldPath[i],
        replacement = newPath[i],
        kept = oldPath[i + 1],
        source = newPath[i + 1];
      if (current !== root) {
        for (const name of current.getAttributeNames())
          if (!replacement.hasAttribute(name)) current.removeAttribute(name);
        for (const { name, value } of replacement.attributes) current.setAttribute(name, value);
      }
      for (const child of [...current.childNodes]) if (child !== kept) child.remove();
      while (replacement.firstChild !== source) current.insertBefore(replacement.firstChild, kept);
      while (source.nextSibling) current.append(source.nextSibling);
    }
  };
  const active = document.activeElement,
    focusId = preserve ? active?.id : null,
    selection = active && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null,
    fieldValue = active && active.dataset?.persist ? active.value : null;
  navigationId ||=
    root.contains(active) && active.matches('.sidebar-nav .nav-btn, .companion-tabs [data-action="navigate"]')
      ? active.dataset.id
      : null;
  const restoreNavigationFocus = () => {
    if (!navigationId || root.inert) return;
    root
      .querySelector(
        `.sidebar-nav [data-action="navigate"][data-id="${CSS.escape(navigationId)}"], .companion-tabs [data-action="navigate"][data-id="${CSS.escape(navigationId)}"]`,
      )
      ?.focus({ preventScroll: true });
  };
  const itineraryFocus =
    preserve && root.contains(active) && active?.dataset?.action?.startsWith('journey-itinerary-')
      ? {
          action: active.dataset.action,
          id: active.dataset.id || '',
          targetId: active.dataset.targetId || '',
          direction: active.dataset.direction || '',
          step: active.closest('[data-itinerary-step]')?.dataset.itineraryStep || '',
        }
      : null;
  const restoreItineraryFocus = () => {
    if (!itineraryFocus) return;
    const next = [...root.querySelectorAll('[data-action]')].find(
      (el) =>
        el.dataset.action === itineraryFocus.action &&
        (el.dataset.id || '') === itineraryFocus.id &&
        (el.dataset.targetId || '') === itineraryFocus.targetId &&
        (el.dataset.direction || '') === itineraryFocus.direction &&
        (el.closest('[data-itinerary-step]')?.dataset.itineraryStep || '') === itineraryFocus.step,
    );
    next?.focus({ preventScroll: true });
  };
  const scroll = root.querySelector('.content')?.scrollTop || 0;
  if (compact) {
    const opened = new Set(
      [...root.querySelectorAll('[data-compact-detail][open]')].map((e) => e.dataset.compactDetail),
    );
    const itineraryDetails = new Map(
      [...root.querySelectorAll('details[data-persist-detail]')].map((el) => [
        el.dataset.persistDetail,
        el.open,
      ]),
    );
    const compactScroll = root.querySelector('.compact-body')?.scrollTop || 0;
    replaceRoot(compactPage());
    const navigation = root.querySelector('.companion-tabs');
    if (navigation) {
      navigation.setAttribute('role', 'navigation');
      navigation.setAttribute('aria-label', '随行页面');
      for (const button of navigation.querySelectorAll('[data-action="navigate"]')) {
        button.classList.add('compact-tab');
        button.classList.toggle('active', button.dataset.id === route);
        if (button.dataset.id === route) button.setAttribute('aria-current', 'page');
      }
    }
    if (companionMode === 'expanded' && availableIntentDrafts().length && route !== 'journey')
      root.querySelector('.compact-body')?.insertAdjacentHTML('afterbegin', intentDraftBanner());
    syncItineraryIntentEditors();
    for (const el of root.querySelectorAll('[data-compact-detail]'))
      el.open = opened.has(el.dataset.compactDetail);
    if (preserve)
      for (const el of root.querySelectorAll('details[data-persist-detail]'))
        if (itineraryDetails.has(el.dataset.persistDetail))
          el.open = itineraryDetails.get(el.dataset.persistDetail);
    const body = root.querySelector('.compact-body');
    if (body) body.scrollTop = compactScroll;
    if (focusId && companionMode === 'expanded') {
      const field = document.getElementById(focusId);
      if (field) {
        if (fieldValue !== null && focusId !== 'note') field.value = fieldValue;
        field.focus();
        if (selection && field.setSelectionRange && !['number', 'email'].includes(field.type))
          field.setSelectionRange(...selection);
      }
    }
    restoreItineraryFocus();
    restoreNavigationFocus();
    return;
  }
  const sidebarScroll = root.querySelector('.sidebar-nav')?.scrollTop || 0;
  const openedDetails = new Map(
    preserve
      ? [...root.querySelectorAll('details[data-persist-detail]')].map((el) => [
          el.dataset.persistDetail,
          el.open,
        ])
      : [],
  );
  replaceRoot(
    `<div class="layout"><aside class="sidebar"><div class="brand"><span class="seal">逸</span><div><div class="brand-name">逸剑手札</div><div class="brand-sub">WANDERING JOURNAL</div></div></div><nav class="sidebar-nav" aria-label="手札页面"><div class="nav-section">我的江湖</div>${[
      ['home', 'home'],
      ['checklist', 'scroll'],
      ['library', 'book'],
      ['database', 'sword'],
      ['world', 'scroll'],
      ['materials', 'leaf'],
      ['journey', 'map'],
      ['goals', 'bag'],
      ['journal', 'feather'],
    ]
      .map(
        ([id, glyph]) =>
          `<button class="nav-btn ${route === id ? 'active' : ''}"${route === id ? ' aria-current="page"' : ''} data-action="navigate" data-id="${id}">${icon(glyph)}${headings[id]}${id === 'goals' && profile().goals.filter((g) => !goalDone(g)).length ? `<span class="nav-count">${profile().goals.filter((g) => !goalDone(g)).length}</span>` : ''}</button>`,
      )
      .join('')}<div class="nav-section mt">一路相伴</div>${[
      ['saves', 'archive'],
      ['settings', 'settings'],
    ]
      .map(
        ([id, glyph]) =>
          `<button class="nav-btn ${route === id ? 'active' : ''}"${route === id ? ' aria-current="page"' : ''} data-action="navigate" data-id="${id}">${icon(glyph)}${headings[id]}</button>`,
      )
      .join(
        '',
      )}</nav><div class="sidebar-art"><div class="sidebar-line"></div><p>山水有相逢<br>江湖不相忘</p><small>ONE JOURNEY AT A TIME</small></div><div class="profile-box"><div class="avatar">侠</div><div class="profile-info"><strong>${esc(profile().name)}</strong><small>记录只保存在本机</small></div>${iconButton('profiles', 'settings', '管理周目')}</div></aside><div class="workspace"><div class="titlebar"><span class="window-name">逸剑风云决 · 个人助手</span><span class="spacer"></span><div class="window-buttons">${iconButton('window-minimize', 'minus', '最小化窗口')}${iconButton('window-maximize', 'maximize', '最大化或还原窗口')}${iconButton('window-close', 'close', '关闭窗口', '', 'close')}</div></div><header class="topbar"><div class="breadcrumb">我的江湖 ${icon('chevron')}<b>${headings[route]}</b></div><div class="row"><span data-save-health>${timelineViews.chip(environment.health)}</span><button class="search-trigger" data-action="search">${icon('search')}找一个人，一件事<kbd>Ctrl K</kbd></button>${iconButton('compact', 'pin', '打开随行小窗 · Ctrl+Alt+J')}</div></header><main class="content">${availableJournalDrafts().length ? `<div class="notice mb">${act('journal-drafts', `继续写记录 · ${availableJournalDrafts().length} 份草稿`, 'text-btn')}</div>` : ''}${({ home: homePage, checklist: checklistPage, library: libraryPage, database: databaseView, world: worldPage, materials: materialPage, 'recipe-discovery': recipeDiscoveryPage, goals: goalsPage, saves: savesPage, settings: settingsPage, archives: archivesPage, journey: journeyPage, journal: journalPage }[route] || homePage)()}</main></div></div>`,
  );
  root.querySelector('.sidebar-nav').scrollTop = sidebarScroll;
  if (availableIntentDrafts().length && !['home', 'journey'].includes(route))
    root.querySelector('.content')?.insertAdjacentHTML('afterbegin', intentDraftBanner());
  syncItineraryIntentEditors();
  root.querySelector('.sidebar-nav .nav-btn.active')?.scrollIntoView({ block: 'nearest' });
  if (preserve) {
    root.querySelector('.content').scrollTop = scroll;
    for (const el of root.querySelectorAll('details[data-persist-detail]'))
      if (openedDetails.has(el.dataset.persistDetail)) el.open = openedDetails.get(el.dataset.persistDetail);
  }
  if (focusId) {
    const next = document.getElementById(focusId);
    if (next) {
      if (fieldValue !== null && next.dataset.persist && !['list-search', 'note'].includes(focusId))
        next.value = fieldValue;
      next.focus();
      if (selection && typeof next.setSelectionRange === 'function')
        try {
          next.setSelectionRange(...selection);
        } catch {}
    }
  }
  restoreItineraryFocus();
  restoreNavigationFocus();
}
function intentDraftBanner() {
  return `<div class="notice mb">${act('intent-drafts', `继续未完成安排 · ${availableIntentDrafts().length} 份草稿`, 'text-btn')}</div>`;
}
function showOverlay(html, drawer = false, preserve = false) {
  ++backupPreviewRequest;
  if (resourcePriorityDraft && !html.includes('class="resource-priority-editor"')) {
    resourcePriorityRequest++;
    resourcePriorityDraft = null;
  }
  captureJournalDraft();
  captureIntentDrafts();
  activeIntentEditor = null;
  const oldScroll = preserve ? overlay.querySelector('.drawer-body')?.scrollTop || 0 : 0;
  const focusedId = preserve && overlay.contains(document.activeElement) ? document.activeElement.id : null;
  const opened = preserve
    ? [...overlay.querySelectorAll('details[open]')].map(
        (e) => e.id || e.querySelector('summary')?.textContent,
      )
    : [];
  if (!overlay.firstChild) lastFocus = document.activeElement;
  if (!drawer) {
    currentDrawer = null;
    drawerHistory.length = 0;
  }
  root.inert = true;
  overlay.innerHTML = `<div class="overlay-backdrop ${drawer ? 'drawer-backdrop' : ''}" data-backdrop="true">${html}</div>`;
  if (drawer && drawerHistory.length)
    overlay
      .querySelector('.drawer-head')
      ?.insertAdjacentHTML(
        'afterbegin',
        iconButton(
          'drawer-back',
          'arrow',
          drawerHistory.at(-1).type === 'search' ? '返回搜索结果' : '返回上一页',
          '',
          'drawer-back',
        ),
      );
  const focusable = overlay.querySelector('input,textarea,select,button');
  ((focusedId && overlay.querySelector('#' + CSS.escape(focusedId))) || focusable)?.focus();
  if (preserve)
    for (const e of overlay.querySelectorAll('details'))
      e.open = opened.includes(e.id || e.querySelector('summary')?.textContent);
  if (preserve && overlay.querySelector('.drawer-body'))
    overlay.querySelector('.drawer-body').scrollTop = oldScroll;
  if (currentDrawer?.type === 'timeline' && submittingNodes.has(currentDrawer.data.record.id))
    nodeControlsDisabled(currentDrawer.data.record.id, true);
  if (currentDrawer?.type === 'timeline') updateHealth(environment.health);
}
function dismissOverlay() {
  const backup = backupRenameDraft;
  if (backup && overlay.querySelector('[data-action="backup-rename-save"]')) {
    backupRenameDraft = null;
    const previousOverlay = overlay.firstChild,
      request = ++backupPreviewRequest,
      scope = backupPreviewScope();
    call('inspectBackup', backup.id)
      .then((current) => {
        if (
          overlay.firstChild !== previousOverlay ||
          request !== backupPreviewRequest ||
          scope !== backupPreviewScope()
        )
          return;
        drawerHistory.splice(0, drawerHistory.length, ...backup.history);
        showBackupPreview({ type: 'backup', data: current, status: 'verified', scope });
        overlay.querySelector('[data-action="backup-rename"]')?.focus({ preventScroll: true });
        overlay.querySelector('.drawer-body').scrollTop = backup.scroll;
      })
      .catch((error) => {
        if (
          overlay.firstChild !== previousOverlay ||
          request !== backupPreviewRequest ||
          scope !== backupPreviewScope()
        )
          return;
        closeOverlay();
        toast('无法重新打开备份预览：' + error.message, true);
      });
    return;
  }
  const note = noteRestoreConfirmation;
  if (note && overlay.querySelector('[data-note-restore-preview]')) {
    noteRestoreConfirmation = null;
    if (note.profileId === profile().id) {
      showNoteHistory(note.returnContext);
      return;
    }
  }
  const draft = journalRemoveDraft;
  if (
    draft?.mode === 'single' &&
    draft.returnToRecord &&
    overlay.querySelector('[data-action="journal-entry-remove-confirm"]')
  ) {
    journalRemoveDraft = null;
    if (
      draft.profileId === profile().id &&
      profile().journalEntries?.some((entry) => entry.id === draft.id)
    ) {
      showOverlay(eventJournalViews.detail(profile(), draft.id), true);
      overlay.querySelector('[data-action="journal-entry-remove"]')?.focus({ preventScroll: true });
      overlay.querySelector('.drawer-body').scrollTop = draft.scroll;
      return;
    }
  }
  const intent = journeyTrashConfirmation;
  if (
    intent?.type === 'remove' &&
    intent.returnContext &&
    overlay.querySelector('[data-action="journey-intent-remove-confirm"]')
  ) {
    journeyTrashConfirmation = null;
    if (intent.profileId === profile().id) {
      overlay.replaceChildren(intent.returnContext.content);
      activeIntentEditor = intent.returnContext.editor;
      journeyDraft = intent.returnContext.draft;
      overlay.querySelector('[data-action="journey-intent-remove"]')?.focus({ preventScroll: true });
      overlay.querySelector('.modal').scrollTop = intent.returnContext.scroll;
      if (journeyDraft?.kind === 'gift') loadGiftStock(journeyDraft);
      return;
    }
  }
  closeOverlay();
}
function closeOverlay() {
  ++backupPreviewRequest;
  backupRenameDraft = null;
  noteRestoreConfirmation = null;
  journalRemoveDraft = null;
  journeyTrashConfirmation = null;
  itineraryClearConfirmation = null;
  craftCompletionDraft = null;
  resourcePriorityRequest++;
  resourcePriorityDraft = null;
  captureNodeDraft();
  captureJournalDraft();
  captureIntentDrafts();
  activeIntentEditor = null;
  window.journal.timelineRelease().catch(() => {});
  detailRequest++;
  comparisonState = null;
  currentDrawer = null;
  drawerHistory.length = 0;
  overlay.innerHTML = '';
  root.inert = false;
  drawerId = null;
  databaseId = null;
  revealed = false;
  let returnFocus = lastFocus?.isConnected ? lastFocus : null;
  if (!returnFocus && lastFocus?.id) returnFocus = root.querySelector('#' + CSS.escape(lastFocus.id));
  if (!returnFocus && lastFocus?.dataset.action) {
    const matches = [...root.querySelectorAll('[data-action]')].filter((element) =>
      ['action', 'id', 'direction', 'targetId'].every(
        (key) => element.dataset[key] === lastFocus.dataset[key],
      ),
    );
    if (matches.length === 1) returnFocus = matches[0];
  }
  (returnFocus || root.querySelector('.nav-btn.active, .compact-tab.active'))?.focus();
}
function showDetail(id, keep = false) {
  const e = entry(id);
  if (!e) return;
  rememberDrawer({ type: 'guide', id }, keep || (currentDrawer?.type === 'guide' && currentDrawer.id === id));
  drawerId = id;
  if (!keep) revealed = state.settings.spoiler === 'details';
  const status = profile().checks[id];
  const html = `<section class="drawer" role="dialog" aria-modal="true" aria-label="${esc(e.title)}详情"><div class="drawer-head"><span class="small muted">江湖索引 / ${e.kind}</span>${iconButton('close-overlay', 'close', '关闭详情')}</div><div class="drawer-body"><div class="tag-row">${pill(e.kind, 'green')}${e.tags.map((t) => pill(t)).join('')}</div><h1>${esc(e.title)}</h1><div class="row small muted">${icon('pin')}${esc(e.location)}</div><p class="intro">${esc(e.hint)}</p>${e.checkpoint ? notice(`核对节点：${e.checkpoint}`) : ''}<div class="detail-block"><div class="detail-label">建议整理阶段</div><p class="small">${catalog.stages[e.stage].title} · 这是参考标签，实际触发取决于前置任务。</p></div><div class="detail-block"><h3>详细线索</h3>${revealed ? `<ol class="steps">${e.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>` : `<div class="spoiler-box">${icon('eye')}<h3>把探索的乐趣留给自己</h3><p>展开后可能包含任务条件、选择或奖励。</p>${act('reveal', '我需要详细线索', 'btn soft', id)}</div>`}</div>${e.related.length ? `<div class="detail-block"><h3>关联线索</h3>${e.related.map((r) => act('detail', esc(entry(r)?.title || r), 'btn mb', r, 'arrow')).join(' ')}</div>` : ''}<div class="detail-block"><h3>资料来源</h3>${
    e.sourceIds.length
      ? e.sourceIds
          .map((id) => {
            const s = source(id);
            return `<div class="source-row"><div class="row between"><strong>${esc(s.title)}</strong>${iconButton('source', 'external', '在浏览器打开原文', id)}</div><p>${esc(s.author)} · ${esc(s.date)}</p><p>${esc(s.version)}</p></div>`;
          })
          .join('')
      : '<p class="small muted">手札使用建议，由本工具整理。</p>'
  }<p class="small muted mt">本卡是精选参考，非完整攻略。新版本或不同前置选择可能改变触发条件。</p></div></div><div class="drawer-actions">${e.checklist ? act('check', status === 'done' ? '已完成 · 撤销' : '标记为已完成', 'btn primary', id, 'check') : act('entry-goal', '加入我的目标', 'btn primary', id, 'plus')}${iconButton('favorite', 'star', profile().favorites.includes(id) ? '取消收藏' : '收藏线索', id, `favorite ${profile().favorites.includes(id) ? 'on' : ''}`)}${e.checklist ? act('skip', status === 'skip' ? '恢复待办' : '暂不做', 'btn', id) : ''}</div></section>`;
  showOverlay(html, true);
}
function modal(title, description, body, footer) {
  showOverlay(
    `<section class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="row between"><h2>${title}</h2>${iconButton('close-overlay', 'close', '关闭')}</div>${description ? `<p>${description}</p>` : ''}${body}<div class="modal-footer">${act('close-overlay', '取消', 'btn')}${footer}</div></section>`,
  );
}
function stageModal(selectCurrent = false) {
  modal(
    '这一程，走到哪里了？',
    '选择最接近你当前主线的阶段。只会调整手札的提醒范围。',
    `<div class="field"><label for="stage-select">当前阶段</label><select id="stage-select">${catalog.stages.map((s) => `<option value="${s.id}" ${s.id === profile().stage ? 'selected' : ''}>${s.id + 1}. ${s.title} · ${s.sub}</option>`).join('')}</select></div>${notice('已勾选的记录会保留。切换阶段不会替你完成或跳过任何条目。', true)}`,
    act('stage-save', '保存进度', 'btn primary', selectCurrent ? 'current' : ''),
  );
}
async function changeStage(id) {
  if (id === profile().stage && profile().stageConfirmed !== false) {
    closeOverlay();
    return;
  }
  const old = profile().stage,
    earlier = pending().filter((e) => e.checkpoint && e.stage < id);
  if (id > old && earlier.length) {
    modal(
      '推进前，再核对一下',
      `有 ${earlier.length} 条较早阶段的时机提醒还未标记。可以继续切换，稍后仍能在清单中找到它们。`,
      `<div class="small muted">${earlier
        .slice(0, 4)
        .map((e) => `<p>· ${esc(e.title)}</p>`)
        .join('')}</div>`,
      act('stage-confirm', '仍然切换阶段', 'btn primary', String(id)),
    );
  } else {
    await mutation({ type: 'stage', value: id });
    closeOverlay();
    toast('当前阶段已更新');
  }
}
function goalModal(id, savedDraft = null) {
  const g = id ? profile().goals.find((x) => x.id === id) : null;
  const quantityField =
    itemGoal(g) || Object.hasOwn(savedDraft?.values || {}, 'quantity')
      ? `<div class="field"><label for="goal-quantity">收集数量（件）</label><input id="goal-quantity" type="number" min="1" max="999" step="1" required value="${g?.source?.quantity || 1}"><p class="save-note">${g ? '按这件物品的数量核对行程与持有参照；默认 1 件，完成状态仍由你管理。' : '原物品目标已移除，草稿仍保留；请先恢复原目标再重新核对，正式保存会更新原目标。'}</p></div>`
      : '';
  journeyDraft =
    !quantityField && personalGoal(g)
      ? {
          kind: 'goal',
          profileId: profile().id,
          placePicker: {
            selectedId: savedDraft?.values.placeId ?? g?.placeId ?? '',
            query: savedDraft?.values.placeQuery || '',
            page: 1,
          },
        }
      : null;
  modal(
    g ? '编辑行囊目标' : '下一步，想做什么？',
    '一句明确的小目标，就足够开始下一次出发。',
    `<div class="field"><label for="goal-title">目标</label><input id="goal-title" maxlength="200" placeholder="例如：去青木舫，看看司马铃的新任务" value="${esc(g?.title || '')}"></div><div class="field"><label for="goal-detail">补充说明（可选）</label><textarea id="goal-detail" rows="4" maxlength="2000" placeholder="前置条件、需要准备的东西……">${esc(g?.detail || '')}</textarea></div>${journeyDraft ? placePicker.field(gameIndex, journeyDraft.placePicker, '目标地点（可选）') + '<p class="save-note">保存地点后，同一个目标会参与按地点行程，完成状态仍由原目标管理。选择「地点未定」可移除地点；不会从文字猜选，也不会合并同名待办。</p>' : ''}`,
    act('goal-save', g ? '保存修改' : '放进行囊', 'btn primary', g?.id || ''),
  );
  if (quantityField)
    document.querySelector('#goal-detail').closest('.field').insertAdjacentHTML('beforebegin', quantityField);
  document.querySelector('#goal-title')?.focus();
  if (savedDraft) writeIntentValues('goal', savedDraft.values, overlay);
  activateIntentEditor('goal', id || '', {}, savedDraft);
}
function profilesModal() {
  modal(
    '每一程，都有自己的故事',
    '周目之间的清单、目标与笔记分别保存。',
    `<div class="field"><label for="profile-select">切换周目</label><select id="profile-select">${state.profiles.map((p) => `<option value="${p.id}" ${p.id === profile().id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div><div class="row mb">${act('profile-switch', '切换到此周目', 'btn soft')}${act('profile-rename', '重命名当前周目', 'text-btn')}</div><div class="separator"></div><div class="field"><label for="profile-name">开启新周目</label><input id="profile-name" placeholder="例如：二周目 · 刀法之旅" maxlength="40"></div><div class="field"><label for="profile-binding">新周目使用哪份游戏存档</label><select id="profile-binding"><option value="@none">暂不绑定 · 仅查资料</option><option value="@latest">跟随最新已保存进度</option>${readableSaves()
      .map(
        (f) =>
          `<option value="${esc(f.name)}">${esc(f.name)} · ${esc(f.metadata.mapName)} · ${hours(f.metadata.playSeconds)}</option>`,
      )
      .join(
        '',
      )}</select></div><p class="small muted">新周目不会自动认领旧存档；绑定后才显示对应的任务和库存。</p>`,
    act('profile-create', '新建周目', 'btn primary'),
  );
}
function saveSlotModal() {
  const current = profile().referenceMode === 'none' ? '@none' : profile().saveSlot || '@latest';
  const files = environment.saves.files.filter((f) => f.metadata);
  modal(
    '这一程，回顾哪份存档？',
    '只设置手札的默认回顾与备料参照，不会加载或修改游戏存档。',
    `<div class="field"><label for="save-slot-select">${esc(profile().name)}的默认存档</label><select id="save-slot-select"><option value="@latest" ${current === '@latest' ? 'selected' : ''}>跟随最新已保存进度</option><option value="@none" ${current === '@none' ? 'selected' : ''}>仅查资料 · 不核对游戏存档</option>${!current.startsWith('@') && !files.some((f) => f.name === current) ? `<option value="${esc(current)}" selected>${esc(current)} · 当前不可读</option>` : ''}${files.map((f) => `<option value="${esc(f.name)}" ${f.name === current ? 'selected' : ''}>${esc(f.name)} · ${esc(f.metadata.mapName)} · ${hours(f.metadata.playSeconds)} · ${when(f.modifiedAt)}</option>`).join('')}</select></div><p class="small muted">每个手札周目分别记住这个选择。游戏中未保存的变化不会反映在这里；更换存档目录后会重新使用自动选择。</p>`,
    act('save-slot-save', '保存选择', 'btn primary'),
  );
}
function searchModal(context) {
  captureNodeDraft();
  detailRequest++;
  const value = context?.query ?? lastSearchQuery;
  showOverlay(
    `<section class="modal search-modal" role="dialog" aria-modal="true" aria-label="搜索江湖索引"><label class="search-input">${icon('search')}<input id="global-search" role="combobox" aria-autocomplete="list" aria-controls="search-filter-options" aria-expanded="false" autofocus placeholder="找一位侠客，一本武学，一个地方……" maxlength="200" aria-label="全局搜索">${iconButton('close-overlay', 'close', '关闭搜索')}</label><details class="search-tools"><summary>全部 7 种筛选与语法 · 保存搜索</summary><div class="row wrap">${act('search-save', '保存当前搜索', 'text-btn', '', 'star')}${act('search-run', '绿色物品', 'chip', '种类:物品 品质:绿')}${act('search-run', '未完成目标', 'chip', '种类:目标 状态:未完成')}</div><div id="global-filter-help"></div></details><div id="global-filter-suggestions" class="search-filter-suggestions"></div><div id="global-results" class="search-results"></div><div class="search-foot">搜索效果、任务、地点与本周目记录 · Esc 关闭</div></section>`,
  );
  rememberDrawer({
    type: 'search',
    query: value,
    personalAll: !!context?.personalAll,
    selection: context?.selection,
  });
  const input = document.querySelector('#global-search');
  input.value = value;
  showSearchResults(value);
  if (context) {
    document.querySelector('#global-results').scrollTop = context.scroll || 0;
    const selected = [...overlay.querySelectorAll('.search-result')].find(
      (result) =>
        result.dataset.action === context.selection?.action && result.dataset.id === context.selection?.id,
    );
    (selected || input).focus();
  } else {
    input.focus();
    input.select();
  }
}
function showSearchResults(value) {
  const results = overlay.querySelector('#global-results');
  if (!results) return;
  const search = currentDrawer?.type === 'search' ? currentDrawer : null;
  const changed = search && search.query !== value;
  const oldScroll = changed ? 0 : results.scrollTop;
  const focused = results.contains(document.activeElement) ? document.activeElement.dataset : null;
  if (changed) {
    search.personalAll = false;
    delete search.selection;
  }
  lastSearchQuery = value;
  if (search) search.query = value;
  const q = value.trim();
  const savedTasks =
    environment.saves.files.find((f) => f.name === environment.recent?.name)?.metadata?.quests || [];
  const statuses = new Map(savedTasks.map((task) => [task.id, task.status]));
  const docs = [
    ...catalog.entries.map((e) => ({
      ...e,
      name: e.title,
      searchKind: e.kind,
      title: e.title,
      sub: e.location + ' · 精选线索',
      action: 'detail',
      glyph: kindIcon(e.kind),
      group: 'guides',
    })),
    ...gameIndex.entries.map((e) => ({
      ...e,
      quality: qualityText.quality(e),
      title: e.name,
      sub: e.kind + ' · ' + e.type + ' · 本机图鉴',
      action: 'database-detail',
      glyph: { 物品: 'bag', 武学: 'sword', 人物: 'person', 配方: 'scroll' }[e.kind],
      group: 'database',
    })),
    ...gameIndex.world.quests.map((e) => ({
      ...e,
      kind: '任务',
      title: e.name,
      status: statuses.get(e.gameId) || '待核对',
      sub: '任务资料 · #' + e.gameId,
      action: 'world-quest',
      glyph: 'scroll',
      group: 'quests',
    })),
    ...gameIndex.world.maps.map((e) => ({
      ...e,
      kind: '地点',
      title: e.name,
      sub: '地点线索 · #' + e.gameId,
      action: 'world-place',
      glyph: 'map',
      group: 'places',
    })),
    ...profile().goals.map((g) => ({
      ...g,
      kind: '目标',
      name: g.title,
      status: goalDone(g) ? '已完成' : '未完成',
      sub: '我的目标 · ' + (goalDone(g) ? '已完成' : '未完成'),
      action: 'search-goal',
      glyph: 'bag',
      group: 'personal',
    })),
    ...(profile().craftPlans || []).map((p) => ({
      ...p,
      kind: '计划',
      title: p.name,
      description: p.list.map((line) => gameViews.byId(gameIndex, line.id)?.name).join(' '),
      sub: '制作计划 · ' + p.list.length + ' 种配方',
      action: 'craft-plan-open',
      glyph: 'leaf',
      group: 'personal',
    })),
    ...(environment.journey?.profileId === profile().id
      ? environment.journey.actions
          .filter((a) => !a.gameComplete && !a.userDone && !a.handled)
          .map((a) => ({
            id: a.id,
            kind: '行动',
            title: a.title,
            detail: a.detail,
            location: a.places.map((p) => p.name).join(' '),
            sub: '这一程做什么 · ' + (a.progress?.label || '待处理'),
            action: 'journey-focus',
            glyph: 'map',
            group: 'personal',
          }))
      : []),
    ...(profile().journalEntries || [])
      .slice()
      .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
      .map((e) => ({
        ...e,
        kind: '记录',
        title: e.title,
        detail: [e.body, ...e.tags, ...e.links.map((link) => link.label)].join(' '),
        location: e.links
          .filter((link) => link.type === 'place')
          .map((link) => link.label)
          .join(' '),
        sub: when(e.occurredAt) + ' · ' + e.body.slice(0, 80),
        action: 'journal-entry-open',
        glyph: 'feather',
        group: 'records',
      })),
    ...(profile().notes
      ? [
          {
            id: profile().id,
            kind: '笔记',
            title: '江湖随手记',
            detail: profile().notes,
            sub: '本周目的随手记',
            action: 'search-note',
            glyph: 'edit',
            group: 'personal',
          },
        ]
      : []),
  ];
  const values = Object.fromEntries(
    searchFilterFields.map((field) => [
      field.key,
      [
        ...new Set(
          [
            ...(field.key === 'quality' || field.key === 'status' || field.key === 'kind'
              ? field.examples
              : []),
            ...docs.flatMap((doc) =>
              field.key === 'kind'
                ? doc.searchKind || doc.kind || []
                : field.key === 'name'
                  ? doc.name || doc.title || []
                  : doc[field.key] || [],
            ),
          ].filter((value) => typeof value === 'string' && value.trim()),
        ),
      ],
    ]),
  );
  const input = overlay.querySelector('#global-search');
  const selectedSuggestion = !changed && searchSuggestions[searchSuggestionIndex]?.label;
  const focusedSuggestion =
    !changed && document.activeElement.matches('[data-action="search-filter-suggestion"]')
      ? searchSuggestions[Number(document.activeElement.dataset.id)]?.label
      : null;
  searchSuggestions = searchFilterSuggestions(value, input?.selectionStart ?? value.length, values);
  searchSuggestionIndex = searchSuggestions.length
    ? Math.max(
        0,
        searchSuggestions.findIndex((suggestion) => suggestion.label === selectedSuggestion),
      )
    : -1;
  renderSearchSuggestions();
  if (focusedSuggestion) {
    const index = searchSuggestions.findIndex((suggestion) => suggestion.label === focusedSuggestion);
    overlay
      .querySelector('[data-action="search-filter-suggestion"][data-id="' + index + '"]')
      ?.focus({ preventScroll: true });
  }
  const help = overlay.querySelector('#global-filter-help');
  if (help && !help.innerHTML) help.innerHTML = searchHelpViews.help(values);
  let matches, compareTitles;
  try {
    matches = compileSearch(q);
    compareTitles = compareSearchTitles(q);
  } catch (e) {
    results.innerHTML = notice(e.message, true);
    results.scrollTop = 0;
    return;
  }
  const all = q
    ? docs.filter(matches)
    : docs.filter((d) => d.group === 'personal' || d.group === 'guides' || d.group === 'records');
  const quotas = { personal: 8, records: 8, database: 12, guides: 7, quests: 5, places: 4 };
  const matchedRecords = all.filter((d) => d.group === 'records').map((d) => d.id);
  if (q) journalView.globalMatchedIds = matchedRecords;
  const personal = all.filter((d) => d.group === 'personal').sort(compareTitles);
  const list = [];
  if (search?.personalAll) list.push(...personal);
  else
    for (const group of ['personal', 'records', 'database', 'guides', 'quests', 'places'])
      list.push(
        ...all
          .filter((d) => d.group === group)
          .sort(compareTitles)
          .slice(0, quotas[group]),
      );
  const more = search?.personalAll
    ? '<div class="row wrap">' +
      act('search-personal-short', '返回快捷结果', 'text-btn', '', 'arrow') +
      '<span class="small muted">个人内容 ' +
      personal.length +
      ' 项 · 全部结果</span></div>'
    : '<div class="search-all-groups">' +
      (personal.length
        ? act('search-personal-all', '个人内容 ' + personal.length + ' 项 · 查看全部', 'text-btn')
        : '') +
      [
        ['records', '江湖记录'],
        ['guides', '精选线索'],
        ['database', '百物图鉴'],
        ['quests', '任务'],
        ['places', '地点'],
      ]
        .filter(() => q)
        .map(([id, label]) => {
          const count = all.filter((d) => d.group === id).length;
          return count
            ? '<button class="text-btn" data-action="search-all" data-id="' +
                id +
                '" data-query="' +
                esc(q) +
                '">' +
                label +
                ' ' +
                count +
                ' 项 · 查看全部</button>'
            : '';
        })
        .join('') +
      '</div>' +
      (q ? '' : searchHistory());
  results.innerHTML =
    more +
    (list.length
      ? list
          .map(
            (e) =>
              '<button class="search-result" data-action="' +
              e.action +
              '" data-id="' +
              esc(e.id) +
              '"><span class="result-icon">' +
              (e.action === 'database-detail' ? picture(e.id, 'search') : icon(e.glyph || 'book')) +
              '</span><span class="spacer"><strong>' +
              (e.action === 'database-detail' ? qualityText.name(e.id, e.title) : esc(e.title)) +
              '</strong><small>' +
              esc(e.sub + (e.action === 'database-detail' && e.quality ? ' · ' + e.quality + '色品质' : '')) +
              '</small></span>' +
              icon('chevron') +
              '</button>',
          )
          .join('')
      : empty('暂时没有匹配内容', '可以搜索效果、材料、任务说明、个人目标，或使用下方筛选示例。'));
  if (!changed && focused)
    [...results.querySelectorAll('[data-action]')]
      .find((result) => result.dataset.action === focused.action && result.dataset.id === focused.id)
      ?.focus({ preventScroll: true });
  results.scrollTop = oldScroll;
}
function searchHistory() {
  return [
    ['savedSearches', '保存的搜索'],
    ['recentSearches', '最近使用'],
  ]
    .map(([key, title]) =>
      profile()[key]?.length
        ? '<div class="search-history"><h3>' +
          title +
          '</h3>' +
          profile()
            [key].map(
              (q) =>
                '<div class="row"><button class="chip" data-action="search-run" data-id="' +
                esc(q) +
                '">' +
                esc(q) +
                '</button>' +
                (key === 'savedSearches' ? iconButton('search-forget', 'trash', '移除保存的搜索', q) : '') +
                '</div>',
            )
            .join('') +
          (key === 'recentSearches' ? act('search-history-clear', '清空最近使用', 'text-btn') : '') +
          '</div>'
        : '',
    )
    .join('');
}
async function refresh() {
  const token = ++refreshRequest;
  const next = await call('refresh');
  if (token !== refreshRequest) return;
  const discoverySourceChanged =
    recipeDiscoverySourceSignature(environment) !== recipeDiscoverySourceSignature(next);
  environment = next;
  if (discoverySourceChanged) invalidateRecipeDiscovery();
  render(true);
  if (route === 'recipe-discovery' && recipeDiscoveryNeedsRefresh) await refreshRecipeDiscovery();
  if (token !== refreshRequest) return;
  if (journeyDraft?.kind === 'gift' && document.querySelector('#journey-item-options'))
    loadGiftStock(journeyDraft);
  if (route === 'world' && worldView.referenceName === undefined) await loadWorldReference();
  const signature = (name) => next.saves.files.find((f) => f.name === name)?.hash;
  if (worldView.referenceName !== undefined) {
    const name = worldView.follow ? latestReference() : worldView.referenceName;
    if (name !== worldView.referenceName || signature(name) !== worldView.reference?.hash)
      await loadWorldReference();
  }
  if (
    materialView.referenceName !== undefined &&
    (materialView.result || route === 'materials') &&
    !materialView.loading
  ) {
    const name = materialView.follow ? latestReference() : materialView.referenceName;
    if (
      !materialView.result ||
      name !== materialView.referenceName ||
      signature(name) !== materialView.result.reference?.hash
    )
      await calculateMaterials();
  }
  if (referenceSaveName !== undefined || referenceFollow) {
    const name = referenceFollow ? latestReference() : referenceSaveName;
    if (name !== referenceSaveName || signature(name) !== referenceSave?.hash) {
      referenceSaveName = name;
      const profileId = profile().id;
      let ref;
      try {
        ref = name ? await call('saveDetails', name) : null;
      } catch {
        ref = null;
      }
      if (token !== refreshRequest || profileId !== profile().id) return;
      referenceSave = ref;
      if (currentDrawer?.type === 'database') {
        const e = gameViews.byId(gameIndex, currentDrawer.id);
        if (e?.kind === '配方') await showDatabaseDetail(e.id, currentDrawer.quantity || 1);
        if (e?.kind === '人物' || e?.kind === '物品') await showDatabaseDetail(e.id);
        const freshness = overlay.querySelector('.reference-freshness');
        if (freshness)
          freshness.textContent = name ? '已同步新的已保存进度 · ' + name : '参照存档不可读，请重新选择。';
      }
    }
  }
  if (
    currentDrawer?.type === 'database' &&
    gameViews.byId(gameIndex, currentDrawer.id)?.kind === '物品' &&
    currentDrawer.planningSignature !== planningIntentSignature()
  )
    await showDatabaseDetail(currentDrawer.id);
  if (currentDrawer?.type === 'search' && !composing) showSearchResults(currentDrawer.query);
}
async function handle(action, id, target, navigationFocused = false) {
  if (
    currentDrawer?.type === 'search' &&
    target?.classList.contains('search-result') &&
    lastSearchQuery.trim()
  ) {
    compileSearch(lastSearchQuery);
    await mutation({ type: 'search-remember', query: lastSearchQuery.trim() });
  }
  switch (action) {
    case 'journey-trash-open':
    case 'journey-trash-close':
      journeyTrashView.open = action.endsWith('-open');
      journeyTrashView.page = 1;
      closeOverlay();
      route = 'journey';
      render();
      break;
    case 'journey-trash-page':
      journeyTrashView.page = Math.max(1, Number(id) || 1);
      render(true);
      break;
    case 'historical-journey-trash-page': {
      const [profileId, page] = id.split('|'),
        view = historicalJourneyTrashViews.get(profileId) || {};
      historicalJourneyTrashViews.set(profileId, { ...view, page: Math.max(1, Number(page) || 1) });
      render(true);
      break;
    }
    case 'journey-trash-detail':
    case 'historical-journey-trash-detail': {
      const [profileId, trashId] = action.startsWith('historical-') ? id.split('|') : [profile().id, id];
      const p = action.startsWith('historical-')
        ? protectionView.history?.journal.profiles.find((p) => p.id === profileId)
        : profile();
      const row = p?.journeyTrash?.find((row) => row.id === trashId);
      if (!row) throw Error('这项已移除安排已变化，请重新核对');
      modal(
        action.startsWith('historical-') ? '历史已移除安排 · 只读' : '已移除安排的完整内容',
        p.name,
        journeyTrashViews.detail(row, journalIndex()),
        '',
      );
      break;
    }
    case 'journey-trash-restore-preview':
    case 'journey-trash-copy-goal-preview':
    case 'journey-trash-purge-preview': {
      const row = profile().journeyTrash?.find((row) => row.id === id);
      if (!row) throw Error('这项已移除安排已变化，请重新核对');
      const purge = action === 'journey-trash-purge-preview';
      const copyGoal = action === 'journey-trash-copy-goal-preview';
      const itinerary = !purge && row.kind === 'itinerary';
      if (copyGoal && row.kind !== 'goal') throw Error('请选择要另存的已移除行囊目标');
      journeyTrashConfirmation = {
        profileId: profile().id,
        row: structuredClone(row),
        type: purge ? 'journey-trash-purge' : copyGoal ? 'journey-trash-copy-goal' : 'journey-trash-restore',
        ...(itinerary ? { expectedItinerary: structuredClone(profile().journey?.itinerary ?? null) } : {}),
      };
      modal(
        purge
          ? '永久清除这项个人安排？'
          : copyGoal
            ? '按原文字另存为独立目标？'
            : itinerary
              ? '找回这一程？'
              : '找回这项个人安排？',
        purge
          ? '清除后无法从这里找回。已有导出副本仍保留；其他安排和后续内容保持。'
          : copyGoal
            ? '另存全文、原完成状态与置顶设置，作为新的手动目标；不再关联原资料或自动跟踪。原完整副本仍保留，当前其他目标保持。'
            : itinerary
              ? '确认后仅替换本次行程选择。当前行程先保留为可找回副本；个人已处理按当前状态保留，后来的独立安排与手记继续保留。'
              : '只找回原完整内容。当前库存用途会重新核对，后来的记录与游戏存档保留。',
        journeyTrashViews.detail(row, journalIndex()) +
          (itinerary
            ? journeyTrashViews.itineraryDetail(journeyTrashConfirmation.expectedItinerary, journalIndex(), {
                heading: '当前待替换行程 · 将先保留完整副本',
              })
            : ''),
        act(
          'journey-trash-confirm',
          purge
            ? '永久清除这项安排'
            : copyGoal
              ? '另存为独立目标并保留原副本'
              : itinerary
                ? '保留当前副本并找回这一程'
                : '找回这项安排',
          purge ? 'btn danger' : 'btn primary',
          id,
        ),
      );
      break;
    }
    case 'journey-trash-confirm': {
      const preview = journeyTrashConfirmation;
      if (
        !preview ||
        preview.profileId !== profile().id ||
        !['journey-trash-restore', 'journey-trash-purge', 'journey-trash-copy-goal'].includes(preview.type) ||
        preview.row.id !== id
      )
        throw Error('安排或周目已变化，请重新核对');
      await mutation({
        type: preview.type,
        profileId: preview.profileId,
        id,
        expectedTrash: preview.row,
        ...(preview.expectedItinerary !== undefined ? { expectedItinerary: preview.expectedItinerary } : {}),
      });
      journeyTrashConfirmation = null;
      closeOverlay();
      await refresh();
      toast(
        preview.type === 'journey-trash-restore'
          ? preview.row.kind === 'itinerary'
            ? '这一程已找回，刚才的行程副本与后续内容保留；个人已处理沿用当前状态'
            : '所选安排已找回，后续内容保留；请核对当前物资用途'
          : preview.type === 'journey-trash-copy-goal'
            ? '已另存为独立目标，原完整副本与其他目标保留'
            : '所选安排已永久清除',
      );
      break;
    }
    case 'intent-drafts':
      captureIntentDrafts();
      modal(
        '继续未完成的安排',
        '这里的编辑还没有加入正式安排。',
        intentDraftViews.panel(availableIntentDrafts(), gameIndex) || '<p>当前周目没有未完成安排。</p>',
        '',
      );
      break;
    case 'intent-draft-resume': {
      const row = availableIntentDrafts().find((draft) => draft.id === id);
      if (!row) throw Error('草稿已变化，请重新核对');
      await openIntentDraft(row);
      break;
    }
    case 'historical-intent-draft-open': {
      const [profileId, draftId] = id.split('|');
      const selected = protectionView.history?.journal.profiles.find((p) => p.id === profileId);
      const row = selected?.intentDrafts?.find((draft) => draft.id === draftId);
      if (!row) throw Error('历史草稿已变化，请重新打开档案');
      modal('历史未完成安排 · 只读', selected.name, intentDraftViews.detail(row, gameIndex), '');
      break;
    }
    case 'intent-draft-copy': {
      const editor = activeIntentEditor;
      if (
        !editor ||
        editor.id !== id ||
        editor.profileId !== profile().id ||
        !['goal', 'journey-todo', 'journey-gift', 'craft-plan'].includes(editor.kind)
      )
        throw Error('请打开能另存的个人草稿');
      captureIntentEditor(editor, true);
      const pending = pendingIntentDrafts.get(id),
        values = readIntentValues(editor.kind, editor.scope),
        newId = crypto.randomUUID();
      const copiedTargetId =
        editor.kind === 'goal' && (itemGoal(editor.expectedTarget) || Object.hasOwn(values, 'quantity'))
          ? editor.targetId
          : '';
      const originalDraft = profile().intentDrafts?.find((row) => row.id === id);
      if (copiedTargetId && !editor.expectedTarget)
        throw Error('原物品目标已变化或删除，请先恢复原目标；草稿仍保留');
      if (copiedTargetId && originalDraft) {
        // Reopening an old draft previews the current target. Preserve its original
        // Store fingerprint until the user explicitly rechecks that target.
        const ordered = (value) =>
          Array.isArray(value)
            ? value.map(ordered)
            : value && typeof value === 'object'
              ? Object.fromEntries(
                  Object.keys(value)
                    .sort()
                    .map((key) => [key, ordered(value[key])]),
                )
              : value;
        const digest = await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(JSON.stringify(ordered(editor.expectedTarget))),
        );
        const fingerprint = [...new Uint8Array(digest)]
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('');
        if (fingerprint !== originalDraft.targetFingerprint)
          throw Error('原物品目标已变化或删除，请先重新核对；草稿仍保留');
      }
      if (
        copiedTargetId &&
        JSON.stringify(intentTarget(profile(), editor.kind, copiedTargetId, editor.context)) !==
          JSON.stringify(editor.expectedTarget)
      )
        throw Error('原物品目标已变化或删除，请先重新核对；草稿仍保留');
      pendingIntentDrafts.set(newId, {
        type: 'intent-draft-put',
        id: newId,
        kind: editor.kind,
        targetId: copiedTargetId,
        context: structuredClone(editor.context),
        values,
        expectedRevision: 0,
        expectedTarget: copiedTargetId ? structuredClone(editor.expectedTarget) : null,
        profileId: editor.profileId,
        signature: JSON.stringify(values),
        capturedAt: new Date().toISOString(),
      });
      await flushIntentDrafts(newId);
      editor.committed = true;
      if (pendingIntentDrafts.get(id) === pending) pendingIntentDrafts.delete(id);
      const row = profile().intentDrafts.find((draft) => draft.id === newId);
      await openIntentDraft(row);
      toast('这些编辑已另存为新草稿，原正式安排与磁盘草稿保留');
      break;
    }
    case 'intent-draft-discard': {
      captureIntentDrafts();
      await intentDraftQueue.catch(() => {});
      const pending = pendingIntentDrafts.get(id),
        stored = profile().intentDrafts?.find((row) => row.id === id);
      if (!pending && !stored) {
        closeOverlay();
        break;
      }
      const localOnly = !!pending && (!stored || stored.revision !== (intentDraftVersions.get(id) || 0));
      intentDraftConfirmation = {
        type: 'discard',
        id,
        profileId: profile().id,
        pending,
        row: stored && structuredClone(stored),
        localOnly,
      };
      modal(
        '放弃这份未完成编辑？',
        localOnly
          ? '仅放弃当前窗口未成功暂存的编辑，已有磁盘草稿与正式安排保留。'
          : '只移除这份草稿，原正式安排仍保留。',
        intentDraftViews.detail(
          availableIntentDrafts().find((row) => row.id === id),
          gameIndex,
        ),
        act('intent-draft-discard-confirm', localOnly ? '放弃本窗口编辑' : '放弃这份草稿', 'btn danger', id),
      );
      break;
    }
    case 'intent-draft-discard-confirm': {
      const preview = intentDraftConfirmation;
      if (!preview || preview.type !== 'discard' || preview.id !== id || preview.profileId !== profile().id)
        throw Error('草稿或周目已变化，请重新核对');
      await intentDraftQueue.catch(() => {});
      if (preview.row && !preview.localOnly)
        await mutation({
          type: 'intent-draft-remove',
          id,
          expectedDraft: preview.row,
          profileId: preview.profileId,
        });
      if (pendingIntentDrafts.get(id) === preview.pending) pendingIntentDrafts.delete(id);
      for (const [key, editor] of itineraryIntentEditors)
        if (editor.id === id) {
          editor.committed = true;
          itineraryFormDrafts.delete(key);
          itineraryIntentEditors.delete(key);
        }
      intentDraftConfirmation = null;
      closeOverlay();
      render(true);
      toast(preview.localOnly ? '本窗口编辑已放弃，磁盘草稿保留' : '所选草稿已放弃');
      break;
    }
    case 'intent-draft-recheck': {
      captureIntentDrafts();
      await flushIntentDrafts(id);
      const row = profile().intentDrafts?.find((draft) => draft.id === id);
      if (!row) throw Error('请先保留这份草稿');
      const current = structuredClone(intentTarget(profile(), row.kind, row.targetId, row.context));
      intentDraftConfirmation = {
        type: 'rebase',
        id,
        profileId: profile().id,
        row: structuredClone(row),
        current,
      };
      const currentName =
        current?.title ||
        current?.name ||
        current?.note ||
        current?.step?.title ||
        (current?.npcId ? '当前赠礼意图' : current ? '当前安排' : '原安排已不存在或尚未新建');
      modal(
        '重新核对原安排',
        row.kind === 'goal' && Object.hasOwn(row.values, 'quantity')
          ? '确认后以现在的原物品目标为参照，保留数量与文字；仍需点击正式保存。原目标已移除时，请先从已移除的个人安排恢复原目标。'
          : '确认后以现在的原安排为参照，保留草稿文字；仍需点击正式保存。原安排已删除时，个人待办、赠礼、目标和制作计划可另存为新草稿。',
        `<h3>${esc(currentName)}</h3><p class="preserve-text">${esc(current?.detail || current?.note || '')}</p>${intentDraftViews.detail(row, gameIndex)}`,
        act('intent-draft-recheck-confirm', '以当前安排重新核对', 'btn primary', id),
      );
      break;
    }
    case 'intent-draft-recheck-confirm': {
      const preview = intentDraftConfirmation;
      if (!preview || preview.type !== 'rebase' || preview.id !== id || preview.profileId !== profile().id)
        throw Error('核对内容已变化，请重新打开');
      await mutation({
        type: 'intent-draft-rebase',
        id,
        expectedDraft: preview.row,
        expectedTarget: preview.current,
        profileId: preview.profileId,
      });
      intentDraftConfirmation = null;
      const row = profile().intentDrafts.find((draft) => draft.id === id);
      if (intentFieldId(row)) itineraryIntentEditors.delete(intentEditorKey(intentFieldId(row)));
      await openIntentDraft(row);
      toast('已重新核对，草稿仍未正式提交');
      break;
    }
    case 'note-history':
      await saveNote();
      showNoteHistory();
      break;
    case 'note-restore-preview': {
      await saveNote();
      const row = profile().noteRevisions?.find((row) => row.id === id);
      if (!row) throw Error('旧内容已变化，请重新打开随手记旧内容');
      noteRestoreConfirmation = {
        profileId: profile().id,
        id,
        expectedValue: profile().notes,
        returnContext: {
          id,
          scroll: overlay.querySelector('.modal')?.scrollTop || 0,
          opened: [...overlay.querySelectorAll('[data-note-revision][open]')].map(
            (row) => row.dataset.noteRevision,
          ),
        },
      };
      modal(
        '将旧内容放回随手记？',
        '确认后替换当前随手记；当前非空文字会先保留为一份旧内容。目标、逐条记录和游戏进度继续沿用。',
        `<section data-note-restore-preview><h3>将找回的完整文字</h3><p class="preserve-text">${esc(row.body)}</p><details><summary>当前随手记 · ${profile().notes.length} 字</summary><p class="preserve-text">${esc(profile().notes) || '当前为空'}</p></details></section>`,
        act('note-restore-confirm', '确认放回随手记', 'btn primary', id, 'refresh'),
      );
      break;
    }
    case 'note-restore-confirm': {
      const confirmation = noteRestoreConfirmation;
      if (!confirmation || confirmation.profileId !== profile().id || confirmation.id !== id)
        throw Error('周目或旧内容已变化，请重新预览');
      await mutation({
        type: 'note-restore',
        profileId: confirmation.profileId,
        id: confirmation.id,
        expectedValue: confirmation.expectedValue,
      });
      noteRestoreConfirmation = null;
      closeOverlay();
      render(true);
      toast('旧内容已放回随手记；替换前的非空文字仍可找回');
      break;
    }
    case 'journal-revisions-open':
    case 'historical-journal-revisions-open':
    case 'journal-revisions-entry':
    case 'historical-journal-revisions-entry':
    case 'journal-revisions-close':
    case 'historical-journal-revisions-close': {
      const historical = action.startsWith('historical-'),
        view = historical ? historyJournalView : journalView;
      const selected = historical ? historyJournalProfile() : profile();
      if (!selected) throw Error('周目已变化，请重新打开旧版本');
      view.revisions = !action.endsWith('-close');
      view.trash = false;
      view.revisionEntryId = action.endsWith('-entry') ? id : '';
      view.revisionPage = 1;
      view.revisionQuery = '';
      closeOverlay();
      render();
      break;
    }
    case 'journal-revisions-page':
    case 'historical-journal-revisions-page': {
      const view = action.startsWith('historical-') ? historyJournalView : journalView;
      view.revisionPage = Math.max(1, Number(id) || 1);
      render(true);
      break;
    }
    case 'journal-revision-detail':
    case 'historical-journal-revision-detail': {
      const historical = action.startsWith('historical-');
      const selected = historical ? historyJournalProfile() : profile();
      if (!selected?.journalRevisions?.some((row) => row.id === id)) throw Error('旧版本已变化，请重新打开');
      showOverlay(eventJournalViews.revisionDetail(selected, id, historical), true);
      break;
    }
    case 'journal-revision-restore-preview':
    case 'journal-revision-purge-preview': {
      const row = profile().journalRevisions?.find((row) => row.id === id);
      if (!row) throw Error('旧版本已变化，请重新打开');
      const purge = action === 'journal-revision-purge-preview';
      journalRevisionConfirmation = {
        profileId: profile().id,
        row: structuredClone(row),
        entry: structuredClone(profile().journalEntries?.find((entry) => entry.id === row.entry.id) || null),
        type: purge ? 'journal-revision-purge' : 'journal-revision-restore',
      };
      modal(
        purge ? '永久清除这个旧版本？' : '将旧版本另存为新记录？',
        purge
          ? '只清除下面这个旧版本，无法再从旧版本列表恢复。原记录、其他旧版本、草稿与已导出备份保留。'
          : '将下面的完整旧内容保存为一条独立新记录。原记录、后来新增内容、目标、行程与游戏存档保留。',
        eventJournalViews.revisionContent(row),
        act(
          'journal-revision-confirm',
          purge ? '永久清除这个旧版本' : '另存为新记录',
          purge ? 'btn danger' : 'btn primary',
          id,
        ),
      );
      break;
    }
    case 'journal-revision-confirm': {
      const confirmation = journalRevisionConfirmation;
      if (!confirmation || confirmation.profileId !== profile().id || confirmation.row.id !== id)
        throw Error('旧版本或周目已变化，请重新核对');
      await mutation({
        type: confirmation.type,
        id,
        profileId: confirmation.profileId,
        expectedRevision: confirmation.row,
        expectedEntry: confirmation.entry,
      });
      journalRevisionConfirmation = null;
      closeOverlay();
      render(true);
      toast(
        confirmation.type === 'journal-revision-restore'
          ? '旧版本已另存为新记录，原记录与后来内容保留'
          : '这个旧版本已永久清除',
      );
      break;
    }
    case 'journal-trash-open':
    case 'historical-journal-trash-open':
    case 'journal-trash-close':
    case 'historical-journal-trash-close': {
      const historical = action.startsWith('historical-'),
        view = historical ? historyJournalView : journalView;
      if (historical && !historyJournalProfile()) throw Error('历史周目已变化，请重新打开');
      view.trash = action.endsWith('-open');
      view.revisions = false;
      view.trashPage = 1;
      closeOverlay();
      render();
      break;
    }
    case 'journal-trash-page':
    case 'historical-journal-trash-page': {
      const view = action.startsWith('historical-') ? historyJournalView : journalView;
      view.trashPage = Math.max(1, Number(id) || 1);
      render(true);
      break;
    }
    case 'journal-trash-detail':
    case 'historical-journal-trash-detail': {
      const historical = action.startsWith('historical-'),
        selected = historical ? historyJournalProfile() : profile();
      if (!selected?.journalTrash?.some((row) => row.entry.id === id))
        throw Error('这条已删除记录已变化，请重新核对');
      showOverlay(eventJournalViews.detail(selected, id, { readOnly: true, trash: true, historical }), true);
      break;
    }
    case 'journal-trash-restore-preview':
    case 'journal-trash-purge-preview': {
      const row = profile().journalTrash?.find((row) => row.entry.id === id);
      if (!row) throw Error('这条已删除记录已变化，请重新核对');
      const purge = action === 'journal-trash-purge-preview';
      journalTrashConfirmation = {
        profileId: profile().id,
        row: structuredClone(row),
        type: purge ? 'journal-trash-purge' : 'journal-trash-restore',
      };
      modal(
        purge ? '永久清除这条记录？' : '恢复这条记录？',
        purge
          ? '清除后无法从已删除记录中恢复。已导出的备份仍保留；其他记录、草稿和目标保持。'
          : '找回这一条记录，保留后来写的内容；目标完成、行程与游戏存档保持。',
        `<p>${esc(row.entry.title)}</p><p class="preserve-text">${esc(row.entry.body)}</p>`,
        act(
          'journal-trash-confirm',
          purge ? '永久清除这条记录' : '恢复这条记录',
          purge ? 'btn danger' : 'btn primary',
          id,
        ),
      );
      break;
    }
    case 'journal-trash-confirm': {
      const draft = journalTrashConfirmation;
      if (!draft || draft.profileId !== profile().id || draft.row.entry.id !== id)
        throw Error('记录或周目已变化，请重新核对');
      await mutation({
        type: draft.type,
        profileId: draft.profileId,
        ids: [id],
        expectedEntries: [draft.row],
      });
      journalTrashConfirmation = null;
      closeOverlay();
      render(true);
      toast(
        draft.type === 'journal-trash-restore' ? '这条记录已恢复，后来写的内容保留' : '这条记录已永久清除',
      );
      break;
    }
    case 'search-filter-suggestion':
      applySearchSuggestion(searchSuggestions[Number(id)]);
      break;
    case 'search-filter-insert': {
      const input = overlay.querySelector('#global-search');
      if (input)
        applySearchSuggestion(
          insertSearchFilter(input.value, input.selectionStart ?? input.value.length, id),
        );
      break;
    }
    case 'journal-drafts':
      closeOverlay();
      route = 'journal';
      render();
      break;
    case 'journal-draft-resume': {
      const draft = availableJournalDrafts().find((row) => row.id === id);
      if (!draft) throw Error('草稿已不存在，请刷新后核对');
      const entry = profile().journalEntries?.find((row) => row.id === draft.entryId);
      openJournalEditor(entry || null, draft);
      break;
    }
    case 'journal-draft-discard': {
      captureJournalDraft();
      const draftId = id || document.querySelector('#journal-entry-form')?.dataset.draftId;
      const draft = availableJournalDrafts().find((row) => row.id === draftId);
      if (!draft) {
        closeOverlay();
        break;
      }
      modal(
        '放弃这份记录草稿？',
        '只移除这份未完成的编辑，原来的正式记录仍保留。',
        '<p>' + esc(draft.title || '未命名草稿') + '</p>',
        act('journal-draft-discard-confirm', '放弃这份草稿', 'btn danger', draftId),
      );
      break;
    }
    case 'journal-draft-discard-confirm': {
      await journalDraftQueue.catch(() => {});
      const pending = pendingJournalDrafts.get(id);
      const existing = profile().journalDrafts?.find((draft) => draft.id === id);
      if (existing)
        await mutation({
          type: 'journal-draft-remove',
          id,
          revision: journalDraftVersions.get(id) ?? existing.revision,
        });
      if (pendingJournalDrafts.get(id) === pending) pendingJournalDrafts.delete(id);
      journalDraftVersions.delete(id);
      journalDraftSaved.delete(id);
      closeOverlay();
      render();
      toast('所选草稿已放弃');
      break;
    }
    case 'journal-draft-copy': {
      captureJournalDraft();
      await journalDraftQueue.catch(() => {});
      const form = document.querySelector('#journal-entry-form');
      if (!form) throw Error('请先打开要另存的草稿');
      const original = eventJournalViews.readDraft(form),
        newId = crypto.randomUUID();
      const copy = {
        ...original,
        id: newId,
        revision: 0,
        snapshotMode: original.snapshotMode === 'keep' ? 'none' : original.snapshotMode,
      };
      delete copy.entryId;
      delete copy.entryUpdatedAt;
      delete copy.entrySnapshot;
      if (profile().journalDrafts?.some((draft) => draft.id === original.id)) copy.sourceId = original.id;
      await mutation(copy);
      pendingJournalDrafts.delete(original.id);
      form.dataset.committed = 'true';
      const draft = profile().journalDrafts.find((row) => row.id === newId);
      openJournalEditor(null, draft);
      toast('已另存新草稿，原记录和原草稿保留');
      break;
    }
    case 'journal-entry-new':
      await saveNote();
      openJournalEditor();
      break;
    case 'journal-entry-open': {
      closeOverlay();
      route = 'journal';
      render();
      showOverlay(eventJournalViews.detail(profile(), id), true);
      lastFocus =
        root.querySelector('[data-action="journal-entry-open"][data-id="' + CSS.escape(id) + '"]') ||
        root.querySelector('.nav-btn.active, .compact-tab.active');
      break;
    }
    case 'journal-entry-edit': {
      const entry = profile().journalEntries?.find((e) => e.id === id);
      if (!entry || entry.kind !== 'manual') throw Error('这条手写记录已不存在');
      openJournalEditor(entry);
      break;
    }
    case 'journal-entry-save': {
      const form = document.querySelector('#journal-entry-form');
      if (!form) throw Error('请重新打开记录编辑');
      if (!form.reportValidity()) break;
      const intent = eventJournalViews.readForm(form);
      captureJournalDraft(true);
      form.dataset.submitting = 'true';
      const controls = [...overlay.querySelectorAll('input,select,textarea,button')].map((control) => [
        control,
        control.disabled,
      ]);
      for (const [control] of controls) control.disabled = true;
      try {
        await flushJournalDrafts();
        await mutation({
          type: 'journal-draft-commit',
          id: form.dataset.draftId,
          revision: journalDraftVersions.get(form.dataset.draftId) ?? Number(form.dataset.draftRevision),
          occurredAt: intent.occurredAt,
          profileId: form.dataset.profileId,
        });
        form.dataset.committed = 'true';
      } finally {
        delete form.dataset.submitting;
        for (const [control, disabled] of controls) control.disabled = disabled;
      }
      journalDraftSaved.delete(form.dataset.draftId);
      journalDraftVersions.delete(form.dataset.draftId);
      closeOverlay();
      route = 'journal';
      render();
      toast('江湖记录已保存');
      break;
    }
    case 'journal-entry-remove': {
      const entry = profile().journalEntries?.find((e) => e.id === id);
      if (!entry) throw Error('这条记录已不存在');
      const reading = overlay.querySelector('.drawer-body[data-journal-id]');
      journalRemoveDraft = {
        mode: 'single',
        profileId: profile().id,
        id,
        entry: structuredClone(entry),
        returnToRecord: reading?.dataset.journalId === id,
        scroll: reading?.scrollTop || 0,
      };
      modal(
        '删除这条记录？',
        '移入已删除记录，可逐条恢复；目标、行程和游戏存档保持。',
        '<p>' + esc(entry.title) + '</p>',
        act('journal-entry-remove-confirm', '删除这条记录', 'btn danger', id),
      );
      break;
    }
    case 'journal-entry-remove-confirm': {
      const draft = journalRemoveDraft;
      if (!draft || draft.mode !== 'single' || draft.id !== id || draft.profileId !== profile().id)
        throw Error('记录或周目已变化，请关闭确认并重新核对');
      await mutation({
        type: 'journal-entry-remove',
        id: draft.id,
        expectedEntry: draft.entry,
        profileId: draft.profileId,
      });
      journalRemoveDraft = null;
      closeOverlay();
      render();
      break;
    }
    case 'journal-export':
      await handle('export');
      break;
    case 'journal-remove-filtered': {
      const ids = eventJournalViews.query(profile(), journalView, journalIndex()).matchedIds;
      if (!ids.length) break;
      const entries = profile().journalEntries.filter((e) => ids.includes(e.id));
      journalRemoveDraft = {
        mode: 'batch',
        profileId: profile().id,
        ids,
        entries: structuredClone(entries),
        updated: entries.map((e) => [e.id, e.updatedAt]),
      };
      modal(
        '删除筛选出的 ' + ids.length + ' 条记录？',
        '下面所选记录会移入已删除记录，可逐条恢复；目标和行程状态保持。',
        '<ul>' +
          entries
            .slice(0, 20)
            .map((e) => '<li>' + esc(e.title) + ' · ' + when(e.occurredAt) + '</li>')
            .join('') +
          '</ul>' +
          (entries.length > 20 ? '<p>另有 ' + (entries.length - 20) + ' 条，范围为当前筛选结果。</p>' : ''),
        act('journal-remove-filtered-confirm', '删除这 ' + ids.length + ' 条记录', 'btn danger'),
      );
      break;
    }
    case 'journal-remove-filtered-confirm': {
      const draft = journalRemoveDraft;
      if (
        !draft ||
        draft.mode !== 'batch' ||
        draft.profileId !== profile().id ||
        draft.updated.some(
          ([id, time]) => profile().journalEntries?.find((e) => e.id === id)?.updatedAt !== time,
        )
      )
        throw Error('所选记录或周目已变化，请重新核对筛选结果');
      await mutation({
        type: 'journal-entries-remove',
        ids: draft.ids,
        expectedEntries: draft.entries,
        profileId: draft.profileId,
      });
      journalRemoveDraft = null;
      closeOverlay();
      render();
      toast('所选记录已移入已删除记录，可以逐条恢复');
      break;
    }
    case 'journal-reference-page': {
      const input = document.querySelector('#journal-reference-query');
      const results = document.querySelector('#journal-reference-results');
      if (!input || !results) break;
      results.innerHTML = eventJournalViews.referenceResults(
        profile(),
        journalIndex(),
        input.value,
        Number(id),
      );
      results.querySelector('[data-reference-page-heading]')?.focus({ preventScroll: true });
      break;
    }
    case 'journal-reference-remove':
    case 'journal-reference-add': {
      const input = document.querySelector('#journal-links');
      if (!input) break;
      const links = input.value
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (action === 'journal-reference-add' && !links.includes(id)) links.push(id);
      else if (action === 'journal-reference-remove' && links.includes(id))
        links.splice(links.indexOf(id), 1);
      if (links.length > 8) throw Error('每条记录最多关联 8 项');
      input.value = links.join('\n');
      const form = document.querySelector('#journal-entry-form'),
        entry = profile().journalEntries?.find((e) => e.id === form?.dataset.entryId);
      document.querySelector('#journal-selected-references').innerHTML = eventJournalViews.selectedReferences(
        profile(),
        journalIndex(),
        links,
        entry,
      );
      captureJournalDraft();
      break;
    }
    case 'historical-journal-filter':
    case 'journal-filter': {
      const historical = action.startsWith('historical-'),
        view = historical ? historyJournalView : journalView;
      if (historical && !historyJournalProfile()) throw Error('历史周目已变化，请重新打开');
      const form = document.querySelector(
        historical ? '#historical-journal-filter-form' : '#journal-filter-form',
      );
      if (!form) break;
      const values = new FormData(form);
      for (const key of ['query', 'from', 'to', 'kind', 'tag'])
        view[key] = String(values.get('journal-' + key) || '');
      view.page = 1;
      render(true);
      break;
    }
    case 'historical-journal-filter-clear':
      historyJournalView = { query: '', from: '', to: '', kind: '', tag: '', page: 1 };
      render();
      break;
    case 'historical-journal-tag-filter':
      historyJournalView = { query: '', from: '', to: '', kind: '', tag: id, page: 1 };
      render();
      break;
    case 'historical-journal-page':
      historyJournalView.page = Math.max(1, Number(id) || 1);
      render(true);
      break;
    case 'protection-journal-profile':
      if (!protectionView.history?.journal.profiles.some((p) => p.id === id)) throw Error('历史周目已不存在');
      protectionView.journalProfileId = id;
      historyJournalView = { query: '', from: '', to: '', kind: '', tag: '', page: 1 };
      render();
      break;
    case 'historical-journal-entry-open': {
      const p = historyJournalProfile();
      if (!p) throw Error('请重新选择历史周目');
      showOverlay(eventJournalViews.detail(p, id, { readOnly: true }), true);
      break;
    }
    case 'journal-filter-clear':
      journalView = { query: '', from: '', to: '', kind: '', tag: '', page: 1 };
      render();
      break;
    case 'journal-tag-filter':
      journalView = { query: '', from: '', to: '', kind: '', tag: id, page: 1 };
      render();
      break;
    case 'journal-page':
      journalView.page = Math.max(1, Number(id) || 1);
      render(true);
      break;
    case 'journal-link': {
      const at = id.indexOf(':'),
        type = id.slice(0, at),
        entity = id.slice(at + 1);
      const entry = profile()
        .journalEntries?.flatMap((e) => e.links)
        .find((link) => link.type === type && link.id === entity && !link.detached);
      if (!entry) throw Error('原关联已移除或不属于当前周目');
      if (type === 'database') await showDatabaseDetail(entity);
      else if (type === 'quest' || type === 'place') await showWorldDetail(entity, type);
      else if (type === 'guide') await handle('detail', entity);
      else {
        closeOverlay();
        route = type === 'goal' ? 'goals' : type === 'craft-plan' ? 'materials' : 'journey';
        render();
      }
      break;
    }
    case 'search-personal-all':
    case 'search-personal-short':
      if (currentDrawer?.type === 'search') {
        currentDrawer.personalAll = action === 'search-personal-all';
        overlay.querySelector('#global-results').scrollTop = 0;
        showSearchResults(currentDrawer.query);
        (overlay.querySelector('.search-result') || overlay.querySelector('#global-search'))?.focus();
      }
      break;
    case 'search-all': {
      const value = target.dataset.query || query;
      closeOverlay();
      if (id === 'records') {
        route = 'journal';
        journalView = {
          query: '',
          from: '',
          to: '',
          kind: '',
          tag: '',
          page: 1,
          globalQuery: value,
          ids: journalView.globalMatchedIds || [],
        };
      } else if (id === 'guides') {
        route = 'library';
        kind = '全部';
        query = value;
      } else if (id === 'database') {
        route = 'database';
        databaseKind = '全部';
        databaseType = '全部';
        databasePage = 0;
        query = value;
      } else {
        route = 'world';
        worldView.kind = id === 'places' ? 'places' : 'quests';
        worldView.query = value;
        worldView.roots = false;
        worldView.status = 'all';
        worldView.page = 0;
        await loadWorldReference();
      }
      render();
      break;
    }
    case 'library-search-all':
      searchModal();
      document.querySelector('#global-search').value = query;
      showSearchResults(query);
      break;
    case 'help':
      showOverlay(
        `<section class="drawer" role="dialog" aria-modal="true" aria-label="手札使用说明"><div class="drawer-head"><span class="small muted">从这里开始</span>${iconButton('close-overlay', 'close', '关闭使用说明')}</div><div class="drawer-body"><h1>手札使用说明</h1><p class="preserve-text help-copy">${esc(await call('help'))}</p></div></section>`,
        true,
      );
      break;
    case 'save-slot':
      saveSlotModal();
      break;
    case 'save-slot-save':
      {
        const value = document.querySelector('#save-slot-select').value;
        await mutation({
          type: 'save-slot',
          value: ['@none', '@latest'].includes(value) ? '' : value,
          mode: value === '@none' ? 'none' : value === '@latest' ? 'latest' : 'slot',
        });
      }
      referenceSaveName = undefined;
      referenceSave = null;
      await refresh();
      closeOverlay();
      toast('已保存这个周目的回顾选择');
      break;
    case 'drawer-back': {
      const view = drawerHistory.pop();
      if (!view) break;
      currentDrawer = null;
      if (view.type === 'database') {
        referenceSaveName = view.referenceName;
        referenceFollow = view.follow;
        await showDatabaseDetail(view.id, view.quantity || 1, view.giftPage);
      } else if (view.type === 'search') searchModal(view);
      else if (view.type === 'guide') showDetail(view.id);
      else if (view.type === 'backup') await inspectBackupPreview(view.data.id);
      else if (view.type === 'timeline') {
        rememberDrawer(view);
        showOverlay(timelineViews.preview(view.data), true);
      } else if (view.type === 'save') {
        selectedSave = view.data;
        rememberDrawer(view);
        showOverlay(gameViews.saveDetail(view.data, gameIndex), true);
      } else if (view.type === 'comparison') showComparison('', view.data);
      else if (view.type === 'world-quest' || view.type === 'world-place') {
        worldView.referenceName = view.referenceName;
        worldView.follow = view.follow;
        worldView.reference = view.reference;
        worldView.error = view.error || '';
        await showWorldDetail(view.id, view.type === 'world-quest' ? 'quest' : 'place');
      }
      break;
    }
    case 'navigate': {
      if (currentDrawer?.type === 'backup') closeOverlay();
      else ++backupPreviewRequest;
      if (id !== 'archives') ++protectionRequest;
      await saveNote();
      const returnToNavigation =
        navigationFocused &&
        (document.activeElement === target || document.activeElement === document.body) &&
        !root.inert;
      route = id;
      query = '';
      filter = 'current';
      render(false, returnToNavigation ? id : null);
      if (id === 'world' && worldView.referenceName === undefined) await loadWorldReference();
      if (id === 'materials') {
        materialView.referenceName ??= defaultReference();
        render();
        if (!materialView.result) await calculateMaterials();
      }
      if (id === 'journey') await refresh();
      break;
    }
    case 'journey-refresh':
      await refresh();
      break;
    case 'recipe-discovery-open':
      closeOverlay();
      route = 'recipe-discovery';
      render();
      await refreshRecipeDiscovery();
      break;
    case 'recipe-discovery-refresh':
      await refreshRecipeDiscovery();
      break;
    case 'recipe-discovery-view':
      await refreshRecipeDiscovery({ view: id, page: 1 });
      break;
    case 'recipe-discovery-page':
      await refreshRecipeDiscovery({ page: Number(id) });
      break;
    case 'recipe-discovery-add': {
      const view = recipeDiscoveryView;
      if (view.busy) break;
      const input = target
        .closest('[data-recipe-discovery-id]')
        ?.querySelector('[data-recipe-discovery-quantity]');
      if (!input?.checkValidity()) {
        input?.reportValidity();
        throw Error('加入次数须为 1 至 999 的整数');
      }
      const quantity = Number(input.value);
      const discovery = { scopeToken: target.dataset.discoveryScope, recipeId: id, quantity };
      view.adding = true;
      view.busy = true;
      render(true);
      try {
        if (view.targetPlanId) {
          const plan = profile().craftPlans?.find((p) => p.id === view.targetPlanId);
          if (!plan) throw Error('所选制作计划已不存在，请重新选择');
          const editing = plan.id === profile().activeCraftPlanId;
          const list = structuredClone(editing ? profile().craftList || [] : plan.list);
          const old = list.find((line) => line.id === id);
          if (old) old.quantity += quantity;
          else list.push({ id, quantity });
          await mutation({
            type: 'craft-plan-save',
            id: plan.id,
            name: plan.name,
            list,
            choices: editing ? profile().craftChoices || {} : plan.choices || {},
            reserved: plan.reserved !== false,
            discovery,
          });
        } else {
          const old = profile().craftList?.find((line) => line.id === id)?.quantity || 0;
          await mutation({ type: 'craft-set', id, quantity: old + quantity, discovery });
        }
        await refresh();
        await refreshRecipeDiscovery();
        toast('配方已加入计划，余料与全部用途已重新核对');
      } catch (e) {
        view.error = e.message;
        view.busy = false;
        // The old source remains labelled for inspection; a new successful
        // query is required before another addition can use its scope.
        if (view.result) view.result = { ...view.result, scopeToken: null };
        render(true);
      } finally {
        view.adding = false;
        view.busy = !!view.reading;
        if (view === recipeDiscoveryView) render(true);
      }
      break;
    }
    case 'journey-place-filter':
      journeyView.place = id || '';
      render();
      break;
    case 'journey-show-completed':
      journeyView.completed = !journeyView.completed;
      render(true);
      break;
    case 'journey-handle': {
      const action = environment.journey?.actions.find((a) => a.id === id);
      if (!action || environment.journey.profileId !== profile().id) throw Error('行动已变化，请重新核对');
      await mutation({ type: 'journey-action-handle', id, handled: !action.handled });
      await refresh();
      break;
    }
    case 'journey-itinerary-add':
    case 'journey-itinerary-place': {
      syncItineraryIntentEditors();
      const fieldId = 'itinerary-' + (action === 'journey-itinerary-add' ? 'add' : 'change') + '-' + id;
      let editor = itineraryIntentEditors.get(intentEditorKey(fieldId));
      if (!editor) {
        const mode = action === 'journey-itinerary-add' ? 'add' : 'place';
        const scope = target.closest('[data-itinerary-choice]');
        editor = intentEditor(
          'itinerary-choice',
          id,
          { mode, actionId: id, ...(mode === 'place' ? { ownerId: id } : {}) },
          null,
          scope,
        );
      }
      await commitIntentEditor(editor);
      clearItineraryDraft('itinerary-' + (action === 'journey-itinerary-add' ? 'add' : 'change') + '-' + id);
      await refresh();
      toast(action === 'journey-itinerary-add' ? '已加入本次行程' : '本次场景已保存');
      break;
    }
    case 'journey-itinerary-remove':
      await mutation({
        type: action,
        id,
        profileId: profile().id,
        expectedItinerary: structuredClone(profile().journey?.itinerary ?? null),
      });
      await refresh();
      toast('已移出本次选择，原完整行程已保留', false, act('journey-trash-open', '找回这一程…', 'btn soft'));
      break;
    case 'journey-itinerary-move':
      await mutation({ type: action, id, direction: target.dataset.direction });
      await refresh();
      break;
    case 'journey-itinerary-name':
      syncItineraryIntentEditors();
      await commitIntentEditor(itineraryIntentEditors.get(intentEditorKey('journey-itinerary-name')));
      clearItineraryDraft('journey-itinerary-name');
      await refresh();
      break;
    case 'journey-itinerary-status':
      await mutation({ type: action, status: id });
      await refresh();
      break;
    case 'journey-itinerary-skip': {
      const trip = compact ? companionData?.itinerary : environment.journey?.itinerary;
      const step = trip?.steps.find((s) => s.actionId === id);
      if (!step) throw Error('本次选择已变化，请重新核对');
      await mutation({ type: action, id, skipped: !step.skipped });
      await refresh();
      break;
    }
    case 'journey-itinerary-handle': {
      const trip = compact ? companionData?.itinerary : environment.journey?.itinerary;
      const step = trip?.steps.find((s) => s.actionId === id);
      if (!step) throw Error('本次选择已变化，请重新核对');
      const currentId = step.handledActionId || step.action?.id || id;
      await mutation({ type: 'journey-action-handle', id: currentId, handled: !step.handled });
      await refresh();
      break;
    }
    case 'journey-itinerary-continue': {
      syncItineraryIntentEditors();
      const fieldId = 'itinerary-continue-' + id + '-' + target.dataset.targetId;
      const editor =
        itineraryIntentEditors.get(intentEditorKey(fieldId)) ||
        intentEditor(
          'itinerary-choice',
          id,
          { mode: 'continue', actionId: target.dataset.targetId, ownerId: id },
          null,
          target.closest('[data-itinerary-continuation]'),
        );
      await commitIntentEditor(editor);
      clearItineraryDraft('itinerary-continue-' + id + '-' + target.dataset.targetId);
      await refresh();
      toast('已接续当前任务步骤，原行程顺序与事项仍保留');
      break;
    }
    case 'journey-itinerary-clear':
      itineraryClearConfirmation = {
        profileId: profile().id,
        expectedItinerary: structuredClone(profile().journey?.itinerary ?? null),
      };
      modal(
        '清空本次行程选择？',
        '先保留下面这份完整行程，再清空本次选择。个人待办、目标和已处理记录会继续保留，之后可单独找回这一程。',
        journeyTrashViews.itineraryDetail(itineraryClearConfirmation.expectedItinerary, journalIndex(), {
          heading: '清空前的完整行程 · 将保留副本',
        }),
        act('journey-itinerary-clear-confirm', '保留副本并清空本次选择', 'btn danger'),
      );
      break;
    case 'journey-itinerary-clear-confirm': {
      const preview = itineraryClearConfirmation;
      if (!preview || preview.profileId !== profile().id) throw Error('行程或周目已变化，请重新核对');
      await mutation({
        type: 'journey-itinerary-clear',
        profileId: preview.profileId,
        expectedItinerary: preview.expectedItinerary,
      });
      for (const key of itineraryFormDrafts.keys())
        if (key.startsWith(profile().id + '\u0000')) itineraryFormDrafts.delete(key);
      closeOverlay();
      await refresh();
      toast('本次选择已清空，原完整行程已保留', false, act('journey-trash-open', '找回这一程…', 'btn soft'));
      break;
    }
    case 'journey-itinerary-journal': {
      const trip = compact ? companionData?.itinerary : environment.journey?.itinerary;
      if (!trip?.steps.length) throw Error('本次行程尚无选择');
      const labels = {
        pending: '待处理',
        unavailable: '需要核对',
        skipped: '仅本次跳过',
        'game-complete': '当前参照记录游戏已完成',
        'user-done': '个人已完成',
        handled: '个人已处理',
        prepared: '当前参照材料已齐',
      };
      const body =
        `本次选择 ${trip.summary.total} 项，个人已处理 ${trip.summary.handled} 项，个人已完成 ${trip.summary['user-done']} 项，本次跳过 ${trip.summary.skipped} 项，仍待处理或核对 ${trip.summary.remaining} 项。\n\n` +
        trip.steps
          .slice(0, 20)
          .map(
            (step, i) =>
              `${i + 1}. ${step.title.slice(0, 100)} · ${itineraryPlaceLabel(step).slice(0, 120)} · ${labels[step.status]}`,
          )
          .join('\n') +
        (trip.steps.length > 20
          ? '\n另有 ' + (trip.steps.length - 20) + ' 项；完整选择仍在「这一程做什么」中保留。'
          : '') +
        (trip.reference
          ? `\n\n对照 ${trip.reference.name} · ${when(trip.reference.modifiedAt)} · SHA ${trip.reference.hash.slice(0, 12)}`
          : '') +
        '\n游戏任务与材料状态来自当前已保存参照，不代表这一程新增的游戏进度。';
      openJournalEditor();
      document.querySelector('#journal-title').value = (trip.name + ' · 行程回顾').slice(0, 160);
      document.querySelector('#journal-body').value = body;
      captureJournalDraft();
      break;
    }
    case 'journey-place-dialog':
      journeyDialog('place', id);
      break;
    case 'journey-open': {
      if (!/^journey:[a-z-]+:[a-f0-9]{32}$/.test(id)) throw Error('行动编号无效');
      journeyView = { query: '', place: '', completed: false };
      route = 'journey';
      closeOverlay();
      const resolvedId =
        (compact ? companionData?.itinerary : environment.journey?.itinerary)?.steps.find(
          (s) => s.actionId === id,
        )?.action?.id || id;
      render();
      (
        document.querySelector(`[data-journey-id="${CSS.escape(resolvedId)}"]`) ||
        document.querySelector(`[data-itinerary-step="${CSS.escape(id)}"]`)
      )?.scrollIntoView({ block: 'center' });
      break;
    }
    case 'journey-todo-dialog':
    case 'journey-todo':
      journeyDialog('todo', id);
      break;
    case 'journey-gift-dialog':
    case 'journey-gift-edit':
      journeyDialog('gift', id);
      break;
    case 'journey-place-page':
      if (!Number.isSafeInteger(Number(id)) || Number(id) < 1) throw Error('请选择有效的地点查询页');
      refreshPlacePicker(Number(id));
      break;
    case 'journey-gift-page': {
      const [kind, page] = id.split(':');
      if (!['person', 'item'].includes(kind) || !Number.isSafeInteger(Number(page)) || Number(page) < 1)
        throw Error('请选择有效的赠礼查询页');
      refreshGiftPicker(kind, Number(page));
      break;
    }
    case 'journey-goal':
      closeOverlay();
      route = 'goals';
      render();
      document
        .querySelector(`[data-action="goal-toggle"][data-id="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ block: 'center' });
      break;
    case 'journey-focus': {
      closeOverlay();
      route = 'journey';
      journeyView = { query: '', place: '', completed: true };
      const resolvedId =
        (compact ? companionData?.itinerary : environment.journey?.itinerary)?.steps.find(
          (s) => s.actionId === id,
        )?.action?.id || id;
      render();
      (
        document.querySelector(`[data-journey-id="${CSS.escape(resolvedId)}"]`) ||
        document.querySelector(`[data-itinerary-step="${CSS.escape(id)}"]`)
      )?.scrollIntoView({ block: 'center' });
      break;
    }
    case 'journey-intent-save': {
      const draft = journeyDraft;
      if (!draft || draft.profileId !== profile().id) throw Error('周目已变化，请重新打开个人记录');
      if ([...overlay.querySelectorAll('input,select,textarea')].some((n) => !n.checkValidity()))
        throw Error('请填写完整名称、人物、物品与有效数量');
      await commitIntentEditor(activeIntentEditor);
      journeyDraft = null;
      closeOverlay();
      route = 'journey';
      await refresh();
      toast('个人打算已加入当前周目的行程');
      break;
    }
    case 'journey-intent-remove': {
      const draft = journeyDraft;
      if (!draft || !draft.record || draft.profileId !== profile().id)
        throw Error('请重新打开要移除的个人记录');
      journeyTrashConfirmation = {
        type: 'remove',
        kind: draft.kind,
        profileId: draft.profileId,
        record: structuredClone(draft.record),
        returnContext: {
          content: overlay.firstChild,
          editor: activeIntentEditor,
          draft,
          scroll: overlay.querySelector('.modal').scrollTop,
        },
      };
      modal(
        '移除这项个人安排？',
        '完整内容会保留在「已移除的个人安排」，以后可单条找回。当前未提交的编辑仍保留为草稿。',
        journeyTrashViews.detail({ kind: draft.kind, record: draft.record }, journalIndex(), {
          preview: true,
        }),
        act('journey-intent-remove-confirm', '移除并保留可找回内容', 'btn danger'),
      );
      break;
    }
    case 'journey-intent-remove-confirm': {
      const preview = journeyTrashConfirmation;
      if (!preview || preview.type !== 'remove' || preview.profileId !== profile().id)
        throw Error('安排或周目已变化，请重新核对');
      await mutation({
        type: 'journey-' + preview.kind + '-remove',
        profileId: preview.profileId,
        ...(preview.kind === 'place' ? { placeId: preview.record.placeId } : { id: preview.record.id }),
        expectedRecord: preview.record,
      });
      journeyTrashConfirmation = null;
      closeOverlay();
      journeyDraft = null;
      await refresh();
      toast('所选安排已移除，可从行程中的已移除安排找回');
      break;
    }
    case 'world-quest':
      await showWorldDetail(id, 'quest');
      break;
    case 'world-person': {
      const person = gameViews.byId(gameIndex, id);
      if (!person) throw Error('人物资料不存在');
      worldView.referenceName = referenceSaveName;
      worldView.follow = referenceFollow;
      worldView.reference = referenceSave;
      closeOverlay();
      route = 'world';
      worldView.kind = 'quests';
      worldView.status = 'all';
      worldView.query = person.name;
      worldView.page = 0;
      render();
      if (worldView.referenceName === undefined) await loadWorldReference();
      break;
    }
    case 'world-place':
      await showWorldDetail(id, 'place');
      break;
    case 'world-kind':
      worldView.kind = id;
      worldView.page = 0;
      worldView.query = '';
      render();
      break;
    case 'world-page':
      worldView.page = Number(id);
      render();
      break;
    case 'world-refresh':
      await refresh();
      await loadWorldReference();
      break;
    case 'world-back-to-list':
      closeOverlay();
      route = 'world';
      worldView.kind = 'quests';
      render();
      break;
    case 'world-quest-goal': {
      const q = gameIndex.world.quests.find((q) => q.id === id);
      if (!q) throw Error('任务资料不存在');
      await mutation({
        type: 'goal-add',
        title: q.name,
        detail:
          `任务资料编号：${q.gameId}${worldView.reference ? `\n对照：${worldView.reference.name} · ${when(worldView.reference.modifiedAt)}` : ''}\n${q.description}`.slice(
            0,
            1900,
          ),
        source: { type: 'quest', id },
      });
      toast('任务已记入待办');
      break;
    }
    case 'world-reserve-material': {
      const [questId, itemId] = id.split(':');
      const q = gameIndex.world.quests.find((q) => q.id === questId);
      const material = q?.materials?.find((m) => String(m.id) === itemId);
      if (!material) throw Error('任务用料资料不存在');
      await mutation({
        type: 'task-reserve',
        questId,
        itemId,
      });
      await showWorldDetail(questId, 'quest', true);
      toast('已按任务分别预留；可在备料清单查看用途和调整数量');
      break;
    }
    case 'craft-search-page':
      materialView.searchPage = Math.max(0, Number(id) || 0);
      render(true);
      break;
    case 'resource-priority-open': {
      await refresh();
      if (!materialBudgetContext().summary && (profile().craftList || []).length) await calculateMaterials();
      const context = materialBudgetContext();
      const summary = context.summary;
      if (!summary?.priorityOwners?.length) throw Error('物资用途正在变化，请重新核对');
      const ids = summary.priorityOwners.map((row) => row.id);
      await previewResourcePriority(ids, true, context);
      break;
    }
    case 'resource-priority-move': {
      const draft = resourcePriorityDraft;
      if (!draft?.preview || draft.loading) break;
      const order = [...draft.preview.afterOrder],
        from = order.indexOf(id);
      const to = from + (target.dataset.direction === 'up' ? -1 : 1);
      if (from < 0 || to < 0 || to >= order.length) break;
      [order[from], order[to]] = [order[to], order[from]];
      await previewResourcePriority(order);
      break;
    }
    case 'resource-priority-reset':
      await previewResourcePriority([]);
      break;
    case 'resource-priority-refresh':
      if (resourcePriorityDraft) await previewResourcePriority(resourcePriorityDraft.order);
      break;
    case 'resource-priority-save': {
      const draft = resourcePriorityDraft;
      if (!draft?.preview || draft.loading || draft.profileId !== profile().id)
        throw Error('请重新核对物资顺序');
      draft.loading = true;
      renderResourcePriorityDialog();
      try {
        await mutation({
          type: 'resource-priority-set',
          profileId: draft.profileId,
          order: draft.preview.order,
          fingerprint: draft.preview.fingerprint,
          referenceName: draft.referenceName,
        });
        closeOverlay();
        await refresh();
        if (route === 'materials' && (profile().craftList || []).length) await calculateMaterials();
        toast('物资用途顺序已保存');
      } catch (e) {
        draft.loading = false;
        draft.preview = null;
        draft.error = e.message;
        renderResourcePriorityDialog();
      }
      break;
    }
    case 'craft-add': {
      const recipe = gameViews.byId(gameIndex, id);
      if (recipe?.kind !== '配方') throw Error('请选择一份配方');
      const amount = document.querySelector('#recipe-quantity') && databaseId === id ? recipeQuantity() : 1;
      const old = profile().craftList?.find((line) => line.id === id)?.quantity || 0;
      await mutation({ type: 'craft-set', id, quantity: old + amount });
      invalidateMaterials();
      toast(`已加入备料清单 · ${recipe.name} ${old + amount} 次`);
      break;
    }
    case 'craft-open':
      closeOverlay();
      route = 'materials';
      materialView.referenceName ??= referenceSaveName ?? defaultReference();
      materialView.follow ??= referenceFollow ?? defaultFollow();
      render();
      if ((profile().craftList || []).length) await calculateMaterials();
      break;
    case 'craft-remove':
      await mutation({ type: 'craft-remove', id });
      invalidateMaterials();
      render(true);
      toast('已移出配方，原次数和清单已保留，可找回上一次编辑清单');
      break;
    case 'craft-review':
    case 'craft-calculate':
      await mutationQueue;
      await calculateMaterials();
      if (action === 'craft-review')
        document.querySelector('.craft-result-card')?.scrollIntoView({ block: 'start' });
      break;
    case 'craft-missing':
      materialView.onlyMissing = !materialView.onlyMissing;
      render(true);
      break;
    case 'craft-goal': {
      if (
        !materialView.result ||
        JSON.stringify(materialView.resultList) !== JSON.stringify(profile().craftList || [])
      )
        throw Error('请先重新核对备料清单');
      craftPlanModal('', profile().craftList, true);
      break;
    }
    case 'craft-plan-dialog':
      craftPlanModal(id);
      break;
    case 'craft-plan-complete': {
      const plan = profile().craftPlans?.find((entry) => entry.id === id);
      if (!plan) throw Error('这份制作计划已不存在，请重新核对');
      if (plan.done) {
        await mutation({
          type: 'craft-plan-complete',
          id,
          value: false,
          profileId: profile().id,
          expectedPlan: plan,
        });
        await refresh();
        toast('计划已重新打开，按原先的预留与目标状态重新核对用料');
        break;
      }
      const list = plan.list
        .map((line) => {
          const recipe = gameIndex.entries.find((entry) => entry.id === line.id);
          return `<p>${esc(recipe?.name || line.id)} × ${line.quantity} 次</p>`;
        })
        .join('');
      modal(
        '整份计划都已制作完成？',
        `将「${esc(plan.name)}」记为个人制作完成`,
        `<div class="journey-intent-body"><p class="save-note">确认后释放这整份计划的用料，关联行程会推进。配方、原预留偏好及独立勾选的目标会保留，可以重新打开。不会修改游戏库存，也不会把预计产物算成持有量。</p>${list}</div>`,
        act('craft-plan-complete-confirm', '整份已制作，释放用料', 'btn primary', plan.id, 'check'),
      );
      overlay.querySelector('.modal')?.classList.add('journey-intent-modal');
      craftCompletionDraft = { profileId: profile().id, plan: structuredClone(plan) };
      break;
    }
    case 'craft-plan-complete-confirm': {
      const draft = craftCompletionDraft;
      if (!draft || draft.profileId !== profile().id || draft.plan.id !== id)
        throw Error('计划预览或周目已变化，请重新查看后确认');
      await mutation({
        type: 'craft-plan-complete',
        id,
        value: true,
        profileId: draft.profileId,
        expectedPlan: draft.plan,
      });
      closeOverlay();
      await refresh();
      toast('计划已记为制作完成，用料已释放；可在备料页重新打开');
      break;
    }
    case 'craft-plan-reserve': {
      const plan = profile().craftPlans?.find((x) => x.id === id);
      if (plan) await mutation({ type: 'craft-plan-reserve', id, value: plan.reserved === false });
      break;
    }
    case 'craft-draft-reserve':
      await mutation({ type: 'craft-draft-reserve', value: profile().reserveCraftDraft === false });
      break;
    case 'allocation-edit': {
      const [questId, itemId] = id.split(':');
      const input = document.getElementById('allocation-' + questId + '-' + itemId);
      if (!input?.checkValidity()) throw Error('请填写 0 至 999999 的整数');
      await mutation({ type: 'task-reserve-edit', questId, itemId, count: Number(input.value) });
      break;
    }
    case 'allocation-remove':
      await mutation({ type: 'task-reserve-remove', questId: id });
      break;
    case 'craft-plan-copy': {
      const plan = profile().craftPlans?.find((x) => x.id === id);
      if (plan) craftPlanModal('', plan.list, false, plan.name + ' · 副本', plan.choices || {});
      break;
    }
    case 'craft-plan-save': {
      const draft = craftPlanDraft;
      if (!draft || draft.profileId !== profile().id) throw Error('周目已变化，请重新打开计划');
      await commitIntentEditor(activeIntentEditor);
      craftPlanDraft = null;
      closeOverlay();
      toast('制作计划已独立保存');
      break;
    }
    case 'craft-plan-open':
      await mutation({ type: 'craft-plan-open', id });
      materialView.planId = id;
      route = 'materials';
      closeOverlay();
      await calculateMaterials();
      break;
    case 'craft-goals-merge':
      await mutation({ type: 'craft-goals-merge' });
      await calculateMaterials();
      toast('已合并未完成的制作目标；相同配方不会与编辑清单重复累加');
      break;
    case 'craft-choice': {
      const [itemId, recipeId = ''] = id.split(':');
      await mutation({ type: 'craft-choice', itemId, recipeId });
      await calculateMaterials();
      break;
    }
    case 'craft-draft-restore':
      await mutation({ type: 'craft-draft-restore' });
      materialView.planId = null;
      await calculateMaterials();
      break;
    case 'craft-plan-remove': {
      const record = profile().craftPlans?.find((plan) => plan.id === id);
      if (!record) throw Error('制作计划已变化，请重新核对');
      journeyTrashConfirmation = {
        type: 'remove-craft-plan',
        profileId: profile().id,
        record: structuredClone(record),
      };
      modal(
        '移除这份制作计划？',
        '完整计划会保留在「已移除的个人安排」，可单条找回；当前编辑清单保持。仍被行囊目标引用时会先阻止移除，请先处理对应目标。',
        journeyTrashViews.detail({ kind: 'craft-plan', record }, journalIndex(), { preview: true }),
        act('craft-plan-remove-confirm', '移除并保留可找回内容', 'btn danger', id),
      );
      break;
    }
    case 'craft-plan-remove-confirm': {
      const preview = journeyTrashConfirmation;
      if (
        !preview ||
        preview.type !== 'remove-craft-plan' ||
        preview.profileId !== profile().id ||
        preview.record.id !== id
      )
        throw Error('制作计划或周目已变化，请重新核对');
      await mutation({
        type: 'craft-plan-remove',
        profileId: preview.profileId,
        id,
        expectedRecord: preview.record,
      });
      if (materialView.planId === id) materialView.planId = null;
      closeOverlay();
      toast('制作计划已移除，可单条找回；当前编辑清单保留');
      break;
    }
    case 'detail':
      showDetail(id);
      break;
    case 'database-kind':
      databaseKind = id;
      databaseType = '全部';
      databasePage = 0;
      render(true);
      break;
    case 'database-page':
      databasePage = Number(id);
      render();
      break;
    case 'database-reset':
      query = '';
      databaseType = '全部';
      databasePage = 0;
      render(true);
      document.querySelector('#list-search')?.focus();
      break;
    case 'database-detail': {
      let quantity = 1;
      if (!currentDrawer && route === 'materials') {
        await mutationQueue;
        referenceSaveName = materialView.referenceName ?? defaultReference();
        referenceFollow = materialView.follow ?? defaultFollow();
        referenceSave = null;
        if (target.closest('.craft-line'))
          quantity = profile().craftList?.find((line) => line.id === id)?.quantity || 1;
      }
      await showDatabaseDetail(id, quantity);
      break;
    }
    case 'database-uses': {
      const e = gameViews.byId(gameIndex, id);
      if (!e) break;
      closeOverlay();
      route = 'database';
      databaseKind = '配方';
      databaseType = '全部';
      databasePage = 0;
      query = e.name;
      render();
      break;
    }
    case 'database-goal': {
      const e = gameViews.byId(gameIndex, id);
      if (!e) break;
      await mutation({
        type: 'goal-add',
        title: `寻找${e.name}`,
        detail: `${e.type}\n${e.description || ''}`.slice(0, 2000),
        source: { type: 'database', id: e.id },
      });
      toast('已加入我的待办');
      break;
    }
    case 'database-gifts': {
      const e = gameViews.byId(gameIndex, id);
      if (!e) break;
      closeOverlay();
      route = 'database';
      databaseKind = '物品';
      databaseType = e.hobbies[0] || '全部';
      databasePage = 0;
      query = '';
      render();
      toast(`先查看${e.name}偏好的「${databaseType}」，其余偏好可在人物资料中查看`);
      break;
    }
    case 'recipe-goal': {
      const plan = await call('recipePlan', id, recipeQuantity(), referenceSaveName || undefined);
      await mutation({
        type: 'goal-add',
        title: `制作${plan.targetName} ×${plan.quantity}`,
        source: { type: 'database', id, quantity: plan.quantity },
        detail: `材料：\n${plan.materials.map((m) => `${m.name} ×${m.count}${m.owned !== undefined ? `（已有 ${m.owned}，缺 ${m.missing}）` : ''}`).join('\n')}\n铜钱：${plan.money.toLocaleString()} 文${plan.reference ? `\n对照：${plan.reference.name} · ${when(plan.reference.modifiedAt)}\n库存来自已保存的文件，游戏内新变化请重新核对。` : ''}\n来源：本机配方 · Build ${gameIndex.build}`,
      });
      toast('备料单已加入我的待办');
      break;
    }
    case 'save-compare':
      showComparison(id || '');
      break;
    case 'compare-run':
      await readComparison();
      break;
    case 'compare-swap': {
      const left = document.querySelector('#compare-left'),
        right = document.querySelector('#compare-right');
      [left.value, right.value] = [right.value, left.value];
      await readComparison();
      break;
    }
    case 'compare-refresh': {
      const token = ++detailRequest;
      await refresh();
      if (token === detailRequest && currentDrawer?.type === 'comparison') showComparison();
      break;
    }
    case 'compare-filter':
      if (comparisonState?.result) {
        comparisonState.filter = id;
        overlay
          .querySelectorAll('[data-action="compare-filter"]')
          .forEach((button) => button.classList.toggle('active', button.dataset.id === id));
        document.querySelector('#compare-inventory-results').innerHTML = comparisonViews.inventory(
          comparisonState.result,
          gameIndex,
          comparisonState.query,
          id,
        );
      }
      break;
    case 'save-detail': {
      const result = await call('saveDetails', id);
      selectedSave = result;
      rememberDrawer({ type: 'save', data: result });
      showOverlay(gameViews.saveDetail(result, gameIndex), true);
      break;
    }
    case 'save-quest-jump': {
      if (!environment.recent?.name) break;
      const result = await call('saveDetails', environment.recent.name);
      selectedSave = result;
      rememberDrawer({ type: 'save', data: result });
      showOverlay(gameViews.saveDetail(result, gameIndex), true);
      const section = overlay.querySelector('.save-recorded-quests');
      if (section) section.open = true;
      const target = [...overlay.querySelectorAll('[data-quest-id]')].find((el) => el.dataset.questId === id);
      if (target) {
        target.querySelector('details').open = true;
        target.scrollIntoView({ block: 'center' });
      } else {
        section?.scrollIntoView({ block: 'start' });
        toast('这份存档的任务状态已变化，请核对当前列表');
      }
      break;
    }
    case 'save-quest-filter':
      if (selectedSave?.metadata.quests)
        document.querySelector('#save-quest-results').innerHTML = gameViews.questList(
          selectedSave.metadata.quests,
          id,
          selectedSave.metadata.inventory,
          gameIndex,
        );
      break;
    case 'save-quest-goal': {
      const q = selectedSave?.metadata.quests?.find((q) => q.id === Number(id));
      if (!q) break;
      const steps = selectedSave.metadata.quests.filter((c) => c.parentId === q.id && c.step === 1);
      await mutation({
        type: 'goal-add',
        title: q.name,
        source: { type: 'quest', id: `quest-${q.id}` },
        detail:
          `${q.description}\n${steps.map((s) => '· ' + s.name).join('\n')}\n来源：${selectedSave.name} · ${when(selectedSave.modifiedAt)}`.slice(
            0,
            2000,
          ),
      });
      toast('已把这项任务记入待办');
      break;
    }
    case 'save-recap-goal': {
      if (!selectedSave) break;
      const m = selectedSave.metadata;
      await mutation({
        type: 'goal-add',
        title: `从${m.mapName}继续出发`,
        detail: `存档：${selectedSave.name}\n保存于：${when(selectedSave.modifiedAt)}\n同行：${m.team?.map((n) => n.name).join('、') || '未知'}\n主线追踪：${m.mainQuest?.name || '未记录'}\n支线追踪：${m.quest?.name || '未记录'}`,
      });
      toast('这次出发已经记进行囊');
      break;
    }
    case 'close-overlay':
      dismissOverlay();
      break;
    case 'reveal':
      revealed = true;
      showDetail(id, true);
      break;
    case 'search':
      searchModal();
      break;
    case 'search-save': {
      const value = document.querySelector('#global-search')?.value.trim();
      compileSearch(value);
      await mutation({ type: 'search-save', query: value });
      toast('搜索已保存，在空白搜索页可再次使用');
      break;
    }
    case 'search-run':
      compileSearch(id);
      await mutation({ type: 'search-remember', query: id });
      searchModal({ query: id });
      break;
    case 'search-forget':
      await mutation({ type: 'search-forget', query: id });
      showSearchResults('');
      break;
    case 'search-history-clear':
      await mutation({ type: 'search-history-clear' });
      showSearchResults('');
      break;
    case 'search-goal': {
      closeOverlay();
      route = 'goals';
      render();
      const button = document.querySelector('[data-action="goal-toggle"][data-id="' + id + '"]');
      const destination = button?.disabled ? button.closest('.goal-row') : button;
      destination?.focus();
      destination?.scrollIntoView({ block: 'center' });
      break;
    }
    case 'search-note':
      closeOverlay();
      route = 'goals';
      render();
      document.querySelector('#note')?.scrollIntoView({ block: 'center' });
      document.querySelector('#note')?.focus();
      break;
    case 'filter':
      if (id === 'current' && profile().stageConfirmed === false) {
        stageModal(true);
        break;
      }
      filter = id;
      render(true);
      break;
    case 'kind':
      kind = id;
      render(true);
      break;
    case 'stage':
      stageModal();
      break;
    case 'stage-save':
      if (id === 'current') filter = 'current';
      await changeStage(Number(document.querySelector('#stage-select').value));
      break;
    case 'stage-change':
      await changeStage(Number(id));
      break;
    case 'stage-confirm':
      await mutation({ type: 'stage', value: Number(id) });
      closeOverlay();
      toast('当前阶段已更新');
      break;
    case 'check': {
      const was = profile().checks[id] === 'done';
      const undo = {
        profileId: profile().id,
        type: 'check',
        id,
        value: profile().checks[id] || 'todo',
        title: entry(id)?.title || '清单事项',
      };
      await mutation({ type: 'check', id, value: was ? 'todo' : 'done' });
      if (compact && !was) {
        compactUndo = undo;
        render(true);
      }
      if (drawerId === id) showDetail(id, true);
      toast(was ? '已恢复为待办' : '记下了，又完成一件小事');
      break;
    }
    case 'skip':
      await mutation({ type: 'check', id, value: profile().checks[id] === 'skip' ? 'todo' : 'skip' });
      showDetail(id, true);
      break;
    case 'favorite': {
      const had = profile().favorites.includes(id);
      await mutation({ type: 'favorite', id });
      if (drawerId === id) showDetail(id, true);
      toast(had ? '已移出收藏' : '线索已放进行囊');
      break;
    }
    case 'goal-add':
      goalModal();
      break;
    case 'goal-source': {
      const source = profile().goals.find((g) => g.id === id)?.source;
      if (!source) break;
      if (source.type === 'guide') {
        if (!entry(source.id)) throw Error('这条线索在当前资料中不可用');
        showDetail(source.id);
      } else if (source.type === 'quest') {
        await showWorldDetail(source.id, 'quest');
      } else if (source.type === 'planner') {
        if (source.id !== 'current') {
          await mutation({ type: 'craft-plan-open', id: source.id });
          materialView.planId = source.id;
        } else toast('这是早期目标，跟随当前编辑清单；可以保存为独立计划');
        closeOverlay();
        route = 'materials';
        materialView.referenceName ??= defaultReference();
        render();
        await calculateMaterials();
      } else {
        if (!gameViews.byId(gameIndex, source.id)) throw Error('这项资料在当前图鉴中不可用');
        referenceSaveName = undefined;
        referenceSave = null;
        await showDatabaseDetail(source.id, source.quantity || 1);
      }
      break;
    }
    case 'goal-place-edit':
    case 'goal-edit':
      goalModal(id);
      break;
    case 'goal-save':
      await commitIntentEditor(activeIntentEditor);
      closeOverlay();
      toast('目标已保存');
      break;
    case 'goal-pin':
      await mutation({ type: 'goal-pin', id });
      break;
    case 'goal-toggle': {
      const goal = profile().goals.find((g) => g.id === id);
      if (goal && goalStatus(goal).automaticDone) {
        await mutation({ type: 'goal-tracking', id, mode: 'manual', reopen: true });
        toast('已保留为手动待办，游戏任务记录未改变');
        break;
      }
      const undo = {
        profileId: profile().id,
        type: 'goal',
        id,
        value: !!goal?.done,
        title: goal?.title || '目标',
      };
      await mutation({ type: 'goal-toggle', id });
      if (compact && !undo.value) {
        compactUndo = undo;
        render(true);
      }
      break;
    }
    case 'goal-tracking': {
      const goal = profile().goals.find((g) => g.id === id);
      if (goal)
        await mutation({
          type: 'goal-tracking',
          id,
          mode: goal.progressMode === 'manual' ? 'auto' : 'manual',
        });
      break;
    }
    case 'compact-undo': {
      const undo = compactUndo;
      if (!undo || undo.profileId !== profile().id) break;
      if (undo.type === 'check' && profile().checks[undo.id] === 'done')
        await mutation({ type: 'check', id: undo.id, value: undo.value });
      if (undo.type === 'goal' && profile().goals.find((g) => g.id === undo.id)?.done)
        await mutation({ type: 'goal-toggle', id: undo.id });
      compactUndo = null;
      render(true);
      toast('已恢复为待办');
      break;
    }
    case 'goal-remove': {
      const record = profile().goals.find((g) => g.id === id);
      if (!record) throw Error('目标已变化，请重新核对');
      journeyTrashConfirmation = {
        type: 'remove-goal',
        profileId: profile().id,
        record: structuredClone(record),
      };
      modal(
        '从行囊中移除这件事？',
        '完整内容会保留在「已移除的个人安排」，以后可单条找回。游戏存档保持。',
        journeyTrashViews.detail({ kind: 'goal', record }, journalIndex(), { preview: true }),
        act('goal-remove-confirm', '移除并保留可找回内容', 'btn danger', id),
      );
      break;
    }
    case 'goal-remove-confirm': {
      const preview = journeyTrashConfirmation;
      if (
        !preview ||
        preview.type !== 'remove-goal' ||
        preview.profileId !== profile().id ||
        preview.record.id !== id
      )
        throw Error('目标或周目已变化，请重新核对');
      await mutation({
        type: 'goal-remove',
        profileId: preview.profileId,
        id,
        expectedRecord: preview.record,
      });
      journeyTrashConfirmation = null;
      closeOverlay();
      toast('目标已移除，可在已移除的个人安排中找回');
      break;
    }
    case 'entry-goal': {
      const e = entry(id);
      await mutation({
        type: 'goal-add',
        title: e.title,
        detail: `地点：${e.location}\n${e.hint}`,
        source: { type: 'guide', id: e.id },
      });
      toast('已加入我的待办');
      break;
    }
    case 'profiles':
      await saveNote();
      profilesModal();
      break;
    case 'profile-create':
      await saveNote();
      {
        const selected = document.querySelector('#profile-binding').value;
        await mutation({
          type: 'profile-add',
          name: document.querySelector('#profile-name').value,
          mode: selected === '@none' ? 'none' : selected === '@latest' ? 'latest' : 'slot',
          saveSlot: selected.startsWith('@') ? '' : selected,
        });
      }
      closeOverlay();
      render();
      toast('新的一程，出发吧');
      break;
    case 'profile-switch':
      captureJournalDraft();
      await flushJournalDrafts();
      await saveNote();
      await mutation({ type: 'profile-switch', id: document.querySelector('#profile-select').value });
      closeOverlay();
      render();
      toast('已切换周目');
      break;
    case 'profile-rename':
      modal(
        '给这一程换个名字',
        '',
        `<div class="field"><input id="rename-profile" maxlength="40" value="${esc(profile().name)}" aria-label="周目名称"></div>`,
        act('profile-rename-save', '保存名称', 'btn primary'),
      );
      break;
    case 'profile-rename-save':
      await mutation({ type: 'profile-rename', name: document.querySelector('#rename-profile').value });
      closeOverlay();
      toast('周目名称已更新');
      break;
    case 'start-assistance': {
      if (startingAssistance) break;
      startingAssistance = true;
      assistanceError = '';
      render(true);
      try {
        const result = await call('startAssistance');
        if (!result.cancelled) {
          state = result.state;
          environment = result.environment;
          toast(
            result.launchOnly
              ? '已开始游戏，以后将直接启动；自动存档可稍后开启'
              : '已准备好，进入游戏后会自动留住进度',
          );
        }
      } catch (error) {
        assistanceError = error.message;
        toast(error.message, true);
      } finally {
        startingAssistance = false;
        await refresh();
      }
      break;
    }
    case 'bridge-install':
    case 'bridge-disable': {
      const result = await call(action === 'bridge-install' ? 'bridgeInstall' : 'bridgeDisable');
      if (!result.cancelled) {
        environment = result.environment;
        render(true);
        toast(action === 'bridge-install' ? '组件已接入，请重启游戏' : '游戏接入已停用，历史副本保留');
      }
      break;
    }
    case 'timeline-toggle': {
      const result = await call('timelineConfigure', {
        enabled: !environment.timeline.enabled,
        interval: Number(document.querySelector('#timeline-interval').value),
      });
      if (!result.cancelled) {
        environment = result.environment;
        render(true);
        toast(environment.timeline.enabled ? '时间线已开启，可保存时自动记录' : '时间线自动保存已关闭');
      }
      break;
    }
    case 'timeline-save': {
      toast('正在通过游戏保存进度…');
      const result = await call('timelineSave');
      if (id === 'attempt') {
        const updated = await call('timelineUpdate', result.record.id, {
          bookmarked: true,
          label: '尝试起点 · ' + new Date().toLocaleString('zh-CN'),
          note: '重复尝试时，从这个收藏节点读回。返回入口只代表最近一次读档前。',
        });
        result.environment = updated.environment;
      }
      environment = result.environment;
      render(true);
      toast(id === 'attempt' ? '尝试起点已收藏，可反复从这里读回' : '游戏进度已保存并收藏，历史副本校验通过');
      break;
    }
    case 'timeline-preview': {
      const result = await call('timelineInspect', id);
      rememberDrawer({ type: 'timeline', data: result });
      showOverlay(timelineViews.preview(result), true);
      break;
    }
    case 'timeline-load': {
      if (timelineLoadInFlight) throw Error('正在确认或执行上一次读档，请等待完成');
      timelineLoadInFlight = true;
      updateHealth(environment.health);
      try {
        const result = await call('timelineLoad', id);
        if (!result.cancelled) {
          environment = result.environment;
          closeOverlay();
          render(true);
          toast('历史进度已读入，读档前进度和完整保护副本已保留');
        }
      } finally {
        timelineLoadInFlight = false;
        updateHealth(environment.health);
      }
      break;
    }
    case 'timeline-target':
      timelineView.target = Number(id);
      render(true);
      break;
    case 'node-draft-review': {
      const draft = environment.activity?.drafts[id];
      if (!draft) throw Error('草稿已不存在，请刷新');
      if (environment.timeline.history.some((r) => r.id === id)) await handle('timeline-preview', id);
      else
        modal(
          '找回节点草稿',
          '这个节点已不在当前时间线中，草稿文字仍然保留。',
          `<p class="preserve-text">${esc(draft.label)}\n${esc(draft.note)}</p>`,
          act('node-draft-to-note', '转存到本周目随手记', 'btn primary', id),
        );
      break;
    }
    case 'node-draft-to-note': {
      const draft = environment.activity?.drafts[id];
      if (!draft) throw Error('草稿已不存在');
      await saveNote();
      await mutation({ type: 'note', value: profile().notes + '\n\n' + draft.label + '\n' + draft.note });
      closeOverlay();
      toast('草稿文字已转存，原草稿仍然保留');
      break;
    }
    case 'node-draft-remove':
      await nodeDraftQueue.catch(() => {});
      environment.activity = await call('nodeDraft', id, null);
      pendingNodeDrafts.delete(id);
      await flushNodeDrafts().catch((e) => toast('仍有草稿未保存：' + e.message, true));
      render(true);
      toast('这份草稿已放弃');
      break;
    case 'timeline-draft-discard': {
      const drawer = currentDrawer;
      await nodeDraftQueue.catch(() => {});
      pendingNodeDrafts.delete(id);
      drawer.data.draft = null;
      environment.activity = await call('nodeDraft', id, null);
      if (currentDrawer === drawer) {
        const result = await call('timelineInspect', id);
        if (currentDrawer === drawer) {
          currentDrawer = null;
          rememberDrawer({ type: 'timeline', data: result });
          showOverlay(timelineViews.preview(result), true);
        }
      }
      toast('已放弃这份草稿');
      break;
    }
    case 'reserve-save': {
      const input = document.querySelector('#reserve-count');
      if (!input?.checkValidity()) throw Error('请填写 0 至 999999 的整数');
      await mutation({
        type: 'reserve-set',
        id: String(gameViews.byId(gameIndex, databaseId).gameId),
        count: Number(input.value),
      });
      await showDatabaseDetail(databaseId);
      toast('预留数量已保存，赠礼与备料会一起扣除');
      break;
    }
    case 'gift-page':
      await showDatabaseDetail(databaseId, 1, Math.max(0, Number(id) || 0));
      break;
    case 'save-feedback':
      await mutation({ type: 'settings', value: { saveFeedback: !state.settings.saveFeedback } });
      break;
    case 'timeline-page':
      timelineView.page = Math.max(0, Number(id) || 0);
      render(true);
      break;
    case 'timeline-bookmark':
    case 'timeline-edit-save': {
      const drawer = currentDrawer;
      if (drawer?.type !== 'timeline' || drawer.data.record.id !== id)
        throw Error('节点预览已变更，请重新选择');
      if (submittingNodes.has(id)) throw Error('这个节点正在保存，请稍候');
      const r = drawer.data.record;
      const value = {
        label: document.querySelector('#timeline-label').value,
        note: document.querySelector('#timeline-note').value,
      };
      if (action === 'timeline-bookmark')
        value.bookmarked = !(r.bookmarked === true || (r.kind === 'manual' && r.bookmarked !== false));
      if (target?.dataset.retain === 'true') value.bookmarked = true;
      const controls = [
        ...overlay.querySelectorAll(
          '#timeline-label,#timeline-note,[data-action="timeline-edit-save"],[data-action="timeline-bookmark"],[data-action="timeline-draft-discard"]',
        ),
      ];
      submittingNodes.add(id);
      for (const control of controls) control.disabled = true;
      try {
        await captureNodeDraft().catch(() => {});
        const result = await call('timelineUpdate', id, value);
        const pending = pendingNodeDrafts.get(id);
        if (pending?.label === value.label && pending?.note === value.note) pendingNodeDrafts.delete(id);
        environment = result.environment;
        render(true);
        const completedDrawer = currentDrawer;
        if (completedDrawer?.type === 'timeline' && completedDrawer.data.record.id === id) {
          const inspected = await call('timelineInspect', id);
          if (currentDrawer === completedDrawer) {
            currentDrawer = null;
            rememberDrawer({ type: 'timeline', data: inspected }, true);
            showOverlay(timelineViews.preview(inspected), true);
          }
        }
        toast(
          action === 'timeline-bookmark'
            ? value.bookmarked
              ? '已收藏，节点单独保留'
              : '已取消收藏，后续参与轮换'
            : '名称与备注已保存',
        );
      } finally {
        submittingNodes.delete(id);
        for (const control of controls) if (control.isConnected) control.disabled = false;
        nodeControlsDisabled(id, false);
      }
      break;
    }
    case 'shortcuts-save': {
      const result = await call('configureShortcuts', {
        save: document.querySelector('#shortcut-save').value,
        history: document.querySelector('#shortcut-history').value,
      });
      state = result.state;
      environment = result.environment;
      render(true);
      toast('快捷键设置已保存');
      shortcutDrafts = {};
      render(true);
      break;
    }
    case 'window-quit':
      if (await prepareQuit()) await call('window', 'quit');
      break;
    case 'reading-scale-reset':
      await changeReadingScale('reset');
      break;
    case 'window-quit-discard':
      await nodeDraftQueue.catch(() => {});
      await journalDraftQueue.catch(() => {});
      await intentDraftQueue.catch(() => {});
      clearTimeout(journalDraftTimer);
      clearTimeout(intentDraftTimer);
      if (activeIntentEditor) activeIntentEditor.committed = true;
      for (const editor of itineraryIntentEditors.values()) editor.committed = true;
      pendingIntentDrafts.clear();
      pendingJournalDrafts.clear();
      pendingNodeDrafts.clear();
      await Promise.all([...drafts.keys()].map(saveNote));
      await call('window', 'quit');
      break;
    case 'timeline-recover': {
      const result = await call('timelineRecover');
      environment = result.environment;
      render(true);
      toast('中断记录已核对，自动保存保持关闭');
      break;
    }
    case 'backup': {
      if (!state.settings.savePath && !(await handle('choose-saves'))) break;
      const place =
        profile().stageConfirmed === false ? environment.recent?.mapName || '江湖进度' : stage().title;
      modal(
        '给这一刻留个名字',
        '先确认游戏内保存已经完成。将备份当前目录中的所有文件，并逐个校验。',
        `<div class="field"><label for="backup-label">备份名称</label><input id="backup-label" maxlength="100" placeholder="例如：品剑大会前 / 北山村选择前" value="${esc(place.slice(0, 80))} · ${new Date().toLocaleDateString('zh-CN')}"></div>`,
        act('backup-confirm', '创建备份', 'btn primary', '', 'download'),
      );
      document.querySelector('#backup-label').select();
      break;
    }
    case 'backup-confirm': {
      const label = document.querySelector('#backup-label').value;
      const result = await call('backup', label);
      environment = result.environment;
      closeOverlay();
      render(true);
      toast(`已备份并校验 ${result.count} 个文件`);
      break;
    }
    case 'verify': {
      const result = await call('verifyBackup', id);
      toast(`完整性校验通过 · ${result.count} 个文件`);
      break;
    }
    case 'backup-preview':
      await inspectBackupPreview(id);
      break;
    case 'backup-folder':
      await call('openBackup', id);
      break;
    case 'backup-rename': {
      const b = environment.backups.find((b) => b.id === id);
      backupRenameDraft =
        currentDrawer?.type === 'backup' && currentDrawer.data.id === id
          ? {
              id,
              scroll: overlay.querySelector('.drawer-body')?.scrollTop || 0,
              history: [...drawerHistory],
            }
          : null;
      modal(
        '修改备份名称',
        '更改名称不会改变备份里的存档内容。',
        `<div class="field"><label for="rename-backup">名称</label><input id="rename-backup" maxlength="100" value="${esc(b?.label || '')}"></div>`,
        act('backup-rename-save', '保存名称', 'btn primary', id),
      );
      break;
    }
    case 'backup-rename-save': {
      const r = await call('renameBackup', id, document.querySelector('#rename-backup').value);
      environment = r.environment;
      closeOverlay();
      render(true);
      toast('备份名称已更新');
      break;
    }
    case 'restore': {
      await restoreBackupPreview(id);
      break;
    }
    case 'recover-restore': {
      const result = await call('recoverRestore');
      if (!result.cancelled) {
        environment = result.environment;
        render(true);
        toast('中断的恢复已回退，安全副本仍然保留');
      }
      break;
    }
    case 'reconnect-detected': {
      const result = await call('useDetectedSaves', id);
      state = result.state;
      environment = result.environment;
      invalidateBackupPreview('存档来源已改变，旧预览已失效。请重新校验后再恢复。');
      referenceSaveName = undefined;
      referenceSave = null;
      render(true);
      toast('已重新连接存档');
      return true;
    }
    case 'choose-saves': {
      const result = await call('chooseSaves');
      if (!result.cancelled) {
        state = result.state;
        environment = result.environment;
        invalidateBackupPreview('存档来源已改变，旧预览已失效。请重新校验后再恢复。');
        referenceSaveName = undefined;
        referenceSave = null;
        render(true);
        toast('已连接存档目录');
      }
      return !result.cancelled;
    }
    case 'refresh':
      await refresh();
      toast('已刷新本机存档');
      break;
    case 'backup-page':
      invalidateBackupPreview('列表页已改变，旧预览已失效。请重新校验后再恢复。');
      backupView.page = Math.max(0, Number(id) || 0);
      render(true);
      break;
    case 'historical-backup-page':
      historyBackupView.page = Math.max(0, Number(id) || 0);
      render(true);
      break;
    case 'backup-selection': {
      const selected = new Set(backupView.selected);
      if (selected.has(id)) selected.delete(id);
      else {
        if (selected.size >= 1000) throw Error('每批最多选择 1000 份，请先导出这一批');
        selected.add(id);
      }
      backupView.selected = [...selected];
      render(true);
      break;
    }
    case 'backup-select-page': {
      const filtered = backupViews.filtered(environment.backups, backupView);
      const page = Math.min(backupView.page, Math.max(0, Math.ceil(filtered.length / 20) - 1));
      const selected = new Set(backupView.selected);
      for (const backup of filtered.slice(page * 20, page * 20 + 20)) selected.add(backup.id);
      if (selected.size > 1000) throw Error('每批最多选择 1000 份，请先导出这一批');
      backupView.selected = [...selected];
      render(true);
      break;
    }
    case 'backup-selection-clear':
      backupView.selected = [];
      render(true);
      break;
    case 'backup-lock':
    case 'backup-unlock': {
      const result = await call('lockBackup', id, action === 'backup-lock');
      if (!result.cancelled) {
        environment = result.environment;
        render(true);
        toast(result.locked ? '这份副本已锁定' : '这份副本已解锁，原件继续保留');
      }
      break;
    }
    case 'backup-cleanup-selected': {
      await saveNote();
      const ids = [...backupView.selected];
      try {
        const result = await call('cleanupBackups', ids);
        if (result.environment) environment = result.environment;
        if (!result.cancelled) {
          backupView.selected = backupView.selected.filter((id) => !ids.includes(id));
          toast('所选 ' + result.count + ' 份副本已导出留底并清理');
        } else if (result.exported) toast('保护包已导出，所选本机副本继续保留');
      } finally {
        await refresh();
      }
      break;
    }
    case 'backup-cleanup-rollback':
    case 'backup-cleanup-finish': {
      try {
        const result = await call(
          'recoverBackupCleanup',
          id,
          action === 'backup-cleanup-rollback' ? 'rollback' : 'finish',
        );
        if (!result.cancelled) {
          environment = result.environment;
          toast(
            result.phase === 'rolled-back'
              ? '全部暂存副本已放回列表'
              : '这批副本清理已完成，导出留底继续保留',
          );
        }
      } finally {
        await refresh();
      }
      break;
    }
    case 'backup-export-selected': {
      await saveNote();
      const ids = backupView.selected.filter((id) => environment.backups.some((b) => b.id === id));
      const result = await call('exportSelectedBackups', ids);
      if (!result.cancelled)
        toast('所选 ' + result.backups.length + ' 份完整备份及手札已校验并导出，原件保留');
      break;
    }
    case 'auto-backup':
      await mutation({ type: 'settings', value: { autoBackup: !state.settings.autoBackup } });
      toast(
        state.settings.autoBackup ? '完整自动备份已开启，立即检查存档，之后每分钟核对' : '自动备份已关闭',
      );
      break;
    case 'spoiler':
      await mutation({
        type: 'settings',
        value: { spoiler: state.settings.spoiler === 'hints' ? 'details' : 'hints' },
      });
      break;
    case 'folder':
      await call('openFolder', id);
      break;
    case 'source':
      await call('openSource', id);
      break;
    case 'export': {
      captureJournalDraft();
      captureIntentDrafts();
      await flushJournalDrafts();
      await flushIntentDrafts();
      await Promise.all([...drafts.keys()].map(saveNote));
      const r = await call('exportJournal');
      if (!r.cancelled) toast('全部周目已导出');
      break;
    }
    case 'protection-open':
      await saveNote();
      route = 'archives';
      closeOverlay();
      await loadProtectionList();
      break;
    case 'protection-history': {
      const token = ++protectionRequest;
      protectionView.error = '';
      const history = await call('protectionHistory', id);
      if (token !== protectionRequest) break;
      protectionView.history = history;
      protectionView.backupId = '';
      protectionView.journalProfileId = '';
      historyJournalView = { query: '', from: '', to: '', kind: '', tag: '', page: 1 };
      protectionView.nodePage = 0;
      route = 'archives';
      render();
      break;
    }
    case 'protection-backup-select':
      protectionView.backupId = id;
      render(true);
      break;
    case 'protection-archive-page':
      protectionView.archivePage = Math.max(0, Number(id) || 0);
      render(true);
      break;
    case 'protection-node-page':
      protectionView.nodePage = Math.max(0, Number(id) || 0);
      render(true);
      break;
    case 'protection-backup-inspect':
    case 'protection-node-inspect': {
      const history = protectionView.history;
      if (!history) throw Error('请先打开离线档案');
      const file = await call(
        'protectionInspect',
        history.id,
        action === 'protection-backup-inspect' ? 'backup' : 'timeline',
        action === 'protection-backup-inspect' ? protectionView.backupId : id,
        action === 'protection-backup-inspect' ? id : undefined,
      );
      if (protectionView.history !== history || route !== 'archives') break;
      showOverlay(protectionViews.preview(file), true);
      break;
    }
    case 'protection-history-export': {
      const result = await call('exportHistoricalProtection', id);
      if (!result.cancelled)
        toast(`历史保护包已校验 · ${result.backups.length} 份备份 · ${result.nodes} 个节点`);
      break;
    }
    case 'protection-export': {
      if (protectionView.exportResultOverride?.status === 'running') {
        toast('正在导出全部保护资料，请等待本次操作完成。', true);
        break;
      }
      const request = ++protectionExportRequest;
      const previousResult = protectionView.exportResultOverride;
      captureJournalDraft();
      captureIntentDrafts();
      await flushJournalDrafts();
      await flushIntentDrafts();
      await Promise.all([...drafts.keys()].map(saveNote));
      if (request !== protectionExportRequest) break;
      const attemptAt = Date.now();
      protectionView.exportResultOverride = {
        schema: 1,
        status: 'running',
        at: attemptAt,
        file: '',
        message: '本次完整导出正在选择、校验或生成中，尚未确认完成。',
      };
      render(true);
      let result;
      try {
        result = await call('exportProtection');
      } catch (error) {
        if (request !== protectionExportRequest) break;
        protectionView.exportResultOverride = error.exportResult || {
          schema: 1,
          status: 'failed',
          at: Date.now(),
          file: '',
          code: error.code,
          message: error.message,
          backupId: error.backupId,
          diagnostic: error.message,
          published: !!error.published,
          recordNotSaved: true,
        };
        render();
        await refresh().catch(() => {});
        if (request !== protectionExportRequest) break;
        toast(
          error.published
            ? '保护包已生成，但结果记录未保存。请核对目标文件并查看诊断。'
            : '完整导出未完成，请查看页面中的具体原因；原件仍保留。',
          true,
        );
        break;
      }
      if (request !== protectionExportRequest) break;
      protectionView.exportResultOverride = result.exportResult || (result.cancelled ? previousResult : null);
      if (!result.cancelled) {
        protectionView.omittedArchives = result.omittedArchives || [];
        render(true);
        await refresh();
        if (request !== protectionExportRequest) break;
        render(true);
        toast(
          `保护包已校验${result.volumes > 1 ? ' · ' + result.volumes + ' 卷，请完整带走分卷目录' : ''} · 本机 ${result.backups.length} 份完整备份 · ${result.nodes} 个节点${result.historicalArchives ? ` · ${result.historicalArchives} 份已校验历史档案` : ''}${result.omittedArchives?.length ? ` · 未包含 ${result.omittedArchives.length} 份异常历史档案，原件仍在本机` : ''}`,
        );
      } else render(true);
      break;
    }
    case 'protection-import-volumes':
    case 'protection-import': {
      await saveNote();
      const mode = action === 'protection-import-volumes' ? 'directory' : 'files';
      let result;
      try {
        result = await call('importProtection', mode);
      } catch (error) {
        const checksum = error.code === 'PROTECTION_CHECKSUM_MISMATCH';
        const failure = {
          message: checksum
            ? '保护包校验失败，文件可能损坏或没有复制完整。'
            : error.code === 'PROTECTION_FORMAT_UNSUPPORTED'
              ? '这不是逸剑手札保护包。请选择由“导出全部保护资料”生成的文件；若是分卷目录，请使用“导入分卷目录”。'
              : error.code === 'PROTECTION_PACKAGE_TRUNCATED'
                ? '保护包没有复制完整或已损坏，请重新复制完整原包；分卷需要带齐整个目录。'
                : error.code === 'PROTECTION_METADATA_INVALID'
                  ? '保护包里的资料清单损坏或不完整，请重新复制完整保护包。'
                  : /[\u3400-\u9fff]/.test(error.message)
                    ? error.message
                    : '未能导入这份保护资料，请查看详情并核对文件。',
          diagnostic: error.message,
          mode,
        };
        protectionView.importFailure = failure;
        route = 'archives';
        await loadProtectionList();
        if (protectionView.importFailure === failure) toast(failure.message, true);
        break;
      }
      if (!result.cancelled) {
        protectionView.importFailure = null;
        protectionView.archives = result.archives;
        protectionView.retainedUnverifiedArchives = result.retainedUnverifiedArchives || [];
        protectionView.loaded = true;
        protectionView.history = await call('protectionHistory', result.id);
        protectionView.backupId = '';
        protectionView.journalProfileId = '';
        historyJournalView = { query: '', from: '', to: '', kind: '', tag: '', page: 1 };
        protectionView.nodePage = 0;
        route = 'archives';
        render();
        toast(
          `离线档案已保存${result.historicalArchives ? `，含 ${result.historicalArchives} 份以前的档案` : ''}${result.reusedArchives ? `；${result.reusedArchives} 份已存档案校验后沿用` : ''}${result.retainedUnverifiedArchives?.length ? `；${result.retainedUnverifiedArchives.length} 份未通过校验的旧档案原样保留，已另存可用档案` : ''}。当前手札与游戏进度未改动`,
        );
      }
      break;
    }
    case 'protection-import-error-dismiss':
      protectionView.importFailure = null;
      render();
      break;
    case 'protection-use-journal': {
      captureJournalDraft();
      captureIntentDrafts();
      await flushJournalDrafts();
      await flushIntentDrafts();
      await Promise.all([...drafts.keys()].map(saveNote));
      const result = await call('useHistoricalJournal', id);
      if (!result.cancelled) {
        state = result.state;
        await refresh();
        toast('历史手札已使用，替换前的本机手札副本已保留');
      }
      break;
    }
    case 'protection-restore': {
      const history = protectionView.history;
      if (!history) throw Error('请先打开离线档案');
      const result = await call('restoreHistoricalBackup', history.id, id);
      if (!result.cancelled) {
        environment = result.environment;
        render(true);
        toast('完整备份已恢复，恢复前的完整进度已保留');
      }
      break;
    }
    case 'import': {
      captureJournalDraft();
      captureIntentDrafts();
      await flushJournalDrafts();
      await flushIntentDrafts();
      await Promise.all([...drafts.keys()].map(saveNote));
      const r = await call('importJournal');
      if (!r.cancelled) {
        state = r.state;
        render();
        toast(
          r.resetReferences
            ? `手札已导入，原记录副本已保留；${r.resetReferences} 个周目已改为跟随最新存档，可在周目管理重新选择参照`
            : '手札已导入，原记录副本已保留',
        );
      }
      break;
    }
    case 'launch':
      await call('launchGame');
      toast('已请求 Steam 启动逸剑风云决');
      break;
    case 'compact':
      await saveNote();
      await call('compact');
      break;
    case 'companion-collapse':
      closeOverlay();
      await call('companionCollapse');
      break;
    case 'companion-enabled':
      await mutation({
        type: 'settings',
        value: { companionEnabled: state.settings.companionEnabled === false },
      });
      break;
    case 'main':
      await call('window', 'main');
      break;
    case 'window-minimize':
      await saveNote();
      await call('window', 'minimize');
      break;
    case 'window-maximize':
      await call('window', 'maximize');
      break;
    case 'window-close':
      captureJournalDraft();
      await flushJournalDrafts();
      await saveNote();
      await call('window', 'close');
      break;
  }
}
document.addEventListener('submit', async (event) => {
  if (
    !['journal-entry-form', 'journal-filter-form', 'historical-journal-filter-form'].includes(event.target.id)
  )
    return;
  event.preventDefault();
  try {
    await handle(
      event.target.id === 'journal-entry-form'
        ? 'journal-entry-save'
        : event.target.id === 'historical-journal-filter-form'
          ? 'historical-journal-filter'
          : 'journal-filter',
    );
  } catch (e) {
    toast(e.message, true);
  }
});
document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) {
    if (event.target.dataset.backdrop) dismissOverlay();
    return;
  }
  if (target.disabled) return;
  const navigationFocused =
    document.activeElement === target &&
    target.matches('.sidebar-nav .nav-btn, .companion-tabs [data-action="navigate"]');
  const action = target.dataset.action,
    id = target.dataset.id;
  if (currentDrawer?.type === 'search' && target.classList.contains('search-result'))
    currentDrawer.selection = { action, id };
  const lock = ![
    'detail',
    'search',
    'close-overlay',
    'filter',
    'kind',
    'stage',
    'stage-change',
    'reveal',
    'goal-add',
    'goal-edit',
    'goal-place-edit',
    'profiles',
  ].includes(action);
  if (lock) target.disabled = true;
  try {
    await handle(action, id, target, navigationFocused);
  } catch (e) {
    toast(e.message, true);
  } finally {
    target.disabled = false;
  }
});
document.addEventListener('input', (event) => {
  if (event.target.hasAttribute('data-journey-trash-query') && !event.isComposing && !composing) {
    if (event.target.dataset.journeyTrashQuery === 'history')
      historicalJourneyTrashViews.set(event.target.dataset.profileId, { query: event.target.value, page: 1 });
    else Object.assign(journeyTrashView, { query: event.target.value, page: 1 });
    render(true);
    return;
  }
  if (event.target.closest('.personal-intent-editor')) captureIntentEditor(activeIntentEditor);
  if (
    ['journal-revision-query', 'historical-journal-revision-query'].includes(event.target.id) &&
    !event.isComposing &&
    !composing
  ) {
    const view = event.target.id.startsWith('historical-') ? historyJournalView : journalView;
    view.revisionQuery = event.target.value;
    view.revisionPage = 1;
    render(true);
    return;
  }
  if (
    ['journal-trash-query', 'historical-journal-trash-query'].includes(event.target.id) &&
    !event.isComposing &&
    !composing
  ) {
    const view = event.target.id.startsWith('historical-') ? historyJournalView : journalView;
    view.trashQuery = event.target.value;
    view.trashPage = 1;
    render(true);
    return;
  }
  if (event.target.hasAttribute('data-itinerary-draft')) {
    itineraryFormDrafts.set(itineraryDraftKey(event.target.id), event.target.value);
    captureIntentEditor(itineraryIntentEditors.get(intentEditorKey(event.target.id)));
    return;
  }
  if (event.target.id === 'recipe-discovery-search' && !event.isComposing && !composing) {
    recipeDiscoveryView.options.query = event.target.value;
    recipeDiscoveryView.options.page = 1;
    clearTimeout(recipeDiscoveryTimer);
    recipeDiscoveryTimer = setTimeout(() => refreshRecipeDiscovery(), 250);
    return;
  }
  if (event.target.matches('[data-recipe-discovery-quantity]')) {
    if (event.target.checkValidity()) {
      recipeDiscoveryView.options.quantities[event.target.dataset.recipeDiscoveryQuantity] = Number(
        event.target.value,
      );
      clearTimeout(recipeDiscoveryTimer);
      recipeDiscoveryTimer = setTimeout(() => refreshRecipeDiscovery(), 250);
    }
    return;
  }
  if (event.target.id === 'journey-place-search') {
    refreshPlacePicker();
    return;
  }
  if (['journey-person-search', 'journey-item-search'].includes(event.target.id)) {
    refreshGiftPicker(event.target.id === 'journey-person-search' ? 'person' : 'item');
    return;
  }
  if (event.target.closest('#journal-entry-form') && event.target.id !== 'journal-reference-query') {
    captureJournalDraft();
    return;
  }
  if (event.target.id === 'journey-search' && !event.isComposing && !composing) {
    journeyView.query = event.target.value;
    render(true);
    return;
  }
  if (['timeline-label', 'timeline-note'].includes(event.target.id)) {
    captureNodeDraft();
    return;
  }
  if (event.target.id === 'world-search' && !event.isComposing && !composing) {
    worldView.query = event.target.value;
    worldView.page = 0;
    render(true);
    return;
  }
  if (event.target.id === 'journal-reference-query' && !event.isComposing && !composing) {
    const results = document.querySelector('#journal-reference-results');
    if (results)
      results.innerHTML = eventJournalViews.referenceResults(profile(), journalIndex(), event.target.value);
    return;
  }
  if (
    ['backup-search', 'historical-backup-search'].includes(event.target.id) &&
    !event.isComposing &&
    !composing
  ) {
    const view = event.target.id === 'backup-search' ? backupView : historyBackupView;
    view.query = event.target.value;
    view.page = 0;
    render(true);
    return;
  }
  if (event.target.id === 'craft-search' && !event.isComposing && !composing) {
    materialView.query = event.target.value;
    materialView.searchPage = 0;
    render(true);
    return;
  }
  if (event.target.id === 'compare-inventory-search' && comparisonState?.result) {
    comparisonState.query = event.target.value;
    document.querySelector('#compare-inventory-results').innerHTML = comparisonViews.inventory(
      comparisonState.result,
      gameIndex,
      comparisonState.query,
      comparisonState.filter,
    );
  }
  if (event.target.id === 'compare-quest-search' && comparisonState?.result) {
    comparisonState.questQuery = event.target.value;
    document.querySelector('#compare-quest-results').innerHTML = comparisonViews.quests(
      comparisonState.result,
      comparisonState.questQuery,
    );
  }
  if (event.target.id === 'save-inventory-search') {
    document.querySelector('#save-inventory-results').innerHTML = gameViews.inventoryList(
      selectedSave.metadata.inventory,
      event.target.value,
      gameIndex,
    );
    return;
  }
  if (event.target.id === 'recipe-quantity') {
    event.target.setCustomValidity('');
    try {
      const e = gameViews.byId(gameIndex, databaseId);
      const n = recipeQuantity();
      document.querySelector('#recipe-materials').innerHTML = gameViews.recipeMaterials(
        e,
        n,
        gameIndex,
        reservableReference(referenceSave),
      );
      event.target.setCustomValidity('');
    } catch (e) {
      event.target.setCustomValidity(e.message);
      document.querySelector('#recipe-materials').innerHTML = notice(
        '填写 1 至 999 的整数制作次数后查看材料与预计总产物。',
      );
    }
    return;
  }
  if (event.target.id === 'note') {
    const id = event.target.dataset.profileId;
    const owner = state.profiles.find((row) => row.id === id);
    if (!owner) return;
    const previous = drafts.get(id) ?? owner.notes;
    const value = event.target.value;
    const cleared = previous.trim() && !value.trim();
    if (cleared)
      pendingNoteClears.set(
        id,
        [
          ...(pendingNoteClears.get(id) || []).filter((row) => row.body !== previous),
          { body: previous },
        ].slice(-20),
      );
    noteVersions.set(id, (noteVersions.get(id) || 0) + 1);
    drafts.set(id, value);
    const status = document.querySelector('#note-status');
    if (status) status.textContent = '正在保存…';
    clearTimeout(noteTimer);
    if (cleared) saveNote(id).catch(() => {});
    else noteTimer = setTimeout(() => saveNote(id).catch(() => {}), 700);
  }
  if (event.target.id === 'list-search' && !event.isComposing && !composing) {
    query = event.target.value;
    databasePage = 0;
    render(true);
  }
  if (event.target.id === 'global-search' && !event.isComposing && !composing)
    showSearchResults(event.target.value);
  if (['shortcut-save', 'shortcut-history'].includes(event.target.id))
    shortcutDrafts[event.target.id.slice(9)] = event.target.value;
  if (event.target.id === 'timeline-search' && !event.isComposing && !composing) {
    timelineView.query = event.target.value;
    timelineView.page = 0;
    render(true);
  }
});
document.addEventListener('compositionstart', () => {
  composing = true;
});
document.addEventListener('compositionend', (event) => {
  composing = false;
  captureIntentDrafts();
  if (event.target.hasAttribute('data-journey-trash-query')) {
    if (event.target.dataset.journeyTrashQuery === 'history')
      historicalJourneyTrashViews.set(event.target.dataset.profileId, { query: event.target.value, page: 1 });
    else Object.assign(journeyTrashView, { query: event.target.value, page: 1 });
  }
  if (['journal-revision-query', 'historical-journal-revision-query'].includes(event.target.id)) {
    const view = event.target.id.startsWith('historical-') ? historyJournalView : journalView;
    view.revisionQuery = event.target.value;
    view.revisionPage = 1;
  }
  if (['journal-trash-query', 'historical-journal-trash-query'].includes(event.target.id)) {
    const view = event.target.id.startsWith('historical-') ? historyJournalView : journalView;
    view.trashQuery = event.target.value;
    view.trashPage = 1;
  }
  if (event.target.id === 'global-search') showSearchResults(event.target.value);
  if (event.target.id === 'world-search') {
    worldView.query = event.target.value;
    worldView.page = 0;
  }
  if (event.target.id === 'craft-search') materialView.query = event.target.value;
  if (event.target.id === 'list-search') query = event.target.value;
  if (event.target.id === 'timeline-search') {
    timelineView.query = event.target.value;
    timelineView.page = 0;
  }
  render(true);
});
document.addEventListener('change', async (event) => {
  if (event.target.closest('.personal-intent-editor')) captureIntentEditor(activeIntentEditor);
  if (event.target.hasAttribute('data-itinerary-draft')) {
    itineraryFormDrafts.set(itineraryDraftKey(event.target.id), event.target.value);
    captureIntentEditor(itineraryIntentEditors.get(intentEditorKey(event.target.id)));
    return;
  }
  if (event.target.id === 'recipe-discovery-craft') {
    await refreshRecipeDiscovery({ craft: event.target.value, page: 1 });
    return;
  }
  if (event.target.id === 'recipe-discovery-learned') {
    await refreshRecipeDiscovery({ learned: event.target.value, page: 1 });
    return;
  }
  if (event.target.id === 'recipe-discovery-target-plan') {
    recipeDiscoveryView.targetPlanId = event.target.value;
    render(true);
    return;
  }
  if (event.target.id === 'journey-place' && journeyDraft?.placePicker) {
    journeyDraft.placePicker.selectedId = event.target.value;
    refreshPlacePicker(journeyDraft.placePicker.page);
    return;
  }
  if (
    [
      'journey-person',
      'journey-item',
      'journey-item-quality',
      'journey-item-preferred',
      'journey-item-stock',
    ].includes(event.target.id)
  ) {
    const kind = event.target.id === 'journey-person' ? 'person' : 'item';
    if (journeyDraft?.giftPicker?.[kind] && ['journey-person', 'journey-item'].includes(event.target.id))
      journeyDraft.giftPicker[kind].selectedId = event.target.value;
    refreshGiftPicker(kind, journeyDraft?.giftPicker?.[kind]?.page);
    if (kind === 'person') refreshGiftPicker('item');
    return;
  }
  const backupFilter = /^(historical-backup|backup)-(kind|from|to|lock)$/.exec(event.target.id);
  if (backupFilter) {
    const view = backupFilter[1] === 'backup' ? backupView : historyBackupView;
    view[backupFilter[2]] = event.target.value;
    view.page = 0;
    render(true);
    return;
  }
  if (event.target.id === 'reading-scale') {
    const value = Number(event.target.value);
    const next = readingScaleQueue
      .catch(() => {})
      .then(() => mutation({ type: 'settings', value: { readingScale: value } }));
    readingScaleQueue = next;
    try {
      await next;
    } catch (e) {
      toast(e.message, true);
      render(true);
    }
    return;
  }
  if (['companion-position', 'companion-opacity'].includes(event.target.id)) {
    const value =
      event.target.id === 'companion-position'
        ? { companionPosition: event.target.value }
        : { compactOpacity: Number(event.target.value) };
    try {
      await mutation({ type: 'settings', value });
    } catch (e) {
      toast(e.message, true);
      render(true);
    }
    return;
  }
  if (event.target.id === 'timeline-filter') {
    timelineView.kind = event.target.value;
    timelineView.page = 0;
    render(true);
    return;
  }
  if (event.target.id === 'timeline-interval') {
    try {
      const result = await call('timelineConfigure', {
        enabled: environment.timeline.enabled,
        interval: Number(event.target.value),
      });
      if (!result.cancelled) environment = result.environment;
      render(true);
    } catch (e) {
      toast(e.message, true);
      render(true);
    }
    return;
  }
  if (['person-save', 'item-save'].includes(event.target.id)) {
    referenceFollow = event.target.value === '@latest';
    referenceSaveName = referenceFollow ? latestReference() : event.target.value;
    referenceSave = null;
    await showDatabaseDetail(databaseId);
    return;
  }
  if (event.target.classList.contains('craft-count')) {
    const id = event.target.dataset.id,
      quantity = Number(event.target.value),
      profileId = profile().id;
    invalidateMaterials();
    try {
      await mutation({ type: 'craft-set', id, quantity, profileId });
    } catch (e) {
      toast(e.message, true);
      render(true);
    }
    return;
  }
  if (event.target.id === 'craft-save') {
    invalidateMaterials();
    materialView.follow = event.target.value === '@latest';
    materialView.referenceName = materialView.follow ? latestReference() : event.target.value;
    render(true);
    return;
  }
  if (event.target.id === 'world-save') {
    await loadWorldReference(event.target.value);
    return;
  }
  if (event.target.id === 'world-status') {
    worldView.status = event.target.value;
    worldView.page = 0;
    render(true);
    return;
  }
  if (event.target.id === 'world-scope') {
    worldView.roots = event.target.value === 'roots';
    worldView.page = 0;
    render(true);
    return;
  }
  if (['compare-left', 'compare-right'].includes(event.target.id) && comparisonState) {
    detailRequest++;
    comparisonState[event.target.id === 'compare-left' ? 'left' : 'right'] = event.target.value;
    comparisonState.result = null;
    document.querySelector('#compare-status').textContent = '';
    document.querySelector('#comparison-result').innerHTML =
      '<p class="save-note">所选槽位已改变，请点击「比较记录」。</p>';
    return;
  }
  if (event.target.id === 'recipe-save') {
    try {
      referenceFollow = event.target.value === '@latest';
      referenceSaveName = referenceFollow ? latestReference() : event.target.value;
      await showDatabaseDetail(databaseId, currentDrawer?.quantity || 1);
    } catch (e) {
      event.target.value = referenceFollow ? '@latest' : referenceSaveName || '';
      toast(e.message, true);
    }
    return;
  }
  if (event.target.id === 'database-type') {
    databaseType = event.target.value;
    databasePage = 0;
    render(true);
  }
  if (event.target.id === 'detected-save') {
    try {
      const r = await call('useDetectedSaves', event.target.value);
      state = r.state;
      environment = r.environment;
      invalidateBackupPreview('存档来源已改变，旧预览已失效。请重新校验后再恢复。');
      referenceSaveName = undefined;
      referenceSave = null;
      render();
      toast('已切换存档目录');
    } catch (e) {
      toast(e.message, true);
    }
  }
});
document.addEventListener('keydown', (event) => {
  if (event.isComposing || composing) return;
  if ((event.ctrlKey || event.metaKey) && !event.altKey && ['=', '+', '-', '0'].includes(event.key)) {
    event.preventDefault();
    changeReadingScale(event.key === '0' ? 'reset' : event.key === '-' ? 'out' : 'in').catch((e) =>
      toast(e.message, true),
    );
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    searchModal();
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    if (compact && !overlay.firstChild) {
      escapeCollapse = true;
      return;
    }
    dismissOverlay();
    return;
  }
  if (overlay.querySelector('#global-search')) {
    if (event.target.id === 'global-search' && searchSuggestions.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        searchSuggestionIndex =
          (searchSuggestionIndex + (event.key === 'ArrowDown' ? 1 : -1) + searchSuggestions.length) %
          searchSuggestions.length;
        renderSearchSuggestions();
        return;
      }
      if (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey)) {
        event.preventDefault();
        applySearchSuggestion(searchSuggestions[Math.max(0, searchSuggestionIndex)]);
        return;
      }
    }
    const results = [...overlay.querySelectorAll('.search-result')];
    const index = results.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' && results.length) {
      event.preventDefault();
      results[Math.min(index + 1, results.length - 1)].focus();
      return;
    }
    if (event.key === 'ArrowUp' && index >= 0) {
      event.preventDefault();
      (results[index - 1] || overlay.querySelector('#global-search')).focus();
      return;
    }
    if (event.key === 'Enter' && event.target.id === 'global-search' && results.length) {
      event.preventDefault();
      results[0].click();
      return;
    }
  }
  if (event.key === 'Enter' && event.target.matches('input') && overlay.firstChild) {
    const submit = overlay.querySelector(
      '[data-action="goal-save"],[data-action="profile-rename-save"],[data-action="backup-confirm"],[data-action="backup-rename-save"]',
    );
    if (submit) {
      event.preventDefault();
      submit.click();
      return;
    }
  }
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('.entry-card')) {
    event.preventDefault();
    showDetail(event.target.dataset.id);
    return;
  }
  if (event.key === 'Tab' && overlay.firstChild) {
    const focusable = [
      ...overlay.querySelectorAll('button,input,textarea,select,summary,[tabindex="0"]'),
    ].filter((e) => !e.disabled && e.getClientRects().length > 0);
    const first = focusable[0],
      last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }
});
let readingWheelAt = 0;
document.addEventListener(
  'wheel',
  (event) => {
    if (!event.ctrlKey || event.altKey || event.isComposing || composing || !event.deltaY) return;
    event.preventDefault();
    if (Date.now() - readingWheelAt < 180) return;
    readingWheelAt = Date.now();
    changeReadingScale(event.deltaY < 0 ? 'in' : 'out').catch((e) => toast(e.message, true));
  },
  { passive: false },
);
let escapeCollapse = false;
document.addEventListener('keyup', (event) => {
  if (
    event.target.id === 'global-search' &&
    ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) &&
    !event.isComposing &&
    !composing
  )
    showSearchResults(event.target.value);
  if (compact && event.key === 'Escape') {
    event.preventDefault();
    if (escapeCollapse) {
      escapeCollapse = false;
      call('companionCollapse').catch((e) => toast(e.message, true));
    }
  }
});
window.addEventListener('beforeunload', (event) => {
  captureJournalDraft();
  captureIntentDrafts();
  if (drafts.size || pendingNodeDrafts.size || pendingJournalDrafts.size || pendingIntentDrafts.size) {
    const quitting = quitIntent;
    event.preventDefault();
    event.returnValue = false;
    Promise.all([
      flushNodeDrafts(),
      flushJournalDrafts(),
      flushIntentDrafts(),
      ...[...drafts.keys()].map((id) => saveNote(id)),
    ])
      .then(() => call('window', quitting ? 'quit' : 'close'))
      .catch((e) => {
        toast('退出前草稿未保存：' + e.message, true);
        if (quitting) handle('window-quit').catch((error) => toast(error.message, true));
      });
  }
});
try {
  const boot = await call('bootstrap');
  ({ catalog, gameIndex, state, environment, version } = boot);
  if (compact) {
    api.onCompanion((value) => {
      companionVisible = value.visible;
      if (companionMode === value.mode) return;
      companionMode = value.mode;
      if (companionMode === 'hint') closeOverlay();
      render(true);
      if (companionMode === 'expanded') refreshCompanion().catch(() => {});
    });
    companionData = await call('companionSnapshot');
    companionMode = companionData.mode;
  }
  render();
  if (environment.warning) toast(environment.warning, true);
  api.onState((next) => {
    const currentId = state.activeProfileId;
    const currentSlot = profile().saveSlot || '';
    const currentPath = state.settings.savePath;
    const currentBasket = planningIntentSignature();
    const currentMode = profile().referenceMode;
    state = next;
    const intentsChanged = currentBasket !== planningIntentSignature();
    if (compact) {
      companionData = null;
      ++companionRequest;
      refreshCompanion().catch(() => {});
    }
    if (intentsChanged) {
      invalidateMaterials();
      invalidateRecipeDiscovery();
    }
    if (
      currentId !== state.activeProfileId ||
      currentSlot !== (profile().saveSlot || '') ||
      currentMode !== profile().referenceMode ||
      currentPath !== state.settings.savePath
    ) {
      invalidateBackupPreview('存档来源或回顾选择已改变，旧预览已失效。请重新校验后再恢复。');
      resetPlanningViews();
      if (currentId !== state.activeProfileId) {
        closeOverlay();
        journeyDraft = null;
        journeyView = { query: '', place: '', completed: false };
        journeyTrashView = { open: false, query: '', page: 1 };
        journeyTrashConfirmation = null;
      }
      referenceSaveName = undefined;
      referenceSave = null;
      environment.recent = null;
      refresh().catch((e) => toast(e.message, true));
    } else if (intentsChanged) refresh().catch((e) => toast(e.message, true));
    render(true);
    if (currentDrawer?.type === 'search' && !composing) showSearchResults(currentDrawer.query);
  });
  api.onEvent((event) => {
    if (event.type === 'protection') {
      protectionView.busy = event.busy;
      protectionView.label = event.label;
      render(true);
    }
    if (event.type === 'health') updateHealth(event.health);
    if (event.type === 'error') toast(event.text, true);
    if (document.hidden && event.type !== 'error') return;
    if (['backup', 'error', 'auto-status', 'timeline', 'operation'].includes(event.type))
      refresh().catch((e) => toast(e.message, true));
  });
  api.onQuitRequested(({ cancelled }) => {
    quitIntent = !cancelled;
    if (cancelled) {
      const discard = document.querySelector('[data-action="window-quit-discard"]');
      if (discard) discard.disabled = false;
    }
    return cancelled ? false : prepareQuit();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh().catch((e) => toast(e.message, true));
  });
  api.onAction(async ({ action }) => {
    if (action === 'hide') {
      captureJournalDraft();
      captureIntentDrafts();
      try {
        await flushJournalDrafts();
        await flushIntentDrafts();
        closeOverlay();
      } catch (error) {
        await call('window', 'main');
        toast('草稿未保存，编辑窗口已保留：' + error.message, true);
      }
      return;
    }
    closeOverlay();
    route = 'saves';
    try {
      await refresh();
      if (action === 'return') {
        const id = environment.timeline.returnRecord?.id;
        if (!id) {
          toast('尚无读档前进度');
          return;
        }
        const result = await call('timelineInspect', id);
        rememberDrawer({ type: 'timeline', data: result });
        showOverlay(timelineViews.preview(result), true);
      }
    } catch (e) {
      toast(e.message, true);
    }
  });
  setInterval(() => {
    if (compact && companionVisible) refreshCompanion().catch(() => {});
    if (!document.hidden)
      call('health')
        .then(updateHealth)
        .catch(() => {});
    if (
      ['home', 'saves', 'world', 'materials', 'database', 'journey', 'recipe-discovery'].includes(route) &&
      (!compact || route !== 'home') &&
      !document.hidden &&
      (currentDrawer || !document.activeElement?.matches('select,input,textarea'))
    )
      refresh().catch(() => {});
  }, 5000);
  await call('ready');
} catch (e) {
  root.innerHTML = `<div class="loading"><span class="seal">逸</span><h1>手札暂时无法打开</h1><p>${esc(e.message)}</p><p class="small muted">请关闭后重新打开；已有记录保存在本机数据目录。</p></div>`;
}
