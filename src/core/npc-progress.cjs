'use strict';
const { currentNpcPower } = require('./npc-power.cjs');
const { martialConsultation, defaultConsultationExcludedRows } = require('../shared/martial-consultation.mjs');

// Compare saved NPC records, never initial item pools. A missing record is
// unknown; an empty eligible list does not prove all private items are gone.
const lifeAttributes = [
  [27, '锻造'],
  [48, '制衣'],
  [61, '钓鱼'],
  [63, '烹饪'],
  [65, '炼丹'],
  [67, '采集'],
];
const mergeStatus = (checks) =>
  checks.some((row) => row.status === 'unmet')
    ? 'unmet'
    : checks.some((row) => row.status === 'unknown')
      ? 'unknown'
      : 'met';

function createNpcProgressProjector({ world, game, itemStats = {}, contracts = {}, guide = {}, extraSkillClues = {} }) {
  const people = new Map(world.people.map((row) => [row.gameId, row]));
  const entries = new Map(game.entries.map((row) => [row.id, row]));
  const quests = new Map(world.quests.map((row) => [row.gameId, row]));
  const maps = new Map(world.maps.map((row) => [row.key, row]));
  const importantRewards = new Set(
    (guide.duels || []).flatMap((row) => (row.rewards || []).map((item) => item.itemId)),
  );
  return function project(metadata = {}) {
    const combat = metadata.combat;
    const known =
      (combat?.format === 14 || combat?.origin === 'live') &&
      Array.isArray(combat.npcStates) &&
      combat.player;
    if (!known) return { available: false, people: [], remaining: [], learning: [], locked: [], cleared: [] };
    const npcStates = new Map(combat.npcStates.map((row) => [row.id, row]));
    const states = Array.isArray(metadata.questStates || metadata.quests)
      ? new Map((metadata.questStates || metadata.quests).map((row) => [row.id, row.step]))
      : null;
    const player = combat.player;
    const ownPower = combat.origin === 'live' ? currentNpcPower(player.attributes) : null;
    const learned = new Set(player.skills.map((row) => row.id));
    const inventory = Array.isArray(metadata.inventory) ? new Map() : null;
    for (const item of inventory ? metadata.inventory : [])
      inventory.set(item.id, (inventory.get(item.id) || 0) + item.count);
    function requirement(raw) {
      const type =
        raw.type ||
        String(raw.Type || '')
          .split('::')
          .pop();
      const id = raw.id ?? raw.Id;
      const value = raw.value ?? raw.Num;
      const quest = quests.get(id);
      const linkedQuest = quest || quests.get(raw.relatedQuestId);
      const name = raw.name || quest?.name || `任务 #${id}`;
      const result = { type, id, value, name, status: 'unknown' };
      // An explicit None entry is not an empty array. The recovered default
      // evaluator returns false; callers or overrides may differ.
      if (type === 'None') return { ...result, status: 'unknown', text: '条件待确认' };
      if (type === 'PreQuest') {
        // The native GetQuestStep returns 0 for a missing key. This default is
        // valid only when the complete quest collection was parsed successfully.
        const step = states ? (states.get(id) ?? 0) : undefined;
        const completedOwner =
          !quest && raw.relatedQuestId !== id && states?.get(raw.relatedQuestId) === 4 && step !== value;
        return {
          ...result,
          status: step === undefined ? 'unknown' : step === value ? 'met' : 'unmet',
          text: `${name.replace(/^【[^】]+】\s*/, '')}：${completedOwner && value === 4 ? '相关步骤尚未完成' : value === 4 ? '完成后解锁' : '需要状态 ' + value}`,
          entityId: linkedQuest?.id || null,
        };
      }
      if (type === 'NoQuest')
        return {
          ...result,
          status: states ? (states.has(id) ? 'unmet' : 'met') : 'unknown',
          text: `${name.replace(/^【[^】]+】\s*/, '')}：尚未触发`,
          entityId: linkedQuest?.id || null,
        };
      if (type === 'Item') {
        const item = entries.get('item-' + id);
        return {
          ...result,
          name: item?.name || `物品 #${id}`,
          entityId: item?.id,
          status: inventory ? ((inventory.get(id) || 0) >= value ? 'met' : 'unmet') : 'unknown',
          text: `${item?.name || `物品 #${id}`} ×${value}`,
        };
      }
      if (type === 'Money')
        return {
          ...result,
          // The native Money requirement compares the float32 balance strictly
          // above the float32 threshold; it is not a payment affordability check.
          status: Number.isFinite(metadata.money) && Number.isFinite(value)
            ? (Math.fround(metadata.money) > Math.fround(value) ? 'met' : 'unmet')
            : 'unknown',
          text: Number.isFinite(value) ? `铜钱超过 ${value}` : '铜钱条件待确认',
        };
      return { ...result, text: raw.name || `${type} ${id} / ${value}` };
    }
    const evaluate = (rows) => (rows || []).map(requirement).filter((row) => row.text);
    function guildFreeConsultation(person, setting) {
      const rule = contracts.martialCost?.guildFree;
      if (
        !states ||
        !rule ||
        !Number.isSafeInteger(rule.targetGuildId) ||
        contracts.people?.[person.gameId]?.guildId !== rule.targetGuildId ||
        rule.completedQuestStep !== 4 ||
        rule.initialMaxQuality !== 0 ||
        !Array.isArray(rule.sequence) ||
        !Number.isInteger(setting?.grade) ||
        setting.grade < 1 ||
        setting.grade > 6
      )
        return false;
      // Native cost uses the target NPC's guild and stops at the first quest
      // outside step 4. Later promotions cannot fill a gap in this prefix.
      let maxQuality = rule.initialMaxQuality;
      for (const unlock of rule.sequence) {
        if (
          !Number.isSafeInteger(unlock.questId) ||
          unlock.questId <= 0 ||
          !Number.isInteger(unlock.maxQuality) ||
          unlock.maxQuality <= maxQuality ||
          unlock.maxQuality > 6
        )
          return false;
        if (states.get(unlock.questId) !== rule.completedQuestStep) break;
        maxQuality = unlock.maxQuality;
      }
      return setting.grade <= maxQuality;
    }
    function vigorCheck(normal = 60, reduced = 30) {
      // Saved attributes are base values, not the native current energy.
      const value = combat.origin === 'live' ? player.attributes?.[44] : undefined;
      // The extra-difficulty option 精力旺盛 halves energy costs. Its current
      // selection is not read here, so the middle range stays conditional.
      return {
        status: !Number.isFinite(value)
          ? 'unknown'
          : value >= normal
            ? 'met'
            : value < reduced
              ? 'unmet'
              : 'unknown',
        text: !Number.isFinite(value)
          ? '精力待确认'
          : value < reduced
            ? `精力不足（当前 ${Math.floor(value)}，至少 ${reduced}）`
            : value < normal
              ? `精力 ${Math.floor(value)}，需 ${normal}；精力旺盛时需 ${reduced}`
              : '精力充足',
      };
    }
    function friendship(person, saved) {
      const locks = person.friendshipLocks || [];
      for (const [index, lock] of locks.entries()) {
        const checks = evaluate(lock.requirements);
        const status = mergeStatus(checks);
        if (status !== 'met') {
          // An unknown first failure may defer to any later lock or the default
          // cap. The effective value is still known if none can lower raw.
          let rawUnaffected = status === 'unknown' &&
            Number.isFinite(saved.rawFriendliness) && saved.rawFriendliness <= 100;
          let possibleCapReached = false;
          if (status === 'unknown' && Number.isFinite(saved.rawFriendliness)) {
            for (const [offset, candidate] of locks.slice(index).entries()) {
              const candidateStatus = offset === 0 ? status : mergeStatus(evaluate(candidate.requirements));
              if (candidateStatus !== 'met' &&
                  (!Number.isFinite(candidate.at) || candidate.at < saved.rawFriendliness))
                rawUnaffected = false;
              if (candidateStatus !== 'met' && Number.isFinite(candidate.at) &&
                  candidate.at < 100 && saved.rawFriendliness >= candidate.at)
                possibleCapReached = true;
              if (candidateStatus === 'unmet') break;
            }
          }
          return {
            raw: saved.rawFriendliness,
            value: status === 'unmet' ? Math.min(saved.rawFriendliness, lock.at) : rawUnaffected ? saved.rawFriendliness : null,
            cap: status === 'unmet' ? lock.at : null,
            possibleCap: lock.at,
            possibleCapReached,
            checks,
            status,
          };
        }
      }
      return {
        raw: saved.rawFriendliness,
        value: saved.rawFriendliness,
        cap: 100,
        checks: [],
        status: 'met',
      };
    }
    function affinityChecks(friendship, threshold) {
      if (!Number.isFinite(threshold) || threshold <= 0) return [];
      const status =
        friendship.raw < threshold
          ? 'unmet'
          : friendship.value === null
            ? 'unknown'
            : friendship.value >= threshold
              ? 'met'
              : 'unmet';
      const checks = [
        {
          status,
          showWhenMet: true,
          text: `好感 ${threshold}${friendship.value === null ? '（剧情上限待确认）' : `（当前 ${friendship.value}）`}`,
        },
      ];
      if (status !== 'met' && (friendship.cap ?? friendship.possibleCap) < threshold)
        checks.push(...friendship.checks);
      return checks;
    }
    function gate(person, saved, friendship, kind) {
      const checks = [];
      let minimumQuality = null;
      const declaredEntry = person.functions?.includes(kind);
      checks.push({
        status: 'unknown',
        code: declaredEntry ? 'interaction-unverified' : 'interaction-not-declared',
        text: declaredEntry
          ? '当前入口待确认'
          : '固定资料无常规入口，当前情况待确认',
      });
      if (kind === 'Compare')
        checks.push(...evaluate(contracts.people?.[person.gameId]?.compareRequirements));
      const threshold = contracts.friendlyLimits?.[kind];
      if (kind === 'Compare' && contracts.compare?.basis === 'raw') {
        checks.push({
          status: friendship.raw >= threshold ? 'met' : 'unmet',
          showWhenMet: true,
          text: `比武好感 ${threshold}（当前 ${friendship.raw}）`,
        });
        checks.push(vigorCheck(contracts.compare.vigor, contracts.compare.talentVigor));
      } else checks.push(...affinityChecks(friendship, threshold));
      if (kind === 'Compare' && !Number.isFinite(threshold))
        checks.push({ status: 'unknown', text: '比武好感门槛待确认' });
      if (
        kind === 'Gift' &&
        friendship.cap !== null &&
        friendship.raw >= friendship.cap &&
        friendship.cap < 100
      )
        checks.push({
          status: 'unknown',
          code: 'friendship-cap',
          text: `已达到剧情好感上限 ${friendship.cap}，赠礼情况待确认`,
        });
      if (kind === 'Gift' && friendship.cap === null && friendship.possibleCapReached)
        checks.push({ status: 'unknown', code: 'friendship-cap', text: '可能已达到剧情好感上限，赠礼情况待确认' });
      if (kind === 'Gift') {
        if (friendship.value !== null && friendship.value >= 100)
          checks.push({ status: 'unmet', text: '好感已满，常规赠礼受限' });
        const targetPower = combat.origin === 'live' ? currentNpcPower(saved.attributes) : null;
        checks.push(
          ownPower && targetPower
            ? {
                status: targetPower.level - ownPower.level >= 2 ? 'unmet' : 'met',
                text: `赠礼境界：你${ownPower.title}，对方${targetPower.title}${targetPower.level - ownPower.level >= 2 ? '，相差两阶以上，先提升战力' : ''}`,
              }
            : { status: 'unknown', text: '赠礼境界待确认：对方高出你两阶时不可送礼' },
        );
        if (friendship.value !== null) {
          const f = friendship.value;
          const rank =
            f <= -100
              ? -5
              : f <= -80
                ? -4
                : f <= -60
                  ? -3
                  : f <= -40
                    ? -2
                    : f <= -20
                      ? -1
                      : f < 20
                        ? 0
                        : f < 40
                          ? 1
                          : f < 60
                            ? 2
                            : f < 80
                              ? 3
                              : 4;
          minimumQuality = ['白', '绿', '蓝', '金', '暗金', '红'][Math.abs(rank)];
          checks.push({
            status: 'met',
            text: `礼物至少${minimumQuality}色品质`,
          });
        }
      }
      if (saved.visible === false) checks.push({ status: 'unknown', text: '地图中暂未显示此人物' });
      return { status: mergeStatus(checks), checks, ...(kind === 'Gift' ? { minimumQuality } : {}) };
    }
    const rows = [];
    for (const [id, saved] of npcStates) {
      const person = people.get(id);
      if (!person) continue;
      const friend = friendship(person, saved);
      const compare = gate(person, saved, friend, 'Compare');
      const consult = gate(person, saved, friend, 'Consult');
      const gift = gate(person, saved, friend, 'Gift');
      const totals = new Map();
      const uncertainCounts = new Set();
      for (const item of saved.inventory) {
        const definition = itemStats.items?.[item.id];
        // ItemSpecs are object slots. A non-stackable or unknown row with
        // Num > 1 does not establish that many transferable objects.
        if (item.count > 1 && definition?.cantTakeFromCompare !== true && definition?.canStack !== true) {
          uncertainCounts.add(item.id);
          continue;
        }
        totals.set(item.id, (totals.get(item.id) || 0) + item.count);
      }
      const privateItems = [...totals]
        .map(([id, count]) => ({ id, count }))
        // The native Compare reward picker excludes protected private items.
        .filter((row) => row.count > 0)
        .map((row) => {
          const item = entries.get('item-' + row.id);
          return {
            ...row,
            entityId: item?.id || null,
            name: item?.name || `物品 #${row.id}`,
            important:
              importantRewards.has(row.id) ||
              ['Recipe', 'Pill', 'QuestItem'].includes(item?.typeKey) ||
              /Book$/.test(item?.typeKey || '') ||
              ['金', '暗金', '红'].includes(item?.quality),
            owned: inventory ? inventory.get(row.id) || 0 : null,
          };
        })
        .sort((a, b) => Number(b.important) - Number(a.important) || a.id - b.id);
      const remainingItems = privateItems.filter((row) => itemStats.items?.[row.id] && !itemStats.items[row.id].cantTakeFromCompare);
      const unknownItems = privateItems.filter((row) => !itemStats.items?.[row.id]);
      for (const id of uncertainCounts) {
        let item = unknownItems.find((row) => row.id === id);
        if (!item) {
          const entry = entries.get('item-' + id);
          item = { id, count: 0, entityId: entry?.id || null, name: entry?.name || `物品 #${id}` };
          unknownItems.push(item);
        }
        item.hasUncertainStackCount = true;
      }
      // A zero-count ItemInfoSpec is still an object in the observed picker;
      // its selection and transfer cannot be inferred from the count alone.
      for (const item of saved.inventory) {
        if (item.count !== 0 || itemStats.items?.[item.id]?.cantTakeFromCompare === true) continue;
        const existing = unknownItems.find((row) => row.id === item.id);
        if (existing) {
          existing.hasZeroCount = true;
          continue;
        }
        const entry = entries.get('item-' + item.id);
        unknownItems.push({
          id: item.id,
          count: 0,
          entityId: entry?.id || null,
          name: entry?.name || `物品 #${item.id}`,
          hasZeroCount: true,
        });
      }
      const protectedItems = privateItems.filter((row) => itemStats.items?.[row.id]?.cantTakeFromCompare === true);
      const protectedCount = protectedItems.length;
      // The tutorial victory path bypasses ordinary private-item rolls while
      // quest 5068 is requested, even if the private bag still has items.
      const privateSelection = id !== 10047 ? { status: 'met' } : !states
        ? { status: 'unknown', text: '卫霍切磋任务状态待确认，普通比武私物挑选待核对' }
        : states.get(5068) === 1
          ? { status: 'unmet', text: '“与卫霍切磋，赢得高粱酒”进行中时，获胜不抽取普通私物' }
          : { status: 'met' };
      const learning = [];
      for (const [attribute, name] of lifeAttributes) {
        const teacherValue = saved.attributes?.[attribute];
        const playerValue = player.attributes?.[attribute];
        if (!Number.isFinite(teacherValue) || !Number.isFinite(playerValue)) continue;
        // The native dialog compares truncated levels and permits equality.
        // JiYiLevelExpConfigs ends at 10; recommendations cover training below
        // that configured limit, without claiming a benefit for 10/10 visits.
        const teacherLevel = Math.trunc(teacherValue);
        const playerLevel = Math.trunc(playerValue);
        if (teacherLevel < 1 || playerLevel < 0 || playerLevel >= 10 || teacherLevel < playerLevel) continue;
        const threshold = 10 * teacherLevel;
        const checks = [...consult.checks, ...(combat.origin === 'live' ? affinityChecks(friend, threshold) : []), vigorCheck()];
        if (combat.origin !== 'live')
          checks.push({ status: 'unknown', text: '存档基础等级仅供筛选，当前等级和请教资格待确认' });
        // The native confirmation can re-read the teacher's fractional level
        // and use it for a stricter affinity check. Its dynamic branch is unknown.
        const confirmationThreshold = Math.fround(Math.fround(teacherValue) * 10);
        if (combat.origin === 'live' && Number.isFinite(friend.value) && confirmationThreshold > threshold &&
            friend.value >= threshold && friend.value < confirmationThreshold)
          checks.push({ status: 'unknown', text: '确认时的好感要求待核对' });
        learning.push({
          kind: 'life',
          ...(combat.origin === 'live' ? {} : { levelSource: 'saved-base' }),
          name,
          teacherLevel,
          playerLevel,
          threshold,
          status: mergeStatus(checks),
          checks,
        });
      }
      for (const skill of saved.skills) {
        if (learned.has(skill.id)) continue;
        const entry = entries.get('skill-' + skill.id);
        const clue = (extraSkillClues.people?.[id] || []).find((row) => row.id === skill.id);
        const setting = contracts.skills?.[skill.id];
        // The observed default consultation path does not establish this
        // flag as a hard gate for these skills. Preserve them as uncertain.
        const uncertainOpen = setting?.openForPlayer === false;
        if (setting?.excluded) continue;
        const consultation = martialConsultation(
          setting?.grade,
          metadata.difficulty,
          contracts.martialConsultation,
        );
        const checks = [...consult.checks, vigorCheck()];
        if (!entry)
          checks.push({
            status: 'unknown',
            text: defaultConsultationExcludedRows.has(skill.id)
              ? '默认请教列表通常不显示，其他方式待确认'
              : clue ? '武学详情未收录，请教资格待确认' : '武学资料未收录，请教资格待确认',
          });
        if (uncertainOpen)
          checks.push({ status: 'unknown', text: `${entry?.name || '该武学'}的请教资格待确认` });
        if (combat.origin !== 'live')
          checks.push({ status: 'unknown', text: '存档武学仅供筛选，当前武学及请教资格待确认' });
        const threshold = setting?.friendliness;
        if (Number.isFinite(threshold)) checks.push(...affinityChecks(friend, threshold));
        else checks.push({ status: 'unknown', text: '功法请教条件待确认' });
        checks.push(...evaluate(setting?.requirements));
        const baseCost = Number.isFinite(setting?.skillPointCost)
          ? Math.abs(Math.trunc(setting.skillPointCost))
          : null;
        if (guildFreeConsultation(person, setting)) {
          checks.push({
            status: 'met',
            showWhenMet: true,
            text: '武学点消耗 0（门派免费请教）',
          });
          if (!Number.isFinite(player.skillPoints) || player.skillPoints < 0)
            checks.push({
              status: Number.isFinite(player.skillPoints) ? 'unmet' : 'unknown',
              text: Number.isFinite(player.skillPoints) ? '当前武学点不足' : '当前武学点待确认',
            });
        } else if (baseCost !== null)
          checks.push({
            status: Number.isFinite(player.skillPoints) && player.skillPoints >= baseCost ? 'met' : 'unknown',
            showWhenMet: true,
            text: `武学点${Number.isFinite(player.skillPoints) ? ` ${player.skillPoints}` : '待确认'}，基础消耗 ${baseCost}（门派、难度或武力充裕可减免）`,
          });
        learning.push({
          kind: 'martial',
          id: skill.id,
          entityId: entry?.id || null,
          name: entry?.name || clue?.name || defaultConsultationExcludedRows.get(skill.id) || '未收录武学',
          teacherLevel: skill.level,
          threshold: threshold ?? null,
          ...(consultation ? { consultation } : {}),
          status: mergeStatus(checks),
          checks,
        });
      }
      const place = maps.get(saved.mapKey);
      const blockedLearning = learning.find((item) => item.status === 'unmet');
      const restriction =
        remainingItems.length && privateSelection.status !== 'met'
          ? { operation: '私物挑选', status: privateSelection.status, checks: [privateSelection] }
          : remainingItems.length && compare.status === 'unmet'
          ? { operation: '比武', ...compare }
          : remainingItems.length &&
              Number.isFinite(friend.cap) &&
              friend.cap < 100 &&
              gift.status === 'unmet'
            ? { operation: '赠礼', ...gift }
            : blockedLearning
              ? { operation: '请教', status: blockedLearning.status, checks: blockedLearning.checks }
              : remainingItems.length && saved.visible === false
                ? {
                    operation: '位置',
                    status: 'unknown',
                    checks: [{ status: 'unknown', text: '地图中暂未显示此人物' }],
                  }
                : null;
      rows.push({
        id: person.id,
        npcId: id,
        name: person.name,
        level: saved.level,
        power: combat.origin === 'live' ? currentNpcPower(saved.attributes) : null,
        ownPower,
        place: place ? { id: place.id, name: place.name } : null,
        samePlace: !!saved.mapKey && saved.mapKey === metadata.map,
        visible: saved.visible,
        friendship: friend,
        compare,
        consult,
        gift,
        remainingItems,
        unknownItems,
        protectedItems,
        protectedCount,
        privateSelection,
        importantCount: remainingItems.filter((row) => row.important).length,
        collection: remainingItems.length ? 'remaining' : unknownItems.length ? 'unknown' : 'cleared',
        learning,
        lifeCandidatesIncomplete: combat.origin !== 'live',
        restriction,
      });
    }
    rows.sort(
      (a, b) =>
        Number(b.samePlace) - Number(a.samePlace) ||
        b.importantCount - a.importantCount ||
        a.name.localeCompare(b.name, 'zh-CN'),
    );
    const actionableFirst = (kind) => (a, b) => {
      const knownConditionsMet = (gate) => {
        const checks = gate?.checks || [];
        return checks.some((check) => check.status === 'met') &&
          checks.every((check) => check.status === 'met' ||
            (check.status === 'unknown' && check.code === 'interaction-unverified'));
      };
      const ready = (row) =>
        kind === 'learning'
          ? row.learning.some(knownConditionsMet)
          : knownConditionsMet(row.compare);
      const missing = (row) => row.remainingItems.filter((item) => item.important && item.owned === 0).length;
      return (
        Number(ready(b)) - Number(ready(a)) ||
        Number(b.samePlace) - Number(a.samePlace) ||
        missing(b) - missing(a) ||
        b.importantCount - a.importantCount ||
        a.name.localeCompare(b.name, 'zh-CN')
      );
    };
    return {
      available: true,
      origin: combat.origin === 'live' ? 'live' : 'saved',
      ...(contracts.martialConsultation ? { difficulty: metadata.difficulty ?? null } : {}),
      inventoryKnown: inventory !== null,
      placeKnown: !!metadata.map,
      people: rows,
      remaining: rows
        .filter((row) => row.remainingItems.length && row.compare.status !== 'unmet' && row.privateSelection.status === 'met')
        .sort(actionableFirst('remaining')),
      learning: rows
        .filter((row) => row.learning.some((item) => item.status !== 'unmet'))
        .sort(actionableFirst('learning')),
      locked: rows.filter((row) => row.restriction),
      unknown: rows.filter((row) => row.unknownItems.length),
      cleared: rows.filter((row) => !row.remainingItems.length && !row.unknownItems.length),
    };
  };
}

module.exports = { createNpcProgressProjector };
