'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const loaded = Promise.all([
  import('../src/renderer/world-views.js'),
  import('../src/renderer/entity-references.js'),
]);
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const quest = (gameId, parentId, name) => ({
  id: `quest-${gameId}`,
  gameId,
  parentId,
  name,
  kind: 'Primary',
  description: '',
  requestNPCs: [],
  finishNPCs: [],
  requirements: [],
  placements: [],
});
const fixture = () => ({
  entries: [],
  world: {
    maps: [],
    quests: [quest(5200, 0, '合成任务'), quest(5201, 5200, '合成步骤')],
  },
});
async function views(index) {
  const [{ createWorldViews }, { createEntityReferences }] = await loaded;
  const helpers = {
    esc,
    act: (action, label, _cls, id) =>
      `<button data-action="${action}" data-id="${esc(id)}">${label}</button>`,
    pill: (label) => `<span>${esc(label)}</span>`,
    notice: esc,
    icon: () => '',
    iconButton: () => '',
    empty: esc,
    picture: () => '',
  };
  const world = createWorldViews(helpers);
  const refs = createEntityReferences({
    ...helpers,
    index: () => index,
    qualityText: { html: (_id, label) => label },
  });
  return {
    detail: (reference, id = 'quest-5200') => world.questDetail(index, id, { reference }, true),
    page: (reference, status = 'all') =>
      world.page(index, { kind: 'quests', roots: true, query: '', page: 0, reference, status }, []),
    preview: (context, id = 'quest-5200') => refs.preview(id, context),
  };
}
const reference = (quests) => ({ metadata: { quests } });

for (const step of [2, 3, 4]) {
  test(`closed root state ${step} retires stale active descendants while preserving step history`, async () => {
    const index = fixture();
    const view = await views(index);
    const saved = reference([
      { id: 5200, step },
      { id: 5201, step: 1 },
    ]);
    const before = JSON.stringify({ index, saved });
    const html = view.detail(saved);
    assert.doesNotMatch(html, /codex-active-steps|当前步骤/);
    const history = html.match(
      /<details[^>]+data-persist-detail="quest-steps-quest-5200">[\s\S]*?<\/details>/,
    )[0];
    assert.match(history, /data-id="quest-5201"/);
    assert.match(history, /进行中/);
    assert.doesNotMatch(view.preview({ reference: saved }), /下一步：/);
    assert.doesNotMatch(view.page(saved), /进行中的步骤：/);
    assert.doesNotMatch(view.page(saved, 'active'), /world-quest-card/);
    assert.equal(JSON.stringify({ index, saved }), before);
  });
}

test('open and unrecorded ancestors retain active child guidance', async () => {
  const view = await views(fixture());
  for (const root of [[], [{ id: 5200, step: 0 }], [{ id: 5200, step: 1 }]]) {
    const saved = reference([...root, { id: 5201, step: 1 }]);
    assert.match(view.detail(saved), /codex-active-steps[\s\S]*?合成步骤/);
    assert.match(view.preview({ reference: saved }), /下一步：合成步骤/);
    assert.match(view.page(saved, 'active'), /进行中的步骤：合成步骤/);
  }
  assert.doesNotMatch(view.detail(null), /codex-active-steps/);
  assert.doesNotMatch(view.preview({}), /下一步：/);
});

for (const step of [2, 3, 4]) {
  test(`closed intermediate state ${step} blocks deeper descendants from both ancestor drawers`, async () => {
    const index = fixture();
    index.world.quests.push(quest(5202, 5201, '深层步骤'));
    const view = await views(index);
    const saved = reference([
      { id: 5200, step: 1 },
      { id: 5201, step },
      { id: 5202, step: 1 },
    ]);
    for (const id of ['quest-5200', 'quest-5201']) {
      assert.doesNotMatch(view.detail(saved, id), /codex-active-steps/);
      assert.doesNotMatch(view.preview({ reference: saved }, id), /下一步：/);
      assert.match(view.detail(saved, id), /data-id="quest-5202"/);
    }
  });
}

test('a closed branch leaves an independent open branch available', async () => {
  const index = fixture();
  index.world.quests.push(quest(5202, 5201, '关闭分支的旧步骤'), quest(5203, 5200, '开放分支'));
  const view = await views(index);
  const saved = reference([
    { id: 5200, step: 1 },
    { id: 5201, step: 4 },
    { id: 5202, step: 1 },
    { id: 5203, step: 1 },
  ]);
  const active = view
    .detail(saved)
    .match(/<section class="detail-block codex-active-steps">[\s\S]*?<\/section>/)[0];
  assert.match(active, /开放分支/);
  assert.doesNotMatch(active, /关闭分支的旧步骤/);
  assert.match(view.preview({ reference: saved }), /下一步：开放分支/);
});

test('preview status overrides participate in ancestor closure checks', async () => {
  const view = await views(fixture());
  const open = reference([
    { id: 5200, step: 1 },
    { id: 5201, step: 1 },
  ]);
  const closed = reference([
    { id: 5200, step: 4 },
    { id: 5201, step: 1 },
  ]);
  assert.doesNotMatch(
    view.preview({ reference: open, statuses: new Map([['quest-5200', '已失败']]) }),
    /下一步：/,
  );
  assert.doesNotMatch(
    view.preview({ reference: closed, statuses: new Map([['quest-5201', '进行中']]) }),
    /下一步：/,
  );
  assert.match(
    view.preview({ reference: closed, statuses: new Map([['quest-5200', '进行中']]) }),
    /下一步：合成步骤/,
  );
});

test('parent cycles terminate and follow flow closure semantics', async () => {
  const index = fixture();
  index.world.quests[0].parentId = 5202;
  index.world.quests.push(quest(5202, 5201, '环内祖先'));
  const view = await views(index);
  const open = reference([{ id: 5201, step: 1 }]);
  assert.match(view.detail(open), /codex-active-steps/);
  assert.match(view.preview({ reference: open }), /下一步：合成步骤/);
  for (const step of [2, 3, 4]) {
    const closed = reference([
      { id: 5201, step: 1 },
      { id: 5202, step },
    ]);
    assert.doesNotMatch(view.detail(closed), /codex-active-steps/);
    assert.doesNotMatch(view.preview({ reference: closed }), /下一步：/);
    assert.match(view.detail(closed), /相关步骤 · 2/);
  }
});
