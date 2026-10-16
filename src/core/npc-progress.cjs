'use strict';
const { currentNpcPower } = require('./npc-power.cjs');

// Compare complete saved NPC records, never initial item pools. A missing
// record is unknown; an explicitly empty private bag is a completed collection.
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

function createNpcProgressProjector({ world, game, contracts = {}, guide = {} }) {
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
    const inventory = Array.isArray(metadata.inventory)
      ? new Map(metadata.inventory.map((row) => [row.id, row.count]))
      : null;
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
      if (type === 'None') return { ...result, status: 'met', text: '' };
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
          status: Number.isFinite(metadata.money) ? (metadata.money >= value ? 'met' : 'unmet') : 'unknown',
          text: `铜钱 ${value}`,
        };
      return { ...result, text: raw.name || `${type} ${id} / ${value}` };
    }
    const evaluate = (rows) => (rows || []).map(requirement).filter((row) => row.text);
    function vigorCheck(normal = 60, reduced = 30) {
      const value = player.attributes?.[44];
      // The native UI needs 60, or 30 with a particular talent. Until the
      // talent's saved ownership is proved, the middle range stays conditional.
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
              ? `精力 ${Math.floor(value)}，需 ${normal}；相关天赋可降至 ${reduced}`
              : '精力充足',
      };
    }
    function friendship(person, saved) {
      for (const lock of person.friendshipLocks || []) {
        const checks = evaluate(lock.requirements);
        const status = mergeStatus(checks);
        if (status !== 'met')
          return {
            raw: saved.rawFriendliness,
            value: status === 'unmet' ? Math.min(saved.rawFriendliness, lock.at) : null,
            cap: status === 'unmet' ? lock.at : null,
            possibleCap: lock.at,
            checks,
            status,
          };
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
      if (!person.functions?.includes(kind))
        checks.push({
          status: 'unmet',
          text: `暂无常规${{ Compare: '比武', Consult: '请教', Gift: '赠礼' }[kind]}入口`,
        });
      if (kind === 'Compare')
        checks.push(...evaluate(contracts.people?.[person.gameId]?.compareRequirements));
      const threshold = contracts.friendlyLimits?.[kind];
      if (kind === 'Compare' && contracts.compare?.basis === 'raw') {
        checks.push({
          status: friendship.raw >= threshold ? 'met' : 'unmet',
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
        checks.push(
          { status: 'unmet', text: `好感暂时上限 ${friendship.cap}，先解锁剧情` },
          ...friendship.checks,
        );
      if (kind === 'Gift') {
        if (friendship.value !== null && friendship.value >= 100)
          checks.push({ status: 'unmet', text: '好感已满，无需继续送礼' });
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
            f <= -80
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
          minimumQuality = ['白', '绿', '蓝', '金', '暗金'][Math.abs(rank)];
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
      for (const item of saved.inventory) totals.set(item.id, (totals.get(item.id) || 0) + item.count);
      const remainingItems = [...totals]
        .map(([id, count]) => ({ id, count }))
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
      const learning = [];
      for (const [attribute, name] of lifeAttributes) {
        const teacherLevel = saved.attributes?.[attribute];
        const playerLevel = player.attributes?.[attribute];
        if (
          !Number.isFinite(teacherLevel) ||
          !Number.isFinite(playerLevel) ||
          teacherLevel < 1 ||
          playerLevel < 0 ||
          teacherLevel <= playerLevel
        )
          continue;
        const threshold = 10 * Math.trunc(teacherLevel);
        const checks = [...consult.checks, ...affinityChecks(friend, threshold), vigorCheck()];
        learning.push({
          kind: 'life',
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
        const setting = contracts.skills?.[skill.id];
        if (!entry) continue;
        if (setting?.excluded || setting?.openForPlayer === false) continue;
        const checks = [...consult.checks, vigorCheck()];
        const threshold = setting?.friendliness;
        if (Number.isFinite(threshold)) checks.push(...affinityChecks(friend, threshold));
        else checks.push({ status: 'unknown', text: '功法请教条件待确认' });
        checks.push(...evaluate(setting?.requirements));
        const baseCost = Number.isFinite(setting?.skillPointCost)
          ? Math.abs(Math.trunc(setting.skillPointCost))
          : null;
        if (baseCost !== null)
          checks.push({
            status: Number.isFinite(player.skillPoints) && player.skillPoints >= baseCost ? 'met' : 'unknown',
            text: `武学点${Number.isFinite(player.skillPoints) ? ` ${player.skillPoints}` : '待确认'}，基础消耗 ${baseCost}（门派、难度或天赋可减免）`,
          });
        learning.push({
          kind: 'martial',
          id: skill.id,
          entityId: entry?.id || null,
          name: entry?.name || `武学 #${skill.id}`,
          teacherLevel: skill.level,
          threshold: threshold ?? null,
          status: mergeStatus(checks),
          checks,
        });
      }
      const place = maps.get(saved.mapKey);
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
        importantCount: remainingItems.filter((row) => row.important).length,
        collection: remainingItems.length ? 'remaining' : 'cleared',
        learning,
      });
    }
    rows.sort(
      (a, b) =>
        Number(b.samePlace) - Number(a.samePlace) ||
        b.importantCount - a.importantCount ||
        a.name.localeCompare(b.name, 'zh-CN'),
    );
    return {
      available: true,
      origin: combat.origin === 'live' ? 'live' : 'saved',
      people: rows,
      remaining: rows.filter((row) => row.remainingItems.length && row.compare.status !== 'unmet'),
      learning: rows.filter((row) => row.learning.some((item) => item.status !== 'unmet')),
      locked: rows.filter(
        (row) =>
          (row.remainingItems.length && row.compare.status === 'unmet') ||
          (row.remainingItems.length &&
            Number.isFinite(row.friendship.cap) &&
            row.friendship.cap < 100 &&
            row.gift.status === 'unmet') ||
          (row.remainingItems.length && row.visible === false) ||
          row.learning.some((item) => item.status === 'unmet'),
      ),
      cleared: rows.filter((row) => !row.remainingItems.length),
    };
  };
}

module.exports = { createNpcProgressProjector };
