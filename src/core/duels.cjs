'use strict';
const { createDuelReadiness } = require('./duel-readiness.cjs');

// Curated challenge leads describe a story window, never a live NPC presence or
// a victory prediction. Missing saved conditions remain unknown.
function createDuelProjector({ guide, world, game }) {
  const people = new Map(
    [...game.entries, ...world.people].filter((row) => row.kind === '人物').map((row) => [row.gameId, row]),
  );
  const quests = new Map(world.quests.map((row) => [row.gameId, row]));
  const readiness = createDuelReadiness(game, world);
  const taskName = (id) => String(quests.get(id)?.name || `剧情记录 #${id}`).replace(/^【[^】]+】\s*/, '');
  return function project({ available, states, mainQuestId, difficultyName = '', combat = null }) {
    const saved = new Map((available ? states : []).map((row) => [row.id, row.step]));
    const rows = (guide.duels || []).map((entry) => {
      const person = people.get(entry.npcId);
      const conditions = (entry.afterAllComplete || []).map((id) => ({
        id: `quest-${id}`,
        name: taskName(id),
        status: saved.get(id) === 4 ? 'met' : saved.has(id) ? 'unmet' : 'unknown',
      }));
      const closed =
        (entry.untilAnyStarted || []).some((id) => [1, 2, 4].includes(saved.get(id))) ||
        (entry.untilAnyComplete || []).some((id) => saved.get(id) === 4);
      const stageMatch = !!mainQuestId && (entry.chapterRoots || []).includes(mainQuestId);
      return {
        ...entry,
        name: entry.name || person?.name || '人物待核对',
        personId: person ? person.id : null,
        conditions,
        closed,
        stageMatch,
        current: available && stageMatch && !closed && !conditions.some((row) => row.status === 'unmet'),
        confidence: conditions.some((row) => row.status === 'unknown')
          ? '阶段匹配 · 前置仍待核对'
          : '阶段线索 · 到场核对',
        readiness: readiness(entry, available ? combat : null),
        sources: (entry.sourceIds || [])
          .filter((id) => guide.sources[id])
          .map((id) => ({ ...guide.sources[id], id: 'flow:' + id })),
      };
    });
    return {
      available,
      difficultyName,
      candidates: rows.filter((row) => row.current),
      guide: rows,
      reason: !available
        ? '尚未对照可读存档；下方可以查全部已整理的比武资料。'
        : !mainQuestId
          ? '当前主线阶段待核对；暂不猜测哪些人物现在可挑战。'
          : '按已保存的主线阶段整理候选；人物是否仍在场、好感和私物请到游戏中核对。',
      combatLimit:
        '按最近一次存档核对角色准备，不读取实时战斗面板，也未模拟战斗；静态等级不能直接换算胜率。具体修炼目标是准备建议，须再核对游戏中的交互条件。',
    };
  };
}

module.exports = { createDuelProjector };
