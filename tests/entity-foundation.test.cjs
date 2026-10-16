'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const url = (name) => {
  const source = fs
    .readFileSync(path.join(__dirname, '../src/renderer', name), 'utf8')
    .replace(
      /from '(\.\.?\/[^']+)'/g,
      (_, dependency) => 'from ' + JSON.stringify(url(path.posix.join(path.posix.dirname(name), dependency))),
    );
  return 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
};
const loaded = Promise.all([
  import(url('entity-catalog.js')),
  import(url('entity-references.js')),
  import(url('game-images.js')),
]);
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const portrait = '0123456789abcdef0123.png';
const fixture = () => ({
  entries: [
    { id: 'npc-1', gameId: 1, name: '江小彤', kind: '人物' },
    { id: 'npc-2', gameId: 2, name: '江小彤', kind: '人物' },
    { id: 'item-1', gameId: 1, name: '亮银甲', kind: '物品', quality: '白' },
    { id: 'item-2', gameId: 2, name: '亮银甲', kind: '物品', quality: '蓝' },
  ],
  images: { 'npc-1': portrait },
  world: {
    maps: [
      { id: 'place-1', gameId: 1, name: '武当派', key: 'wudang', cave: false },
      { id: 'place-2', gameId: 2, name: '梧桐村', key: 'village-a', cave: false },
      { id: 'place-3', gameId: 3, name: '梧桐村', key: 'village-b', cave: false },
    ],
    placeAliases: [{ name: '武当派', mentions: ['武当山', '武当'] }],
    quests: [
      { id: 'quest-5213', gameId: 5213, name: '【主线】拜师武当', parentId: 0 },
      {
        id: 'quest-5214',
        gameId: 5214,
        name: '前往三清殿参加拜师大典',
        parentId: 5213,
        placements: [{ mapKey: 'wudang' }],
      },
    ],
  },
});
const references = (createEntityReferences, data) =>
  createEntityReferences({
    index: () => data,
    esc,
    picture: (id) => `<span data-picture="${esc(id)}"></span>`,
    icon: esc,
    qualityText: { html: (_, label) => label },
  });

test('typed prose links places, exact child tasks and a verified guide alias without duplicating references in prose', async () => {
  const [{ entityCatalog }, { createEntityReferences }] = await loaded;
  const data = fixture(),
    catalog = entityCatalog(data),
    refs = references(createEntityReferences, data);
  const html = refs.text('拜入武当前往武当山；前往三清殿参加拜师大典，再回梧桐村。');
  assert.match(html, /data-action="world-quest" data-id="quest-5213"/);
  assert.match(html, /data-action="world-place" data-id="place-1" data-entity-id="place-1"/);
  assert.match(html, /data-action="world-quest" data-id="quest-5214"/);
  assert.match(html, /data-action="entity-choice" data-id="name:梧桐村"/);
  assert.equal(catalog.resolve('place-1')[0].kind, '地点');
  assert.equal(catalog.resolve('name:梧桐村').length, 2);
  assert.equal(catalog.resolve('name:亮银甲').length, 2);
  assert.equal(catalog.resolve('name:江小彤').length, 2);
});

test('a missing portrait export does not hide a shared known portrait or collapse distinct NPCs', async () => {
  const [, { createEntityReferences }, { sharedEntityArtwork, createGameImages }] = await loaded;
  const data = fixture(),
    refs = references(createEntityReferences, data);
  assert.match(refs.artwork('name:江小彤'), /data-picture="npc-1"/);
  assert.equal(refs.choices('name:江小彤').length, 2);
  assert.equal(sharedEntityArtwork(data, refs.choices('name:江小彤')), 'npc-1');
  data.images['npc-2'] = 'fedcba9876543210fedc.png';
  assert.doesNotMatch(refs.artwork('name:江小彤'), /data-picture/);
  assert.match(refs.artwork('name:江小彤'), /person/);
  data.images['npc-2'] = '../unsafe.png';
  assert.equal(sharedEntityArtwork(data, refs.choices('name:江小彤')), 'npc-1');
  const images = createGameImages({ index: () => data, icon: esc, esc });
  assert.match(images.person('江小彤'), /0123456789abcdef0123\.png/);
  assert.match(images.picture('place-1'), /image-fallback">pin/);
  assert.doesNotMatch(images.picture('npc-2'), /<img/);
});

test('place and task previews keep actionable saved facts without save filenames or debug identifiers', async () => {
  const [, { createEntityReferences }] = await loaded;
  const refs = references(createEntityReferences, fixture());
  const reference = {
    name: 'secret.sav',
    hash: 'private-hash',
    metadata: { map: 'wudang', quests: [{ id: 5214, step: 1 }] },
  };
  const place = refs.preview('place-1', { reference });
  assert.match(place, /当前保存地点/);
  assert.match(place, /拜师武当/);
  const quest = refs.preview('quest-5213', { reference });
  assert.match(quest, /下一步：前往三清殿参加拜师大典/);
  assert.doesNotMatch(place + quest, /secret\.sav|private-hash|SHA|场景编号|不保证执行顺序/);
});

test('same-name choices show verified scene clues and distinguish otherwise unknown variants', async () => {
  const [, { createEntityReferences }] = await loaded;
  const data = fixture();
  data.world.maps.push({ id: 'place-4', gameId: 4, name: '梧桐村', key: 'village-c' });
  data.world.quests.push({
    id: 'quest-10',
    gameId: 10,
    name: '寻找草药',
    placements: [{ mapKey: 'village-a' }],
  });
  data.entries[1].npcFacts = { level: 40, fixedItems: [] };
  const refs = references(createEntityReferences, data);
  const places = refs.choices('name:梧桐村');
  const labels = places.map((entry) => refs.choiceSummary(entry, places, { metadata: { map: 'village-b' } }));
  assert.match(labels[0], /场景 1\/3.*寻找草药/);
  assert.match(labels[1], /场景 2\/3.*当前地点/);
  assert.match(labels[2], /场景 3\/3.*暂无关联任务/);
  assert.equal(new Set(labels).size, 3);
  const people = refs.choices('name:江小彤');
  const peopleLabels = people.map((entry) => refs.choiceSummary(entry, people));
  assert.doesNotMatch(peopleLabels[0], /40/);
  assert.match(peopleLabels[1], /初始等级 40/);
  assert.doesNotMatch(labels.join('') + peopleLabels.join(''), /place-|npc-|village-|SHA/);
});

test('direct lists and hover cards distinguish real namesakes with the shared summary', async () => {
  const [, { createEntityReferences }] = await loaded;
  const [{ createGameViews }, { createWorldViews }] = await Promise.all([
    import(url('game-views.js')),
    import(url('world-views.js')),
  ]);
  const data = require('../src/core/game-data.cjs').encyclopedia();
  const refs = references(createEntityReferences, data);
  const helpers = {
    esc,
    act: () => '',
    icon: () => '',
    iconButton: () => '',
    pill: esc,
    notice: esc,
    empty: esc,
    picture: () => '',
    variantSummary: refs.variantSummary,
    richText: refs.text,
    qualityText: { quality: () => '', label: () => '', name: (_e, name) => esc(name) },
  };
  const people = createGameViews(helpers).page(data, '名称:茶博士', '人物', '全部', 0);
  assert.match(people, /初始等级 20/);
  assert.match(people, /初始等级 30/);
  const places = createWorldViews(helpers).page(
    data,
    { kind: 'places', query: '名称:梧桐村', page: 0, roots: false, status: 'all' },
    [],
  );
  for (const n of [1, 2, 3, 4]) assert(places.includes(`场景 ${n}/4`));
  const a = refs.preview('place-63'),
    b = refs.preview('place-64');
  assert.notEqual(a, b);
  assert.match(a, /场景 3\/4/);
  assert.match(b, /场景 4\/4/);
  const overlap = refs.preview('map-point:1367.43:648.71');
  assert.match(overlap, /place-map-preview/);
  assert.match(overlap, /蜃楼岛/);
  assert.match(overlap, /幻林/);
  for (const [itemId, placeName] of [
    ['item-1000', '梧桐村'],
    ['item-156', '武当派'],
  ]) {
    const detail = createGameViews(helpers).detail(data, itemId);
    const sellers = detail.match(/<details class="detail-block item-sellers">([\s\S]*?)<\/details>/)?.[1];
    assert(sellers, 'real item has known sellers');
    assert.match(sellers, new RegExp('data-entity-id="[^"]+"[^>]*>[\\s\\S]*?' + placeName));
    assert.match(sellers, /data-action="(?:world-place|entity-choice)"/);
  }
});

test('saved tracking names link only to a known exact quest and never to an undefined target', async () => {
  const { createGameViews } = await import(url('game-views.js'));
  const game = require('../src/core/game-data.cjs');
  const index = game.encyclopedia();
  const view = createGameViews({
    esc,
    act: (action, label, cls, id) =>
      `<button data-action="${esc(action)}" data-id="${esc(id)}">${label}</button>`,
    icon: () => '',
    iconButton: () => '',
    picture: () => '',
    pill: esc,
    bytes: esc,
    when: esc,
    hours: esc,
    qualityText: { name: (_id, name) => esc(name) },
  });
  for (const [trackingQuest, known] of [
    [5200, true],
    [987654321, false],
  ]) {
    const metadata = game.enrich({ trackingQuest, trackingMainQuest: 987654322 });
    const before = structuredClone(metadata);
    const html = view.saveDetail({ name: 'synthetic.sav', metadata }, index);
    assert.equal(html.includes('data-action="world-quest" data-id="quest-5200"'), known);
    assert.doesNotMatch(html, /data-id="quest-(?:undefined|987654321|987654322)"/);
    assert(html.includes(esc(metadata.mainQuest.name)), 'unmapped tracking remains readable');
    assert.deepEqual(metadata, before);
  }
});
