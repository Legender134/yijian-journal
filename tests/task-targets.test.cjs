'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const world = require('../src/data/world-index.json');
const { createTaskTargetProjector } = require('../src/core/task-targets.cjs');
const { encyclopedia } = require('../src/core/game-data.cjs');
const { flowSnapshot } = require('../src/core/flow.cjs');
const projector = createTaskTargetProjector(world);
const project = projector.template;
const quest = (id) => world.quests.find((q) => q.gameId === id);
const esc = (s) =>
  String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('"', '&quot;');
const act = (action, label, cls, id) =>
  `<button data-action="${action}" data-id="${esc(id)}">${label}</button>`;
const helpers = {
  esc,
  act,
  pill: esc,
  when: esc,
  icon: () => '',
  picture: () => '',
  iconButton: () => '',
  notice: esc,
  empty: esc,
  qualityText: { html: (_id, name) => esc(name) },
};

test('current destinations follow instructions, excluding direction landmarks, narration and report subjects', () => {
  for (const [id, expected] of [
    [8879, ['武当派']],
    [5151, ['洛村']],
    [5235, ['猴儿林']],
    [5238, ['清河村']],
    [5506, ['北山村', '峋谷关']],
    [5581, ['葬龙谷', '黎城']],
    [5784, ['天水城', '程家堡']],
    [18059, ['十万大山']],
    [18532, ['鹰愁谷']],
    [11612, ['竹海']],
    [30392, ['和璞山庄']],
    [11847, ['竹海']],
    [11610, ['洛村']],
    [5172, ['洛村']],
    [7025, ['景陇']],
    [8504, ['通幽沼']],
    [11631, ['威远镖局']],
    [11873, ['梧桐村']],
    [12531, ['雷家村']],
    [13082, ['一线天']],
    [20101, ['天剑宗']],
    [11611, ['姑苏城']],
    [5921, ['丐帮分舵']],
    [6051, ['峋谷关']],
    [14126, ['饿虎坡']],
    [11898, ['青木舫']],
    [5111, ['后山山洞']],
    [11243, []],
    [12317, []],
    [8515, []],
    [8520, ['长生殿']],
    [5768, ['紫竹林']],
    [14082, []],
  ])
    assert.deepEqual(
      project(quest(id))
        .places.filter((p) => !quest(id).materials?.length || p.purpose !== 'turn-in')
        .map((p) => p.name),
      expected,
      String(id),
    );
  const task = quest(8879),
    before = structuredClone(task);
  const target = project(task).places[0];
  assert.equal(target.id, null, 'the title cannot choose one Wudang story variant');
  assert(target.mapKeys.length > 1);
  assert.deepEqual(task, before);
  assert.equal(project(quest(5111)).purpose, 'departure');
  assert.deepEqual(
    project({ name: '离开洛村，前往梧桐村' }).places.map((p) => p.purpose),
    ['departure', 'objective'],
  );
});

test('qualified caves resolve to their own family while an unqualified cave remains a chooser', async () => {
  const named = project(quest(5076)).places[0];
  assert.equal(named.name, '后山山洞');
  assert.equal(named.id, null);
  assert.deepEqual(named.mapKeys.sort(), ['LV_21_P', 'LV_21_P1']);
  const generic = project({ name: '前往山洞深处' }).places[0];
  assert.equal(generic.id, null);
  assert(generic.mapKeys.length > 2);
  assert.equal(project(quest(5715)).places[0].id, 'place-25');
  assert.match(project(quest(5715)).nextAction, /万劫窟/);
  const { createEntityReferences } = await import('../src/renderer/entity-references.js');
  const index = encyclopedia(),
    refs = createEntityReferences({ ...helpers, index: () => index });
  assert.equal(refs.choices('name:后山的山洞口').length, 2);
  assert(refs.choices('name:山洞').length > 2);
  const { taskMentions } = await import('../src/renderer/task-mentions.js');
  const mentioned = taskMentions(index, { description: '进入山洞。' });
  assert.equal(mentioned.places.length, 1);
  assert.deepEqual(mentioned.places[0].choices.map((p) => p.key).sort(), generic.mapKeys.toSorted());
  const { createWorldViews } = await import('../src/renderer/world-views.js');
  const reference = { metadata: { quests: [5074, 5076].map((id) => ({ id, step: 1 })) } };
  const views = createWorldViews(helpers);
  for (const id of ['place-11', 'place-12'])
    assert.match(
      views.placeDetail(index, id, { reference }).match(/data-place-current-tasks[\s\S]*?<\/section>/)?.[0],
      /quest-5076/,
    );
  assert.doesNotMatch(
    views
      .placeDetail(index, 'place-95', { reference })
      .match(/data-place-current-tasks[\s\S]*?<\/section>/)?.[0] || '',
    /quest-5076/,
  );
});

test('same-name finish variants remain one explicit choice instead of duplicate current buttons', async () => {
  const { createFlowViews } = await import('../src/renderer/flow-views.js');
  const { createEntityReferences } = await import('../src/renderer/entity-references.js');
  const index = encyclopedia(),
    refs = createEntityReferences({
      ...helpers,
      qualityText: { html: (_id, name) => name },
      index: () => index,
    });
  for (const [parent, id, name] of [
    [11249, 11259, '铁匠-张海'],
    [11305, 11313, '掌柜-李郝'],
  ]) {
    const people = project(quest(id)).people;
    assert.equal(people.length, 1);
    assert.equal(people[0].id, null);
    assert.equal(people[0].ids.length, 2);
    const reference = {
      name: 'synthetic.sav',
      metadata: { quests: [parent, id].map((id) => ({ id, step: 1 })) },
    };
    const flow = flowSnapshot({ id: 'synthetic', referenceMode: 'latest' }, reference);
    const html = createFlowViews({ ...helpers, richText: (s, t) => refs.text(s, 'flow-quest', t) }).panel(
      flow,
      { compact: true },
    );
    const lead = html.match(/<section class="flow-now[\s\S]*?<details class="flow-now-details"/)?.[0];
    assert.equal((lead.match(new RegExp(`data-id="name:${name}"`, 'g')) || []).length, 1);
  }
});

test('task-specified material sources share their destination and do not contradict or repeat the visible instruction', async () => {
  const { createFlowViews } = await import('../src/renderer/flow-views.js');
  const reference = {
    name: 'synthetic.sav',
    metadata: { quests: [11840, 11847].map((id) => ({ id, step: 1 })), inventory: [] },
  };
  const flow = flowSnapshot({ id: 'synthetic', referenceMode: 'latest' }, reference);
  const route = flow.active[0].steps[0].materials[0].routes[0];
  assert.equal(route.placeId, 'place-32');
  assert.equal(route.placeName, '竹海');
  const views = createFlowViews(helpers);
  const lead = views
    .panel(flow, { compact: true })
    .match(/<section class="flow-now[\s\S]*?<details class="flow-now-details"/)?.[0];
  assert.doesNotMatch(lead, /暂无获取地点|flow-source-brief/);
  assert.match(
    views.taskMaterials(flow, { compact: true }),
    /flow-source-brief[^>]*>[^<]*<button[^>]*data-id="place-32"/,
  );
});

test('acquisition destinations neither claim delivery nor place the later recipient there', () => {
  for (const id of [11260, 11697, 11703, 11888, 11612]) {
    const targets = project(quest(id));
    assert.equal(targets.purpose, 'objective', String(id));
    assert(targets.places.length > 0, String(id));
    for (const place of targets.places) {
      assert.equal(place.purpose, 'objective', String(id));
      assert.deepEqual(place.personIds, [], String(id));
    }
  }
  assert.deepEqual(project(quest(11078)).places[0].personIds, [10125]);
  for (const id of [11696, 11631]) {
    const delivery = project(quest(id));
    assert.equal(delivery.purpose, 'turn-in');
    assert.deepEqual(delivery.places[0].personIds, quest(id).finishNPCs);
  }
  const fishing = project(quest(6255));
  assert.equal(fishing.purpose, 'objective');
  assert.deepEqual(fishing.places[0].personIds, []);
});

test('a step does not send the player back to its commissioner', () => {
  for (const [id, expected] of [
    [11776, ['npc-17010']],
    [11696, ['npc-10803']],
    [11003, ['npc-10005']],
    [11173, []],
    [11656, []],
    [11260, []],
    [5057, []],
    [12831, []],
    [14007, []],
  ])
    assert.deepEqual(
      projector.project(quest(id), { inventory: [] }).people.map((p) => p.id),
      expected,
      String(id),
    );
});

test('ambiguous story scenes retain the current task without claiming an exact scene or NPC', async () => {
  const index = encyclopedia();
  const { createWorldViews } = await import('../src/renderer/world-views.js');
  const { createEntityReferences } = await import('../src/renderer/entity-references.js');
  const { placeEntityId } = await import('../src/renderer/entity-catalog.js');
  const reference = { metadata: { quests: [8830, 8879].map((id) => ({ id, step: 1 })) } };
  const views = createWorldViews(helpers);
  const refs = createEntityReferences({ ...helpers, index: () => index });
  const places = index.world.maps.filter((p) => p.name === '武当派');
  assert(places.length > 1);
  for (const place of places) {
    const id = placeEntityId(place, index.world.maps);
    const html = views.placeDetail(index, id, { reference });
    const current = html.match(/data-place-current-tasks[\s\S]*?<\/section>/)?.[0];
    assert.match(current, /quest-8879/, place.key);
    assert.match(current, /场景待确认/, place.key);
    assert.doesNotMatch(current, /交互：|交付：/, place.key);
    const preview = refs.preview(id, { reference });
    assert.match(preview, /返回武当/, place.key);
    assert.match(preview, /场景待确认/, place.key);
  }
});

test('collection and delivery are distinct and a sole interaction scene can resolve a namesake', async () => {
  const herb = project(quest(11078));
  assert.equal(herb.purpose, 'turn-in');
  assert.deepEqual(
    herb.places.map((p) => p.name),
    ['洛村'],
  );
  assert.equal(herb.people[0].id, 'npc-10125');
  assert.equal(herb.people[0].role, '交付');
  const maps = [
    { id: 'place-1', key: 'first', name: '武当派' },
    { id: 'place-1', key: 'later', name: '武当派' },
  ];
  const p = createTaskTargetProjector({ maps, people: [{ gameId: 1, name: '张三' }] }).project;
  const task = {
    name: '返回武当拜见张三',
    finishNPCs: [1],
    placements: [{ mapKey: 'later', npcId: 1, interactionTarget: true }],
  };
  assert.equal(p(task).places[0].id, 'place-1:later');
  const { createFlowViews } = await import('../src/renderer/flow-views.js');
  const flow = flowSnapshot(
    { id: 'synthetic', referenceMode: 'latest' },
    { name: 'synthetic.sav', metadata: { quests: [8830, 8879].map((id) => ({ id, step: 1 })) } },
  );
  Object.assign(flow.active[0].steps[0], { nextAction: '拜见张三', targets: p(task) });
  assert.match(createFlowViews(helpers).panel(flow, { compact: true }), /data-id="place-1:later"/);
  assert.equal(
    p({ ...task, placements: [...task.placements, { mapKey: 'first', npcId: 1, interactionTarget: true }] })
      .places[0].id,
    null,
  );
  assert.equal(
    p({ ...task, placements: [{ mapKey: 'later', npcId: 1, interactionTarget: false }] }).places[0].id,
    null,
  );
});

test('flow lead uses objectives while retaining all narrative relationships in expanded details', async () => {
  const { createFlowViews } = await import('../src/renderer/flow-views.js');
  const flow = flowSnapshot(
    { id: 'synthetic', referenceMode: 'latest' },
    {
      name: 'synthetic.sav',
      hash: 'synthetic',
      metadata: {
        quests: [
          { id: 8830, step: 1 },
          { id: 8879, step: 1 },
        ],
        inventory: [],
      },
    },
  );
  const step = flow.active[0].steps[0];
  assert(step.places.some((p) => p.name === '名剑山庄'));
  assert(!step.targets.places.some((p) => p.name === '名剑山庄'));
  const html = createFlowViews(helpers).panel(flow, { compact: true });
  const lead = html.match(/<section class="flow-now[\s\S]*?<details class="flow-now-details"/)[0];
  assert.match(lead, /前往 武当派/);
  assert.doesNotMatch(lead, /名剑山庄|欧阳衡|欧阳雪/);
  assert.match(html, /名剑山庄/);
  const main = createFlowViews(helpers).panel(flow);
  const mainLead = main.match(
    /<article class="flow-task flow-task-summary" data-flow-quest="quest-8830">[\s\S]*?<details data-persist-detail="main-task-quest-8830"/,
  )?.[0];
  assert(mainLead);
  assert.doesNotMatch(mainLead, /名剑山庄|欧阳衡|欧阳雪/);
  assert.match(
    main.slice(main.indexOf('data-persist-detail="main-task-quest-8830"')),
    /flow-places[\s\S]*名剑山庄/,
  );
});

test('resting before tomorrow does not become a destination until the departure step is active', async () => {
  const { createWorldViews } = await import('../src/renderer/world-views.js');
  const views = createWorldViews(helpers),
    index = encyclopedia();
  for (const place of index.world.maps.filter((p) => p.name === '长生殿')) {
    const resting = views.placeDetail(index, place.id, {
      reference: { metadata: { quests: [8499, 8515].map((id) => ({ id, step: 1 })) } },
    });
    assert.doesNotMatch(
      resting.match(/data-place-current-tasks[\s\S]*?<\/section>/)?.[0] || '',
      /quest-8515/,
    );
    const departing = views.placeDetail(index, place.id, {
      reference: { metadata: { quests: [8499, 8520].map((id) => ({ id, step: 1 })) } },
    });
    assert.match(departing.match(/data-place-current-tasks[\s\S]*?<\/section>/)?.[0], /quest-8520/);
  }
  const withLaterPerson = createTaskTargetProjector({
    maps: world.maps,
    people: [{ gameId: 1, name: '张三' }],
  }).project({
    name: '休息一晚，准备明日去洛村找张三',
    finishNPCs: [1],
    placements: [{ mapKey: 'LV_25_P', npcId: 1, interactionTarget: true }],
  });
  assert.deepEqual(withLaterPerson.people, []);
  assert.deepEqual(withLaterPerson.places, []);
});

test('collection and invitation leads never promote later recipients, duplicate finish variants or the player', async () => {
  const { createFlowViews } = await import('../src/renderer/flow-views.js');
  const views = createFlowViews(helpers);
  for (const [parent, id, forbidden] of [
    [11249, 11260, /交付|张海/],
    [5053, 5057, /交付|孙老/],
    [12815, 12831, /宇文逸|交互/],
    [14006, 14007, /慧达/],
    [11840, 11847, /慕海棠|青木舫/],
  ]) {
    const reference = {
      name: 'synthetic.sav',
      metadata: { quests: [parent, id].map((id) => ({ id, step: 1 })), inventory: [] },
    };
    const flow = flowSnapshot({ id: 'synthetic', referenceMode: 'latest' }, reference);
    const html = views.panel(flow, { compact: true });
    const lead = html.match(/<section class="flow-now[\s\S]*?<details class="flow-now-details"/)?.[0];
    assert(lead, String(id));
    assert.match(lead, new RegExp(quest(id).name), String(id));
    assert.doesNotMatch(lead.slice(lead.indexOf('class="flow-next-action"')), forbidden, String(id));
  }
});

test('collection objectives reverse-link to the collection map instead of the later hand-in scene', async () => {
  const { createWorldViews } = await import('../src/renderer/world-views.js');
  const views = createWorldViews(helpers),
    index = encyclopedia();
  const reference = { metadata: { quests: [11840, 11847].map((id) => ({ id, step: 1 })), inventory: [] } };
  const collection = views.placeDetail(index, 'place-32', { reference });
  assert.match(collection.match(/data-place-current-tasks[\s\S]*?<\/section>/)?.[0], /quest-11847/);
  const later = views.placeDetail(index, 'place-55', { reference });
  assert.doesNotMatch(later.match(/data-place-current-tasks[\s\S]*?<\/section>/)?.[0] || '', /quest-11847/);
  assert.deepEqual(
    projector
      .project({ ...quest(11847), name: '前往竹海寻找青竹' }, { inventory: [] })
      .places.map((p) => p.name),
    ['竹海'],
  );
});

test('the same objective index carries an active task and its hand-in NPC into the place codex', async () => {
  const index = encyclopedia();
  const { createWorldViews } = await import('../src/renderer/world-views.js');
  const { createEntityReferences } = await import('../src/renderer/entity-references.js');
  const reference = {
    metadata: {
      quests: [
        { id: 11077, step: 1 },
        { id: 11078, step: 1 },
      ],
    },
  };
  const views = createWorldViews(helpers);
  const html = views.placeDetail(index, 'place-13', { reference });
  const current = html.match(/data-place-current-tasks[\s\S]*?<\/section>/)?.[0];
  assert(current);
  assert.match(current, /quest-11078/);
  assert.match(current, /npc-10125/);
  assert.match(current, /交付/);
  const closed = views.placeDetail(index, 'place-13', {
    reference: { metadata: { quests: [{ id: 11078, step: 4 }] } },
  });
  assert.doesNotMatch(closed, /data-place-current-tasks/);
  const refs = createEntityReferences({ ...helpers, index: () => index });
  assert.match(refs.preview('place-13', { reference }), /养生秘术/);
});

test('task hover follows the tracked parallel step and the same projected live next step', async () => {
  const index = encyclopedia();
  const { createEntityReferences } = await import('../src/renderer/entity-references.js');
  const refs = createEntityReferences({ ...helpers, index: () => index });
  const reference = {
    metadata: { trackingQuest: 5372, quests: [5368, 5371, 5372].map((id) => ({ id, step: 1 })) },
  };
  const preview = refs.preview('quest-5368', { reference });
  assert.match(preview, /下一步：与莫弃交谈/);
  assert.doesNotMatch(preview, /下一步：与莫问交谈/);
  for (const trackingQuest of [0, undefined]) {
    const historical = {
      name: 'history.sav',
      metadata: { ...reference.metadata, trackingQuest, trackingMainQuest: 5372 },
    };
    const flow = flowSnapshot(
      { id: 'synthetic', referenceMode: 'slot', saveSlot: historical.name },
      historical,
    );
    assert.equal(flow.active[0].steps[0].nextAction, '与莫弃交谈');
    assert.match(refs.preview('quest-5368', { reference: historical }), /下一步：与莫弃交谈/);
  }
  const live = { origin: 'live', metadata: { quests: reference.metadata.quests } };
  assert.match(
    refs.preview('quest-5368', { reference: live, nextSteps: new Map([['quest-5368', '与莫弃交谈']]) }),
    /下一步：与莫弃交谈/,
  );
  const untracked = { metadata: { quests: [5368, 5372, 5371].map((id) => ({ id, step: 1 })) } };
  const untrackedFlow = flowSnapshot(
    { id: 'synthetic', referenceMode: 'latest' },
    { name: 'synthetic.sav', ...untracked },
  );
  assert.equal(untrackedFlow.active[0].steps[0].nextAction, '与莫弃交谈');
  assert.match(refs.preview('quest-5368', { reference: untracked }), /下一步：与莫弃交谈/);
  const explicit = refs.preview('quest-5368', {
    reference,
    currentSteps: new Map([['quest-5368', 'quest-5371']]),
    nextSteps: new Map([['quest-5368', '与莫问交谈']]),
  });
  assert.match(explicit, /下一步：与莫问交谈/);
  assert.doesNotMatch(explicit, /交互：莫弃/);
});

test('a linked alias for the same destination is not repeated as another target line', async () => {
  const { createFlowViews } = await import('../src/renderer/flow-views.js');
  const { createEntityReferences } = await import('../src/renderer/entity-references.js');
  const index = encyclopedia();
  const refs = createEntityReferences({
    ...helpers,
    picture: () => '',
    qualityText: { html: (_id, name) => name },
    index: () => index,
  });
  const flow = flowSnapshot(
    { id: 'synthetic', referenceMode: 'latest' },
    {
      name: 'synthetic.sav',
      metadata: {
        quests: [
          { id: 8830, step: 1 },
          { id: 8879, step: 1 },
        ],
      },
    },
  );
  const html = createFlowViews({ ...helpers, richText: (s, t) => refs.text(s, 'flow-quest', t) }).panel(
    flow,
    { compact: true },
  );
  const lead = html.match(/<section class="flow-now[\s\S]*?<details class="flow-now-details"/)[0];
  assert.equal((lead.match(/place-name:武当/g) || []).length, 2, 'one button has data-id and data-entity-id');
  assert.doesNotMatch(lead, /flow-targets/);
});

test('mixed collection and delivery steps share missing, ready and unknown material phases across flow, map and hover', async () => {
  const index = encyclopedia();
  const { createWorldViews } = await import('../src/renderer/world-views.js');
  const { createEntityReferences } = await import('../src/renderer/entity-references.js');
  const { createFlowViews } = await import('../src/renderer/flow-views.js');
  const views = createWorldViews(helpers),
    refs = createEntityReferences({ ...helpers, index: () => index });
  const current = (html) => html.match(/data-place-current-tasks[\s\S]*?<\/section>/)?.[0] || '';
  for (const [root, id, deliveryPlace, sourcePlace] of [
    [11077, 11078, 'place-13', 'place-24'],
    [11052, 11054, 'place-9', 'place-22'],
    [13404, 13405, 'place-304', 'place-14'],
  ]) {
    const task = quest(id);
    const actualDelivery = index.world.objectives[task.id].places.find((p) => p.purpose === 'turn-in');
    const placeId = actualDelivery?.id || deliveryPlace;
    for (const phase of ['missing', 'ready', 'unknown']) {
      const reference = {
        name: 'synthetic.sav',
        metadata: { quests: [root, id].map((id) => ({ id, step: 1 })) },
      };
      if (phase !== 'unknown')
        reference.metadata.inventory =
          phase === 'ready' ? task.materials.map((m) => ({ id: m.id, count: m.count })) : [];
      const before = structuredClone(reference);
      const flow = flowSnapshot({ id: 'synthetic', referenceMode: 'latest' }, reference);
      const step = flow.active.find((q) => q.gameId === root).steps.find((q) => q.id === task.id);
      assert.equal(step.targets.materialState, phase, String(id));
      const handIn = current(views.placeDetail(index, placeId, { reference }));
      const source = current(views.placeDetail(index, sourcePlace, { reference }));
      const preview = refs.preview('quest-' + root, { reference });
      if (phase === 'missing') {
        assert.equal(
          step.targets.people.some((p) => p.role === '交付'),
          false,
        );
        assert.doesNotMatch(handIn, new RegExp(task.id));
        assert.match(source, new RegExp(task.id));
        assert.match(source, /备料线索/);
        assert.match(step.nextAction, /先备齐|收集军需物资/);
        assert.doesNotMatch(preview, /交付：/);
      } else if (phase === 'ready') {
        assert.match(handIn, new RegExp(task.id));
        assert.doesNotMatch(source, new RegExp(task.id));
        assert.match(step.nextAction, /交付/);
        assert(step.targets.people.some((p) => p.role === '交付'));
      } else {
        assert.match(handIn, /集齐材料后交付/);
        assert.match(step.nextAction, /集齐材料后交付/);
        assert.match(preview, /集齐后交付/);
        assert.equal(
          step.targets.people.some((p) => p.role === '交付'),
          false,
        );
      }
      const html = createFlowViews(helpers).panel(flow, { compact: true });
      assert(html.includes(task.name), 'retain the original instruction in expanded details');
      assert.deepEqual(reference, before);
    }
  }
  const reference = {
    metadata: { quests: [11077, 11078].map((id) => ({ id, step: 1 })), inventory: [{ id: 10262, count: 1 }] },
  };
  assert.doesNotMatch(
    current(views.placeDetail(index, 'place-44', { reference })),
    /quest-11078/,
    'do not send players for already collected materials',
  );
  assert.match(current(views.placeDetail(index, 'place-24', { reference })), /quest-11078/);
  const partlyCollected = current(views.placeDetail(index, 'place-22', { reference }));
  assert.match(partlyCollected, /补骨脂/);
  assert.doesNotMatch(partlyCollected, /地黄/);
});

test('task hover names the selected current actors instead of the whole quest family', async () => {
  const index = encyclopedia();
  const { createEntityReferences } = await import('../src/renderer/entity-references.js');
  const refs = createEntityReferences({ ...helpers, index: () => index });
  for (const [root, step, forbidden] of [
    [11840, 11847, /交互：[^<]*慕海棠/],
    [11775, 11779, /交互：[^<]*(?:张彩织|蕊蕊)/],
  ]) {
    const reference = { metadata: { quests: [root, step].map((id) => ({ id, step: 1 })), inventory: [] } };
    const preview = refs.preview('quest-' + root, { reference });
    assert.match(
      preview,
      step === 11779 ? /到连鼓山寻找张彩织的货物，可能藏在宝箱内/ : new RegExp(quest(step).name),
    );
    assert.doesNotMatch(preview, forbidden);
  }
});

test('map current tasks exclude active narrative parents and recognize the verified waterfall alias', async () => {
  const index = encyclopedia();
  const { createWorldViews } = await import('../src/renderer/world-views.js');
  const views = createWorldViews(helpers);
  const current = (id, reference) =>
    views.placeDetail(index, id, { reference }).match(/data-place-current-tasks[\s\S]*?<\/section>/)?.[0] ||
    '';
  const reference = {
    metadata: { trackingQuest: 12001, quests: [12000, 12001].map((id) => ({ id, step: 1 })) },
  };
  assert.doesNotMatch(current('place-14', reference), /quest-12000/);
  assert.match(current('place-13', reference), /quest-12001/);
  const waterfall = { metadata: { quests: [11875, 11880].map((id) => ({ id, step: 1 })) } };
  assert.match(current('place-41', waterfall), /quest-11880/);
  assert.deepEqual(
    project(quest(11880)).places.map((p) => p.name),
    ['檀林'],
  );
});

test('material completion requirements govern collection, handover and unknown stock regardless of title wording', async () => {
  const index = encyclopedia();
  const { createEntityReferences } = await import('../src/renderer/entity-references.js');
  const { createWorldViews } = await import('../src/renderer/world-views.js');
  const refs = createEntityReferences({ ...helpers, index: () => index });
  const views = createWorldViews(helpers);
  const current = (place, reference) =>
    views
      .placeDetail(index, place, { reference })
      .match(/data-place-current-tasks[\s\S]*?<\/section>/)?.[0] || '';
  for (const id of [11721, 12035, 30056, 11475, 11109, 32702, 11128, 11130, 14002, 14005]) {
    const task = quest(id);
    for (const phase of ['missing', 'ready', 'unknown']) {
      const reference = {
        name: 'synthetic.sav',
        metadata: { quests: [task.parentId, id].map((id) => ({ id, step: 1 })) },
      };
      if (phase !== 'unknown') reference.metadata.inventory = phase === 'ready' ? task.materials : [];
      const before = structuredClone(reference);
      const flow = flowSnapshot({ id: 'synthetic', referenceMode: 'latest' }, reference);
      const step = flow.active.find((q) => q.gameId === task.parentId).steps.find((q) => q.id === task.id);
      assert.equal(step.targets.materialState, phase, String(id));
      const recipients = step.targets.people.filter((p) => p.ids.some((id) => task.finishNPCs.includes(id)));
      const preview = refs.preview('quest-' + task.parentId, { reference });
      if (phase === 'missing') {
        assert.equal(recipients.length, 0, String(id));
        assert.doesNotMatch(preview, /(?:交互|交付|交谈)：/);
        assert.equal(
          step.targets.places.some((p) => /turn-in/.test(p.purpose)),
          false,
        );
      } else if (phase === 'ready') {
        assert.equal(recipients.flatMap((p) => p.ids).length, task.finishNPCs.length);
        assert.equal(
          step.targets.places.some((p) => p.purpose === 'material-source'),
          false,
        );
      } else {
        assert(recipients.every((p) => /后/.test(p.role)));
        assert.match(step.nextAction, /材料后/);
      }
      if (id === 12035) {
        const source = current('place-300', reference),
          later = current('place-304', reference);
        if (phase === 'ready') {
          assert.doesNotMatch(source, /quest-12035/);
          assert.match(later, /quest-12035/);
        } else {
          assert.match(source, /quest-12035/);
          if (phase === 'missing') assert.doesNotMatch(later, /quest-12035/);
          else assert.match(later, /集齐材料后交付/);
        }
      }
      if (id === 11721 && phase === 'missing') assert.match(current('place-25', reference), /quest-11721/);
      assert.deepEqual(reference, before);
    }
  }
});

test('specific cave instructions and primary quest collection clues resolve to the right maps and materials', async () => {
  const index = encyclopedia();
  const { createEntityReferences } = await import('../src/renderer/entity-references.js');
  const refs = createEntityReferences({ ...helpers, index: () => index });
  assert.deepEqual(
    project(quest(5888)).places.map((p) => p.id),
    ['place-910', 'place-911'],
  );
  const linked = refs.text(quest(5888).name);
  assert.match(linked, /place-910/);
  assert.match(linked, /place-911/);
  assert.doesNotMatch(linked, /name:山洞|place-(?:11|12|35|49|95)["']/);
  assert.deepEqual(
    refs.choices('name:圣潭').map((p) => p.id),
    ['place-910'],
  );
  assert.deepEqual(
    project(quest(5715)).places.map((p) => p.id),
    ['place-25'],
  );
  const missingFish = projector.project(quest(11109), { inventory: [{ id: 10531, count: 1 }] });
  assert.deepEqual(
    missingFish.places.map((p) => [p.name, p.materialIds.toSorted()]),
    [
      ['津鲤村', [10534]],
      ['天鸣村', [10534, 10537]],
      ['白龟洞', [10534]],
      ['洱郡', [10537]],
    ],
  );
  assert.deepEqual(
    projector.project(quest(11475), { inventory: [] }).places.map((p) => p.name),
    ['凤凰洞', '天山', '恶人谷'],
  );
  assert.deepEqual(
    projector.project(quest(30056), { inventory: [{ id: 10326, count: 3 }] }).places[0].materialIds,
    [10330],
  );
  const guide = require('../src/data/task-objective-guide.json');
  for (const [id, entry] of Object.entries(guide)) {
    if (id === 'materialSources') continue;
    assert(quest(Number(id)), id);
    assert(
      entry.evidenceQuestIds.every((id) => quest(id)),
      id,
    );
    for (const source of entry.collectionPlaces || []) {
      assert(
        world.maps.some((p) => p.name === source.name),
        source.name,
      );
      assert(
        source.materialIds.every((materialId) =>
          quest(Number(id)).materials.some((m) => m.id === materialId),
        ),
      );
    }
  }
  const items = require('../src/data/game-index.json').entries;
  for (const [id, names] of Object.entries(guide.materialSources)) {
    const item = items.find((item) => item.kind === '物品' && item.gameId === Number(id));
    assert(item, id);
    for (const name of names) {
      assert(
        world.maps.some((place) => place.name === name),
        name,
      );
      assert(item.description.includes(name), `keep source ${name} traceable to item ${id}`);
    }
  }
});

test('non-item completion conditions remain visible and govern current handover in every reading context', async () => {
  const index = encyclopedia();
  const { createEntityReferences } = await import('../src/renderer/entity-references.js');
  const refs = createEntityReferences({ ...helpers, index: () => index });
  for (const [id, readings, hint] of [
    [17009, [{ money: 0 }, { money: 100000 }, {}, { money: 100001 }], /(?:100,001|1) 文/],
    [11878, [{ teamIds: [] }, { teamIds: [0] }, {}, { teamIds: [0, 10047] }], /卫霍在队/],
  ]) {
    const task = quest(id);
    for (const [i, reading] of readings.entries()) {
      const reference = {
        name: 'synthetic.sav',
        metadata: {
          ...reading,
          inventory: task.materials,
          quests: [task.parentId, id].map((id) => ({ id, step: 1 })),
        },
      };
      const before = structuredClone(reference);
      const flow = flowSnapshot({ id: 'synthetic', referenceMode: 'latest' }, reference);
      const step = flow.active.find((q) => q.gameId === task.parentId).steps.find((q) => q.id === task.id);
      const preview = refs.preview('quest-' + task.parentId, { reference });
      if (i === 3) {
        assert.equal(step.targets.materialState, 'ready');
        assert.match(step.nextAction, /交付/);
      } else {
        assert.equal(step.targets.materialState, i === 2 ? 'unknown' : 'missing');
        assert.match(step.nextAction, hint);
        assert.match(preview, hint);
        assert.doesNotMatch(step.nextAction, /^向.*交付$/);
        assert.equal(
          step.targets.people.some((p) => p.role === '交付'),
          false,
        );
      }
      assert.deepEqual(reference, before);
    }
  }
  for (const [id, person] of [
    [16035, '商葶苧'],
    [16059, '元疆'],
  ]) {
    const task = quest(id),
      target = projector.project(task, { inventory: task.materials });
    assert.equal(target.materialState, 'unknown');
    assert.match(target.nextAction, new RegExp('等待合适时机.*霹雳门找' + person));
    assert(target.places.every((p) => p.purpose === 'conditional-turn-in'));
  }
});

test('known collection clues remain linked and missing-item specific in flow, map and acquisition summaries', async () => {
  const index = encyclopedia();
  const { createWorldViews } = await import('../src/renderer/world-views.js');
  const { createFlowViews } = await import('../src/renderer/flow-views.js');
  const views = createWorldViews(helpers);
  const current = (place, reference) =>
    views
      .placeDetail(index, place, { reference })
      .match(/data-place-current-tasks[\s\S]*?<\/section>/)?.[0] || '';
  for (const [id, place, material, source] of [
    [14002, 'place-15', 10154, /平康城.*当铺购买/s],
    [11821, 'place-65', 168, /猴儿林/],
    [11822, 'place-36', 10525, /清河村|梧桐村/],
    [11736, 'place-47', 10288, /断天崖/],
    [11737, 'place-25', 10276, /万劫窟/],
    [14062, 'place-36', 10527, /清河村|双河村/],
  ]) {
    const task = quest(id),
      reference = {
        name: 'synthetic.sav',
        metadata: { inventory: [], quests: [task.parentId, id].map((id) => ({ id, step: 1 })) },
      };
    assert.match(current(place, reference), new RegExp(task.id));
    const flow = flowSnapshot({ id: 'synthetic', referenceMode: 'latest' }, reference);
    const step = flow.active.find((q) => q.gameId === task.parentId).steps.find((q) => q.id === task.id);
    assert(step.materials.find((m) => m.id === 'item-' + material).routes.some((r) => source.test(r.label)));
    const html = createFlowViews(helpers).panel(flow, { compact: true });
    assert.doesNotMatch(
      html.match(/<section class="flow-now[\s\S]*?<details class="flow-now-details"/)?.[0] || '',
      /暂无获取地点/,
    );
    reference.metadata.inventory = task.materials;
    assert.doesNotMatch(current(place, reference), new RegExp(task.id));
  }
  const fish = quest(11821),
    partial = {
      name: 'synthetic.sav',
      metadata: {
        inventory: [{ id: 168, count: 5 }],
        quests: [fish.parentId, 11821].map((id) => ({ id, step: 1 })),
      },
    };
  assert.doesNotMatch(current('place-65', partial), /quest-11821/);
  assert.match(current('place-36', partial), /quest-11821/);
  for (const id of [14181, 30145]) {
    const task = quest(id),
      reference = {
        name: 'synthetic.sav',
        metadata: { inventory: [], quests: [task.parentId, id].map((id) => ({ id, step: 1 })) },
      };
    const flow = flowSnapshot({ id: 'synthetic', referenceMode: 'latest' }, reference);
    assert.match(createFlowViews(helpers).panel(flow, { compact: true }), /幽云泽商人出售/);
  }
  assert.deepEqual(
    projector.project(quest(5714), { inventory: [] }).places.map((p) => p.name),
    ['万劫窟'],
  );
  assert.deepEqual(
    project(quest(11832)).places.map((p) => p.name),
    ['平康城'],
  );
});

test('party conditions on non-material steps stay visible in flow, hover and the current destination', async () => {
  const index = encyclopedia();
  const { createWorldViews } = await import('../src/renderer/world-views.js');
  const { createEntityReferences } = await import('../src/renderer/entity-references.js');
  const views = createWorldViews(helpers),
    refs = createEntityReferences({ ...helpers, index: () => index });
  for (const [id, place, members, hint] of [
    [11952, 'place-38', [5029], /需莫弃在队/],
    [11880, 'place-41', [10047], /需卫霍在队/],
    [11912, 'place-21', [11708, 10268], /需司马铃、上官虹在队/],
  ]) {
    const task = quest(id);
    for (const phase of ['missing', 'unknown', 'met']) {
      const reference = {
        name: 'synthetic.sav',
        metadata: { trackingQuest: id, quests: [task.parentId, id].map((id) => ({ id, step: 1 })) },
      };
      if (phase !== 'unknown') reference.metadata.teamIds = phase === 'met' ? members : [];
      const before = structuredClone(reference);
      const flow = flowSnapshot({ id: 'synthetic', referenceMode: 'latest' }, reference);
      const step = flow.active.find((q) => q.gameId === task.parentId).steps.find((q) => q.id === task.id);
      const current =
        views
          .placeDetail(index, place, { reference })
          .match(/data-place-current-tasks[\s\S]*?<\/section>/)?.[0] || '';
      const preview = refs.preview('quest-' + task.parentId, { reference });
      assert.match(current, new RegExp(task.id));
      if (phase === 'met') {
        assert(!step.targets.conditionHint);
        assert.doesNotMatch(step.nextAction, hint);
        assert.doesNotMatch(current, hint);
        assert.doesNotMatch(preview, hint);
      } else {
        assert.equal(step.targets.actionState, phase);
        assert.match(step.nextAction, hint);
        assert.match(current, hint);
        assert.match(preview, hint);
      }
      assert.deepEqual(reference, before);
    }
  }
  const both = projector.project(quest(11912), { teamIds: [] });
  assert.equal((both.nextAction.match(/在队/g) || []).length, 1, 'group the same requirement once');
  assert.equal(projector.project(quest(11912), { teamIds: [11708] }).conditionHint, '需上官虹在队');
});

test('all explicit game party annotations resolve against this reading including namesake party actors', () => {
  const annotated = world.quests.filter((q) =>
    /【(?:此任务)?需([^【】]+?)在队】/.test(q.name + ' ' + q.description),
  );
  assert.equal(annotated.length, 26);
  for (const task of annotated) {
    const required = project(task).actionRequirements.filter((r) => r.type === 'TeamMember');
    assert(required.length, String(task.gameId));
    for (const teamIds of [[], undefined]) {
      const target = projector.project(task, { teamIds });
      assert.match(target.conditionHint, /在队/);
      assert(target.places.every((place) => place.conditionHint));
    }
    const teamIds = required.map((r) => (r.ids || [r.id])[0]);
    assert.doesNotMatch(
      projector.project(task, { teamIds }).conditionHint || '',
      /在队/,
      String(task.gameId),
    );
  }
  for (const id of [8001, 17109]) assert(!projector.project(quest(13250), { teamIds: [id] }).conditionHint);
  assert.match(projector.project(quest(12412), { money: 2000 }).nextAction, /还需 1,001 文/);
  assert.match(projector.project(quest(12412), {}).nextAction, /需 3,001 文/);
});

test('an explicit handover retains its bound actor and sole completion scene even when the title omits the name', async () => {
  const index = encyclopedia();
  const { createWorldViews } = await import('../src/renderer/world-views.js');
  const { createEntityReferences } = await import('../src/renderer/entity-references.js');
  const task = quest(16303),
    target = projector.project(task, {});
  assert.deepEqual(
    target.people.map((p) => [p.id, p.role]),
    [['npc-19714', '交付']],
  );
  assert.deepEqual(
    target.places.map((p) => [p.id, p.personIds]),
    [['place-905', [19714]]],
  );
  const reference = {
    name: 'synthetic.sav',
    metadata: { trackingQuest: 16303, quests: [16300, 16303].map((id) => ({ id, step: 1 })) },
  };
  const flow = flowSnapshot({ id: 'synthetic', referenceMode: 'latest' }, reference);
  const step = flow.active.find((q) => q.gameId === 16300).steps.find((q) => q.id === task.id);
  assert.equal(step.targets.people[0].id, 'npc-19714');
  const refs = createEntityReferences({ ...helpers, index: () => index });
  assert.match(refs.preview('quest-16300', { reference }), /交付：莲芯/);
  const views = createWorldViews(helpers);
  assert.match(
    views
      .placeDetail(index, 'place-905', { reference })
      .match(/data-place-current-tasks[\s\S]*?<\/section>/)?.[0] || '',
    /quest-16303[\s\S]*npc-19714/,
  );
  assert.doesNotMatch(
    views
      .placeDetail(index, 'place-937', { reference })
      .match(/data-place-current-tasks[\s\S]*?<\/section>/)?.[0] || '',
    /quest-16303/,
  );
  for (const id of [5768, 6259])
    assert.equal(
      projector.project(quest(id), {}).people.length,
      0,
      'do not promote a report after an unresolved fight',
    );
});

test('common destination short names share family choices and reverse-link current tasks', async () => {
  const index = encyclopedia();
  const { createWorldViews } = await import('../src/renderer/world-views.js');
  const { createEntityReferences } = await import('../src/renderer/entity-references.js');
  const views = createWorldViews(helpers),
    refs = createEntityReferences({ ...helpers, index: () => index });
  const reference = {
    name: 'synthetic.sav',
    metadata: { quests: [5940, 5947].map((id) => ({ id, step: 1 })) },
  };
  assert.match(refs.text(quest(5947).name), /name:少林/);
  const scenes = world.maps.filter((p) => p.name === '少林寺');
  assert.equal(scenes.length, 2);
  for (const place of scenes)
    assert.match(
      views
        .placeDetail(index, place.id, { reference })
        .match(/data-place-current-tasks[\s\S]*?<\/section>/)?.[0] || '',
      /quest-5947/,
    );
  assert.equal(project(quest(11476)).places[0].name, '姑苏城');
});

test('promotion objectives keep contribution thresholds and contacts in the default action without claiming current contribution', async () => {
  const { createFlowViews } = await import('../src/renderer/flow-views.js');
  const { createEntityReferences } = await import('../src/renderer/entity-references.js');
  const index = encyclopedia(),
    refs = createEntityReferences({ ...helpers, index: () => index });
  for (const [id, threshold] of [
    [5243, 300],
    [5305, 1500],
    [5751, 3000],
    [5851, 6000],
  ]) {
    const task = quest(id),
      reference = {
        name: 'synthetic.sav',
        metadata: {
          trackingQuest: id,
          quests: [task.parentId, id].map((id) => ({ id, step: 1 })),
          money: 10000000,
          teamIds: [],
        },
      };
    const flow = flowSnapshot({ id: 'synthetic', referenceMode: 'latest' }, reference);
    const step = flow.active.find((q) => q.gameId === task.parentId).steps.find((q) => q.id === task.id);
    assert.equal(step.targets.actionState, 'unknown');
    assert.match(step.nextAction, new RegExp('门派贡献需达到' + threshold));
    assert.match(step.nextAction, /元风.*道通/);
    assert.match(step.targets.people.find((p) => p.id === 'npc-5011').role, /条件满足后/);
    const compact = createFlowViews(helpers)
      .panel(flow, { compact: true })
      .split('<details class="flow-now-details"')[0];
    assert.match(compact, new RegExp(String(threshold)));
    assert.match(
      refs.preview('quest-' + task.parentId, { reference }),
      new RegExp('门派贡献需达到' + threshold),
    );
  }
});

test('parallel treatment keeps its OR condition and alternative herb routes across flow, hover and place lookup', async () => {
  const { createFlowViews } = await import('../src/renderer/flow-views.js');
  const { createWorldViews } = await import('../src/renderer/world-views.js');
  const { createEntityReferences } = await import('../src/renderer/entity-references.js');
  const index = encyclopedia(),
    views = createWorldViews(helpers),
    refs = createEntityReferences({ ...helpers, index: () => index });
  for (const id of [7150, 7151]) {
    const task = quest(id),
      reference = {
        name: 'synthetic.sav',
        metadata: { trackingQuest: id, quests: [task.parentId, id].map((id) => ({ id, step: 1 })) },
      };
    const flow = flowSnapshot({ id: 'synthetic', referenceMode: 'latest' }, reference);
    const step = flow.active.find((q) => q.gameId === task.parentId).steps.find((q) => q.id === task.id);
    const compact = createFlowViews(helpers)
      .panel(flow, { compact: true })
      .split('<details class="flow-now-details"')[0];
    assert.match(compact, /任选一种/);
    assert.match(refs.preview('quest-' + task.parentId, { reference }), /任选一种/);
    if (id === 7150) {
      assert.match(compact, /内功120以上，或有特殊队友在队/);
      assert.match(refs.preview('quest-' + task.parentId, { reference }), /内功120以上，或有特殊队友在队/);
    }
    assert(!step.targets.materialGate, 'alternative poison plants must not turn into three mandatory items');
    for (const [name, item] of [
      ['愁雾林', '曼罗香'],
      ['百药谷', '乌头血'],
      ['十万大山', '玉骨莲'],
    ]) {
      assert(step.targets.places.some((p) => p.name === name));
      for (const place of index.world.maps.filter((p) => p.name === name)) {
        const current =
          views
            .placeDetail(index, place.id, { reference })
            .match(/data-place-current-tasks[\s\S]*?<\/section>/)?.[0] || '';
        assert.match(current, new RegExp(task.id));
        assert.match(current, new RegExp(item));
        assert.match(current, /任选一种/);
      }
    }
    for (const inventory of [
      undefined,
      [],
      [{ id: 10386, count: 1 }],
      [
        { id: 10386, count: 1 },
        { id: 10387, count: 1 },
        { id: 10388, count: 1 },
      ],
    ]) {
      const target = projector.project(task, { inventory, teamIds: [] });
      assert.notEqual(target.materialState, 'ready');
      assert.notEqual(target.actionState, 'ready');
      if (id === 7150) assert.match(target.nextAction, /或有特殊队友在队/);
    }
  }
});

test('invitation annotation keeps the same party condition on both inheritance destinations', async () => {
  const { createWorldViews } = await import('../src/renderer/world-views.js');
  const { createEntityReferences } = await import('../src/renderer/entity-references.js');
  const index = encyclopedia(),
    views = createWorldViews(helpers),
    refs = createEntityReferences({ ...helpers, index: () => index });
  const task = quest(28205);
  for (const teamIds of [undefined, [], [19830]]) {
    const reference = {
      name: 'synthetic.sav',
      metadata: { quests: [28200, 28205].map((id) => ({ id, step: 1 })), trackingQuest: 28205, teamIds },
    };
    const target = projector.project(task, reference.metadata);
    assert.deepEqual(
      target.places.map((p) => p.name),
      ['仙猿山', '灵龟岛'],
    );
    for (const name of ['仙猿山', '灵龟岛'])
      for (const place of index.world.maps.filter((p) => p.name === name)) {
        const current =
          views
            .placeDetail(index, place.id, { reference })
            .match(/data-place-current-tasks[\s\S]*?<\/section>/)?.[0] || '';
        assert.match(current, /quest-28205/);
        if (!teamIds?.includes(19830)) assert.match(current, /需步微月在队/);
        else assert.doesNotMatch(current, /需步微月在队/);
      }
    const preview = refs.preview('quest-28200', { reference });
    if (!teamIds?.includes(19830)) assert.match(preview, /需步微月在队/);
    else assert.doesNotMatch(preview, /需步微月在队/);
  }
});

test('reviewed description instructions restore current destinations and exclude later travel or faction-qualified people', () => {
  for (const [id, expected] of [
    [5540, ['峋谷关']],
    [5604, ['不风山']],
    [5867, ['景陇']],
    [7222, ['五仙教']],
    [11972, ['武当派']],
    [12033, ['峋谷关']],
    [12122, ['龙门峡']],
    [12412, ['程家村']],
    [12524, ['连鼓山']],
    [12630, ['蔓阴林']],
    [12632, ['紫竹林']],
    [13260, ['苍岚村']],
    [13265, ['程家堡']],
    [13801, ['万劫窟']],
    [14066, ['野猪林']],
    [14091, ['青萝山']],
    [16121, ['霹雳门库房']],
    [17141, ['五仙教牢房']],
    [17151, ['五仙教']],
    [28014, ['平康城']],
    [29710, ['和璞山庄']],
    [5991, []],
    [9055, []],
    [21060, []],
    [30602, []],
  ]) {
    assert.deepEqual(
      project(quest(id)).places.map((p) => p.name),
      expected,
      String(id),
    );
  }
  for (const id of [5991, 9055]) {
    assert.deepEqual(
      project(quest(id)).people.map((p) => p.id),
      ['npc-5003'],
    );
    assert.doesNotMatch(project(quest(id)).nextAction, /少林/);
  }
  assert.deepEqual(
    project(quest(8536)).places.map((p) => p.name),
    ['五仙教禁地'],
  );
  assert.match(projector.project(quest(12412), { money: 3000 }).nextAction, /程家村.*陆博枭.*比棋/);
  assert.match(projector.project(quest(12412), { money: 3000 }).conditionHint, /还需 1 文/);
  assert(!projector.project(quest(12412), { money: 3001 }).conditionHint);
  assert.match(project(quest(5068)).nextAction, /好感提升至20以上/);
  assert.match(project(quest(11279)).nextAction, /若他已在队伍.*离队/);
  assert.match(project(quest(21282)).nextAction, /入夜后.*知客僧/);
});

test('current action links use verified targets once while global namesakes remain choices', async () => {
  const { createEntityReferences } = await import('../src/renderer/entity-references.js');
  const { createFlowViews } = await import('../src/renderer/flow-views.js');
  const index = encyclopedia();
  const refs = createEntityReferences({ ...helpers, index: () => index });
  for (const [id, exactIds] of [
    [28205, ['place-603', 'place-609']],
    [5243, ['npc-5011']],
  ]) {
    const task = quest(id),
      targets = projector.project(task, { teamIds: [] });
    const linked = refs.text(targets.nextAction, 'flow-quest', targets);
    for (const exactId of exactIds)
      assert.equal((linked.match(new RegExp('data-entity-id="' + exactId + '"', 'g')) || []).length, 1);
    const reference = {
      name: 'synthetic.sav',
      metadata: {
        trackingQuest: id,
        quests: [task.parentId, id].map((id) => ({ id, step: 1 })),
        teamIds: [],
      },
    };
    const flow = flowSnapshot({ id: 'synthetic', referenceMode: 'latest' }, reference);
    const views = createFlowViews({
      ...helpers,
      act: refs.button,
      richText: (text, targets) => refs.text(text, 'flow-quest', targets),
    });
    const lead = views.panel(flow, { compact: true }).split('<details class="flow-now-details"')[0];
    for (const exactId of exactIds)
      assert.equal((lead.match(new RegExp('data-entity-id="' + exactId + '"', 'g')) || []).length, 1);
    assert.doesNotMatch(lead, /class="flow-targets"/);
  }
  assert.match(refs.text('灵龟岛'), /data-entity-id="name:灵龟岛"/);
  assert.doesNotMatch(
    refs.text('前往灵龟岛', 'flow-quest', project(quest(28205))),
    /data-entity-id="quest-28400"/,
  );
  assert.match(refs.text('返回武当', 'flow-quest', project(quest(8879))), /data-entity-id="place-name:武当"/);
  assert.match(
    refs.text('灵龟岛', 'world-quest', { places: [{ id: 'unknown', name: '灵龟岛' }] }),
    /name:灵龟岛/,
  );
});

test('floor-qualified destinations keep the full floor in action links, hover relations and current map lookup', async () => {
  const { createEntityReferences } = await import('../src/renderer/entity-references.js');
  const { createWorldViews } = await import('../src/renderer/world-views.js');
  const index = encyclopedia(),
    refs = createEntityReferences({ ...helpers, index: () => index }),
    views = createWorldViews(helpers);
  const reference = {
    name: 'synthetic.sav',
    metadata: { trackingQuest: 22300, quests: [22170, 22300].map((id) => ({ id, step: 1 })) },
  };
  const task = quest(22300),
    target = projector.project(task, reference.metadata);
  assert.deepEqual(
    target.places.map((p) => [p.id, p.mapKeys]),
    [['place-327', ['LV_TFK_P1']]],
  );
  const flow = flowSnapshot({ id: 'synthetic', referenceMode: 'latest' }, reference);
  const step = flow.active.find((q) => q.gameId === 22170).steps.find((q) => q.id === task.id);
  const linked = refs.text(step.nextAction, 'flow-quest', step.targets);
  assert.match(linked, /data-entity-id="place-327"/);
  assert.doesNotMatch(linked, /data-entity-id="place-328"/);
  assert.match(refs.preview('place-327', { reference }), /天佛窟之战/);
  assert.match(
    views
      .placeDetail(index, 'place-327', { reference })
      .match(/data-place-current-tasks[\s\S]*?<\/section>/)?.[0] || '',
    /quest-22300/,
  );
  assert.doesNotMatch(
    views
      .placeDetail(index, 'place-328', { reference })
      .match(/data-place-current-tasks[\s\S]*?<\/section>/)?.[0] || '',
    /quest-22300/,
  );
});

test('combined combat and report step labels the later recipient without placing him at the fight', async () => {
  const { createEntityReferences } = await import('../src/renderer/entity-references.js');
  const index = encyclopedia(),
    refs = createEntityReferences({ ...helpers, index: () => index });
  const target = project(quest(11132));
  assert.deepEqual(
    target.people.map((p) => [p.id, p.role]),
    [['npc-10404', '战斗后回报']],
  );
  assert.deepEqual(
    target.places.map((p) => [p.name, p.personIds]),
    [['断天崖', []]],
  );
  const reference = {
    name: 'synthetic.sav',
    metadata: { quests: [11131, 11132].map((id) => ({ id, step: 1 })) },
  };
  assert.match(refs.preview('quest-11131', { reference }), /战斗后回报：杨开/);
  for (const id of [5169, 5652, 12667])
    assert(!project(quest(id)).people.some((p) => p.role === '战斗后回报'));
});

test('chosen gift branches name the actual sword or alternative tea in current flow and hover', async () => {
  const { createEntityReferences } = await import('../src/renderer/entity-references.js');
  const { createFlowViews } = await import('../src/renderer/flow-views.js');
  const index = encyclopedia(),
    refs = createEntityReferences({ ...helpers, index: () => index });
  for (const [id, hint] of [
    [12407, /白光剑.*平康城铁匠/],
    [12408, /花坞茶、双井茶或阳羡茶.*任一种/],
  ]) {
    const reference = {
      name: 'synthetic.sav',
      metadata: { trackingQuest: id, quests: [12400, id].map((id) => ({ id, step: 1 })) },
    };
    const flow = flowSnapshot({ id: 'synthetic', referenceMode: 'latest' }, reference);
    const lead = createFlowViews(helpers)
      .panel(flow, { compact: true })
      .split('<details class="flow-now-details"')[0];
    assert.match(lead, hint);
    assert.match(refs.preview('quest-12400', { reference }), hint);
    assert(
      !project(quest(id)).materialGate,
      'the description does not prove an exact accepted item variant or quantity',
    );
  }
});

test('reviewed description-only actions retain their actual current destinations without narrative travel', () => {
  const groups = [
    [[5239, 5241, 11738, 14079, 14110, 14161, 20340, 22060], ['武当派']],
    [[5265], ['博坊地窖']],
    [[5358, 11935, 17031, 20081, 20082, 30113], ['姑苏城']],
    [[5503, 12353], ['幽云泽渡口']],
    [[5514, 30811], ['峋谷关']],
    [[5684, 5685], ['黎城']],
    [[5787], ['程家堡']],
    [[5942, 9246, 12287, 14008, 14155, 23007, 23025], ['少林寺']],
    [[8033], ['碧波门']],
    [[11001], ['后山山洞']],
    [[11317], ['洛村']],
    [[11657, 12629, 12633], ['南渝村']],
    [[11891], ['青木舫']],
    [[11963], ['千陵渡']],
    [[12014], ['落英林']],
    [[12022], ['断天崖']],
    [[12078], ['北山村']],
    [[12082, 12084], ['樊城']],
    [[12113], ['梧桐村']],
    [[12334, 12340, 12354, 12377, 12382], ['谭城']],
    [[12363], ['名剑山庄']],
    [[12380], ['紫竹林']],
    [[12558], ['连鼓山']],
    [[12667], ['天鸣村']],
    [[12712], ['卧秋山']],
    [[12838, 12839, 12936], ['甘泉村']],
    [[13006, 13026, 13046], ['一线天']],
    [[13081, 13085, 13090], ['苦水村']],
    [[13218, 13219, 13220], ['天水城']],
    [[13304], ['神鹰门']],
    [[13502, 13503], ['平阳堡']],
    [[14076], ['六扇门']],
    [[14156], ['少林后殿']],
    [[16114], ['霹雳门']],
    [[17171], ['五仙岭']],
    [[20331], ['驼铃丘']],
    [[22172], ['天佛窟']],
    [[23049], ['囚室']],
    [[23234], ['阎浮镇']],
    [[24042, 24043, 24044, 24045, 24046, 24047], ['峋谷关外']],
    [[28015], ['平康城']],
    [[28027, 32543], ['仙人渡']],
    [[28041], ['野猪林', '碧幽林', '猴儿林']],
    [[30722], ['玄火教']],
  ];
  const before = JSON.stringify(world);
  for (const [ids, expected] of groups)
    for (const id of ids) {
      assert.deepEqual(
        project(quest(id)).places.map((p) => p.name),
        expected,
        String(id),
      );
      assert(!project(quest(id)).materialGate, 'do not invent accepted quantities from prose: ' + id);
    }
  assert.equal(
    groups.reduce((count, [ids]) => count + ids.length, 0),
    87,
  );
  assert.equal(JSON.stringify(world), before);
  assert.match(project(quest(23234)).instruction, /东北方小屋/);
  assert.match(project(quest(30811)).instruction, /或许/);
  assert.match(project(quest(12113)).instruction, /若要.*先去梧桐村/);
  assert.match(project(quest(13502)).instruction, /若要比武/);
  assert.match(project(quest(28041)).instruction, /野猪林、碧幽林或猴儿林/);
  for (const id of [12365, 18918, 20034, 22125]) {
    const target = project(quest(id));
    assert(!target.places.length, 'old, refused, departed or future destinations are not current: ' + id);
  }
  assert(!project(quest(12113)).places.some((p) => p.name === '平阳堡'));
  assert(!project(quest(22060)).places.some((p) => p.name === '天佛窟'));
});

test('description-only current destinations agree in the default flow, root hover and map reverse lookup', async () => {
  const { createEntityReferences } = await import('../src/renderer/entity-references.js');
  const { createFlowViews } = await import('../src/renderer/flow-views.js');
  const { createWorldViews } = await import('../src/renderer/world-views.js');
  const index = encyclopedia(),
    refs = createEntityReferences({ ...helpers, index: () => index });
  const flowViews = createFlowViews(helpers),
    worldViews = createWorldViews(helpers);
  for (const [id, place, hint] of [
    [13006, '一线天', /深入一线天.*寻找殷无矜/],
    [23234, '阎浮镇', /阎浮镇东北方小屋.*江小彤/],
    [11963, '千陵渡', /千陵渡.*重新调查/],
    [22060, '武当派', /回武当派.*清霄/],
    [12363, '名剑山庄', /名剑山庄.*欧阳献公/],
    [12113, '梧桐村', /先去梧桐村/],
    [11935, '姑苏城', /回姑苏城/],
    [8033, '碧波门', /碧波门东侧房间/],
    [30811, '峋谷关', /峋谷关客栈.*或许/],
  ]) {
    const task = quest(id),
      reference = {
        name: 'synthetic.sav',
        metadata: {
          trackingQuest: id,
          quests: [task.parentId, id].map((id) => ({ id, step: 1 })),
        },
      };
    const flow = flowSnapshot({ id: 'synthetic', referenceMode: 'latest' }, reference);
    const lead = flowViews.panel(flow, { compact: true }).split('<details class="flow-now-details"')[0];
    assert.match(lead, hint, String(id));
    assert.match(refs.preview('quest-' + task.parentId, { reference }), hint, String(id));
    for (const map of index.world.maps.filter((p) => p.name === place)) {
      const current =
        worldViews
          .placeDetail(index, map.id, { reference })
          .match(/data-place-current-tasks[\s\S]*?<\/section>/)?.[0] || '';
      assert.match(current, new RegExp('quest-' + id), map.id + ':' + id);
      assert.match(current, hint, 'the map retains the shared current action: ' + id);
    }
    const projected = projector.project(task, reference.metadata);
    if (['峋谷关', '武当派'].includes(place)) {
      assert.equal(projected.places[0].id, null, 'description cannot choose the story scene');
      assert(projected.places[0].mapKeys.length > 1);
    }
  }
});

test('reviewed local actions use their actual scene and keep unidentified meeting places unidentified', () => {
  const groups = [
    [[5153, 11342, 12007], ['洛村']],
    [[5203, 5212, 5216, 5219, 5221, 5229], ['武当派']],
    [[5233], ['清河村']],
    [[5370], ['名剑山庄']],
    [[5536], ['峋谷关']],
    [[5656], ['不风山']],
    [[5733, 14171, 30143], ['威远镖局']],
    [[5768], ['紫竹林']],
    [[5790], ['程家堡']],
    [[5881], ['五仙教']],
    [[6006, 9249, 14109, 20455, 21003], ['少林寺']],
    [[6054], ['葬龙谷', '玄火教']],
    [[7035], ['景陇']],
    [[7090], ['凤凰洞']],
    [[11406, 11478], ['姑苏城']],
    [[11630], ['天水城']],
    [[11708, 11717, 12831, 20072], []],
    [[12067, 12069, 28017, 28020], ['平康城']],
    [[12379], ['天鸣村']],
    [[12508], ['雷家村']],
    [[12843], ['鹰愁谷']],
    [[12910], ['甘泉村']],
    [[13010, 13030, 13054], ['一线天']],
    [[16123], ['霹雳门库房']],
    [[16200, 16301], ['霹雳门']],
    [[21059], ['阎浮镇']],
    [[21178], ['野林']],
    [[22431, 22480], ['天佛窟']],
    [[32524], ['仙人渡']],
  ];
  for (const [ids, expected] of groups)
    for (const id of ids) {
      assert.deepEqual(
        project(quest(id)).places.map((p) => p.name),
        expected,
        String(id),
      );
      assert(!project(quest(id)).materialGate, 'no item quantity is inferred from prose: ' + id);
    }
  assert.equal(
    groups.reduce((count, [ids]) => count + ids.length, 0),
    53,
  );
  assert.match(project(quest(16301)).instruction, /或可.*打听.*取得后.*童安/);
  assert.match(project(quest(11708)).instruction, /避开南疆士兵/);
  assert.match(project(quest(20072)).instruction, /先往渡口.*再.*同返姑苏/);
  assert.equal(project(quest(6006)).places[0].purpose, 'departure');
  assert.equal(project(quest(22480)).places[0].purpose, 'departure');
  assert(
    !project(quest(22480)).places.some((p) => p.name === '玄火教'),
    'a temporary formation outside the cave is not the headquarters',
  );
  assert(
    project(quest(6081)).places.some((p) => p.name === '玄火教'),
    'an actual headquarters journey still resolves',
  );
  for (const [name, expected] of [
    ['前往玄火教阵地', []],
    ['前往玄火教部队', []],
    ['前往玄火教主殿', ['玄火教']],
    ['向少林寺方丈询问', []],
    ['前往少林寺方丈室', ['少林寺']],
    ['回报霹雳门主汤统', []],
    ['回霹雳门复命', ['霹雳门']],
  ])
    assert.deepEqual(
      project({ ...quest(12843), gameId: -1, name }).places.map((p) => p.name),
      expected,
      name,
    );
});

test('map current actions preserve local instructions, ordered return and bound actors without duplicate headings', async () => {
  const { createEntityReferences } = await import('../src/renderer/entity-references.js');
  const { createWorldViews } = await import('../src/renderer/world-views.js');
  const index = encyclopedia(),
    refs = createEntityReferences({ ...helpers, index: () => index });
  const views = createWorldViews({
    ...helpers,
    act: refs.button,
    objectiveText: (value, targets) => refs.text(value, 'world-quest', targets),
  });
  for (const [id, placeName, hint] of [
    [5733, '威远镖局', /进入威远镖局.*打斗/],
    [28020, '平康城', /平康城客栈.*步微月/],
    [32524, '仙人渡', /仙人渡.*商贾逐一接触/],
    [23234, '阎浮镇', /东北方小屋.*江小彤/],
    [22060, '武当派', /回武当派.*清霄道长/],
    [30811, '峋谷关', /峋谷关客栈.*瑶姬或许/],
    [12007, '洛村', /先吸引山贼注意.*待白锦探查后再回洛村会合/],
  ]) {
    const task = quest(id),
      reference = {
        name: 'synthetic.sav',
        metadata: {
          trackingQuest: id,
          quests: [task.parentId, id].map((id) => ({ id, step: 1 })),
        },
      };
    const place = index.world.maps.find((p) => p.name === placeName);
    const current =
      views
        .placeDetail(index, place.id, { reference })
        .match(/data-place-current-tasks[\s\S]*?<\/section>/)?.[0] || '';
    assert.match(current.replace(/<[^>]+>/g, ''), hint, String(id));
    assert.match(current, new RegExp('data-current-step="quest-' + id + '"'));
    const heading = current.match(/data-current-step="quest-[^"]+">([\s\S]*?<\/button>)/)?.[1] || '';
    assert.match(
      heading,
      new RegExp('data-id="quest-' + id + '"'),
      'navigation keeps the exact current step',
    );
    assert(heading.includes(quest(task.parentId).name), 'the heading provides parent task context');
  }
  const target = project(quest(12007));
  assert.deepEqual(target.places[0].mapKeys, ['LV_20_P']);
  assert.deepEqual(target.places[0].personIds, [10131]);
  assert.match(target.places[0].hint, /待白锦探查后/);
});

test('current action links reject faction qualifiers and unrelated interiors while retaining useful map references', async () => {
  const { createEntityReferences } = await import('../src/renderer/entity-references.js');
  const { createFlowViews } = await import('../src/renderer/flow-views.js');
  const { createWorldViews } = await import('../src/renderer/world-views.js');
  const { placeEntityId } = await import('../src/renderer/entity-catalog.js');
  const index = encyclopedia(),
    refs = createEntityReferences({ ...helpers, index: () => index });
  const flowViews = createFlowViews({
    ...helpers,
    act: refs.button,
    richText: (value, targets) => refs.text(value, 'flow-quest', targets),
  });
  const worldViews = createWorldViews({
    ...helpers,
    act: refs.button,
    objectiveText: (value, targets) => refs.text(value, 'world-quest', targets),
  });
  for (const [id, placeName, forbidden, wording] of [
    [22480, '天佛窟', /data-id="place-311"/, /玄火教阵地实行擒王策/],
    [7222, '五仙教', /data-id="name:客房"/, /西边平台的客房休息/],
    [30392, '和璞山庄', /data-id="(?:name:客房|place-311)"/, /玄火教客房，寻找/],
    [12843, '鹰愁谷', /data-id="name:神鹰门"/, /神鹰门门主/],
  ]) {
    const task = quest(id),
      reference = {
        metadata: {
          inventory: [],
          trackingQuest: id,
          quests: [task.parentId, id].map((id) => ({ id, step: 1 })),
        },
      };
    const flow = flowSnapshot({ id: 'synthetic', referenceMode: 'latest' }, reference);
    for (const compact of [false, true]) {
      const html = flowViews.panel(flow, { compact });
      const actions = [...html.matchAll(/<p class="flow-next-action">([\s\S]*?)<\/p>/g)]
        .map((m) => m[1])
        .join('');
      assert.doesNotMatch(actions, forbidden, id + ': actual rendered action links');
      assert.match(actions.replace(/<[^>]+>/g, ''), wording, id + ': literal instruction remains');
    }
    const place = index.world.maps.find((p) => p.name === placeName);
    const current =
      worldViews
        .placeDetail(index, placeEntityId(place, index.world.maps), { reference })
        .match(/data-place-current-tasks[\s\S]*?<\/section>/)?.[0] || '';
    assert.match(current, new RegExp('data-current-step="quest-' + id + '"'));
    assert.doesNotMatch(current, forbidden, id + ': actual rendered map links');
    assert.match(current.replace(/<[^>]+>/g, ''), wording);
  }
  for (const id of [5151, 12407, 6081]) {
    const targets = project(quest(id));
    const html = refs.text(targets.nextAction || targets.instruction, 'flow-quest', targets);
    const expected = { 5151: 'name:梧桐村', 12407: 'place-name:平康城', 6081: 'place-311' }[id];
    assert(html.includes('data-id="' + expected + '"'), 'keep landmark, purchase clue or actual HQ: ' + id);
  }
  assert.match(refs.text('前往客房'), /data-id="name:客房"/);
  assert.match(refs.text('前往玄火教主殿'), /data-id="place-311"/);
  assert.match(refs.text('前往少林寺方丈室'), /data-id="name:少林寺"/);
  assert.match(refs.text('玄火教'), /data-id="place-311"/, 'ordinary codex references remain linkable');
});

test('chosen sword purchase clue is reflected on both ambiguous city maps without inventing an item gate', async () => {
  const { createEntityReferences } = await import('../src/renderer/entity-references.js');
  const { createWorldViews } = await import('../src/renderer/world-views.js');
  const index = encyclopedia(),
    refs = createEntityReferences({ ...helpers, index: () => index });
  const views = createWorldViews({
    ...helpers,
    act: refs.button,
    objectiveText: (value, targets) => refs.text(value, 'world-quest', targets),
  });
  const reference = {
    metadata: { inventory: [], trackingQuest: 12407, quests: [12400, 12407].map((id) => ({ id, step: 1 })) },
  };
  const projected = projector.project(quest(12407), reference.metadata);
  assert.equal(projected.materialGate, undefined);
  assert.equal(projected.places[0].id, null);
  assert.deepEqual(projected.places[0].mapKeys.toSorted(), ['LV_26_P', 'LV_26_P2']);
  assert.match(refs.preview('quest-12400', { reference }), /白光剑.*平康城铁匠处似乎有售/);
  for (const id of ['place-15', 'place-17']) {
    const current =
      views.placeDetail(index, id, { reference }).match(/data-place-current-tasks[\s\S]*?<\/section>/)?.[0] ||
      '';
    assert.match(current, /data-current-step="quest-12407"/);
    assert.match(current.replace(/<[^>]+>/g, ''), /平康城铁匠处似乎有售白光剑/);
    assert.match(current, /场景待确认/);
    assert.doesNotMatch(current, /材料已齐|数量已齐/);
  }
});

test('waiting and actual revisit steps use distinct current destinations without guessing elapsed days', async () => {
  const { allObjectivePlaces } = await import('../src/shared/task-objectives.mjs');
  const { createEntityReferences } = await import('../src/renderer/entity-references.js');
  const { createWorldViews } = await import('../src/renderer/world-views.js');
  const index = encyclopedia(),
    refs = createEntityReferences({ ...helpers, index: () => index });
  const views = createWorldViews({
    ...helpers,
    act: refs.button,
    objectiveText: (value, targets) => refs.text(value, 'world-quest', targets),
  });
  const wait = {
    metadata: {
      trackingQuest: 16019,
      quests: [
        { id: 16018, step: 1 },
        { id: 16019, step: 1 },
      ],
    },
  };
  const revisit = {
    metadata: {
      trackingQuest: 16020,
      quests: [
        { id: 16018, step: 1 },
        { id: 16019, step: 4 },
        { id: 16020, step: 1 },
      ],
    },
  };
  const projected = projector.project(quest(16019), wait.metadata);
  assert.deepEqual(projected.places, []);
  assert.match(projected.instruction, /过几日再回姑苏/);
  assert.deepEqual(
    allObjectivePlaces(projected).map((p) => p.name),
    ['姑苏城'],
  );
  assert.match(refs.preview('quest-16018', { reference: wait }), /下一步：过几日再回姑苏/);
  assert.match(refs.preview('quest-16018', { reference: revisit }), /下一步：回姑苏城再访柳麻衣/);
  const now = projector.project(quest(16020), revisit.metadata);
  assert.deepEqual(
    now.places.map((p) => p.name),
    ['姑苏城'],
  );
  assert.equal(now.places[0].id, null);
  assert.equal(now.people[0].id, 'npc-17009');
  for (const id of ['place-27', 'place-29']) {
    const waiting = views.placeDetail(index, id, { reference: wait });
    assert.doesNotMatch(waiting, /data-current-step="quest-16019"/);
    assert.match(waiting, /data-id="quest-16019"/, 'deferred association remains in related tasks');
    const current =
      views
        .placeDetail(index, id, { reference: revisit })
        .match(/data-place-current-tasks[\s\S]*?<\/section>/)?.[0] || '';
    assert.match(current, /data-current-step="quest-16020"/);
    assert.match(current.replace(/<[^>]+>/g, ''), /回姑苏城再访柳麻衣/);
    assert.doesNotMatch(current, /data-current-step="quest-16019"/);
  }
});

test('ordinary action verbs do not auto-link unrelated steps, while named quests and explicit step navigation remain available', async () => {
  const { createEntityReferences } = await import('../src/renderer/entity-references.js');
  const { createFlowViews } = await import('../src/renderer/flow-views.js');
  const { createWorldViews } = await import('../src/renderer/world-views.js');
  const index = encyclopedia(),
    refs = createEntityReferences({ ...helpers, index: () => index });
  const flows = createFlowViews({
    ...helpers,
    act: refs.button,
    richText: (text, targets) => refs.text(text, 'flow-quest', targets),
  });
  const maps = createWorldViews({
    ...helpers,
    act: refs.button,
    objectiveText: (text, targets) => refs.text(text, 'world-quest', targets),
  });
  for (const [id, mapId, forbidden] of [
    [30811, 'place-300', 'quest-28020'],
    [5358, 'place-27', 'quest-29720'],
  ]) {
    const task = quest(id),
      reference = {
        metadata: { trackingQuest: id, quests: [task.parentId, id].map((id) => ({ id, step: 1 })) },
      };
    const flow = flowSnapshot({ id: 'synthetic', referenceMode: 'latest' }, reference);
    for (const compact of [true, false]) {
      const actions = [
        ...flows.panel(flow, { compact }).matchAll(/<p class="flow-next-action">([\s\S]*?)<\/p>/g),
      ]
        .map((m) => m[1])
        .join('');
      assert(!actions.includes('data-id="' + forbidden + '"'));
      assert.match(
        actions.replace(/<[^>]+>/g, ''),
        id === 30811 ? /峋谷关客栈赴约.*或许/ : /姑苏城客栈休息一晚/,
      );
    }
    const place = id === 30811 ? index.world.maps.find((p) => p.name === '峋谷关').id : mapId;
    const current =
      maps
        .placeDetail(index, place, { reference })
        .match(/data-place-current-tasks[\s\S]*?<\/section>/)?.[0] || '';
    assert(current.includes('data-current-step="quest-' + id + '"'));
    assert(!current.includes('data-id="' + forbidden + '"'));
  }
  assert.doesNotMatch(refs.text('先休息一晚，再赴约'), /data-entity-id="quest-/);
  assert.match(refs.text('先接莲湖会晤，再拜入武当'), /data-id="quest-5213"/);
  assert.match(refs.text('前往三清殿参加拜师大典'), /data-id="quest-5214"/);
  assert.match(
    refs.button('world-quest', quest(28020).name, 'text-btn', 'quest-28020'),
    /data-id="quest-28020"/,
  );
  assert.match(refs.text('武当派长老'), /data-entity-id=/, 'ordinary codex associations retain their links');
});

test('a complete unresolved person name shields its substring in action, codex and reverse relations', async () => {
  const { createEntityReferences } = await import('../src/renderer/entity-references.js');
  const { entityCatalog } = await import('../src/renderer/entity-catalog.js');
  const { taskMentions } = await import('../src/renderer/task-mentions.js');
  const { createFlowViews } = await import('../src/renderer/flow-views.js');
  const { createWorldViews } = await import('../src/renderer/world-views.js');
  const index = encyclopedia(),
    refs = createEntityReferences({ ...helpers, index: () => index }),
    catalog = entityCatalog(index),
    task = quest(17141);
  const reference = {
    metadata: { trackingQuest: 17141, quests: [task.parentId, 17141].map((id) => ({ id, step: 1 })) },
  };
  assert.match(refs.text('前往地牢见龙桑杰'), /龙桑杰/);
  assert.doesNotMatch(refs.text('前往地牢见龙桑杰'), /npc-28235/);
  assert.match(refs.text('找桑杰比武'), /npc-28235/, 'the actual disciple remains linkable');
  assert(!taskMentions(index, task).people.some((row) => row.id === 'npc-28235'));
  assert(!catalog.taskRelations(task).people.some((row) => row.entity.id === 'npc-28235'));
  assert(
    !catalog
      .personRelations(catalog.entries.get('npc-28235'))
      .quests.some((row) => row.entity.id === 'quest-17140'),
  );
  const flows = createFlowViews({
    ...helpers,
    act: refs.button,
    richText: (text, targets) => refs.text(text, 'flow-quest', targets),
  });
  const flow = flowSnapshot({ id: 'synthetic', referenceMode: 'latest' }, reference);
  for (const compact of [true, false])
    assert.doesNotMatch(flows.panel(flow, { compact }), /data-id="npc-28235"/);
  const maps = createWorldViews({
    ...helpers,
    act: refs.button,
    objectiveText: (text, targets) => refs.text(text, 'world-quest', targets),
  });
  const current =
    maps
      .placeDetail(index, 'place-919', { reference })
      .match(/data-place-current-tasks[\s\S]*?<\/section>/)?.[0] || '';
  assert.match(current, /龙桑杰/);
  assert.doesNotMatch(current, /npc-28235/);
  const expanded = structuredClone(index);
  expanded.entries.push({ id: 'npc-999999', gameId: 999999, kind: '人物', name: '龙桑杰' });
  const complete = createEntityReferences({ ...helpers, index: () => expanded });
  assert.match(
    complete.text('见龙桑杰'),
    /npc-999999/,
    'adding a real full record automatically makes it linkable',
  );
});

test('local rooms and a conditional cave return never create unrelated global current destinations', async () => {
  const { createEntityReferences } = await import('../src/renderer/entity-references.js');
  const { createWorldViews } = await import('../src/renderer/world-views.js');
  const { allObjectivePlaces } = await import('../src/shared/task-objectives.mjs');
  const index = encyclopedia(),
    refs = createEntityReferences({ ...helpers, index: () => index });
  const maps = createWorldViews({
    ...helpers,
    act: refs.button,
    objectiveText: (text, targets) => refs.text(text, 'world-quest', targets),
  });
  for (const [id, expected] of [
    [5412, '名剑山庄'],
    [5444, '名剑山庄'],
    [5724, '名剑山庄'],
    [8053, '碧波门'],
    [22020, '少林寺'],
    [29855, '和璞山庄'],
    [30344, '和璞山庄'],
    [30392, '和璞山庄'],
  ]) {
    const task = quest(id),
      reference = {
        metadata: { trackingQuest: id, quests: [task.parentId, id].map((id) => ({ id, step: 1 })) },
      },
      targets = projector.project(task, reference.metadata);
    assert.deepEqual(
      targets.places.map((p) => p.name),
      [expected],
      String(id),
    );
    const action = refs.text(targets.nextAction || targets.instruction, 'flow-quest', targets);
    assert.doesNotMatch(action, /data-id="name:客房"/);
    if (id === 30392) assert.doesNotMatch(action, /data-id="place-311"/);
    const correct = index.world.maps.find((p) => p.name === expected);
    const current =
      maps
        .placeDetail(index, correct.id, { reference })
        .match(/data-place-current-tasks[\s\S]*?<\/section>/)?.[0] || '';
    assert(current.includes('data-current-step="quest-' + id + '"'));
    for (const wrong of ['place-28', 'place-76', 'place-97:LV_KZ_P3'])
      assert(
        !maps.placeDetail(index, wrong, { reference }).includes('data-current-step="quest-' + id + '"'),
        id + ': unrelated room ' + wrong,
      );
  }
  const task = quest(30332),
    reference = {
      metadata: { trackingQuest: 30332, quests: [task.parentId, 30332].map((id) => ({ id, step: 1 })) },
    },
    targets = projector.project(task, reference.metadata);
  assert.deepEqual(targets.places, [], 'settle the person before the later reunion');
  assert.deepEqual(
    allObjectivePlaces(targets).map((p) => p.name),
    ['和璞山庄'],
  );
  assert.match(targets.nextAction, /回刚才藏身的山洞.*惊雷使.*妥当后.*和璞山庄/);
  assert.doesNotMatch(refs.text(targets.nextAction, 'flow-quest', targets), /data-id="name:山洞"/);
  for (const map of index.world.maps)
    assert(
      !maps.placeDetail(index, map.id, { reference }).includes('data-current-step="quest-30332"'),
      map.key,
    );
});

test('known destinations retain their type and scene set through action links and map actions', async () => {
  const { createEntityReferences } = await import('../src/renderer/entity-references.js');
  const { createFlowViews } = await import('../src/renderer/flow-views.js');
  const { createWorldViews } = await import('../src/renderer/world-views.js');
  const { placeEntityId } = await import('../src/renderer/entity-catalog.js');
  const index = encyclopedia(),
    refs = createEntityReferences({ ...helpers, index: () => index });
  const views = createFlowViews({
    ...helpers,
    act: refs.button,
    richText: (s, t) => refs.text(s, 'flow-quest', t),
  });
  const maps = createWorldViews({
    ...helpers,
    act: refs.button,
    objectiveText: (s, t) => refs.text(s, 'world-quest', t),
  });
  for (const id of [24200, 25001, 29710, 29855, 30060, 30340, 30344, 30392, 8081]) {
    const q = quest(id),
      reference = {
        metadata: { trackingQuest: id, quests: [q.parentId, id].map((id) => ({ id, step: 1 })) },
      };
    const targets = projector.project(q, reference.metadata),
      action = targets.nextAction || targets.instruction;
    const linked = refs.text(action, 'flow-quest', targets);
    const ambiguous = targets.places.filter((p) => !p.id && p.mapKeys.length > 1);
    assert(ambiguous.length, String(id));
    for (const place of ambiguous) {
      const mention = place.mentions.find((name) => action.includes(name)) || place.name;
      const group = 'place-name:' + mention,
        choices = refs.choices(group);
      assert.match(linked, new RegExp('data-id="' + group + '"'), String(id));
      assert(
        choices.every((row) => row.kind === '地点'),
        String(id),
      );
      assert.deepEqual(choices.map((row) => row.key).toSorted(), place.mapKeys.toSorted());
      const flow = flowSnapshot({ id: 'synthetic', referenceMode: 'latest' }, reference);
      const lead = views.panel(flow, { compact: true }).split('<details class="flow-now-details"')[0];
      assert.equal((lead.match(new RegExp('data-entity-id="' + group + '"', 'g')) || []).length, 1);
      for (const scene of choices) {
        const current =
          maps
            .placeDetail(index, placeEntityId(scene, index.world.maps), { reference })
            .match(/data-place-current-tasks[\s\S]*?<\/section>/)?.[0] || '';
        assert.match(current, new RegExp('data-current-step="quest-' + id + '"'));
        assert.match(current, new RegExp('data-id="' + group + '"'));
        assert.match(current, /场景待确认/);
        if (id === 8081) assert.doesNotMatch(current, /data-id="quest-8080"/);
      }
    }
    if (id === 8081) {
      assert.match(linked, /data-id="place-928"/, 'departure and destination both remain reachable');
      assert.doesNotMatch(linked, /data-id="quest-8080"/);
    }
  }
  assert(refs.choices('name:天山之巅').some((row) => row.id === 'quest-26038'));
  assert.match(refs.text('天山之巅'), /data-id="name:天山之巅"/);
  assert.match(
    refs.text('返回五仙教'),
    /data-id="quest-8080"/,
    'ordinary named task references remain available',
  );
});

test('formal named steps in shipped recommendations keep references without linking ordinary instructions', async () => {
  const { createEntityReferences } = await import('../src/renderer/entity-references.js');
  const index = encyclopedia(),
    refs = createEntityReferences({ ...helpers, index: () => index });
  const flowGuide = require('../src/data/flow-guide.cjs'),
    duelGuide = require('../src/data/duel-guide.cjs'),
    materialGuide = require('../src/data/material-guide.cjs');
  const strings = (value) =>
    typeof value === 'string'
      ? [value]
      : value && typeof value === 'object'
        ? Object.values(value).flatMap(strings)
        : [];
  const prose = [...strings(flowGuide), ...strings(duelGuide), ...strings(materialGuide)];
  for (const id of [
    5230, 5543, 5829, 5831, 8865, 11061, 11062, 11301, 12038, 12041, 12881, 12936, 13803, 16169, 16189, 20002,
    20013, 22010, 22060, 22150, 23062, 23066, 23070, 24062, 24069,
  ]) {
    const q = quest(id),
      source = prose.find((s) => s.includes(q.name));
    assert(source, id + ': has an explicit shipped reference');
    const linked = refs.text(source);
    const ids = [...linked.matchAll(/data-entity-id="([^"]+)"/g)].map((m) => m[1]);
    assert(
      ids.some((key) => refs.choices(key).some((row) => row.id === q.id)),
      id + ': named reference remains available',
    );
  }
  for (const source of ['到峋谷关客栈赴约', '到姑苏城客栈休息一晚'])
    assert.doesNotMatch(refs.text(source), /data-id="quest-(?:28020|29720)"/);
  const sources = [
    '按任务栏完成同参绝技、同参心法与达摩秘传三场修行。',
    '向道玄核对外丹一途，带茯苓、白芍各1。',
    '进入「意外之喜」的留人后续。',
    '「血染峋谷」记录白锦身亡。',
  ];
  for (const [i, ids] of [
    [0, [23062, 23066, 23070]],
    [1, [13803]],
    [2, [5829]],
    [3, [12038]],
  ])
    for (const id of ids) assert(refs.text(sources[i]).includes('data-id="quest-' + id + '"'));
});

test('formal branches and explicitly quoted canonical titles remain queryable without swallowing navigation', async () => {
  const { createEntityReferences } = await import('../src/renderer/entity-references.js');
  const index = encyclopedia(),
    refs = createEntityReferences({ ...helpers, index: () => index });
  for (const [text, ids] of [
    ['放弃调查会进入「放弃真相」，之后不能继续「查明真相」路线。', [21149, 21148]],
    ['想保留乘黄御风秘籍的收集路线，可核对三人赴战或孤身赴战。', [8554, 8555, 28929]],
  ]) {
    const html = refs.text(text);
    const linked = [...html.matchAll(/data-entity-id="([^"]+)"/g)].flatMap((m) => refs.choices(m[1]));
    for (const id of ids) assert(linked.some((row) => row.id === 'quest-' + id));
  }
  for (const q of index.world.quests.filter((q) => q.name.length >= 2)) {
    const html = refs.text('任务「' + q.name + '」');
    const linked = [...html.matchAll(/data-entity-id="([^"]+)"/g)].flatMap((m) => refs.choices(m[1]));
    assert(
      linked.some((row) => row.id === q.id),
      q.id + ': an explicit title keeps its canonical entry',
    );
  }
  assert.match(refs.text('前往玄火教主殿'), /data-id="place-311"/);
  assert.doesNotMatch(refs.text('前往玄火教主殿'), /data-id="quest-/);
  assert.match(refs.text('「玄火教主」结局'), /data-id="quest-26041"/);
  for (const text of ['先休息一晚，再赴约', '返回武当派，与道通交谈'])
    assert.doesNotMatch(refs.text(text), /data-id="quest-(?:28020|29720|6251|9050)"/);
});

test('current local directions remain visible in compact flow, task hover and the applicable maps', async () => {
  const { createEntityReferences } = await import('../src/renderer/entity-references.js');
  const { createFlowViews } = await import('../src/renderer/flow-views.js');
  const { createWorldViews } = await import('../src/renderer/world-views.js');
  const index = encyclopedia(),
    refs = createEntityReferences({ ...helpers, index: () => index });
  const views = createFlowViews({
    ...helpers,
    act: refs.button,
    richText: (s, t) => refs.text(s, 'flow-quest', t),
  });
  const maps = createWorldViews({
    ...helpers,
    act: refs.button,
    objectiveText: (s, t) => refs.text(s, 'world-quest', t),
  });
  for (const [id, expected, places] of [
    [5025, /梧桐村西边的小树林.*江小彤/, ['梧桐村']],
    [5037, /梧桐村西边的山坡.*夺回.*木剑/, ['梧桐村']],
    [5218, /武当派正殿东侧的真武殿.*道通.*领取身份铭牌/, ['武当派']],
    [5394, /名剑山庄向东寻找琴声/, ['名剑山庄']],
    [5408, /姑苏城.*想离开.*西边桥头/, ['姑苏城']],
    [5583, /黎城东边的法场.*清虚/, ['黎城']],
    [5584, /黎城东边的法场.*清霄/, ['黎城']],
    [5865, /景陇城.*幽云泽乘船.*或.*蔓阴林/, ['景陇']],
    [5943, /少林寺西边的方丈室.*莫问/, ['少林寺']],
    [5953, /回武当派.*晋升真武殿首座.*少林英雄大会/, ['武当派']],
    [6002, /少林寺南边的禅房.*清虚.*风云诀/, ['少林寺']],
    [6084, /玄火教东侧暗牢入口.*万花红/, ['玄火教']],
    [8577, /五仙教西侧厢房.*欧阳雪/, ['五仙教']],
    [8579, /五仙教西侧厢房休息一段时日/, ['五仙教']],
    [9050, /武当派找道通.*晋升真武殿首座/, ['武当派']],
    [11373, /城隍庙左侧.*老猿/, ['城隍庙']],
    [11947, /武当派三清殿东侧.*道通.*千陵渡凶案/, ['武当派']],
    [12402, /武当派弟子房东侧.*元辰.*莫问/, ['武当派']],
    [12404, /武当派试剑台西侧.*莫弃.*莫问/, ['武当派']],
    [16091, /幽云泽渡口东侧.*霹雳门弟子.*前往霹雳门/, ['幽云泽渡口', '霹雳门']],
    [17345, /西侧生殿邀请段履霜/, []],
    [17346, /东侧死殿邀请段朝晨/, []],
    [18932, /比天山更远的北方寻找隆大松/, []],
    [22334, /天佛窟第三层.*击败迦摩/, ['佛窟顶层']],
    [28420, /灵龟岛左侧石台破解河图机关/, ['灵龟岛']],
    [28421, /灵龟岛右侧石台破解洛书机关/, ['灵龟岛']],
  ]) {
    const q = quest(id),
      reference = {
        metadata: {
          trackingQuest: id,
          quests: [q.parentId, id].map((id) => ({ id, step: 1 })),
          inventory: [],
          teamIds: [],
        },
      };
    const targets = projector.project(q, reference.metadata);
    assert.deepEqual(
      targets.places.map((p) => p.name),
      places,
      String(id),
    );
    const flow = flowSnapshot({ id: 'synthetic', referenceMode: 'latest' }, reference);
    const lead = views.panel(flow, { compact: true }).split('<details class="flow-now-details"')[0];
    assert.match(lead.replace(/<[^>]+>/g, ''), expected, id + ': compact action');
    assert.match(refs.preview('quest-' + q.parentId, { reference }), expected, id + ': root hover');
    for (const place of targets.places)
      for (const key of place.mapKeys) {
        const scene = index.world.maps.find((p) => p.key === key);
        const current =
          maps
            .placeDetail(index, scene.id, { reference })
            .match(/data-place-current-tasks[\s\S]*?<\/section>/)?.[0] || '';
        assert.match(current, new RegExp('data-current-step="quest-' + id + '"'));
        assert.match(current.replace(/<[^>]+>/g, ''), expected, id + ': current map action');
      }
    if ([8577, 8579].includes(id))
      for (const scene of index.world.maps.filter((p) => p.name === '长生殿'))
        assert(
          !maps.placeDetail(index, scene.id, { reference }).includes('data-current-step="quest-' + id + '"'),
        );
    if (id === 22334)
      for (const other of ['place-327', 'place-328', 'place-329'])
        assert(!maps.placeDetail(index, other, { reference }).includes('data-current-step="quest-22334"'));
  }
});

test('local room names do not navigate to a shorter unrelated quest title', async () => {
  const { createEntityReferences } = await import('../src/renderer/entity-references.js');
  const { createFlowViews } = await import('../src/renderer/flow-views.js');
  const { createWorldViews } = await import('../src/renderer/world-views.js');
  const index = encyclopedia(),
    refs = createEntityReferences({ ...helpers, index: () => index });
  const views = createFlowViews({
    ...helpers,
    act: refs.button,
    richText: (s, t) => refs.text(s, 'flow-quest', t),
  });
  const maps = createWorldViews({
    ...helpers,
    act: refs.button,
    objectiveText: (s, t) => refs.text(s, 'world-quest', t),
  });
  const q = quest(5218),
    reference = {
      metadata: {
        trackingQuest: 5218,
        quests: [
          { id: q.parentId, step: 1 },
          { id: 5218, step: 1 },
        ],
      },
    };
  const targets = projector.project(q, reference.metadata);
  const flow = flowSnapshot({ id: 'synthetic', referenceMode: 'latest' }, reference);
  const lead = views.panel(flow, { compact: true }).split('<details class="flow-now-details"')[0];
  for (const html of [lead, refs.text('到真武殿领取身份铭牌')]) {
    assert.doesNotMatch(html, /data-id="quest-23200"/);
    assert(html.replace(/<[^>]+>/g, '').includes('真武殿'));
  }
  assert.match(lead, /data-id="npc-5011"/);
  for (const key of targets.places[0].mapKeys) {
    const place = index.world.maps.find((p) => p.key === key);
    const current =
      maps
        .placeDetail(index, place.id, { reference })
        .match(/data-place-current-tasks[\s\S]*?<\/section>/)?.[0] || '';
    assert(current.includes('真武殿'));
    assert.doesNotMatch(current, /data-id="quest-23200"/);
  }
  assert.match(refs.text('「真武」任务'), /data-id="quest-23200"/);
  assert.match(refs.text('前往玄火教主殿'), /data-id="place-311"/);
  assert.doesNotMatch(refs.text('前往玄火教主殿'), /data-id="quest-/);
});

test('relative room instructions retain their current region and local action across flow hover and maps', async () => {
  const { createEntityReferences } = await import('../src/renderer/entity-references.js');
  const { createFlowViews } = await import('../src/renderer/flow-views.js');
  const { createWorldViews } = await import('../src/renderer/world-views.js');
  const index = encyclopedia(),
    refs = createEntityReferences({ ...helpers, index: () => index });
  const views = createFlowViews({
    ...helpers,
    act: refs.button,
    richText: (s, t) => refs.text(s, 'flow-quest', t),
  });
  const maps = createWorldViews({
    ...helpers,
    act: refs.button,
    objectiveText: (s, t) => refs.text(s, 'world-quest', t),
  });
  for (const [id, expected, places] of [
    [5446, '到名剑山庄门口码头，与欧阳雪、瑶姬会合后乘船离开', ['名剑山庄']],
    [5526, '到峋谷关东南方向的徐海家，查清其假装受伤的目的', ['峋谷关']],
    [6085, '进入玄火教暗牢，营救瑶姬', ['玄火教']],
    [11857, '与上官虹前往白帝湖湖心亭，进行第二次试炼', ['白帝湖']],
    [13828, '到武当派后山厢房，迎战武林前辈', ['武当派']],
    [13829, '到武当派后山厢房，迎战武林名宿', ['武当派']],
    [16169, '回霹雳门厢房休息，等候明日', ['霹雳门']],
    [16189, '回霹雳门厢房休息，等候明日', ['霹雳门']],
    [16270, '进入厢房，面见童安', []],
    [29720, '到和璞山庄东厢房休息一晚', ['和璞山庄']],
    [29760, '到和璞山庄正厅找慕迟，让吕仙儿请教兵法', ['和璞山庄']],
    [30006, '到西厢房拜访叶云', []],
    [30044, '到和璞山庄校场一探', ['和璞山庄']],
    [30046, '在和璞山庄与慕寒梅告别，再回房间休息', ['和璞山庄']],
    [30350, '到和璞山庄西厢房，与瑶姬交谈', ['和璞山庄']],
    [30690, '在厢房稍事休息，等候夜幕降临', []],
  ]) {
    const q = quest(id),
      reference = {
        metadata: {
          trackingQuest: id,
          quests: [
            { id: q.parentId, step: 1 },
            { id, step: 1 },
          ],
          inventory: [],
          teamIds: [],
        },
      };
    const targets = projector.project(q, reference.metadata);
    assert.deepEqual(
      targets.places.map((p) => p.name),
      places,
      String(id),
    );
    const flow = flowSnapshot({ id: 'synthetic', referenceMode: 'latest' }, reference);
    const lead = views.panel(flow, { compact: true }).split('<details class="flow-now-details"')[0];
    assert(lead.replace(/<[^>]+>/g, '').includes(expected), id + ': local action visible');
    assert(
      refs
        .preview('quest-' + q.parentId, { reference })
        .replace(/<[^>]+>/g, '')
        .includes(expected),
      id + ': local action in hover',
    );
    for (const place of targets.places)
      for (const key of place.mapKeys) {
        const scene = index.world.maps.find((p) => p.key === key);
        const current =
          maps
            .placeDetail(index, scene.id, { reference })
            .match(/data-place-current-tasks[\s\S]*?<\/section>/)?.[0] || '';
        assert(current.includes('data-current-step="quest-' + id + '"'));
        assert(current.replace(/<[^>]+>/g, '').includes(expected), id + ': local action in map');
      }
    if ([29720, 29760, 30350].includes(id))
      assert.equal(targets.places[0].mapKeys.length, 2, 'do not guess the manor scene');
  }
});
