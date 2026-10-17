'use strict';
const world = require('../data/world-index.json');
const game = require('../data/game-index.json');
const guide = require('../data/flow-guide.cjs');
const materialGuide = require('../data/material-guide.cjs');
const { selectedReference } = require('./goal-progress.cjs');
const { withLiveDialogue } = require('./live-guidance.cjs');
const { createDuelProjector } = require('./duels.cjs');
const duelGuide = require('../data/duel-guide.cjs');
const { createTaskTargetProjector } = require('./task-targets.cjs');

// These are named sections of the story, not a numeric quest-ID ordering.
// A section is selected only by an actually active main-quest record.
const sections = [
  ['初入江湖', [5000, 5020, 5053, 5062, 5074, 5110, 5150, 5176]],
  ['拜师武当', [5200, 5213, 5231]],
  ['平康之行', [5242, 5246, 5275]],
  ['武当进阶', [5304, 5330, 5346]],
  ['品剑与姑苏', [5368, 5454]],
  ['峋谷与天龙帮', [5500, 5550, 5580, 5600, 5680]],
  ['名剑探病与寿礼', [5700, 5749, 5750, 5755]],
  ['天水祝寿', [5780, 5820]],
  ['南疆之行', [5850, 5860, 7005, 7140, 7250, 7280, 7300, 8000, 8030, 8080, 8499, 8800, 8830]],
  ['重返中原', [5920, 5940, 9254, 5980, 5990]],
  ['武林浩劫与决战', [6050, 6080, 6110, 6150]],
  ['烟尘回响 · 少林', [20000, 22000, 22100, 22170]],
  ['烟尘回响 · 武当', [24000, 24020]],
  ['其他主线', [9140]],
];
const labels = { 0: '尚未开始', 1: '进行中', 2: '已失败', 3: '尚未接取', 4: '已完成' };
const cleanName = (s) => String(s || '').replace(/^【[^】]+】\s*/, '');
// Broad upcoming story milestones, independently organized from the public
// walkthrough's chapter structure. This is reference, never an unlocked task.
const nextMilestones = [5200, 5246, 5330, 5368, 5500, 5700, 5780, 5860, 5920, 6050];

function createFlowProjector({
  world: w,
  game: g,
  guide: content,
  materials: materialContent = materialGuide,
}) {
  const quests = new Map(w.quests.map((q) => [q.gameId, q]));
  const people = new Map(w.people.map((p) => [p.gameId, p]));
  const items = new Map(g.entries.map((e) => [e.id, e]));
  const maps = new Map(w.maps.map((p) => [p.key, p]));
  const taskTargets = createTaskTargetProjector(w, materialContent.items);
  const projectDuels = createDuelProjector({ world: w, game: g, guide: duelGuide });
  const children = new Map();
  for (const q of quests.values()) {
    if (!children.has(q.parentId)) children.set(q.parentId, []);
    children.get(q.parentId).push(q);
  }
  function rootOf(q) {
    const seen = new Set();
    while (q?.parentId && !seen.has(q.parentId)) {
      seen.add(q.parentId);
      const parent = quests.get(q.parentId);
      if (!parent) break; // An orphan is not attached to a similarly named quest.
      q = parent;
    }
    return q;
  }
  function family(q) {
    const rows = [],
      seen = new Set(),
      queue = [q];
    for (let i = 0; i < queue.length; i++) {
      if (seen.has(queue[i].gameId)) continue;
      seen.add(queue[i].gameId);
      rows.push(queue[i]);
      queue.push(...(children.get(queue[i].gameId) || []));
    }
    return rows;
  }
  const npcName = (id) => people.get(id)?.name || w.npcNames?.[id] || g.npcNames?.[id] || `人物 #${id}`;
  function textPlaces(text) {
    const aliases = { 武当派: '武当', 少林寺: '少林' };
    const found = w.maps
      .map((p) => ({
        ...p,
        mention: text.includes(p.name)
          ? p.name
          : aliases[p.name] && text.includes(aliases[p.name])
            ? aliases[p.name]
            : '',
      }))
      .filter((p) => p.mention.length > 1);
    const distinct = new Map();
    for (const p of found.filter(
      (p) => !found.some((other) => other.mention !== p.mention && other.mention.includes(p.mention)),
    )) {
      if (distinct.has(p.name)) distinct.get(p.name).id = null;
      else distinct.set(p.name, { ...p });
    }
    return [...distinct.values()].sort((a, b) => text.indexOf(a.mention) - text.indexOf(b.mention));
  }
  function routesFor(material, task, currentMap, targets) {
    const item = items.get(`item-${material.id}`),
      routes = (materialContent.items[material.id]?.routes || []).map((route) => ({
        ...route,
        sources: (route.sourceIds || [])
          .filter((id) => materialContent.sources[id])
          .map((id) => ({ ...materialContent.sources[id], id: 'material:' + id })),
      }));
    const taskRoute = content.stepMaterialRoutes?.[task.gameId]?.[material.id];
    if (taskRoute) routes.unshift({ ...taskRoute, taskSpecific: true });
    for (const hint of targets?.materialHints || [])
      if (hint.materialIds.includes(material.id))
        routes.unshift({
          kind: 'reference',
          label: hint.text,
          detail: task.description,
          taskSpecific: true,
        });
    const collectionPlaces = (targets?.places || []).filter(
      (p) =>
        p.purpose === 'objective' || (p.purpose === 'material-source' && p.materialIds.includes(material.id)),
    );
    const explicitSources = collectionPlaces.filter((place) => place.materialIds?.includes(material.id));
    const inferredSources = explicitSources.length
      ? explicitSources
      : collectionPlaces.length === 1 &&
          task.name.includes(material.name) &&
          /采集|购买|买来|寻找|收集|搜集|找齐|抓|捕捉|获取|取得|取回|钓取/.test(task.name)
        ? collectionPlaces
        : [];
    if (!taskRoute)
      for (const place of inferredSources) {
        if (
          routes.some(
            (route) =>
              route.place === place.name ||
              route.placeName === place.name ||
              (route.placeId && w.maps.find((row) => row.id === route.placeId)?.name === place.name),
          )
        )
          continue;
        routes.push({
          kind: 'reference',
          label: place.name + (place.hint ? ' · ' + place.hint : ' 获取线索'),
          placeId: place.id,
          place: place.name,
          taskSpecific: place.evidence !== '物品资料获取线索',
          instruction:
            !place.hint &&
            place.mentions.some((mention) => (targets.nextAction || task.name).includes(mention))
              ? cleanName(targets.nextAction || task.name)
              : '',
          detail:
            place.evidence === '物品资料获取线索'
              ? item?.description
              : place.evidence === '任务获取地点'
                ? task.description
                : '',
        });
      }
    for (const route of content.itemRoutes?.[material.id] || []) {
      if (!route.placeId || !w.maps.some((place) => place.id === route.placeId)) continue;
      routes.push({
        kind: 'reference',
        label: route.title,
        detail: route.detail,
        placeId: route.placeId,
        place: w.maps.find((place) => place.id === route.placeId).name,
        efficiency: route.efficiency || route.uncertainty || '',
        sources: (route.sourceIds || [])
          .filter((id) => content.sources[id])
          .map((id) => ({ ...content.sources[id], id: 'flow:' + id })),
      });
    }
    for (const shop of g.merchants || []) {
      if (!shop.items.includes(material.id)) continue;
      if (routes.some((route) => route.personId === `npc-${shop.id}`)) continue;
      const person = people.get(shop.id);
      const place = maps.get(person?.walkMap);
      routes.push({
        kind: 'shop',
        label: `购买 · ${shop.name}${place ? ' · ' + place.name : ''}`,
        personId: `npc-${shop.id}`,
        placeId: place?.id,
        place: place?.name,
        detail: item?.buyPrice
          ? `资料标价 ${item.buyPrice} 文/件；当前售卖、库存和折扣请到店核对。`
          : '当前售卖、库存和价格请到店核对。',
        efficiency: `${place ? '地点来自静态行走场景，非当前在场证明。' : '商人所在地点待核对。'}数量够且商店已开放时可直接买齐；不保证当前可买。`,
      });
    }
    const acquisition = item?.description?.match(/(?:可以在|可在|可以通过|可通过|击败|打败)[\s\S]*/)?.[0];
    if (acquisition)
      routes.push({
        kind: /采集|垂钓|钓鱼/.test(acquisition) ? 'gather' : 'reference',
        label: /采集/.test(acquisition) ? '采集来源' : '物品资料来源',
        detail: acquisition,
        efficiency: /概率|掉落/.test(acquisition)
          ? '随机产出；资料没有掉率或每分钟产量。'
          : '可按已开放、离当前地点近的地点选择；刷新时间与每次产量未知。',
      });
    // Quest text can supply a route absent from the item entry. Keep it as a
    // family-level clue, rather than assigning every mentioned place to every item.
    if (!routes.length && /采集|购买|买来|买酒|刷|击败|获得/.test(task.description || ''))
      routes.push({
        kind: 'quest',
        label: '本步骤的获取说明',
        detail: task.description,
        efficiency: '这段说明可能同时涉及数种材料；以游戏内采集点或商店为准。',
      });
    if (!routes.length)
      routes.push({
        kind: 'unknown',
        label: '来源待核对',
        detail: '当前资料没有可确认的购买、采集或掉落地点。',
        efficiency: '暂无效率数据。',
      });
    const nearby = (route) =>
      !!currentMap &&
      (route.place === currentMap ||
        textPlaces(route.detail || '').some((place) => place.name === currentMap));
    const rank = (route) =>
      route.taskSpecific
        ? 0
        : nearby(route)
          ? 1
          : route.kind === 'shop' || (route.personId && !route.placeId)
            ? 4
            : 2;
    return routes
      .map((route) => ({
        ...route,
        placeName: route.place || w.maps.find((place) => place.id === route.placeId)?.name || '',
        personName: route.personId ? npcName(Number(route.personId.replace(/^npc-/, ''))) : '',
        alternative: rank(route) === 4,
      }))
      .sort((a, b) => rank(a) - rank(b));
  }
  function snapshot(profile, reference, error = '', dialogue = null) {
    const selected = selectedReference(profile, reference, error);
    const referenceMode = profile.referenceMode || (profile.saveSlot ? 'slot' : 'latest');
    const live =
      referenceMode === 'latest' && dialogue?.npcState?.origin === 'live' ? dialogue.npcState : null;
    const savedAt = new Date(selected?.modifiedAt || '').getTime();
    const showingOlderSave =
      referenceMode === 'latest' &&
      !live &&
      Number.isFinite(dialogue?.lastLiveAt) &&
      dialogue.lastLiveAt > 0 &&
      (!Number.isFinite(savedAt) || savedAt < dialogue.lastLiveAt);
    const liveMap = live ? maps.get(live.world.split('.').pop()) || maps.get(live.player.mapKey) : null;
    const metadata = live
      ? {
          questStates: live.questStates,
          map: liveMap?.key || '',
          mapName: liveMap?.name || '',
          combat: { origin: 'live', player: live.player, npcStates: live.npcStates },
        }
      : selected?.metadata || {};
    const states = Array.isArray(metadata.questStates) ? metadata.questStates : metadata.quests;
    const available = Array.isArray(states);
    const records = new Map((available ? states : []).map((r) => [r.id, r]));
    const inventory = Array.isArray(metadata?.inventory) ? new Map() : null;
    for (const row of inventory ? metadata.inventory : [])
      if (Number.isSafeInteger(row.count) && row.count >= 0)
        inventory.set(row.id, (inventory.get(row.id) || 0) + row.count);
    const source = selected
      ? {
          name: selected.name,
          hash: selected.hash,
          modifiedAt: selected.modifiedAt,
          mapName: metadata.mapName || '',
          ...(live ? { origin: 'live' } : {}),
        }
      : live
        ? { origin: 'live', mapName: metadata.mapName || '' }
        : null;
    const step = (id) => records.get(id)?.step;
    function blocked(q, closedStates = [2, 3, 4]) {
      const seen = new Set();
      while (q && !seen.has(q.gameId)) {
        seen.add(q.gameId);
        if (closedStates.includes(step(q.gameId))) return true;
        q = quests.get(q.parentId);
      }
      return false;
    }
    function requirement(r) {
      const target = quests.get(r.id),
        name = r.name || target?.name || `记录 #${r.id}`;
      if (r.type === 'PreQuest')
        return {
          text: `${cleanName(name)}：需${labels[r.value] || '状态 ' + r.value}`,
          status: live
            ? (step(r.id) ?? 0) === r.value
              ? 'met'
              : 'unmet'
            : step(r.id) === undefined
              ? 'unknown'
              : step(r.id) === r.value
                ? 'met'
                : 'unmet',
        };
      // Absence in the public quest array does not prove a hidden flag is absent.
      if (r.type === 'NoQuest')
        return {
          text: `${cleanName(name)}：需尚未触发`,
          status: live ? (records.has(r.id) ? 'unmet' : 'met') : records.has(r.id) ? 'unmet' : 'unknown',
        };
      if (r.type === 'Item')
        return {
          text: `${r.name || '物品 #' + r.id} × ${r.value}`,
          status: inventory ? ((inventory.get(r.id) || 0) >= r.value ? 'met' : 'unmet') : 'unknown',
        };
      if (r.type === 'Money')
        return {
          text: `铜钱至少 ${r.value}`,
          status: Number.isFinite(metadata?.money)
            ? metadata.money >= r.value
              ? 'met'
              : 'unmet'
            : 'unknown',
        };
      if (r.type === 'TeamMember') return { text: `${npcName(r.id)}：队伍状态需核对`, status: 'unknown' };
      if (r.type === 'Friendliness' || r.type === 'FriendlinessUp')
        return {
          text: `${r.name || npcName(r.id)}：资料列好感条件 ${r.value}，比较方式与当前好感需核对`,
          status: 'unknown',
        };
      return { text: `${r.name || npcName(r.id)}：${r.type} ${r.value}`, status: 'unknown' };
    }
    function projectStep(q) {
      const targets = taskTargets.project(q, metadata);
      const stepRule = content.stepRequirements?.[q.gameId];
      const blockedWindow = (stepRule?.blockedByAnyRecorded || []).some((id) => records.has(id));
      const places = textPlaces(q.name + ' ' + q.description).map((p) => ({
        id: p.id,
        name: p.name,
        evidence: '当前任务文字提及',
      }));
      for (const row of q.placements || []) {
        const p = maps.get(row.mapKey);
        if (!p || !row.interactionTarget) continue;
        let place = places.find((v) => v.name === p.name);
        if (!place) {
          place = { name: p.name };
          places.push(place);
        }
        place.interactionIds ||= new Set();
        place.interactionIds.add(p.id);
        place.id = place.interactionIds.size === 1 ? p.id : null;
        place.evidence =
          place.interactionIds.size === 1
            ? '资料中的交互场景，非实时位置'
            : '资料中有多个同名交互场景，具体场景待核对';
      }
      for (const place of places) delete place.interactionIds;
      const npcs = [...new Set(q.finishNPCs || [])].map((id) => ({
        id: `npc-${id}`,
        name: npcName(id),
        role: '交互配置',
      }));
      for (const [id, rawName] of Object.entries(w.npcNames || {})) {
        const name = rawName.split('-').at(-1);
        if (name.length < 2 || !`${q.name} ${q.description}`.includes(name)) continue;
        if (!npcs.some((p) => p.id === `npc-${id}`))
          npcs.push({ id: `npc-${id}`, name: rawName, role: '任务文字提及' });
      }
      return {
        id: q.id,
        name: cleanName(q.name),
        targets,
        blockedWindow,
        nextAction: blockedWindow
          ? stepRule.blockedAction
          : !q.parentId && children.get(q.gameId)?.length
            ? targets.conditionHint
              ? `下一步未识别，请查看游戏任务栏；${targets.conditionHint}`
              : '下一步未识别，请查看游戏任务栏。'
            : targets.nextAction || cleanName(q.name),
        description: q.description,
        people: npcs,
        places,
        materials: (q.materials || []).map((m) => ({
          id: `item-${m.id}`,
          name: m.name,
          required: m.count,
          owned: inventory ? inventory.get(m.id) || 0 : null,
          missing: inventory ? Math.max(0, m.count - (inventory.get(m.id) || 0)) : null,
          routes: routesFor(m, q, metadata.mapName, targets),
        })),
        requirements: [...(q.requirements || []), ...(stepRule?.requirements || [])].map(requirement),
        upcoming: [...quests.values()]
          .filter((next) =>
            next.requirements.some((r) => r.type === 'PreQuest' && r.id === q.gameId && r.value === 4),
          )
          .map((next) => ({
            id: next.id,
            name: cleanName(next.name),
            reason: '资料明确列出此步骤完成为前置；其他条件仍需核对。',
          })),
      };
    }
    const groups = new Map();
    const unindexedActive = [...records.values()]
      .filter(
        (record) =>
          Number.isSafeInteger(record.id) && record.id > 0 && record.step === 1 && !quests.has(record.id),
      )
      .map((record) => ({
        id: record.id,
        tracked: record.id === metadata.trackingQuest || record.id === metadata.trackingMainQuest,
      }))
      .sort((a, b) => Number(b.tracked) - Number(a.tracked));
    for (const [id, record] of records) {
      const q = quests.get(id);
      if (!q || record.step !== 1 || blocked(q)) continue;
      const root = rootOf(q);
      if (!groups.has(root.gameId)) groups.set(root.gameId, { root, rows: [] });
      groups.get(root.gameId).rows.push(q);
    }
    const rank = (q) =>
      q.gameId === metadata?.trackingQuest
        ? 0
        : q.gameId === metadata?.trackingMainQuest
          ? 1
          : q.kind === 'Primary'
            ? 2
            : 3;
    const active = [...groups.values()]
      .map(({ root, rows }) => {
        const actualSteps = rows.filter((q) => q.gameId !== root.gameId);
        return {
          id: root.id,
          gameId: root.gameId,
          name: cleanName(root.name),
          kind: root.kind,
          progress: family(root)
            .filter((q) => q.gameId !== root.gameId && labels[step(q.gameId)])
            .map((q) => ({ id: q.id, name: cleanName(q.name), status: labels[step(q.gameId)] })),
          steps: (actualSteps.length ? actualSteps : rows).sort((a, b) => rank(a) - rank(b)).map(projectStep),
          rank: Math.min(...rows.map(rank)),
        };
      })
      .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name, 'zh-CN'));
    const materialDemand = new Map();
    for (const task of active)
      for (const current of task.steps)
        for (const material of current.materials) {
          if (!materialDemand.has(material.id))
            materialDemand.set(material.id, {
              id: material.id,
              name: material.name,
              owned: material.owned,
              required: 0,
              steps: [],
            });
          const demand = materialDemand.get(material.id);
          demand.required += material.required;
          demand.steps.push({
            id: current.id,
            name: current.name,
            taskName: task.name,
            required: material.required,
          });
        }
    const sharedMaterials = [...materialDemand.values()]
      .filter((material) => new Set(material.steps.map((row) => row.id)).size > 1)
      .map((material) => ({
        ...material,
        missing: material.owned === null ? null : Math.max(0, material.required - material.owned),
      }));
    const mainCandidates = active.filter((q) => q.kind === 'Primary');
    const hasTrackedMain = Number.isSafeInteger(metadata.trackingMainQuest) && metadata.trackingMainQuest > 0;
    const trackedRoot = hasTrackedMain ? rootOf(quests.get(metadata.trackingMainQuest)) : null;
    const main = hasTrackedMain
      ? mainCandidates.find((q) => q.gameId === trackedRoot?.gameId)
      : mainCandidates.length === 1
        ? mainCandidates[0]
        : null;
    const stageUncertainty =
      !available || main
        ? ''
        : hasTrackedMain
          ? '当前追踪的主线暂不能与已识别的进行中任务对应；阶段与下一节点待核对，不据其他任务猜测。'
          : mainCandidates.length > 1
            ? '存档同时记录了多条进行中主线，尚无明确的主线追踪；阶段与下一节点待核对。'
            : '这份存档没有可确认的进行中主线；阶段与下一节点待核对。';
    const section = main && sections.find(([, ids]) => ids.includes(main.gameId));
    const milestone = main && content.milestones?.[main.gameId];
    const ambiguousReturn = section?.[0] === '重返中原' && !milestone && main.gameId !== 5990;
    const nextMilestone =
      main && quests.get(milestone?.next || (section && nextMilestones[sections.indexOf(section)]));
    const chapter = main
      ? {
          name: section?.[0] || '当前主线',
          mainName: main.name,
          questId: main.id,
          basis: hasTrackedMain
            ? '依据这份存档的主线追踪与进行中记录。'
            : '依据唯一已识别的进行中主线；未保存的剧情变化仍需核对。',
          next: null,
          nextMilestone: ambiguousReturn
            ? {
                questId: null,
                title: '少林后续路线待核对',
                note: '原版后续有武林浩劫，烟尘回响会先进入少林剑决；当前阶段记录不足以自动区分路线，请核对游戏任务栏。',
              }
            : nextMilestone
              ? {
                  questId: nextMilestone.id,
                  title: cleanName(nextMilestone.name),
                  note: '主线节点参考；实际接取以当前任务栏和前置条件为准。',
                  sources: (milestone?.sourceIds || [])
                    .filter((id) => content.sources[id])
                    .map((id) => ({ ...content.sources[id], id: 'flow:' + id })),
                }
              : null,
        }
      : null;
    const duelProgress = projectDuels({
      available,
      states: available ? states : [],
      mainQuestId: main?.gameId,
      mapName: metadata.mapName || '',
      difficultyName: metadata.difficultyName || '',
      combat: metadata.combat || null,
      metadata,
    });
    const projectedRules = (content.rules || []).map((rule) => {
      const status = rule.questId ? step(rule.questId) : undefined;
      const knownFamily = rule.questId && quests.get(rule.questId) ? family(quests.get(rule.questId)) : [];
      const activeRule = status === 1 || knownFamily.some((q) => step(q.gameId) === 1 && !blocked(q));
      const done = status === 4;
      const failed = status === 2;
      const anchors = rule.afterAllComplete || [];
      const anchorsMet = anchors.length > 0 && anchors.every((id) => step(id) === 4);
      // Side-story windows follow their saved steps, independently of the tracked main quest.
      const stageMatch =
        (main && (rule.chapterRoots || []).includes(main.gameId)) ||
        (rule.stageSteps || []).some((id) => {
          const task = quests.get(id);
          return task && step(id) === 1 && !blocked(task);
        });
      const locationMatch = (rule.locationIds || []).some((id) => {
        const place = w.maps.find((entry) => entry.id === id);
        return place && [place.key, place.name].includes(metadata.mapName);
      });
      const relevant =
        activeRule ||
        locationMatch ||
        (rule.requireStageMatch ? stageMatch && (!anchors.length || anchorsMet) : stageMatch || anchorsMet);
      const deadlineReached =
        (rule.untilAnyRecorded || []).some((id) => records.has(id)) ||
        (rule.untilAnyStarted || []).some((id) => [1, 2, 4].includes(step(id))) ||
        (rule.untilAnyFailed || []).some((id) => step(id) === 2) ||
        (rule.untilAnyComplete || []).some((id) => step(id) === 4);
      const recordedWindowMessage =
        deadlineReached && (rule.recordedWindowMessages || []).find((row) => records.has(row.questId));
      const decisionStepActive = (rule.decisionSteps || []).some((id) => {
        const task = quests.get(id);
        return task && rootOf(task)?.gameId === rule.questId && step(id) === 1 && !blocked(task);
      });
      // Some choices follow a completed visible step and use an unnamed dialog record.
      // Only curated, verified windows may bridge that gap, until a saved branch closes it.
      const decisionAnchors = rule.decisionAfterAllComplete || [];
      const decisionAnyAnchors = rule.decisionAfterAnyComplete || [];
      const completedDecisionAnchor = (id) => {
        const task = quests.get(id);
        return (
          task &&
          rootOf(task)?.gameId === rule.questId &&
          step(id) === 4 &&
          !blocked(quests.get(task.parentId))
        );
      };
      const decisionWindowActive =
        status === 1 &&
        ((decisionAnchors.length > 0 && decisionAnchors.every(completedDecisionAnchor)) ||
          decisionAnyAnchors.some(completedDecisionAnchor));
      const decisionActive =
        !deadlineReached &&
        (decisionStepActive || decisionWindowActive || (rule.decisionOnArrival === true && locationMatch));
      const decisionResolved =
        !decisionActive && (rule.decisionSteps || []).some((id) => [2, 4].includes(step(id)));
      const affectedTasks = (rule.advanceEffects || [])
        .filter((effect) => !effect.questId || ![2, 4].includes(step(effect.questId)))
        .map((effect) => {
          const task = quests.get(effect.questId);
          const accepted = task && family(task).some((entry) => step(entry.gameId) === 1 && !blocked(entry));
          return {
            ...effect,
            name: effect.name || cleanName(task?.name || '任务名称待核对'),
            effect:
              effect.scope === 'accept' && accepted
                ? '这份存档已有进行中记录；资料只限制未接取的窗口，没有证明推进后已接任务会失败。'
                : effect.effect,
          };
        });
      let checkpointWarning = '';
      if (rule.checkpoint && step(rule.checkpoint.questId) === 1) {
        const c = rule.checkpoint;
        const person = duelProgress.progress.people.find((row) => row.npcId === c.npcId);
        const friendship = person?.friendship.value;
        checkpointWarning =
          friendship === null || friendship === undefined
            ? `共饮前先核对陈麟熙好感：达到 ${c.threshold} 时，取胜会让他离场${step(c.affectedQuestId) === 1 ? '，进行中的灭门之案线索也会失败' : ''}。`
            : friendship >= c.threshold
              ? `陈麟熙好感 ${friendship}：共饮后取胜会让他离场${step(c.affectedQuestId) === 1 ? '，进行中的灭门之案线索也会失败' : ''}。想保留人物内容，先不要推进。`
              : `陈麟熙好感 ${friendship}：当前低于 ${c.threshold}，共饮会走保留人物的分支；此时继续赠礼可能改变结果。`;
      }
      return {
        ...rule,
        ...(recordedWindowMessage
          ? {
              closedWindowSummary: recordedWindowMessage.summary,
              closedWindowMessage: recordedWindowMessage.message,
            }
          : {}),
        ...(checkpointWarning
          ? { severity: 'warning', warning: checkpointWarning, compactWarning: checkpointWarning }
          : {}),
        recommendation: rule.recommendation
          ? {
              ...rule.recommendation,
              // Branch requirements are static facts, including when a live
              // choice opens before the next save contains its quest step.
              materials: (rule.recommendation.materialQuestIds || []).flatMap((id) => {
                const task = quests.get(id);
                if (!task || rootOf(task)?.gameId !== rule.questId) return [];
                return projectStep(task).materials;
              }),
            }
          : undefined,
        name: rule.title,
        activeRule,
        activeWindowBlocked: active.some(
          (task) => task.gameId === rule.questId && task.steps.some((step) => step.blockedWindow),
        ),
        done,
        failed,
        relevant,
        deadlineReached,
        decisionActive,
        decisionResolved,
        affectedTasks,
        deliveryOptions: (rule.deliveryQuestIds || []).flatMap((id) => {
          const task = quests.get(id);
          return (task?.requirements || [])
            .filter((row) => row.type === 'Item')
            .map((row) => ({
              questId: id,
              id: `item-${row.id}`,
              name: row.name || items.get(`item-${row.id}`)?.name || `物品 #${row.id}`,
              required: row.value,
              owned: inventory ? inventory.get(row.id) || 0 : null,
            }));
        }),
        state: done
          ? 'done'
          : failed
            ? 'failed'
            : activeRule
              ? 'active'
              : status === 3
                ? 'not-accepted'
                : status === 0
                  ? 'not-started'
                  : 'unrecorded',
        conditions: anchors.map((id) => ({
          text: `${rule.afterLabels?.[id] || cleanName(quests.get(id)?.name || '未命名剧情记录')}：需已完成`,
          status: step(id) === 4 ? 'met' : step(id) === undefined ? 'unknown' : 'unmet',
        })),
        sources: (rule.sourceIds || [])
          .filter((id) => content.sources[id])
          .map((id) => ({ ...content.sources[id], id: 'flow:' + id })),
      };
    });
    const relevantRules = projectedRules.filter(
      (r) =>
        available &&
        r.relevant &&
        !r.done &&
        !r.failed &&
        !r.decisionResolved &&
        (!r.requireDecisionWindow || r.decisionActive),
    );
    const warnings = relevantRules
      .filter((r) => r.warning && r.severity !== 'reminder' && !r.deadlineReached)
      .map((r) => ({ ...r, message: r.warning }));
    const changes = relevantRules
      .filter(
        (r) => (r.untilAnyStarted?.length || r.phaseChange || r.affectedTasks.length) && !r.deadlineReached,
      )
      .map((r) => ({
        id: r.id,
        title: r.title,
        triggerName:
          r.deadlineLabel ||
          r.untilAnyStarted
            .map((id) => cleanName(quests.get(id)?.name || '后续主线推进（具体触发待核对）'))
            .join(' / '),
        consequence: r.warning || '社区资料标注此处为接取窗口边界，推进前请核对。',
        affectedTasks: r.affectedTasks,
      }));
    const opportunities = relevantRules.filter(
      (r) => r.kind !== 'stage' && !r.activeRule && !r.deadlineReached,
    );
    // Raw request conditions are additional leads, never a proof that every
    // unrecorded quest is available. Hide known unmet requirements.
    const knownOpportunity = new Set(opportunities.map((r) => r.questId));
    for (const q of quests.values()) {
      if (!available || !q.requestNPCs.length) continue;
      const root = rootOf(q);
      if (
        knownOpportunity.has(root.gameId) ||
        groups.has(root.gameId) ||
        [1, 2, 4].includes(step(root.gameId)) ||
        [1, 2, 4].includes(step(q.gameId)) ||
        blocked(q, [2, 4])
      )
        continue;
      const conditions = q.requirements.map(requirement);
      const unknownStoryPrerequisite = q.requirements.some(
        (r, index) => r.type === 'PreQuest' && conditions[index].status === 'unknown',
      );
      if (
        conditions.some((r) => r.status === 'unmet') ||
        (step(q.gameId) !== 3 && (unknownStoryPrerequisite || !conditions.some((r) => r.status === 'met')))
      )
        continue;
      const projected = projectStep(q);
      const requestPeople = q.requestNPCs.map(npcName);
      const pickupHint = (content.rules || []).find(
        (rule) =>
          rule.questId === root.gameId &&
          rule.pickup &&
          requestPeople.some((name) =>
            String(rule.pickup.person || '')
              .replace(/[-\s]/g, '')
              .includes(name.split('-').at(-1)),
          ),
      );
      // Pickup locations belong to the requesting NPC, not to destinations in
      // the task's objective text. Static clues do not establish current presence.
      const pickupPlaces = new Set();
      for (const placement of q.placements || []) {
        if (placement.phase !== 'request' || !q.requestNPCs.includes(placement.npcId)) continue;
        const place = maps.get(placement.mapKey);
        if (place) pickupPlaces.add(place.name);
      }
      for (const id of q.requestNPCs) {
        const person = people.get(id);
        const place = maps.get(person?.walkMap);
        if (place) pickupPlaces.add(place.name);
        else for (const clue of textPlaces(person?.description || '')) pickupPlaces.add(clue.name);
      }
      opportunities.push({
        id: 'conditions-' + q.gameId,
        questId: root.gameId,
        name: cleanName(root.name),
        state:
          step(q.gameId) === 3 || step(root.gameId) === 3
            ? 'not-accepted'
            : conditions.some((r) => r.status === 'unknown')
              ? 'conditions-partial'
              : 'conditions-match',
        pickup: {
          place: pickupHint?.pickup.place || [...pickupPlaces].join('、') || '接取地点待核对',
          person: pickupHint?.pickup.person || requestPeople.join('、'),
          action:
            pickupHint?.pickup.action ||
            `与${requestPeople.join('、')}交谈，询问「${cleanName(root.name)}」。`,
          executionPlace: projected.places.map((p) => p.name).join('、'),
        },
        steps: pickupHint?.steps || [q.description],
        choices: [],
        warning: '',
        conditions,
        sources: (pickupHint?.sourceIds || [])
          .filter((id) => content.sources[id])
          .map((id) => ({ ...content.sources[id], id: 'flow:' + id })),
        uncertainty: conditions.length
          ? '已读取的条件见上方；未列出的隐藏条件及 NPC 当前所在位置仍需到游戏中确认。'
          : '这一步在存档中记为尚未接取；资料未列出可核对的接取条件，人物当前所在位置仍需到游戏中确认。',
      });
      knownOpportunity.add(root.gameId);
    }
    // A crossed guide window is a verification item, never an automatic
    // declaration of a missed/failed quest.
    const windowChecks = relevantRules
      .filter((r) => r.kind !== 'stage' && r.deadlineReached && !r.activeRule)
      .map((r) => ({
        ...r,
        message:
          r.closedWindowMessage ||
          `已出现窗口边界的剧情记录；请核对「${r.title}」是否仍可接取。没有任务记录不等于错过。`,
      }));
    const result = {
      profileId: profile.id,
      available,
      reason: available
        ? ''
        : referenceMode === 'none'
          ? '此周目暂不读取游戏进度；可以查看下方流程资料。'
          : error ||
            (referenceMode === 'slot'
              ? `本周目固定参照「${profile.saveSlot || '尚未指定'}」暂不可读取。请检查该存档，或选择本周目的流程参照；保存到其他槽位不会更换固定参照。`
              : '游戏里保存一次后，自动按已保存进度整理任务。'),
      referenceNeedsSelection: !available && referenceMode === 'slot',
      reference: source,
      referenceMode,
      chapter,
      stageUncertainty,
      active,
      unindexedActive,
      sharedMaterials,
      opportunities,
      warnings: [...warnings, ...windowChecks],
      advice: relevantRules.filter((r) => r.warning && r.severity === 'reminder' && !r.deadlineReached),
      decisions: relevantRules
        .filter((r) => r.decisionActive && !r.deadlineReached && r.choices?.length)
        .sort(
          (a, b) =>
            active.findIndex((row) => row.gameId === a.questId) -
            active.findIndex((row) => row.gameId === b.questId),
        ),
      duels: duelProgress,
      stateOrigin: live ? 'live' : 'saved',
      stateNotice: showingOlderSave
        ? selected
          ? '现场更新暂停 · 暂按最近保存显示'
          : '现场更新暂停 · 等待重新读取'
        : '',
      npcStateKey: live?.key || '',
      liveReference: live
        ? {
            origin: 'live',
            key: live.key,
            metadata: { quests: live.questStates, map: metadata.map, mapName: metadata.mapName },
          }
        : null,
      changes,
      coverage: {
        tasks: quests.size,
        mainRoots: [...quests.values()].filter(
          (q) => !q.parentId && q.kind === 'Primary' && !q.name.includes('试玩版'),
        ).length,
        curatedRules: projectedRules.length,
      },
      chapters: sections.map(([name, ids]) => ({
        name,
        roots: ids
          .map((id) => quests.get(id))
          .filter(Boolean)
          .map((q) => ({
            id: q.id,
            name: cleanName(q.name),
            status: labels[step(q.gameId)] || (available ? '未出现在记录' : '未核对存档'),
          })),
      })),
      guide: projectedRules,
    };
    const projected = withLiveDialogue(result, dialogue, quests);
    if (chapter && projected.changes[0]) {
      const next = relevantRules.find((r) => r.id === projected.changes[0].id);
      chapter.next = {
        title: projected.changes[0].triggerName,
        questId: quests.get(next?.untilAnyStarted?.[0] || next?.untilAnyComplete?.[0])?.id || null,
      };
    }
    return projected;
  }
  return { flowSnapshot: snapshot };
}
const { flowSnapshot } = createFlowProjector({ world, game, guide });
module.exports = { createFlowProjector, flowSnapshot };
