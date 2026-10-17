'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  crypto = require('node:crypto');
const { Timeline, AGES, writeBytes } = require('../src/core/timeline.cjs');
const { sha } = require('../src/core/saves.cjs');
const { syntheticSave } = require('./fixtures.cjs');
const { MAX_AUTOMATIC } = require('../src/core/timeline-retention.cjs');
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-timeline-'));
  const source = path.join(root, '76561190000000000', 'SaveGames');
  fs.mkdirSync(source, { recursive: true });
  const clock = { at: Date.now() };
  const timeline = new Timeline(path.join(root, 'history'), { now: () => clock.at });
  timeline.configure(source, false, 10);
  const file = path.join(source, '29.sav');
  const save = (seconds) => {
    const b = syntheticSave({ full: true, seconds });
    writeBytes(file, b);
    return timeline.record(b, 'auto', clock.at);
  };
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('yijian-timeline-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, source, clock, timeline, file, save };
}
test('sparse timeline builds all 11 ages, stays bounded, and reports actual gaps and pauses', (t) => {
  const { clock, timeline, save } = setup(t),
    end = clock.at;
  for (let age = 10800; age >= 0; age -= 10) {
    clock.at = end - age * 1000;
    save(20000 - age);
    assert.ok(timeline.data.records.length <= MAX_AUTOMATIC);
  }
  clock.at = end;
  assert.deepEqual(
    timeline.nodes().map((n) => n.seconds),
    AGES,
  );
  for (const n of timeline.nodes()) {
    assert.ok(n.record.ageSeconds >= n.seconds);
    assert.equal(n.record.gapSeconds, n.record.ageSeconds - n.seconds);
    assert.ok(n.record.gapSeconds <= n.toleranceSeconds);
    assert.equal(n.record.playSeconds, 20000 - n.record.ageSeconds);
    assert.equal(timeline.inspect(n.record.id).record.hash, n.record.hash);
  }
  clock.at = end + 75000;
  const short = timeline.nodes().at(-1);
  assert.equal(short.record, null);
  assert.equal(short.nearestAt, end);
  assert.match(short.reason, /附近没有/);
  assert.ok(
    fs.readdirSync(timeline.blobs).length <= MAX_AUTOMATIC + 2,
    'only current bands and prior atomic manifest remain',
  );
});
test('all bookmarks remain accessible after restart and metadata edits preserve save bytes', (t) => {
  const { timeline, clock, save } = setup(t);
  const first = save(5);
  timeline.updateNode(first.id, { bookmarked: true, label: '重要选择', note: '保留原始进度' });
  for (let i = 0; i < 25; i++) {
    clock.at += 10000;
    timeline.record(syntheticSave({ seconds: 20 + i }), 'manual');
  }
  clock.at += 8000000;
  save(100);
  const again = new Timeline(timeline.root, { now: () => clock.at });
  assert.equal(again.summary().bookmarkCount, 26);
  assert.equal(again.summary().protected.length, 26);
  assert.equal(again.summary().history.length, 27);
  const result = again.inspect(first.id);
  assert.equal(result.record.label, '重要选择');
  assert.equal(result.record.note, '保留原始进度');
  assert.equal(sha(result.bytes), first.hash);
  assert.throws(() => again.updateNode(first.id, { at: clock.at }), /无效/);
  assert.throws(() => again.updateNode(first.id, { label: 'x'.repeat(81) }), /无效/);
  again.updateNode(first.id, { bookmarked: false });
  clock.at += 10000;
  writeBytes(path.join(again.data.source, '29.sav'), syntheticSave({ seconds: 120 }));
  again.record(syntheticSave({ seconds: 120 }), 'auto');
  assert.ok(!again.summary().history.some((r) => r.id === first.id));
});
test('checkpoint comparison is recent saved progress to selected checkpoint, including unavailable fields', (t) => {
  const { timeline, clock } = setup(t);
  const old = timeline.record(
    syntheticSave({
      full: true,
      seconds: 10,
      money: 10,
      team: [0],
      inventory: [{ id: 1002, count: 1 }],
      quests: [{ id: 5200, step: 1 }],
    }),
    'manual',
  );
  clock.at += 10000;
  const latest = timeline.record(
    syntheticSave({
      full: true,
      seconds: 20,
      money: 30,
      team: [0, 10047],
      inventory: [{ id: 1002, count: 3 }],
      quests: [{ id: 5200, step: 4 }],
    }),
    'auto',
  );
  const c = timeline.comparison(old.id);
  assert.equal(c.basis.id, latest.id);
  assert.equal(c.comparison.moneyDelta, -20);
  assert.equal(c.comparison.inventory.changes[0].delta, -2);
  assert.equal(c.comparison.quests.changes[0].rightStep, 1);
  assert.equal(c.comparison.team.leftOnly.length, 1);
  clock.at += 10000;
  timeline.record(syntheticSave({ seconds: 30 }), 'auto');
  assert.equal(timeline.comparison(old.id).comparison.moneyDelta, null);
});
test('timeline preview links exact known team, task and item IDs while preserving historical differences', async () => {
  const { pathToFileURL } = require('node:url'),
    [{ createTimelineViews }, { createEntityReferences }] = await Promise.all([
      import(pathToFileURL(path.join(__dirname, '../src/renderer/timeline-views.js')).href),
      import(pathToFileURL(path.join(__dirname, '../src/renderer/entity-references.js')).href),
    ]);
  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  const index = {
      entries: [
        { id: 'npc-1', gameId: 1, kind: '人物', name: '同名队友' },
        { id: 'npc-2', gameId: 2, kind: '人物', name: '同名队友' },
        ...Array.from({ length: 9 }, (_, i) => ({
          id: `item-${i + 1}`,
          gameId: i + 1,
          kind: '物品',
          name: '同名物品',
        })),
      ],
      world: {
        maps: [],
        quests: [
          { id: 'quest-10', gameId: 10, name: '同名任务', parentId: 0 },
          { id: 'quest-11', gameId: 11, name: '同名任务', parentId: 10 },
        ],
      },
    },
    qualityText = { html: (_, label) => label, name: (_, name) => esc(name) },
    references = createEntityReferences({
      index: () => index,
      esc,
      picture: (id) => `<span data-picture="${esc(id)}"></span>`,
      icon: esc,
      qualityText,
    }),
    options = {
      esc,
      act: references.button,
      icon: esc,
      pill: esc,
      notice: esc,
      hours: esc,
      iconButton: () => '',
      qualityText,
    },
    views = createTimelineViews({ ...options, getIndex: () => index }),
    result = {
      record: { id: 'node-old', at: 1000, kind: 'auto' },
      basis: { id: 'node-new', at: 2000 },
      metadata: {
        mapName: '历史场景',
        money: 10,
        playSeconds: 60,
        team: [
          { id: 1, name: '同名队友' },
          { id: 2, name: '同名队友' },
          { id: 99, name: '同名队友' },
        ],
      },
      readiness: { ready: false, reason: '游戏未连接' },
      comparison: {
        moneyDelta: -20,
        team: {
          available: true,
          rightOnly: [
            { id: 1, name: '同名队友' },
            { id: 99, name: '同名队友' },
          ],
          leftOnly: [{ id: 2, name: '同名队友' }],
        },
        quests: {
          available: true,
          changes: [
            { id: 10, name: '同名任务', parentId: 0, left: '已完成', right: '进行中' },
            { id: 11, name: '同名任务', parentId: 10, left: '进行中', right: '未开始' },
            { id: 12, name: '同名任务', parentId: 10, left: '进行中', right: '未出现在记录' },
          ],
        },
        inventory: {
          available: true,
          changes: [
            ...Array.from({ length: 9 }, (_, i) => ({
              id: i + 1,
              name: '同名物品',
              left: 3,
              right: 1,
              delta: -2,
            })),
            { id: 99, name: '同名物品', left: 0, right: 1, delta: 1 },
            { id: 999, name: '<未知物品>', left: 0, right: 1, delta: 1 },
          ],
        },
      },
    },
    before = JSON.stringify(result),
    html = views.preview(result);
  for (const [action, ids] of [
    ['database-detail', ['npc-1', 'npc-2', ...Array.from({ length: 9 }, (_, i) => `item-${i + 1}`)]],
    ['world-quest', ['quest-10', 'quest-11']],
  ]) {
    for (const id of ids) {
      assert.match(html, new RegExp(`data-action="${action}" data-id="${id}" data-entity-id="${id}"`));
      assert.match(html, new RegExp(`data-picture="${id}"`));
    }
  }
  assert.doesNotMatch(
    html,
    /data-id="(?:npc-99|quest-12|item-99|item-999)"|data-action="entity-choice"|name:/,
  );
  assert.match(html, /<h3>队伍<\/h3>.*同名队友<\/p>/s);
  assert.match(html, /加入：.*npc-1.*同名队友<br>离队：.*npc-2/s);
  assert.match(
    html,
    /方向为“最近保存 → 此节点”，比较铜钱、游玩时长、同行与出战队伍、任务状态、背包数量和已学配方，不含尚未保存的游戏进度/,
  );
  assert.match(html, /<strong>-20<\/strong>/);
  assert.match(html, /已完成 → 进行中/);
  assert.match(html, /进行中 → 未开始/);
  assert.match(html, /进行中 → 未出现在记录/);
  assert.match(html, /3 → 1 <b class="delta-less">\(-2\)<\/b>/);
  assert.match(html, /<details><summary>其余 3 项变化<\/summary>.*data-id="item-9"/s);
  assert.match(html, /&lt;未知物品&gt;/);
  assert.match(html, /id="timeline-load-button"[^>]*\bdisabled/);
  assert.equal(JSON.stringify(result), before);
  assert.doesNotMatch(
    createTimelineViews(options).preview(result),
    /data-action="(?:world-quest|database-detail)"/,
  );
  for (const group of ['team', 'quests', 'inventory']) result.comparison[group].available = false;
  const unavailable = views.preview(result).split('timeline-differences')[1].split('</section>')[0];
  assert.match(unavailable, /队伍数据无法比较.*任务数据无法比较.*库存数据无法比较/s);
  assert.doesNotMatch(unavailable, /data-action="(?:world-quest|database-detail)"/);
});
test('timeline scenes link by exact saved map key on every surface without guessing a namesake', async () => {
  const { pathToFileURL } = require('node:url'),
    { createTimelineViews } = await import(
      pathToFileURL(path.join(__dirname, '../src/renderer/timeline-views.js')).href
    );
  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  const index = {
      entries: [],
      world: {
        maps: [
          { id: 'place-7', key: 'scene-a', name: '同名场景' },
          { id: 'place-7', key: 'scene-b', name: '同名场景' },
          { id: 'place-8', key: 'scene-c', name: '同名场景' },
        ],
      },
    },
    links = [],
    views = createTimelineViews({
      esc,
      icon: esc,
      act: (action, label, cls, id) => {
        if (action === 'archive-entity') links.push({ label, cls, id });
        return `<button data-action="${action}" data-id="${esc(id)}">${label}</button>`;
      },
      pill: esc,
      notice: esc,
      hours: esc,
      bytes: esc,
      iconButton: () => '',
      getIndex: () => index,
    }),
    record = { id: 'synthetic-node', map: 'scene-b', mapName: '同名场景', at: 2000, playSeconds: 60 },
    timeline = {
      enabled: false,
      reason: '合成时间线',
      interval: 10,
      nodes: [{ seconds: 60, record: { ...record, ageSeconds: 60, gapSeconds: 0 } }],
      latest: record,
      history: [record],
      count: 1,
      bytes: 0,
    },
    before = structuredClone(timeline),
    html = views.page(timeline);
  assert.equal(links.length, 3, 'latest, target and history link the exact scene once each');
  assert(links.every((link) => link.id === 'place-7:scene-b' && link.cls === 'text-btn'));
  assert.doesNotMatch(html, /data-id="(?:place-7|place-8|name:[^"]+)"/);
  links.length = 0;
  const namedHistory = views.page({ ...timeline, history: [{ ...record, label: '私人起点' }] });
  assert.equal(links.length, 3, 'a named history entry retains its exact scene in the metadata');
  assert(links.every((link) => link.id === 'place-7:scene-b'));
  assert.match(namedHistory, /<h3>私人起点<\/h3>/);
  const result = {
    record: { ...record, label: '私人节点 <原样>' },
    metadata: { map: 'scene-b', mapName: '同名场景' },
    readiness: { ready: false },
  };
  links.length = 0;
  const preview = views.preview(result);
  assert.equal(links.length, 1);
  assert.equal(links[0].id, 'place-7:scene-b');
  assert.match(preview, /<h1>私人节点 &lt;原样&gt;<\/h1>/);
  assert.match(preview, /id="timeline-load-button"[^>]*\bdisabled/);
  links.length = 0;
  views.preview({ ...result, record, metadata: { mapKey: 'scene-c', mapName: '同名场景' } });
  assert.equal(links.length, 1, 'the preview heading links the exact scene without a duplicate location row');
  assert(links.every((link) => link.id === 'place-8'));
  for (const metadata of [{ map: 'unknown-scene', mapName: '同名场景' }, { mapName: '同名场景' }]) {
    links.length = 0;
    const unknown = views.preview({ ...result, record, metadata });
    assert.equal(links.length, 0);
    assert.match(unknown, /同名场景/);
    assert.doesNotMatch(unknown, /data-action="(?:archive-entity|entity-choice)"/);
  }
  assert.deepEqual(timeline, before);
});
test('missing history remains unavailable instead of pretending to cover an hour', (t) => {
  const { timeline, save, clock } = setup(t);
  save(20);
  clock.at += 5000;
  assert.ok(timeline.nodes().every((n) => n.record === null));
  clock.at += 5000;
  assert.ok(
    timeline
      .nodes()
      .slice(0, -1)
      .every((n) => !n.record),
  );
  assert.equal(timeline.nodes().at(-1).record.playSeconds, 20);
});
test('a day without new saves makes every target unavailable and backward clock blocks native dispatch', (t) => {
  const { timeline, save, clock } = setup(t);
  save(10);
  const at = clock.at;
  clock.at += 86400000;
  assert.ok(timeline.nodes().every((n) => n.record === null && n.nearestAt === at));
  clock.at = at - 1000;
  assert.throws(() => timeline.beginSave(crypto.randomUUID(), 'auto'), /系统时间/);
  assert.equal(timeline.data.pending, null);
});
test('an occupied helper slot cannot be claimed and failed configuration preserves state', (t) => {
  const { timeline, file } = setup(t),
    other = syntheticSave({ seconds: 123 });
  fs.writeFileSync(file, other);
  const before = JSON.stringify(timeline.data);
  assert.throws(() => timeline.configure(timeline.data.source, true, 20), /其他进度/);
  assert.equal(JSON.stringify(timeline.data), before);
  assert.equal(sha(fs.readFileSync(file)), sha(other));
});
test('native save receipt requires new stable bytes and durable pending intent', (t) => {
  const { timeline, source, file, clock, save } = setup(t);
  save(30);
  const id = crypto.randomUUID(),
    old = timeline.beginSave(id, 'manual');
  assert.throws(() => timeline.finishSave(id, old), /尚未完成写入/);
  const reopened = new Timeline(timeline.root, { now: () => clock.at });
  assert.equal(reopened.data.pending.id, id);
  assert.equal(reopened.data.enabled, false);
  const next = syntheticSave({ seconds: 60 });
  writeBytes(file, next);
  fs.utimesSync(file, new Date(clock.at + 1000), new Date(clock.at + 1000));
  const r = reopened.finishSave(id, next);
  assert.equal(r.playSeconds, 60);
  assert.equal(reopened.data.pending, null);
  assert.equal(reopened.assertOwned(), path.join(source, '29.sav'));
});
test('an external write after native receipt stops completion and preserves new progress', (t) => {
  const { timeline, file, save, clock } = setup(t);
  save(10);
  const id = crypto.randomUUID();
  timeline.beginSave(id, 'auto');
  const receipt = syntheticSave({ seconds: 20 }),
    external = syntheticSave({ seconds: 999 });
  writeBytes(file, external);
  fs.utimesSync(file, new Date(clock.at + 1000), new Date(clock.at + 1000));
  assert.throws(() => timeline.finishSave(id, receipt), /又发生了变化/);
  assert.throws(() => timeline.cancelUnwritten(id), /已发生变化/);
  assert.equal(sha(fs.readFileSync(file)), sha(external));
  assert.equal(timeline.data.pending.id, id);
});
test('native rejection cancels only an unwritten request', (t) => {
  const { timeline, save } = setup(t);
  save(10);
  const id = crypto.randomUUID();
  timeline.beginSave(id, 'auto');
  timeline.cancelUnwritten(id);
  assert.equal(timeline.data.pending, null);
});
test('staging changes only the dedicated slot and retains a verified pre-load checkpoint', (t) => {
  const { timeline, source, file, save, clock } = setup(t);
  const old = save(10);
  clock.at += 10000;
  const current = save(20);
  fs.writeFileSync(path.join(source, '0.sav'), 'unrelated');
  fs.writeFileSync(path.join(source, 'JHSaveConfig.sav'), 'index');
  const staged = timeline.stage(old.id);
  assert.equal(sha(fs.readFileSync(file)), old.hash);
  assert.equal(timeline.inspect(staged.safetyId).record.hash, current.hash);
  assert.equal(fs.readFileSync(path.join(source, '0.sav'), 'utf8'), 'unrelated');
  assert.equal(fs.readFileSync(path.join(source, 'JHSaveConfig.sav'), 'utf8'), 'index');
});
test('interruption after slot replacement reconciles ownership without overwriting files', (t) => {
  const { timeline, file, save, clock } = setup(t);
  const old = save(10);
  clock.at += 10000;
  save(20);
  const original = fs.renameSync;
  let commits = 0;
  fs.renameSync = function (a, b) {
    if (b === timeline.file && ++commits === 3) throw Error('simulated manifest failure');
    return original(a, b);
  };
  try {
    assert.throws(() => timeline.stage(old.id), /simulated/);
  } finally {
    fs.renameSync = original;
  }
  assert.equal(sha(fs.readFileSync(file)), old.hash);
  const reopened = new Timeline(timeline.root);
  assert.equal(reopened.data.pending.type, 'stage');
  reopened.reconcileStage();
  assert.equal(reopened.data.ownerHash, old.hash);
  assert.equal(reopened.data.enabled, false);
  assert.equal(reopened.data.pending, null);
});
test('interruption recovery preserves a later external modification', (t) => {
  const { timeline, file, save } = setup(t);
  const old = save(10),
    current = save(20);
  timeline.commit({
    ...timeline.data,
    pending: {
      type: 'stage',
      id: crypto.randomUUID(),
      beforeHash: current.hash,
      targetHash: old.hash,
      at: Date.now(),
    },
  });
  const other = syntheticSave({ seconds: 999 });
  writeBytes(file, other);
  assert.throws(() => timeline.reconcileStage(), /外部修改/);
  assert.equal(sha(fs.readFileSync(file)), sha(other));
  assert.ok(timeline.data.pending);
});
test('damaged checkpoints and traversal ids cannot stage a load', (t) => {
  const { timeline, file, save } = setup(t);
  const r = save(10),
    before = sha(fs.readFileSync(file));
  fs.writeFileSync(path.join(timeline.blobs, r.hash + '.sav'), 'corrupt');
  assert.throws(() => timeline.stage(r.id), /校验失败/);
  assert.throws(() => timeline.inspect('../29.sav'), /编号无效/);
  assert.equal(sha(fs.readFileSync(file)), before);
});
test('rolling retention removes only retired automatic blobs and keeps protections and unknown files', (t) => {
  const { timeline, file, clock, save } = setup(t);
  const first = save(10);
  clock.at += 1000;
  const manual = timeline.record(syntheticSave({ seconds: 15 }), 'manual');
  const unknown = syntheticSave({ seconds: 777 }),
    unknownFile = path.join(timeline.blobs, sha(unknown) + '.sav');
  fs.writeFileSync(unknownFile, unknown);
  clock.at += 8000000;
  save(20);
  clock.at += 10000;
  save(30);
  clock.at += 8000000;
  save(40);
  clock.at += 10000;
  save(50);
  assert.ok(!timeline.data.records.some((r) => r.id === first.id));
  assert.equal(timeline.inspect(manual.id).record.playSeconds, 15);
  assert.ok(fs.existsSync(unknownFile));
  assert.ok(fs.existsSync(file));
  assert.ok(!fs.existsSync(path.join(timeline.blobs, first.hash + '.sav')));
});
test('a selected node survives rotation while saving current progress, including a prior protection', (t) => {
  const { timeline, save, clock } = setup(t);
  const old = timeline.record(syntheticSave({ seconds: 5 }), 'before-load');
  const unpin = timeline.pin(old.id);
  const secondPin = timeline.pin(old.id);
  clock.at += 10000;
  save(20);
  const safety = timeline.record(syntheticSave({ seconds: 25 }), 'before-load');
  timeline.collect();
  assert.equal(timeline.inspect(old.id).record.playSeconds, 5);
  assert.equal(timeline.inspect(safety.id).record.playSeconds, 25);
  unpin();
  unpin(); // Releasing one holder twice cannot remove another holder's pin.
  clock.at += 10000;
  save(30);
  assert.equal(timeline.inspect(old.id).record.playSeconds, 5);
  secondPin();
  clock.at += 10000;
  save(40);
  assert.ok(!timeline.data.records.some((r) => r.id === old.id));
  assert.equal(timeline.inspect(safety.id).record.playSeconds, 25);
});
test('corrupt timeline state is preserved and disables all mutation', (t) => {
  const { timeline } = setup(t);
  fs.writeFileSync(timeline.file, '{broken');
  const bad = new Timeline(timeline.root);
  assert.match(bad.error, /记录损坏/);
  assert.equal(bad.summary().indexError, true);
  assert.ok(bad.summary().diagnostic);
  assert.equal(bad.validateSource(timeline.data.source), fs.realpathSync(timeline.data.source));
  assert.throws(() => bad.validateSource(timeline.root), /不能互相包含/);
  assert.equal(bad.data.source, '');
  assert.equal(bad.data.enabled, false);
  assert.throws(() => bad.configure(timeline.data.source, true, 10), /记录损坏/);
  assert.equal(fs.readFileSync(timeline.file, 'utf8'), '{broken');
});

test('rollback selector preserves every supported age, real record precision and protection gates', async () => {
  const { pathToFileURL } = require('node:url');
  const { createTimelineViews } = await import(
    pathToFileURL(path.join(__dirname, '../src/renderer/timeline-views.js')).href
  );
  const text = (value) => String(value ?? '');
  const view = createTimelineViews({
    esc: text,
    icon: text,
    pill: text,
    notice: text,
    hours: text,
    bytes: text,
    iconButton: () => '',
    act: (action, label, cls, id) =>
      '<button data-action="' + action + '" data-id="' + id + '">' + label + '</button>',
  });
  const record = { id: 'synthetic-precision', at: Date.now() - 65000, mapName: '梧桐村', playSeconds: 100 };
  const timeline = {
    enabled: true,
    ready: true,
    connected: true,
    interval: 10,
    count: 1,
    bytes: 10,
    maxAutomaticRecords: 100,
    latest: record,
    history: [record],
    nodes: AGES.map((seconds) => ({
      seconds,
      toleranceSeconds: seconds === 50 ? 15 : 20,
      record: [50, 60].includes(seconds) ? { ...record, ageSeconds: 65, gapSeconds: 65 - seconds } : null,
    })),
  };
  const before = structuredClone(timeline),
    html = view.page(timeline, { target: 60 });
  assert.match(html, /id="timeline-target"[^>]*aria-label="选择回退时间"/);
  assert.deepEqual(
    [...html.matchAll(/<option value="(\d+)"[^>]*>(?:\d+ (?:秒|分钟|小时)前)/g)]
      .map((match) => Number(match[1]))
      .sort((a, b) => a - b),
    [...AGES].sort((a, b) => a - b),
  );
  assert.match(html, /value="60" selected/);
  assert.match(html, /实际距今 1 分钟 5 秒/);
  assert.match(html, /比目标早 5 秒/);
  assert.match(html, /共用记录/);
  assert.match(html, /29 号.*请勿/);
  for (const blocked of [{ ready: false }, { busy: true }, { pending: {} }, { quiescing: true }])
    assert.match(view.page({ ...timeline, ...blocked }), /data-id="attempt" data-save-ready disabled/);
  assert.deepEqual(timeline, before);
});
