'use strict';

// Objectives come from the current step's instruction, not every place or
// character mentioned while describing its story. Keep narrative relations in
// the existing detail index, independently of these actionable destinations.
const defaultAliases = require('../data/world-place-aliases.json');
const objectiveGuide = require('../data/task-objective-guide.json');
const {
  resolveTaskObjectives,
  isGenericPlaceName,
  placeMentionIsQualifier,
} = require('../shared/task-objectives.mjs');
const delivery =
  /交给|交予|交付|送给|送予|交还|还给|归还|换取|交换|上交|带给|带予|带回|交货|给(?![^，；。]*买)/;
const acquisition =
  /采集|购买|买|搜集|寻找|找寻|找回|收集|收割|找齐|抓|捕捉|获取|取得|取回|夺回|抢回|拿到|炼制|垂钓|钓鱼|钓取|击败|抢/;
function createTaskTargetProjector(world, materialItems = {}) {
  const maps = world.maps || [];
  const parents = new Set(
    (world.quests || []).map((task) => task.parentId).filter((id) => Number.isSafeInteger(id) && id > 0),
  );
  const teamClause = /【(?:此任务)?需(?:邀请)?([^【】]+?)(?:在队|一同前往)】/g;
  const partyIds = (name) =>
    [
      ...new Set([
        ...Object.entries(world.npcNames || {})
          .filter(([, value]) => value === name)
          .map(([id]) => Number(id)),
        ...(world.people || []).filter((person) => person.name === name).map((person) => person.gameId),
      ]),
    ].filter((id) => Number.isSafeInteger(id) && id > 0);
  const names = new Map();
  for (const place of maps) {
    if (!names.has(place.name)) names.set(place.name, []);
    names.get(place.name).push(place);
  }
  const phrases = new Map([...names.keys()].filter((name) => name.length > 1).map((name) => [name, [name]]));
  for (const alias of world.placeAliases || defaultAliases)
    if (names.has(alias.name))
      for (const mention of [...alias.mentions, ...(alias.ambiguousMentions || [])]) {
        const targets = phrases.get(mention) || [];
        if (!targets.includes(alias.name)) targets.push(alias.name);
        phrases.set(mention, targets);
      }
  const entityId = (place) =>
    maps.some((other) => other.id === place.id && other.key !== place.key)
      ? place.id + ':' + place.key
      : place.id;
  const destination = (name, candidates, evidence, purpose = 'objective') => ({
    name,
    id: candidates.length === 1 ? entityId(candidates[0]) : null,
    mapKeys: candidates.map((place) => place.key),
    mentions: [...phrases].filter(([, targets]) => targets.includes(name)).map(([phrase]) => phrase),
    evidence,
    purpose,
  });
  function places(task, people, clauses) {
    const found = [];
    for (const clause of clauses) {
      const occurrences = [];
      for (const [phrase, targets] of phrases)
        for (let start = clause.indexOf(phrase); start !== -1; start = clause.indexOf(phrase, start + 1))
          occurrences.push({
            phrase,
            name: targets.length === 1 ? targets[0] : phrase,
            candidates: targets.flatMap((name) => names.get(name)),
            start,
            end: start + phrase.length,
          });
      const matches = occurrences
        .filter(
          (match) =>
            !occurrences.some(
              (other) =>
                other.start <= match.start &&
                other.end >= match.end &&
                other.phrase.length > match.phrase.length,
            ),
        )
        .sort((a, b) => a.start - b.start);
      for (const match of matches) {
        if (objectiveGuide[task.gameId]?.nonDestinationPlaces?.includes(match.name)) continue;
        const generic = isGenericPlaceName;
        if (generic(match.name) && matches.some((other) => other.end <= match.start && !generic(other.name)))
          continue;
        const before = clause.slice(0, match.start);
        const verbs = [
          ...before.matchAll(
            /前往|到|返回|回到|回返|赶往|赶回|进入|抵达|到达|去往|前去|送回|带回|带给|交给|拜会|拜访|深入|调查|探查|探索|探寻|登上|暂留|游玩|清剿|通过|穿过|离开|往|去|回(?!复|报|答|话)|找|向|在/g,
          ),
        ];
        const verb = verbs.at(-1);
        if (!verb && !/^(?:求援|休整|休息|散心|相会|试炮|之约)/.test(clause.slice(match.end))) continue;
        if (verb && /放弃|不必|无需|不要|不再|并未|没有选择/.test(before.slice(0, verb.index))) continue;
        const between = verb ? before.slice(verb.index + verb[0].length) : '';
        // A place after "tell/report" is the subject of the conversation.
        if (/告知|告诉|汇报|回报|询问|打听/.test(between)) continue;
        const after = clause.slice(match.end);
        // An organisation can qualify a person without naming a destination.
        if (placeMentionIsQualifier(match.name, after)) continue;
        // In "前往梧桐村东边的洛村", the first village is a landmark.
        if (
          /^(?:(?:的)?(?:以)?[东西南北]{1,2}(?:边|侧|面|方|方向|部|岸|郊|角|门外|外|(?=的))|(?:城)?外的)/.test(
            after,
          ) &&
          matches.some(
            (other) =>
              other.start >= match.end &&
              !generic(other.name) &&
              !placeMentionIsQualifier(other.name, clause.slice(other.end)) &&
              !objectiveGuide[task.gameId]?.nonDestinationPlaces?.includes(other.name),
          )
        )
          continue;
        if (!found.some((place) => place.name === match.name)) {
          const purpose =
            verb?.[0] === '离开'
              ? 'departure'
              : delivery.test(clause) && !/采集|购买|搜集|寻找|收集|抓|捕捉/.test(after)
                ? 'turn-in'
                : 'objective';
          found.push(destination(match.name, match.candidates, '任务目标', purpose));
        }
      }
    }
    const interactions = (task.placements || []).filter(
      (row) =>
        row.interactionTarget &&
        people.some((person) => person.id === 'npc-' + row.npcId) &&
        maps.some((p) => p.key === row.mapKey),
    );
    for (const row of interactions) {
      const place = maps.find((p) => p.key === row.mapKey);
      const candidates = [
        ...new Set(
          interactions
            .filter((p) => maps.find((m) => m.key === p.mapKey)?.name === place.name)
            .map((p) => p.mapKey),
        ),
      ].map((key) => maps.find((m) => m.key === key));
      const current = found.find((p) => p.name === place.name || p.mapKeys.includes(place.key));
      const target = destination(place.name, candidates, '交互场景', current?.purpose);
      if (current) Object.assign(current, target);
      else found.push(target);
    }
    return found;
  }
  function template(task) {
    const guide = objectiveGuide[task.gameId];
    let title = String(guide?.instruction || task.name || '');
    const requirements = [...(guide?.actionRequirements || [])];
    for (const match of (String(task.name || '') + '\n' + (task.description || '')).matchAll(teamClause))
      for (const name of match[1]
        .split(/[、，,]/)
        .map((name) => name.trim())
        .filter(Boolean)) {
        if (
          requirements.some((requirement) => requirement.type === 'TeamMember' && requirement.name === name)
        )
          continue;
        const ids = partyIds(name);
        requirements.push(
          ids.length ? { type: 'TeamMember', ids, name } : { type: 'Context', name: `需${name}在队` },
        );
      }
    title = title.replace(teamClause, '').trim();
    for (const [mention, name] of Object.entries(guide?.replacePlaceMentions || {}))
      title = title.replaceAll(mention, name);
    const clauses = title
      .split(/[，,。；;！？!?]/)
      .filter((clause) => !/准备.*(?:明日|明天|来日)|(?:明日|明天|来日|日后|后续)(?:再|才|将)/.test(clause));
    // Request/finish bindings describe quest relations. Even a finish binding
    // can name a later recipient while this step still asks for collection.
    const configured = [
      ...new Set([
        ...(task.finishNPCs || []),
        ...(guide?.currentNPCs || []),
        ...(task.placements || [])
          .filter((p) => p.interactionTarget && Number.isSafeInteger(p.npcId) && p.npcId > 0)
          .map((p) => p.npcId),
      ]),
    ];
    const instruction = clauses.join('，');
    const materials = (task.materials || []).filter((m) => Number.isSafeInteger(m.count) && m.count > 0);
    const recipientIds = [
      ...new Set((task.finishNPCs || []).filter((id) => Number.isSafeInteger(id) && id > 0)),
    ];
    // These item counts are projected from FinishingRequirements. A positive
    // FinishNPC binding is the completion interaction, even if the title only
    // describes collecting. Withdraw it until this reading's materials are ready.
    const needsMaterials = materials.length > 0 && (recipientIds.length > 0 || delivery.test(instruction));
    const finishAction = delivery.test(instruction + '，' + (task.description || '')) ? '交付' : '交谈';
    const personFor = (id) => ({
      id: 'npc-' + id,
      name: world.people?.find((p) => p.gameId === id)?.name || world.npcNames?.[id] || `人物 #${id}`,
      role: delivery.test(instruction) ? '交付' : '交互',
    });
    const completionInteraction =
      !acquisition.test(instruction) &&
      !/赶走|清剿|铲除|剿灭|擒|战胜|击退|驱逐|讨伐|消灭|挑战/.test(instruction) &&
      (delivery.test(instruction) || /交谈|对话|回复|复命|回报|禀告|告知|告诉|询问/.test(instruction));
    const named = configured
      .filter((id) => Number.isSafeInteger(id) && id > 0)
      .map(personFor)
      .filter(
        (person) =>
          (completionInteraction && recipientIds.includes(Number(person.id.slice(4)))) ||
          person.name.split(/[-·]/).some((name) => {
            if (name.length < 2) return false;
            for (const clause of clauses)
              for (let at = clause.indexOf(name); at !== -1; at = clause.indexOf(name, at + 1)) {
                const before = clause.slice(0, at),
                  after = clause.slice(at + name.length);
                if (/属于\s*$/.test(before) || (/^的/.test(after) && acquisition.test(before))) continue;
                if (/(?:帮|替|为|给)\s*$/.test(before) && /寻找|找寻|找回|收集|搜集|买/.test(after)) continue;
                if (!/^(?:的)?(?:货物|包裹|行李|物品|材料|私物|消息|下落|踪迹)/.test(after)) return true;
              }
            return false;
          }),
      );
    // A combined step can name its recipient only after a fight or search.
    // Keep that literal order without guessing whether the first action is done.
    if (!needsMaterials)
      for (const person of named) {
        const reportAt = clauses.findIndex(
          (clause) =>
            /^(?:然后|之后|后再|再).*(?:回复|复命|回报|禀告|告知|告诉|汇报)/.test(clause) &&
            person.name.split(/[-·]/).some((name) => name.length > 1 && clause.includes(name)),
        );
        if (reportAt > 0) {
          const beforeReport = clauses.slice(0, reportAt).join('，');
          if (/击杀|击败|战胜|击退|赶走|清剿|铲除|剿灭|驱逐|讨伐|消灭/.test(beforeReport))
            person.role = '战斗后回报';
          else if (/排查/.test(beforeReport)) person.role = '排查后回报';
        }
      }
    const byName = new Map();
    const candidates = needsMaterials
      ? [
          ...named.filter((p) => !recipientIds.includes(Number(p.id.slice(4)))),
          ...recipientIds.map((id) => ({ ...personFor(id), role: finishAction })),
        ]
      : named;
    for (const person of candidates) {
      const id = Number(person.id.slice(4));
      const current = byName.get(person.name);
      if (current) {
        current.id = null;
        current.ids.push(id);
      } else
        byName.set(person.name, {
          ...person,
          ids: [id],
          mentions: [person.name, person.name.split('-').at(-1)],
        });
    }
    const people = [...byName.values()];
    const currentIds = named.map((person) => Number(person.id.slice(4)));
    const targets = places(
      task,
      needsMaterials ? named.filter((p) => !recipientIds.includes(Number(p.id.slice(4)))) : named,
      clauses,
    );
    for (const place of guide?.objectivePlaces || [])
      if (names.has(place.name)) {
        const existing = targets.find((target) => target.name === place.name);
        if (existing) {
          if (place.hint) existing.hint = place.hint;
        } else
          targets.push({
            ...destination(place.name, names.get(place.name), '任务行动线索'),
            hint: place.hint,
          });
      }
    if (
      targets.length === 1 &&
      targets[0].purpose === 'objective' &&
      people.length === 1 &&
      people[0].role === '交付' &&
      !acquisition.test(instruction)
    )
      targets[0].purpose = 'turn-in';
    for (const target of targets)
      target.personIds = [
        ...new Set([
          ...(target.purpose === 'turn-in' && targets.length === 1 && currentIds.length === 1
            ? currentIds
            : []),
          ...(task.placements || [])
            .filter(
              (p) =>
                p.interactionTarget &&
                currentIds.includes(p.npcId) &&
                target.mapKeys.includes(p.mapKey) &&
                Number.isSafeInteger(p.npcId) &&
                p.npcId > 0,
            )
            .map((p) => p.npcId),
        ]),
      ];
    const collecting = acquisition.test(instruction);
    const collectionPlaces = [];
    const addSource = (place, ids) => {
      const existing = collectionPlaces.find((p) => p.name === place.name);
      if (existing) existing.materialIds = [...new Set([...existing.materialIds, ...ids])];
      else collectionPlaces.push({ ...place, purpose: 'material-source', personIds: [], materialIds: ids });
    };
    if (materials.length) {
      if (collecting)
        for (const place of targets.filter((p) => p.purpose === 'objective'))
          addSource(
            place,
            materials.map((m) => m.id),
          );
      for (const source of guide?.collectionPlaces || [])
        if (names.has(source.name))
          addSource(
            { ...destination(source.name, names.get(source.name), '任务获取地点'), hint: source.hint },
            source.materialIds,
          );
      for (const material of needsMaterials || collecting ? materials : [])
        for (const name of objectiveGuide.materialSources?.[material.id] || [])
          if (names.has(name))
            addSource(destination(name, names.get(name), '物品资料获取线索'), [material.id]);
      for (const material of needsMaterials || collecting ? materials : [])
        for (const route of materialItems[material.id]?.routes || []) {
          const place = maps.find((p) => p.id === route.placeId);
          if (!place) continue;
          addSource(destination(place.name, names.get(place.name), '材料获取线索'), [material.id]);
        }
      const bindings = (needsMaterials ? task.placements || [] : []).filter(
        (p) =>
          p.phase === 'finish' &&
          p.interactionTarget &&
          recipientIds.includes(p.npcId) &&
          maps.some((m) => m.key === p.mapKey),
      );
      for (const name of new Set(bindings.map((p) => maps.find((m) => m.key === p.mapKey).name))) {
        const rows = bindings.filter((p) => maps.find((m) => m.key === p.mapKey).name === name);
        const candidates = maps.filter((p) => rows.some((row) => row.mapKey === p.key));
        if (!targets.some((p) => p.purpose === 'turn-in' && p.name === name))
          targets.push({
            ...destination(name, candidates, '完成交互场景', 'turn-in'),
            personIds: [...new Set(rows.map((p) => p.npcId))],
          });
      }
      for (const name of guide?.turnInPlaces || [])
        if (
          names.has(name) &&
          !targets.some((target) => target.purpose === 'turn-in' && target.name === name)
        )
          targets.push({
            ...destination(name, names.get(name), '任务交付线索', 'turn-in'),
            personIds: recipientIds,
          });
    }
    const handInAt = clauses.findIndex((clause) => delivery.test(clause));
    const collectionPrefix = (handInAt < 0 ? clauses : clauses.slice(0, handInAt)).join('，');
    const collectionAction = collecting && collectionPrefix ? collectionPrefix : '';
    const readyAction = handInAt < 0 ? '' : clauses.slice(handInAt).join('，');
    return {
      questId: task.gameId,
      people,
      instruction: !task.parentId && parents.has(task.gameId) ? '下一步未识别，请查看游戏任务栏。' : title,
      actionRequirements: requirements,
      ...(task.finishingRequirements?.length ? { finishingRequirements: task.finishingRequirements } : {}),
      ...(task.finishingRequirements?.some((row) => ['KillMonster', 'KillMonsterAggre'].includes(row.type))
        ? { counterGate: { recipients: recipientIds.map((id) => ({ ...personFor(id), ids: [id] })) } }
        : {}),
      ...(recipientIds.length && task.finishingRequirements?.some((row) => row.type === 'AggregationItem')
        ? { alternativeHandIn: { recipientIds, action: finishAction } }
        : {}),
      ...(guide?.nonDestinationPlaces ? { nonDestinationPlaces: guide.nonDestinationPlaces } : {}),
      ...(guide?.literalNames ? { literalNames: guide.literalNames } : {}),
      materialHints: guide?.collectionHints || [],
      places: guide?.deferDestinations
        ? []
        : needsMaterials
          ? targets
          : [
              ...targets,
              ...collectionPlaces.filter((source) => !targets.some((target) => target.name === source.name)),
            ],
      ...(guide?.deferDestinations ? { deferredPlaces: targets } : {}),
      ...(title !== task.name ? { nextAction: title } : {}),
      ...(needsMaterials
        ? {
            materialGate: {
              materials,
              collecting,
              collectionPlaces,
              recipientIds,
              action: finishAction,
              collectionAction,
              readyAction,
            },
          }
        : {}),
      purpose:
        targets.length && targets.every((place) => place.purpose === targets[0].purpose)
          ? targets[0].purpose
          : 'objective',
    };
  }
  return { template, project: (task, reading) => resolveTaskObjectives(template(task), reading) };
}
module.exports = { createTaskTargetProjector };
