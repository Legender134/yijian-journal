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
