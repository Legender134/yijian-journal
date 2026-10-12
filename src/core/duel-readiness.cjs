'use strict';

function createDuelReadiness(game, world = { people: [] }) {
  const entries = new Map(game.entries.map((row) => [row.id, row]));
  const people = new Map(world.people.map((row) => [row.gameId, row]));
  const weaponTypes = new Set(['Sword', 'Sabre', 'Spear', 'Fist', 'HiddenWeapon']);
  return function readiness(row, combat) {
    const player = combat?.format === 14 && combat.player?.id === 0 ? combat.player : null;
    const opponent = player ? combat.opponents?.find((npc) => npc.id === row.npcId) : null;
    const checks = [];
    const add = (id, label, status, detail, next) => checks.push({ id, label, status, detail, next });
    for (const [id, label, value] of [
      ['health', '气血', player?.healthRatio],
      ['mana', '内力', player?.manaRatio],
    ]) {
      const known = typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
      const full = known && value >= 0.99999;
      add(
        id,
        label,
        known ? (full ? 'met' : 'unmet') : 'unknown',
        known ? `存档${label}约 ${Math.round(value * 100)}%` : `未读到已保存的${label}比例`,
        `挑战前在游戏里休息或使用回复物品，确认${label}已回满后再保存。`,
      );
    }
    const equipment = player?.equipment?.filter((item) => item.count > 0);
    const namedEquipment = (equipment || []).map((item) => entries.get('item-' + item.id));
    const knownEquipment = Array.isArray(equipment) && namedEquipment.every(Boolean);
    const weapons = namedEquipment.filter((item) => item && weaponTypes.has(item.typeKey));
    add(
      'weapon',
      '主用兵器',
      knownEquipment ? (weapons.length ? 'met' : 'unmet') : 'unknown',
      weapons.length
        ? `存档已装备：${weapons.map((item) => item.name).join('、')}`
        : knownEquipment
          ? '存档没有识别到已装备的兵器'
          : '装备记录尚不能完整识别',
      '在人物装备页穿上主修流派的兵器，再确认常用招式的兵器要求；背包里持有不等于已装备。',
    );
    const missingArmor = ['Hat', 'Clothing', 'Shoes'].filter(
      (type) => !namedEquipment.some((item) => item?.typeKey === type),
    );
    const armorNames = { Hat: '冠帽', Clothing: '衣服', Shoes: '鞋靴' };
    add(
      'armor',
      '防具',
      knownEquipment ? (missingArmor.length ? 'unmet' : 'met') : 'unknown',
      knownEquipment
        ? missingArmor.length
          ? `存档未装备：${missingArmor.map((type) => armorNames[type]).join('、')}`
          : '存档已穿戴冠帽、衣服和鞋靴'
        : '防具记录待核对',
      '先检查人物装备页的空位；有现成防具先穿戴，再到图鉴比较数值，避免为可选切磋盲目花钱。',
    );
    const ownLevel = player?.level,
      enemyLevel = opponent?.level || row.level;
    const levelsKnown =
      Number.isInteger(ownLevel) && ownLevel > 0 && Number.isInteger(enemyLevel) && enemyLevel > 0;
    add(
      'level',
      '等级参考',
      levelsKnown ? (ownLevel < enemyLevel ? 'unmet' : 'met') : 'unknown',
      levelsKnown
        ? `存档宇文逸 ${ownLevel} 级；${opponent?.level ? '存档对手' : '静态模板'} ${enemyLevel} 级${ownLevel < enemyLevel ? `，相差 ${enemyLevel - ownLevel} 级` : ''}`
        : `玩家等级待核对${enemyLevel ? `；对手静态模板 ${enemyLevel} 级` : ''}`,
      '等级差只作保守准备参考，不是切磋门槛或胜率。先提升已学武学、检查经脉与配装，再观察对方当前面板。',
    );
    const friendship = opponent?.rawFriendliness;
    add(
      'friendship',
      '好感与交互',
      Number.isInteger(friendship) && friendship < 20 ? 'unmet' : 'unknown',
      Number.isInteger(friendship)
        ? `存档原始好感 ${friendship}${friendship < 20 ? `，距常见切磋门槛20还差 ${20 - friendship}` : '；仍须核对剧情好感锁与切磋按钮'}`
        : '未读到该人物的有效好感；到场观察互动按钮',
      row.preparationPlan?.interaction ||
        '先观察是否开放切磋。一般需有效好感20；送礼还受双方境界与剧情锁限制，按钮未开放时先看游戏给出的原因。',
    );
    for (const skill of row.preparationPlan?.skills || []) {
      const entry = entries.get('skill-' + skill.id),
        learned = player?.skills?.find((s) => s.id === skill.id);
      const level = Number.isInteger(learned?.level) && learned.level >= 0 ? learned.level : null;
      add(
        'skill-' + skill.id,
        entry?.name || `武学 #${skill.id}`,
        player ? (level !== null && level >= skill.targetLevel ? 'met' : 'unmet') : 'unknown',
        player
          ? level === null
            ? '存档未记录已学'
            : `存档修炼 ${level} 级；建议先到 ${skill.targetLevel} 级`
          : '修炼记录待核对',
        skill.next,
      );
      checks[checks.length - 1].optional = !!skill.optional;
    }
    const missing = checks.filter((check) => check.status === 'unmet' && !check.optional);
    const unknownBasic = checks.find(
      (check) =>
        check.status === 'unknown' && ['health', 'mana', 'weapon', 'armor', 'level'].includes(check.id),
    );
    const basicMissing = missing.find((check) => ['health', 'mana', 'weapon', 'armor'].includes(check.id));
    const specialMissing = checks.find((check) => check.id.startsWith('skill-') && check.status !== 'met');
    const growth =
      row.preparationPlan?.growth ||
      '先修炼已学内功、轻功与主用招式，再在当前流程中做已可完成的任务；不为可选私物硬刷高风险战斗。';
    let status = missing.length ? 'prepare' : 'verify';
    let action = basicMissing
      ? basicMissing.next
      : missing.length && specialMissing
        ? specialMissing.next
        : missing[0]?.next ||
          '基础记录未发现明显缺口；先到场观察切磋按钮、私物与招式，保留可回读存档后再小试。';
    if (!missing.length && unknownBasic) action = `${unknownBasic.label}仍待核对。${unknownBasic.next}`;
    if (!player)
      action =
        row.preparationPlan?.unknown ||
        '先核对气血／内力、已穿装备及常用武学；读不到角色记录时，按下方清单逐项准备后再决定。';
    if (row.preparationPlan?.defaultDefer && (!player || missing.some((check) => check.id === 'level'))) {
      status = 'defer';
      action = row.preparationPlan.defaultDefer;
    }
    const points = player
      ? [
          player.skillPoints > 0 ? `存档还有 ${player.skillPoints} 武学点` : '',
          player.meridianPoints > 0 ? `${player.meridianPoints} 经脉点` : '',
        ]
          .filter(Boolean)
          .join('、')
      : '';
    return {
      status,
      label: status === 'defer' ? '建议暂缓' : status === 'prepare' ? '先补准备' : '到场核对',
      action,
      reason: !player
        ? '当前参照没有可核定的角色记录，不能据对手等级判断能打。'
        : missing.length
          ? `已保存状态有 ${missing.length} 项需要准备；先补这些明确缺口，减少无效挑战。`
          : unknownBasic
            ? '部分基础记录尚不完整，先核对缺少的信息再决定是否尝试。'
            : '已保存的基础准备不等于能够获胜；装备词条、难度、招式与操作仍会影响结果。',
      checks,
      growth: points ? `${points}。${growth}` : growth,
      opponentSkills: (people.get(row.npcId)?.skills || []).flatMap((skill) => {
        const entry = entries.get(skill.id);
        return entry
          ? [
              {
                id: entry.id,
                name: entry.name,
                level: skill.level,
                description: entry.description,
                special: entry.special || '',
              },
            ]
          : [];
      }),
      basis:
        '依据最近一次保存，未保存的换装、回复和修炼暂未计入。攻击／防御基础值不当作含装备、增益的实战面板。等级比较和修炼目标是准备建议，不是通关保证。',
    };
  };
}
module.exports = { createDuelReadiness };
