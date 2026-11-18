// Quest actions are static requests, not proof that the event ran or that the
// current relationship changed. Keep different difficulty arrays separate.
export function npcQuestAffectionSources(index, npcId, coveredQuestIds = []) {
  if (!Number.isSafeInteger(npcId)) return [];
  const quests = index.world?.quests || [];
  const byId = new Map(quests.map((quest) => [quest.gameId, quest]));
  const covered = new Set(coveredQuestIds);
  const finished = quests.flatMap((quest) => {
    if (covered.has(quest.gameId)) return [];
    const finish = index.codex?.quests?.[quest.gameId]?.finish;
    if (!Array.isArray(finish) || finish.length !== 3 || finish.some((actions) => !Array.isArray(actions))) return [];
    const matches = finish.map((actions) => actions.filter((action) => action.type === 'CYHD' && action.id === npcId));
    // Multiple writes need separate ordering and cap analysis; do not add them.
    if (matches.some((actions) => actions.length > 1)) return [];
    const values = matches.map((actions) => actions.length ? actions[0].value : null);
    if (values.some((value) => value !== null && !Number.isSafeInteger(value))) return [];
    if (!values.some((value) => value !== null && value !== 0)) return [];
    return [{ quest, values, kind: 'finish' }];
  });
  // Hidden steps are associated with a visible ancestor by the codex builder.
  // They remain possible story outcomes, not proof the step can currently run.
  const hiddenFinished = new Map();
  for (const [id, detail] of Object.entries(index.codex?.hiddenSteps || {})) {
    const stepId = Number(id);
    const quest = byId.get(detail.relatedQuestId);
    const path = detail.ownerPath;
    const finish = detail.finish;
    if (!Number.isSafeInteger(stepId) || covered.has(stepId) || !quest ||
        !Array.isArray(path) || path[0] !== detail.ownerId || !path.includes(detail.relatedQuestId) ||
        !Array.isArray(finish) || finish.length !== 3 || finish.some((actions) => !Array.isArray(actions))) continue;
    const matches = finish.map((actions) => actions.filter((action) => action.type === 'CYHD' && action.id === npcId));
    if (matches.some((actions) => actions.length > 1)) continue;
    const values = matches.map((actions) => actions.length ? actions[0].value : null);
    if (values.some((value) => value !== null && !Number.isSafeInteger(value)) ||
        !values.some((value) => value !== null && value !== 0)) continue;
    const key = JSON.stringify([detail.relatedQuestId, values]);
    const existing = hiddenFinished.get(key);
    if (existing) existing.stepIds.push(stepId);
    else hiddenFinished.set(key, { quest, values, kind: 'hidden-finish', stepIds: [stepId] });
  }
  const choices = Object.entries(index.codex?.hiddenSteps || {}).flatMap(([id, detail]) => {
    const quest = byId.get(detail.relatedQuestId);
    if (!quest || covered.has(Number(id)) || detail.requirements?.length || detail.finishingRequirements?.length) return [];
    return (detail.choices || []).flatMap((choice) => {
      if (!choice.text || choice.requirements?.length) return [];
      const matches = (choice.actions || []).filter((action) => action.type === 'CYHD' && action.id === npcId);
      if (matches.length !== 1 || !Number.isSafeInteger(matches[0].value) || matches[0].value === 0) return [];
      return [{ quest, values: [matches[0].value], kind: 'choice', choice: choice.text }];
    });
  });
  return [...finished, ...hiddenFinished.values(), ...choices];
}
