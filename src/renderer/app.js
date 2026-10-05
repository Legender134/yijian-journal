import { createGameViews } from './game-views.js';
import { createComparisonViews } from './comparison-views.js';
import { createWorldViews } from './world-views.js';
import { createMaterialViews } from './material-views.js';
import { createGameImages } from './game-images.js';
import { createQualityText } from './quality.js';
import { createTimelineViews } from './timeline-views.js';
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
let databaseKind = '物品',
  databaseType = '全部',
  databasePage = 0,
  databaseId = null,
  selectedSave = null,
  referenceSaveName,
  referenceSave = null,
  detailRequest = 0;
let refreshRequest = 0;
let referenceFollow;
let nodeDraftQueue = Promise.resolve();
let compactUndo = null;
const pendingNodeDrafts = new Map();
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
    (a, b) => Number(a.done) - Number(b.done) || Number(!!b.pinned) - Number(!!a.pinned),
  );
const latestReference = () => readableSaves()[0]?.name || '';
const defaultFollow = () => profile().referenceMode !== 'none' && !profile().saveSlot;
let timelineView = { query: '', kind: 'all', page: 0 };
let shortcutDrafts = {};
let noteTimer,
  mutationQueue = Promise.resolve(),
  composing = false;
const drafts = new Map();
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
let worldRequest = 0,
  materialRequest = 0;
const drawerHistory = [];
function rememberDrawer(view, replace = false) {
  captureNodeDraft();
  if (currentDrawer && !replace) {
    if (currentDrawer.type === 'database') {
      const field = document.querySelector('#recipe-quantity');
      currentDrawer.quantity = field && Number(field.value) > 0 ? Number(field.value) : 1;
      currentDrawer.referenceName = referenceSaveName;
      currentDrawer.follow = referenceFollow;
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
  `<button class="${cls}${action === 'database-detail' && id ? ' pictured-link' : ''}" data-action="${action}"${id ? ` data-id="${esc(id)}"` : ''}>${action === 'database-detail' && id ? picture(id) + '<span>' + qualityText.html(id, label) + '</span>' : (glyph ? icon(glyph) : '') + label}</button>`;
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
    )}${act('shortcuts-save', '应用快捷键', 'btn', '', 'check')}</div><div class="setting-row"><div><h3>系统通知反馈</h3><p>手动保存完成或保存故障时给出静音系统通知；自动保存成功始终不提示。默认关闭。</p></div><button class="switch ${state.settings.saveFeedback ? 'on' : ''}" role="switch" aria-label="系统通知反馈" aria-checked="${!!state.settings.saveFeedback}" data-action="save-feedback"></button></div><p class="small muted">桌面「逸剑风云决 · 存档守护」同时打开游戏和手札。托盘角标：绿色就绪，黄色关闭或暂停，红色故障。</p><p class="small muted">支持 Ctrl+Alt+字母或 F1–F12，可加 Shift；留空停用。快捷键被占用时保留原设置。</p></section>`;
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
  return materialViews.page(gameIndex, profile(), materialView, readableSaves());
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
            ? worldViews.questDetail(gameIndex, currentDrawer.id, view, state.settings.spoiler === 'details')
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
      ? worldViews.questDetail(gameIndex, canonical, worldView, state.settings.spoiler === 'details')
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
  view.follow ??= defaultFollow();
  if (view.follow) view.referenceName = latestReference();
  view.referenceName ??= defaultReference();
  const name = view.referenceName;
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
      JSON.stringify(list) !== JSON.stringify(profile().craftList || [])
    )
      return;
    view.result = result;
    view.resultList = list;
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
    token = ++detailRequest;
  if (!e) return;
  if (e.kind === '配方' || e.kind === '人物') {
    referenceFollow ??= defaultFollow();
    if (referenceFollow) referenceSaveName = latestReference();
    if (referenceSaveName === undefined) referenceSaveName = defaultReference();
    referenceSave = null;
    if (referenceSaveName)
      try {
        referenceSave = await call('saveDetails', referenceSaveName);
      } catch (error) {
        toast(`未能读取对照存档：${error.message}`, true);
      }
  }
  if (token !== detailRequest) return;
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
      },
      currentDrawer?.type === 'database' && currentDrawer.id === id,
    );
    showOverlay(html, true, sameDrawer);
    if (quantityField && !validQuantity) {
      document.querySelector('#recipe-quantity').value = rawQuantity || '';
      document.querySelector('#recipe-materials').innerHTML =
        notice('填写 1 至 999 的整数制作次数后核对材料。');
    }
  }
}
function recipeQuantity() {
  const n = Number(document.querySelector('#recipe-quantity')?.value ?? '1');
  if (!Number.isSafeInteger(n) || n < 1 || n > 999) throw Error('制作次数须为 1 至 999');
  return n;
}
function reservableReference(ref) {
  if (!Array.isArray(ref?.metadata.inventory)) return ref;
  const remaining = { ...(profile().reservations || {}) };
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
function showBackupPreview(b) {
  rememberDrawer({ type: 'backup', data: b });
  const c = b.comparison,
    status = { unchanged: '一致', changed: '将覆盖', missing: '将补回', unknown: '未对照' };
  showOverlay(
    `<section class="drawer save-drawer" role="dialog" aria-modal="true" aria-label="备份预览"><div class="drawer-head"><span class="small muted">存档匣 / 备份预览</span>${iconButton('close-overlay', 'close', '关闭详情')}</div><div class="drawer-body"><div class="tag-row">${pill('校验已通过', 'green')}${pill(`${b.files.length} 个文件`)}</div><h1>${esc(b.label)}</h1><p class="small muted">创建于 ${when(b.createdAt)}</p><div class="detail-block"><h3>与当前存档的区别</h3>${c.available ? `<div class="comparison-grid"><div><strong>${c.changed}</strong><span>内容不同</span></div><div><strong>${c.missing}</strong><span>当前缺少</span></div><div><strong>${c.unchanged}</strong><span>完全一致</span></div></div><p class="save-note">恢复会覆盖备份中的同名文件；当前目录中额外的 ${c.extra} 个文件会保留。比较基于打开此预览时的文件内容。</p>` : notice(c.error || '连接对应存档目录后，可以比较文件差异。', true)}</div><div class="detail-block"><h3>这份副本里的存档</h3><div class="backup-file-list">${b.files.map((f) => `<div><span class="spacer"><strong>${esc(f.name)}${f.metadata ? ` · ${esc(f.metadata.mapName)}` : ''}</strong><small>${f.metadata ? hours(f.metadata.playSeconds) + ' · ' : ''}${when(f.modifiedAt)} · ${bytes(f.bytes)}</small></span>${pill(status[f.status], f.status === 'changed' ? 'orange' : f.status === 'unchanged' ? 'green' : '')}</div>`).join('')}</div></div><p class="small muted mono">原目录：${esc(b.source)}</p><div class="row mt">${act('backup-rename', '修改备份名称', 'btn', b.id, 'edit')}${act('backup-folder', '打开这份副本', 'btn', b.id, 'folder')}</div></div><div class="drawer-actions">${c.sameSource ? act('restore', '恢复这份存档', 'btn primary', b.id, 'refresh') : act('close-overlay', '关闭预览', 'btn primary')}${act('close-overlay', '先不恢复', 'btn')}</div></section>`,
    true,
  );
}
async function call(method, ...args) {
  const result = await api[method](...args);
  if (!result.ok) throw new Error(result.error);
  if (method === 'timelineInspect' && pendingNodeDrafts.has(args[0]))
    result.data.draft = pendingNodeDrafts.get(args[0]);
  return result.data;
}
function toast(text, error = false) {
  const div = document.createElement('div');
  div.className = `toast${error ? ' error' : ''}`;
  div.innerHTML = `${icon(error ? 'info' : 'check')}<span>${esc(text)}</span>`;
  const container = document.querySelector('#toasts');
  container.append(div);
  while (container.children.length > 2) container.firstElementChild.remove();
  setTimeout(() => div.remove(), error ? 7000 : 3300);
}
function mutation(command) {
  const profileId = profile().id;
  const task = mutationQueue.then(async () => {
    const previousBasket = JSON.stringify(profile().craftList || []);
    const next = await call('mutate', { ...command, profileId: command.profileId || profileId });
    state = next;
    if (previousBasket !== JSON.stringify(profile().craftList || []) || command.type === 'reserve-set')
      invalidateMaterials();
    if (['profile-add', 'profile-switch', 'save-slot'].includes(command.type)) {
      resetPlanningViews();
      referenceSaveName = undefined;
      referenceSave = null;
      await refresh();
    }
    render(true);
    return next;
  });
  mutationQueue = task.catch(() => {});
  return task;
}
function saveNote(id = profile().id) {
  clearTimeout(noteTimer);
  if (!drafts.has(id)) return Promise.resolve();
  const value = drafts.get(id);
  return mutation({ type: 'note', value, profileId: id })
    .then(() => {
      if (drafts.get(id) === value) drafts.delete(id);
      const el = document.querySelector('#note-status');
      if (el) el.textContent = '已保存到本机';
    })
    .catch((e) => {
      const el = document.querySelector('#note-status');
      if (el) el.textContent = '保存失败，内容仍在编辑区';
      toast(e.message, true);
      throw e;
    });
}
function noteBlock() {
  return `<div class="note-paper"><div class="row between"><h3>江湖随手记</h3>${icon('feather')}</div><textarea id="note" data-persist="note" maxlength="20000" aria-label="江湖随手记" placeholder="上次停在何处？下次想做什么？\n给未来的自己留句话。">${esc(drafts.get(profile().id) ?? profile().notes)}</textarea><div id="note-status" class="note-footer">${drafts.has(profile().id) ? '正在保存…' : '只存在这台电脑 · 自动保存'}</div></div>`;
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
  return `<section class="hero ${r ? 'has-save' : ''}"><div class="hero-copy"><div class="eyebrow">${r ? (environment.preferredSave ? '这一程的存档 · ' : '最近留下的江湖 · ') + esc(r.name) : '此去江湖 · 心中有数'}</div><h1>${r ? '上次，停在' + esc(r.mapName) + '。' : '走自己的路，<br>不错过在意的人。'}</h1><p>${r ? esc(r.mainQuest || '继续这一程的探索') + '<br>' + when(r.modifiedAt) + ' · ' + hours(r.playSeconds) : '记下此刻的进度，留意沿途的相遇。<br>每一件小事，都可以慢慢完成。'}</p><div class="row">${r ? act('save-detail', '回顾这份存档', 'btn primary', r.name, 'book') : act('stage', esc(stageTitle()) + ' ' + icon('chevron'), 'btn primary')}${act('navigate', '查看流程清单', 'text-btn', 'checklist', 'arrow')}</div></div>${landscape()}${r?.thumbnail ? `<div class="hero-memory"><img src="${r.thumbnail}" alt="最近存档的游戏场景"><span>这一程的片刻</span></div>` : '<div class="hero-seal">一剑一程<br>一页江湖</div>'}</section>`;
}
function homePage() {
  const p = profile(),
    done = Object.values(p.checks).filter((v) => v === 'done').length,
    list = pending().slice(0, 4),
    recent = environment.saves.files.find((f) => f.metadata);
  return `${pageHeader('A PERSONAL JIANGHU JOURNAL', '少侠，别来无恙。', '把琐事交给手札，把心思留给江湖。', act('launch', '启动游戏并守护存档', 'btn', '', 'game'))}
    ${environment.preferredSaveMissing ? notice(`当前周目指定的 ${environment.preferredSave} 暂时不可读。请重新选择默认回顾存档；不会自动改用其他槽位。`, true) : ''}
    ${homeHero()}
    <div class="home-save-choice"><span class="small muted">${profile().referenceMode === 'none' ? '本周目仅查资料，尚未绑定游戏存档' : profile().saveSlot ? '本周目默认回顾：' + esc(profile().saveSlot) : '默认回顾：最近修改的可读存档'}</span><div class="row">${act('save-slot', '选择回顾存档', 'text-btn', '', 'edit')}${act('refresh', '刷新存档', 'text-btn', '', 'refresh')}</div></div>
    <div class="stat-grid"><div class="stat"><div><div class="stat-label">已完成的精选清单</div><div class="stat-value">${done}<span>/ ${catalog.entries.filter((e) => e.checklist).length} 项</span></div></div><div class="stat-icon">${icon('scroll')}</div></div><div class="stat"><div><div class="stat-label">行囊里的收藏</div><div class="stat-value">${p.favorites.length}<span>条线索</span></div></div><div class="stat-icon">${icon('star')}</div></div><div class="stat"><div><div class="stat-label">已留存的存档副本</div><div class="stat-value">${environment.timeline?.count || 0}<span>个时间线节点 · ${environment.backups.length} 份完整备份</span></div></div><div class="stat-icon">${icon('archive')}</div></div></div>
    <div class="dashboard-grid"><div class="stack">${environment.recent?.activeQuests?.length ? `<section class="card"><div class="card-header"><h2>存档里的进行中任务</h2>${pill(environment.recent.pendingTasks + ' 项', 'green')}</div>${environment.recent.activeQuests.map((q) => `<div class="check-row"><div class="check-body"><button class="check-title" data-action="save-quest-jump" data-id="${q.id}">${esc(q.name)}</button><p class="check-description">${q.activeSteps?.length ? '当前步骤：' + q.activeSteps.map((s) => esc(s.name)).join('、') + '<br>主任务记录：' + esc(q.status) + ' · ' : ''}来自 ${esc(environment.recent.name)} · 点开查看记录</p></div>${iconButton('save-quest-jump', 'chevron', '查看这项任务的存档记录', String(q.id))}</div>`).join('')}<p class="save-note">只反映已经保存的任务状态；游戏内的新变化请先保存后刷新。</p></section>` : ''}<section class="card"><div class="card-header"><h2>继续前，留意这些</h2><span class="small muted">按手动阶段整理</span></div>${profile().stageConfirmed === false ? empty('先标记你的主线阶段', '选择阶段后再整理精选提醒。', act('stage', '选择阶段', 'btn soft', '', 'edit')) : list.length ? list.map(checkRow).join('') : empty('这一阶段的精选条目已处理', '可切换阶段，或添加你自己的目标。')}${act('navigate', '查看全部清单', 'text-btn', 'checklist', 'arrow')}</section><section class="card"><div class="card-header"><h2>下一步想做</h2>${act('goal-add', '记一件事', 'text-btn', '', 'plus')}</div>${
      orderedGoals()
        .filter((g) => !g.done)
        .slice(0, 2)
        .map(goalRow)
        .join('') ||
      empty(
        '给下一次出发留个目标',
        '找一本武学、见一位故人，或只是去一个没去过的地方。',
        act('goal-add', '添加我的第一个目标', 'btn soft', '', 'plus'),
      )
    }</section></div><div class="stack">${noteBlock()}<section class="card"><div class="card-header"><h2>存档守护</h2>${icon('shield')}</div><div class="home-protection"><span data-save-health>${timelineViews.chip(environment.health)}</span><p class="small muted">${environment.timeline?.count || 0} 个时间线节点 · ${bytes(environment.timeline?.bytes || 0)}<br>${environment.backups.length} 份完整保护副本 · ${bytes(environment.backups.reduce((sum, b) => sum + b.bytes, 0))}</p><div class="row wrap">${environment.timeline?.latest ? act('timeline-preview', '查看最近可靠记录', 'btn soft', environment.timeline.latest.id, 'eye') : ''}${act('navigate', '管理自动存读档', 'text-btn', 'saves', 'arrow')}</div></div><div class="save-summary"><div class="save-icon">${icon('archive')}</div><div><h3>${environment.saves.files.length ? `找到 ${environment.saves.files.filter((f) => f.name.endsWith('.sav')).length} 个存档文件` : '等待连接本机存档'}</h3><p>${recent ? `最近存档 · ${when(recent.modifiedAt)}` : '在设置中选择 SaveGames 文件夹'}</p></div></div>${act(environment.saves.files.length ? 'backup' : 'choose-saves', environment.saves.files.length ? '备份当前存档' : '连接存档目录', 'btn wide', '', 'download')}<div class="backup-auto-status"><div class="row">${icon('shield')}<strong>完整自动备份${backupStatus()}</strong>${act('navigate', '管理', 'text-btn', 'saves', 'arrow')}</div><p>这里管理已保存文件的完整备份。游戏内自动保存，请到存档匣的时间线中管理。</p></div><p class="save-note">重要选择前，可以在时间线中点击「立即保存」。</p></section></div></div>
    <div class="status-line"><span class="dot"></span>本地保存 · 无需登录 · ${esc(profile().name)}</div>`;
}
function stageStrip() {
  return `<div class="stage-strip">${catalog.stages.map((s) => `<button class="stage-step ${s.id === profile().stage && profile().stageConfirmed !== false ? 'active' : s.id < profile().stage ? 'past' : ''}" data-action="stage-change" data-id="${s.id}" title="${esc(s.sub)}"><span class="stage-dot">${s.id + 1}</span><span>${s.short}</span></button>`).join('')}</div>`;
}
function checklistPage() {
  let list = catalog.entries.filter((e) => e.checklist);
  if (filter === 'current')
    list = list.filter(
      (e) =>
        e.stage === profile().stage || (e.stage < profile().stage && e.checkpoint && !profile().checks[e.id]),
    );
  if (filter === 'pending') list = list.filter((e) => !profile().checks[e.id]);
  if (filter === 'done') list = list.filter((e) => profile().checks[e.id] === 'done');
  if (filter === 'skip') list = list.filter((e) => profile().checks[e.id] === 'skip');
  if (query) list = list.filter(matchesQuery);
  return `${pageHeader('THE JOURNEY', '流程防漏', '在主线向前之前，回头看看值得记住的小事。', act('stage', '调整当前进度', 'btn', '', 'edit'))}${stageStrip()}${notice('阶段由你手动选择。这里只列精选提醒；较早阶段的未处理条目会保留供核对，不代表已经错过。', true)}<div class="toolbar">${[
    ['current', '当前阶段'],
    ['pending', '全部待办'],
    ['done', '已完成'],
    ['skip', '暂不做'],
    ['all', '全部'],
  ]
    .map(
      ([id, label]) =>
        `<button class="chip ${filter === id ? 'active' : ''}" data-action="filter" data-id="${id}">${label}</button>`,
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
  return [e.title, e.location, e.hint, e.kind, ...e.tags]
    .join(' ')
    .toLowerCase()
    .includes(query.trim().toLowerCase());
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
function goalRow(g) {
  return `<div class="goal-row ${g.done ? 'done' : ''}"><button class="check ${g.done ? 'checked' : ''}" data-action="goal-toggle" data-id="${g.id}" aria-label="${g.done ? '取消完成' : '完成目标'} ${esc(g.title)}">${g.done ? icon('check') : ''}</button><div class="spacer"><h3>${g.pinned ? '<span class="small muted">置顶 · </span>' : ''}${esc(g.title)}</h3>${g.detail ? `<p>${esc(g.detail)}</p>` : ''}${g.source ? act('goal-source', g.source.type === 'planner' ? '重新核对备料清单' : g.source.type === 'quest' ? '查看任务资料与记录' : g.source.quantity ? '打开配方，重新核对材料' : '查看原资料', 'text-btn', g.id, 'arrow') : ''}</div>${iconButton('goal-pin', 'pin', g.pinned ? '取消置顶目标' : '置顶目标', g.id, g.pinned ? 'on' : '')}${iconButton('goal-edit', 'edit', '编辑目标', g.id)}${iconButton('goal-remove', 'trash', '删除目标', g.id)}</div>`;
}
function goalsPage() {
  const p = profile();
  return `${pageHeader('PACK LIGHT, GO FAR', '行囊目标', '想学的武功、想见的人，还有下一次出发的理由。', act('goal-add', '添加目标', 'btn primary', '', 'plus'))}<div class="saved-goals"><div class="stack"><section class="card"><div class="card-header"><h2>我的待办</h2>${pill(`${p.goals.filter((g) => !g.done).length} 件未完成`)}</div>${
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
  }</section></div><div class="stack">${noteBlock()}<div class="notice info">${icon('leaf')}<span>每个周目的清单、收藏和随手记彼此独立。你可以在左下角切换或新建周目。</span></div></div></div>`;
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
function savesPage() {
  const save = environment.saves,
    files = save.files,
    backups = environment.backups;
  return `${pageHeader('A PLACE TO RETURN TO', '存档匣', '重要选择之前，为这一程留一份退路。', `${act('refresh', '刷新', 'btn', '', 'refresh')}${act('backup', '备份当前存档', 'btn primary', '', 'download')}`)}${timelineViews.page(environment.timeline, timelineView)}${activityPanel()}${environment.game.build && environment.game.build !== gameIndex.build ? notice(`游戏已更新到 Build ${environment.game.build}，手札图鉴资料为 Build ${gameIndex.build}；名称与配方请以游戏内为准。`, true) : ''}${environment.recovery ? `<div class="recovery-banner">${notice(environment.recovery.error || '发现上次未完成的存档恢复。请先退出游戏，再核对并回退到恢复前的安全副本。')}<div class="row">${environment.recovery.error ? '' : act('recover-restore', '核对并处理恢复中断', 'btn danger', '', 'shield')}${act('folder', '打开备份目录', 'btn', 'backups', 'folder')}</div></div>` : ''}${save.error ? notice(save.error) : ''}${environment.autoError ? notice(environment.autoError) : ''}<div class="card mb"><div class="row between"><div class="row"><div class="save-icon">${icon('folder')}</div><div><h3>${files.length ? '已连接本机存档' : '尚未连接存档'}</h3><p class="small muted">${files.length ? '文件会被只读扫描，备份保存在手札的数据目录。' : '选择游戏的 SaveGames 文件夹即可开始。'}</p></div></div><div class="save-stats"><div><strong>${files.filter((f) => /\.sav$/i.test(f.name)).length}</strong><small>存档文件</small></div><div>${act('choose-saves', '更换目录', 'btn')}</div></div></div><div class="separator"></div><div class="row between"><span class="mono muted">${esc(save.path || '等待选择目录')}</span>${save.path ? act('folder', '打开目录', 'text-btn', 'saves', 'external') : ''}</div></div>
 <div class="row between mb"><h2>留存的副本 <span class="small muted">${backups.length ? `· ${backups.length} 份` : ''}</span></h2><div class="row"><span class="small muted">存档变化时自动备份</span><button role="switch" aria-checked="${state.settings.autoBackup}" aria-label="自动备份" class="switch ${state.settings.autoBackup ? 'on' : ''}" data-action="auto-backup"></button></div></div>
 <div class="card">${backups.length ? backups.map((b) => `<div class="backup-row"><div class="backup-symbol">${icon(b.kind === 'safety' ? 'shield' : 'archive')}</div><div class="spacer"><h3>${esc(b.label)} ${b.kind === 'auto' ? pill('自动') : b.kind === 'safety' ? pill('恢复前副本', 'green') : ''}</h3><p>${when(b.createdAt)} · ${b.count} 个文件 · ${bytes(b.bytes)}</p></div>${iconButton('verify', 'shield', '校验完整性', b.id)}${act('backup-preview', '查看副本', 'btn', b.id, 'eye')}</div>`).join('') : empty('还没有备份', '先在游戏内保存，再创建第一份副本。每份备份都会保留原始文件并校验完整性。', act('backup', '创建第一份备份', 'btn soft', '', 'download'))}</div><p class="save-note">时间线开启时暂停完整自动备份，避免反复复制其他槽位。关闭时间线后，自动备份在手札运行时每分钟检查一次文件变化；稳定后复制已保存的文件，不会替游戏执行保存。副本不会自动删除；可在备份目录中自行管理空间。</p>
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
                 : '—'
             }</td><td><small>${bytes(f.bytes)}</small></td></tr>`,
         )
         .join('')}</tbody></table></div>`
     : empty('还没有读取到文件', '如果游戏已有存档，请在上方连接目录。')
 }
 <p class="save-note">场景、时长和队伍来自存档本身。点击「查看存档回顾」可看缩略图、追踪任务与已学配方。无法解析的版本仍可备份；保存时间取自文件时间。</p>`;
}
function settingsPage() {
  return `${pageHeader('MAKE IT YOUR OWN', '手札设置', '轻一点，静一点，按你自己的节奏来。')}<div class="stack"><section class="card"><h2 class="mb">阅读与陪伴</h2><div class="setting-row"><div><h3>第一次使用这本手札</h3><p>看看存档回顾、备料、小窗和备份怎么用。</p></div>${act('help', '打开使用说明', 'btn', '', 'book')}</div><div class="setting-row"><div><h3>少剧透提示</h3><p>显示人物名、地点和提醒，详细步骤需要主动展开；不保证完全无剧透。</p></div><button class="switch ${state.settings.spoiler === 'hints' ? 'on' : ''}" role="switch" aria-checked="${state.settings.spoiler === 'hints'}" aria-label="少剧透提示" data-action="spoiler"></button></div><div class="setting-row"><div><h3>随行小窗</h3><p>置顶显示待办与当前阶段提醒。${environment.shortcutReady ? 'Ctrl + Alt + J 可快速开关。' : '可使用右侧按钮开关。'}窗口可拖动、缩放。</p></div>${act('compact', '打开随行小窗', 'btn', '', 'pin')}</div><div class="setting-row"><div><h3>当前周目：${esc(profile().name)}</h3><p>每个周目有独立的进度、收藏、目标和笔记。</p></div>${act('profiles', '管理周目', 'btn', '', 'person')}</div></section>
 ${shortcutSettings()}<section class="card"><h2 class="mb">本机连接</h2><div class="setting-row"><div><h3>逸剑风云决 ${environment.game.installed ? '· 已找到' : '· 由 Steam 启动'}</h3><p>${esc(environment.game.path || '使用 Steam 游戏入口启动')}${environment.game.build ? ` · Build ${esc(environment.game.build)}` : ''}</p></div>${act('launch', '启动游戏', 'btn', '', 'game')}</div><div class="setting-row"><div><h3>游戏存档目录</h3><p class="mono">${esc(state.settings.savePath || '尚未选择')}</p></div>${act('choose-saves', '选择目录', 'btn', '', 'folder')}</div>${environment.detected.length > 1 ? `<div class="setting-row"><div><h3>检测到多个存档目录</h3><p>请选择你本次游玩的账户目录。</p></div><select id="detected-save" class="input">${environment.detected.map((p) => `<option value="${esc(p)}" ${p === state.settings.savePath ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></div>` : ''}<div class="setting-row"><div><h3>完整自动备份 · ${backupStatus()}</h3><p>时间线开启或正在存读档时暂停，避免重复复制全部存档。复制已保存的存档，不会替游戏执行保存。开启后每分钟检查变化，稳定后留存副本；文件没有变化时不重复备份，不会自动删除旧副本。</p></div><button class="switch ${state.settings.autoBackup ? 'on' : ''}" role="switch" aria-checked="${state.settings.autoBackup}" aria-label="自动备份" data-action="auto-backup"></button></div></section>
 <section class="card"><h2 class="mb">记录与数据</h2><div class="setting-row"><div><h3>手札备份</h3><p>导出全部周目的记录。导入前会保留当前手札副本；此功能不包含游戏存档。</p></div><div class="row">${act('import', '导入', 'btn', '', 'upload')}${act('export', '导出手札', 'btn', '', 'download')}</div></div><div class="setting-row"><div><h3>本地数据目录</h3><p class="mono">${esc(environment.userData)}</p></div>${act('folder', '打开', 'btn', 'data', 'folder')}</div><div class="setting-row"><div><h3>游戏存档备份目录</h3><p class="mono">${esc(environment.backupRoot)}</p></div>${act('folder', '打开', 'btn', 'backups', 'folder')}</div></section>
 <section class="card"><div class="card-header"><h2>资料与版本</h2>${pill(`v${version}`)}</div><p class="small muted mb">${esc(catalog.notice)} 本地卡片可离线阅读，原文链接会在默认浏览器打开。本工具是个人非官方助手。</p><div class="source-grid">${catalog.sources.map((s) => `<div class="source-row"><div class="row between"><strong>${esc(s.title)}</strong>${iconButton('source', 'external', '打开资料来源', s.id)}</div><p>${esc(s.author)} · ${esc(s.date)}</p><p>${esc(s.version)}</p></div>`).join('')}</div></section></div>`;
}
function compactPage() {
  const list = pending().slice(0, 5);
  const undo =
    compactUndo?.profileId === profile().id
      ? `<div class="notice"><span>已完成：${esc(compactUndo.title)}</span>${act('compact-undo', '撤销这次完成', 'text-btn')}</div>`
      : '';
  return `<div class="compact-shell"><div class="compact-title"><div class="row">${icon('leaf')}逸剑手札 · 随行</div>${iconButton('main', 'maximize', '打开完整手札')}${iconButton('window-close', 'close', '关闭小窗')}</div><div class="compact-body"><div class="eyebrow">此刻的江湖</div><h2>${esc(stageTitle())}</h2><p class="small muted">${esc(profile().name)} · 手动记录的阶段</p>${undo}<div class="separator"></div>${list.length ? list.map(checkRow).join('') : empty('当前精选清单已处理', '在完整手札中切换阶段或添加目标。')}${orderedGoals()
    .filter((g) => !g.done)
    .slice(0, 3)
    .map(
      (g) =>
        `<div class="compact-goal"><div class="row"><button class="check" data-action="goal-toggle" data-id="${g.id}" aria-label="完成目标 ${esc(g.title)}"></button><strong>${esc(g.title)}</strong></div>${g.detail ? `<details data-compact-detail="${esc(g.id)}"><summary>查看备忘与材料</summary><p class="preserve-text">${esc(g.detail)}</p></details>` : ''}</div>`,
    )
    .join(
      '',
    )}${profile().goals.filter((g) => !g.done).length > 3 ? `<p class="small muted">还有 ${profile().goals.filter((g) => !g.done).length - 3} 件待办，可在完整手札中查看。</p>` : ''}${profile().notes ? `<details class="compact-note" data-compact-detail="note"><summary>江湖随手记</summary><p class="preserve-text">${esc(profile().notes)}</p></details>` : ''}</div><div class="compact-foot"><span data-save-health>${timelineViews.chip(environment.health)}</span>${act('backup', '留一份备份', 'text-btn', '', 'archive')}</div></div>`;
}
function render(preserve = false) {
  if (!catalog || !state || composing) return;
  const active = document.activeElement,
    focusId = preserve ? active?.id : null,
    selection = active && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null,
    fieldValue = active && active.dataset?.persist ? active.value : null;
  const scroll = root.querySelector('.content')?.scrollTop || 0;
  if (compact) {
    const opened = new Set(
      [...root.querySelectorAll('[data-compact-detail][open]')].map((e) => e.dataset.compactDetail),
    );
    const compactScroll = root.querySelector('.compact-body')?.scrollTop || 0;
    root.innerHTML = compactPage();
    for (const el of root.querySelectorAll('[data-compact-detail]'))
      el.open = opened.has(el.dataset.compactDetail);
    root.querySelector('.compact-body').scrollTop = compactScroll;
    return;
  }
  root.innerHTML = `<div class="layout"><aside class="sidebar"><div class="brand"><span class="seal">逸</span><div><div class="brand-name">逸剑手札</div><div class="brand-sub">WANDERING JOURNAL</div></div></div><div class="nav-section">我的江湖</div>${[
    ['home', 'home'],
    ['checklist', 'scroll'],
    ['library', 'book'],
    ['database', 'sword'],
    ['world', 'scroll'],
    ['materials', 'leaf'],
    ['goals', 'bag'],
  ]
    .map(
      ([id, glyph]) =>
        `<button class="nav-btn ${route === id ? 'active' : ''}" data-action="navigate" data-id="${id}">${icon(glyph)}${headings[id]}${id === 'goals' && profile().goals.filter((g) => !g.done).length ? `<span class="nav-count">${profile().goals.filter((g) => !g.done).length}</span>` : ''}</button>`,
    )
    .join('')}<div class="nav-section mt">一路相伴</div>${[
    ['saves', 'archive'],
    ['settings', 'settings'],
  ]
    .map(
      ([id, glyph]) =>
        `<button class="nav-btn ${route === id ? 'active' : ''}" data-action="navigate" data-id="${id}">${icon(glyph)}${headings[id]}</button>`,
    )
    .join(
      '',
    )}<div class="sidebar-art"><div class="sidebar-line"></div><p>山水有相逢<br>江湖不相忘</p><small>ONE JOURNEY AT A TIME</small></div><div class="profile-box"><div class="avatar">侠</div><div class="profile-info"><strong>${esc(profile().name)}</strong><small>记录只保存在本机</small></div>${iconButton('profiles', 'settings', '管理周目')}</div></aside><div class="workspace"><div class="titlebar"><span class="window-name">逸剑风云决 · 个人助手</span><span class="spacer"></span><div class="window-buttons">${iconButton('window-minimize', 'minus', '最小化窗口')}${iconButton('window-maximize', 'maximize', '最大化或还原窗口')}${iconButton('window-close', 'close', '关闭窗口', '', 'close')}</div></div><header class="topbar"><div class="breadcrumb">我的江湖 ${icon('chevron')}<b>${headings[route]}</b></div><div class="row"><span data-save-health>${timelineViews.chip(environment.health)}</span><button class="search-trigger" data-action="search">${icon('search')}找一个人，一件事<kbd>Ctrl K</kbd></button>${iconButton('compact', 'pin', '打开随行小窗 · Ctrl+Alt+J')}</div></header><main class="content">${({ home: homePage, checklist: checklistPage, library: libraryPage, database: databaseView, world: worldPage, materials: materialPage, goals: goalsPage, saves: savesPage, settings: settingsPage }[route] || homePage)()}</main></div></div>`;
  if (preserve) root.querySelector('.content').scrollTop = scroll;
  if (focusId) {
    const next = document.getElementById(focusId);
    if (next) {
      if (fieldValue !== null && next.dataset.persist && focusId !== 'list-search') next.value = fieldValue;
      next.focus();
      if (selection && typeof next.setSelectionRange === 'function')
        try {
          next.setSelectionRange(...selection);
        } catch {}
    }
  }
}
function showOverlay(html, drawer = false, preserve = false) {
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
      ?.insertAdjacentHTML('afterbegin', iconButton('drawer-back', 'arrow', '返回上一页', '', 'drawer-back'));
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
function closeOverlay() {
  captureNodeDraft();
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
  lastFocus?.isConnected && lastFocus.focus();
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
function stageModal() {
  modal(
    '这一程，走到哪里了？',
    '选择最接近你当前主线的阶段。只会调整手札的提醒范围。',
    `<div class="field"><label for="stage-select">当前阶段</label><select id="stage-select">${catalog.stages.map((s) => `<option value="${s.id}" ${s.id === profile().stage ? 'selected' : ''}>${s.id + 1}. ${s.title} · ${s.sub}</option>`).join('')}</select></div>${notice('已勾选的记录会保留。切换阶段不会替你完成或跳过任何条目。', true)}`,
    act('stage-save', '保存进度', 'btn primary'),
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
function goalModal(id) {
  const g = id ? profile().goals.find((x) => x.id === id) : null;
  modal(
    g ? '编辑行囊目标' : '下一步，想做什么？',
    '一句明确的小目标，就足够开始下一次出发。',
    `<div class="field"><label for="goal-title">目标</label><input id="goal-title" maxlength="200" placeholder="例如：去青木舫，看看司马铃的新任务" value="${esc(g?.title || '')}"></div><div class="field"><label for="goal-detail">补充说明（可选）</label><textarea id="goal-detail" rows="4" maxlength="2000" placeholder="地点、前置条件、需要准备的东西……">${esc(g?.detail || '')}</textarea></div>`,
    act('goal-save', g ? '保存修改' : '放进行囊', 'btn primary', g?.id || ''),
  );
  document.querySelector('#goal-title')?.focus();
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
function searchModal() {
  showOverlay(
    `<section class="modal search-modal" role="dialog" aria-modal="true" aria-label="搜索江湖索引"><label class="search-input">${icon('search')}<input id="global-search" autofocus placeholder="找一位侠客，一本武学，一个地方……" maxlength="100" aria-label="全局搜索">${iconButton('close-overlay', 'close', '关闭搜索')}</label><div id="global-results" class="search-results"></div><div class="search-foot">搜索线索、图鉴、任务与地点 · Esc 关闭</div></section>`,
  );
  showSearchResults('');
  document.querySelector('#global-search').focus();
}
function showSearchResults(value) {
  const q = value.trim().toLowerCase();
  const guideMatches = catalog.entries.filter(
    (e) => !q || [e.title, e.location, e.kind, ...e.tags].join(' ').toLowerCase().includes(q),
  );
  const localMatches = q
    ? gameIndex.entries.filter((e) =>
        [e.name, e.type, ...(e.hobbies || [])].join(' ').toLowerCase().includes(q),
      )
    : [];
  const taskMatches = q ? gameIndex.world.quests.filter((e) => e.name.toLowerCase().includes(q)) : [];
  const placeMatches = q ? gameIndex.world.maps.filter((e) => e.name.toLowerCase().includes(q)) : [];
  const guides = catalog.entries
    .filter((e) => !q || [e.title, e.location, e.kind, ...e.tags].join(' ').toLowerCase().includes(q))
    .slice(0, q ? 7 : 12)
    .map((e) => ({
      id: e.id,
      title: e.title,
      sub: `${e.location} · 精选线索`,
      action: 'detail',
      glyph: kindIcon(e.kind),
    }));
  const local = q
    ? gameIndex.entries
        .filter((e) => [e.name, e.type, ...(e.hobbies || [])].join(' ').toLowerCase().includes(q))
        .sort((a, b) => Number(b.name === q) - Number(a.name === q))
        .slice(0, 12)
        .map((e) => ({
          id: e.id,
          title: e.name,
          sub: `${e.kind} · ${e.type}${e.quality ? ` · ${e.quality}色` : ''}${e.kind === '人物' ? ' · ' + (e.description ? e.description.slice(0, 80) : '地点未核实') + ` · #${e.gameId}` : ''} · 本机图鉴`,
          action: 'database-detail',
          glyph: { 物品: 'bag', 武学: 'sword', 人物: 'person', 配方: 'scroll' }[e.kind],
        }))
    : [];
  const tasks = q
    ? gameIndex.world.quests
        .filter((e) => e.name.toLowerCase().includes(q))
        .slice(0, 5)
        .map((e) => ({
          id: e.id,
          title: e.name,
          sub: `任务资料 · #${e.gameId}`,
          action: 'world-quest',
          glyph: 'scroll',
        }))
    : [];
  const places = q
    ? gameIndex.world.maps
        .filter((e) => e.name.toLowerCase().includes(q))
        .slice(0, 4)
        .map((e) => ({
          id: e.id,
          title: e.name,
          sub: `地点线索 · #${e.gameId}`,
          action: 'world-place',
          glyph: 'map',
        }))
    : [];
  const list = [...guides, ...local, ...tasks, ...places];
  const more = q
    ? `<div class="search-all-groups">${[
        ['guides', '精选线索', guideMatches.length],
        ['database', '百物图鉴', localMatches.length],
        ['quests', '任务', taskMatches.length],
        ['places', '地点', placeMatches.length],
      ]
        .filter((g) => g[2])
        .map(
          ([id, label, count]) =>
            `<button class="text-btn" data-action="search-all" data-id="${id}" data-query="${esc(value.trim())}">${label} ${count} 项 · 查看全部</button>`,
        )
        .join('')}</div>`
    : '';
  document.querySelector('#global-results').innerHTML =
    more +
    (list.length
      ? list
          .map(
            (e) =>
              `<button class="search-result" data-action="${e.action}" data-id="${e.id}"><span class="result-icon">${e.action === 'database-detail' ? picture(e.id, 'search') : e.action === 'detail' ? gameImages.person(e.title.split(' · ')[0], 'search') || icon(e.glyph) : icon(e.glyph)}</span><span class="spacer"><strong>${e.action === 'database-detail' ? qualityText.name(e.id, e.title) : esc(e.title)}</strong><small>${esc(e.sub)}</small></span>${icon('chevron')}</button>`,
          )
          .join('')
      : empty('暂时没有这条线索', '试试人物名、物品名，或到行囊目标中自行记录。'));
}
async function refresh() {
  const token = ++refreshRequest;
  const next = await call('refresh');
  if (token !== refreshRequest) return;
  environment = next;
  render(true);
  if (route === 'world' && worldView.referenceName === undefined) await loadWorldReference();
  const signature = (name) => next.saves.files.find((f) => f.name === name)?.hash;
  if (worldView.referenceName !== undefined) {
    const name = worldView.follow ? latestReference() : worldView.referenceName;
    if (name !== worldView.referenceName || signature(name) !== worldView.reference?.hash)
      await loadWorldReference();
  }
  if (materialView.referenceName !== undefined && materialView.result) {
    const name = materialView.follow ? latestReference() : materialView.referenceName;
    if (name !== materialView.referenceName || signature(name) !== materialView.result.reference?.hash)
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
        if (e?.kind === '人物') await showDatabaseDetail(e.id);
        const freshness = overlay.querySelector('.reference-freshness');
        if (freshness)
          freshness.textContent = name ? '已同步新的已保存进度 · ' + name : '参照存档不可读，请重新选择。';
      }
    }
  }
}
async function handle(action, id, target) {
  switch (action) {
    case 'search-all': {
      const value = target.dataset.query || query;
      closeOverlay();
      if (id === 'guides') {
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
      } else if (view.type === 'guide') showDetail(view.id);
      else if (view.type === 'backup') showBackupPreview(view.data);
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
    case 'navigate':
      await saveNote();
      route = id;
      query = '';
      filter = 'current';
      render();
      if (id === 'world' && worldView.referenceName === undefined) await loadWorldReference();
      if (id === 'materials') {
        materialView.referenceName ??= defaultReference();
        render();
        if ((profile().craftList || []).length && !materialView.result) await calculateMaterials();
      }
      break;
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
      const plan = materialView.result;
      if (!plan || JSON.stringify(materialView.resultList) !== JSON.stringify(profile().craftList || []))
        throw Error('请先重新核对备料清单');
      const lines = [
        `对照：${plan.reference?.name || '仅合并资料'} · ${plan.reference ? when(plan.reference.modifiedAt) : '未核对库存'}`,
        `基础制作费：${plan.money} 文`,
        ...plan.recipes.map((r) => `${r.name} ×${r.quantity} 次`),
        '材料摘要：',
        ...plan.materials.map(
          (m) =>
            `${m.name} 需${m.count}${m.missing === null ? '' : `，已分配${m.allocated}，缺${m.missing}`}`,
        ),
      ];
      const detail =
        lines.join('\n').slice(0, 1800) +
        '\n这是当次核对摘要；完整清单保存在当前周目的备料清单中，可重新打开核对。';
      await mutation({
        type: 'goal-add',
        title: `备料清单 · ${plan.recipes.length} 种配方`,
        detail,
        source: { type: 'planner', id: 'current' },
      });
      toast('备料摘要已加入待办');
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
    case 'database-detail':
      await showDatabaseDetail(id);
      break;
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
      closeOverlay();
      break;
    case 'reveal':
      revealed = true;
      showDetail(id, true);
      break;
    case 'search':
      searchModal();
      break;
    case 'filter':
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
    case 'goal-edit':
      goalModal(id);
      break;
    case 'goal-save':
      await mutation({
        type: id ? 'goal-edit' : 'goal-add',
        id,
        title: document.querySelector('#goal-title').value,
        detail: document.querySelector('#goal-detail').value,
      });
      closeOverlay();
      toast('目标已保存');
      break;
    case 'goal-pin':
      await mutation({ type: 'goal-pin', id });
      break;
    case 'goal-toggle': {
      const goal = profile().goals.find((g) => g.id === id);
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
    case 'goal-remove':
      modal(
        '从行囊中移除这件事？',
        '这只会删除手札里的目标，不影响游戏。',
        '',
        act('goal-remove-confirm', '移除目标', 'btn danger', id),
      );
      break;
    case 'goal-remove-confirm':
      await mutation({ type: 'goal-remove', id });
      closeOverlay();
      toast('目标已移除');
      break;
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
      await captureNodeDraft().catch(() => {});
      try {
        await flushNodeDrafts();
      } catch (e) {
        modal(
          '仍有节点草稿未保存',
          e.message,
          '<p>可以先关闭此提示，放弃当前草稿或在存档匣删除旧草稿腾出空间，再退出。已有磁盘草稿会保留。</p>',
          act('window-quit-discard', '放弃未保存的节点编辑并退出', 'btn danger'),
        );
        break;
      }
      await Promise.all([...drafts.keys()].map(saveNote));
      await call('window', 'quit');
      break;
    case 'window-quit-discard':
      await nodeDraftQueue.catch(() => {});
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
    case 'backup':
      if (!state.settings.savePath) {
        toast('请先在设置中连接存档目录', true);
        route = 'settings';
        render();
        break;
      }
      modal(
        '给这一刻留个名字',
        '先确认游戏内保存已经完成。将备份当前目录中的所有文件，并逐个校验。',
        `<div class="field"><label for="backup-label">备份名称</label><input id="backup-label" maxlength="100" placeholder="例如：品剑大会前 / 北山村选择前" value="${esc(stage().title)} · ${new Date().toLocaleDateString('zh-CN')}"></div>`,
        act('backup-confirm', '创建备份', 'btn primary', '', 'download'),
      );
      document.querySelector('#backup-label').select();
      break;
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
      showBackupPreview(await call('inspectBackup', id));
      break;
    case 'backup-folder':
      await call('openBackup', id);
      break;
    case 'backup-rename': {
      const b = environment.backups.find((b) => b.id === id);
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
      const result = await call('restore', id);
      if (!result.cancelled) {
        environment = result.environment;
        closeOverlay();
        render(true);
        toast(`已恢复 ${result.restored} 个文件，恢复前副本已保留`);
      }
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
    case 'choose-saves': {
      const result = await call('chooseSaves');
      if (!result.cancelled) {
        state = result.state;
        environment = result.environment;
        referenceSaveName = undefined;
        referenceSave = null;
        render(true);
        toast('已连接存档目录');
      }
      break;
    }
    case 'refresh':
      await refresh();
      toast('已刷新本机存档');
      break;
    case 'auto-backup':
      await mutation({ type: 'settings', value: { autoBackup: !state.settings.autoBackup } });
      toast(state.settings.autoBackup ? '自动备份已开启，运行期间每分钟检查' : '自动备份已关闭');
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
      await saveNote();
      const r = await call('exportJournal');
      if (!r.cancelled) toast('全部周目已导出');
      break;
    }
    case 'import': {
      await saveNote();
      const r = await call('importJournal');
      if (!r.cancelled) {
        state = r.state;
        render();
        toast('手札已导入，原记录副本已保留');
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
      await saveNote();
      await call('window', 'close');
      break;
  }
}
document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) {
    if (event.target.dataset.backdrop) closeOverlay();
    return;
  }
  if (target.disabled) return;
  const action = target.dataset.action,
    id = target.dataset.id;
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
    'profiles',
    'backup',
  ].includes(action);
  if (lock) target.disabled = true;
  try {
    await handle(action, id, target);
  } catch (e) {
    toast(e.message, true);
  } finally {
    target.disabled = false;
  }
});
document.addEventListener('input', (event) => {
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
  if (event.target.id === 'craft-search' && !event.isComposing && !composing) {
    materialView.query = event.target.value;
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
    }
    return;
  }
  if (event.target.id === 'note') {
    const id = profile().id;
    drafts.set(id, event.target.value);
    const status = document.querySelector('#note-status');
    if (status) status.textContent = '正在保存…';
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => saveNote(id).catch(() => {}), 700);
  }
  if (event.target.id === 'list-search' && !event.isComposing && !composing) {
    query = event.target.value;
    databasePage = 0;
    render(true);
  }
  if (event.target.id === 'global-search') showSearchResults(event.target.value);
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
  if (event.target.id === 'person-save') {
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
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    searchModal();
    return;
  }
  if (event.key === 'Escape') {
    closeOverlay();
    return;
  }
  if (overlay.querySelector('#global-search')) {
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
window.addEventListener('beforeunload', (event) => {
  if (drafts.size || pendingNodeDrafts.size) {
    const quitting = environment?.health?.quitting;
    event.preventDefault();
    event.returnValue = false;
    Promise.all([flushNodeDrafts(), ...[...drafts.keys()].map((id) => saveNote(id))])
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
  render();
  if (environment.warning) toast(environment.warning, true);
  api.onState((next) => {
    const currentId = state.activeProfileId;
    const currentSlot = profile().saveSlot || '';
    const currentPath = state.settings.savePath;
    const currentBasket = JSON.stringify([profile().craftList || [], profile().reservations || {}]);
    const currentMode = profile().referenceMode;
    state = next;
    if (currentBasket !== JSON.stringify([profile().craftList || [], profile().reservations || {}]))
      invalidateMaterials();
    if (
      currentId !== state.activeProfileId ||
      currentSlot !== (profile().saveSlot || '') ||
      currentMode !== profile().referenceMode ||
      currentPath !== state.settings.savePath
    ) {
      resetPlanningViews();
      if (currentId !== state.activeProfileId) closeOverlay();
      referenceSaveName = undefined;
      referenceSave = null;
      environment.recent = null;
      refresh().catch((e) => toast(e.message, true));
    }
    render(true);
  });
  api.onEvent((event) => {
    if (event.type === 'health') updateHealth(event.health);
    if (event.type === 'error') toast(event.text, true);
    if (document.hidden && event.type !== 'error') return;
    if (['backup', 'error', 'auto-status', 'timeline', 'operation'].includes(event.type))
      refresh().catch((e) => toast(e.message, true));
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh().catch((e) => toast(e.message, true));
  });
  api.onAction(async ({ action }) => {
    if (action === 'hide') {
      closeOverlay();
      return;
    }
    if (compact) return;
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
    if (!document.hidden)
      call('health')
        .then(updateHealth)
        .catch(() => {});
    if (
      ['home', 'saves', 'world', 'materials', 'database'].includes(route) &&
      !compact &&
      !document.hidden &&
      (currentDrawer || !document.activeElement?.matches('select,input,textarea'))
    )
      refresh().catch(() => {});
  }, 5000);
  await call('ready');
} catch (e) {
  root.innerHTML = `<div class="loading"><span class="seal">逸</span><h1>手札暂时无法打开</h1><p>${esc(e.message)}</p><p class="small muted">请关闭后重新打开；已有记录保存在本机数据目录。</p></div>`;
}
