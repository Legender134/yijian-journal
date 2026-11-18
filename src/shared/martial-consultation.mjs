// Pinned PC skill rows excluded by the recovered default consultation list.
// Runtime row mapping and other learning paths can differ.
export const defaultConsultationExcludedRows = new Map([
  [880, '白帝剑心（剑法精通）'], [882, '乘云御龙心诀'], [883, '韶华胜极神通'],
  [751, '云涛晓雾凌波舞'], [817, '五灵心经'], [866, '五恒天经'],
  [182, '白帝剑阵（剑法）'], [268, '白帝剑阵（刀法）'], [367, '飞将戟法'],
  [368, '浑天梨花枪·极'], [473, '镜湖映月'], [474, '青玉手'],
  [895, '万里平戎策'], [898, '白帝剑心（刀法精通）'], [904, '混沌武典·阴'], [905, '混沌武典'],
]);

// Martial consultation method is independent of entry eligibility and victory.
export function martialConsultation(grade, difficulty, rule) {
  if (
    rule?.schema !== 1 ||
    !Array.isArray(rule.alwaysBattleGrades) ||
    !rule.extraBattle ||
    !rule.difficultyValues ||
    !Number.isInteger(rule.requestedSkillLevel) ||
    rule.requestedSkillLevel < 1 ||
    !Number.isInteger(grade) ||
    grade < 1 ||
    grade > 6
  )
    return null;
  const result = (method) => ({ method, initialLevel: rule.requestedSkillLevel });
  if (rule.alwaysBattleGrades.includes(grade)) return result('battle');
  if (grade !== rule.extraBattle.grade) return result('direct');
  let known = null;
  if (Number.isInteger(difficulty))
    known =
      Object.keys(rule.difficultyValues).find((name) => rule.difficultyValues[name] === difficulty) || null;
  else if (typeof difficulty === 'string') {
    const parts = difficulty.trim().split('::');
    if (parts.length === 1 || (parts.length === 2 && parts[0] === 'EDifficultyMode')) {
      const name = { Normal: 'Common', Difficult: 'Difficulty' }[parts.at(-1)] || parts.at(-1);
      if (Object.hasOwn(rule.difficultyValues, name)) known = name;
    }
  }
  return result(known === null ? 'conditional' : known === rule.extraBattle.difficulty ? 'battle' : 'direct');
}

export function martialConsultationHint(consultation) {
  return { battle: '需比试', conditional: '极难需比试' }[consultation?.method] || '';
}
