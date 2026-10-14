'use strict';

function readDialogue(value) {
  if (
    !value ||
    value.schema !== 1 ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    !Number.isSafeInteger(value.questId) ||
    value.questId < 1 ||
    value.questId > 2147483647 ||
    !Number.isSafeInteger(value.npcId) ||
    value.npcId < 0 ||
    value.npcId > 2147483647 ||
    !Array.isArray(value.options) ||
    value.options.length < 2 ||
    value.options.length > 16
  )
    return null;
  let length = 0;
  const options = [];
  for (const [offset, option] of value.options.entries()) {
    if (
      !option ||
      option.index !== offset + 1 ||
      typeof option.text !== 'string' ||
      !option.text.trim() ||
      Buffer.byteLength(option.text, 'utf8') > 512 ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(option.text)
    )
      return null;
    length += Buffer.byteLength(option.text, 'utf8');
    if (length > 4096) return null;
    options.push({ index: option.index, text: option.text });
  }
  return { schema: 1, sequence: value.sequence, questId: value.questId, npcId: value.npcId, options };
}

// Formatting differences are harmless; never use substring or fuzzy matches for a choice.
const optionText = (value) =>
  String(value || '')
    .replace(/<[^>]*>/g, '')
    .replace(/[\s「」『』“”‘’"'。，、：:！？!?…]/g, '');

function withLiveDialogue(flow, context, quests) {
  if (flow.referenceMode !== 'latest' || !context) return flow;
  const suppressed = new Set(
    (Array.isArray(context.suppressedQuestIds) ? context.suppressedQuestIds : [])
      .slice(0, 64)
      .filter((id) => Number.isSafeInteger(id) && id > 0),
  );
  const visible = (rule) => !(rule.decisionSteps || []).some((id) => suppressed.has(id));
  const base = {
    ...flow,
    decisions: (flow.decisions || []).filter(visible),
    warnings: (flow.warnings || []).filter(visible),
    advice: (flow.advice || []).filter(visible),
    opportunities: (flow.opportunities || []).filter(visible),
  };
  const dialogue = readDialogue(context.dialogue);
  if (!dialogue) return base;
  const candidates = [];
  for (const rule of flow.guide || []) {
    if (!(rule.decisionSteps || []).includes(dialogue.questId)) continue;
    const choices = rule.choices || [];
    if (choices.length < 2 || choices.length !== dialogue.options.length) continue;
    let task = quests.get(dialogue.questId);
    const people = [...(task?.requestNPCs || []), ...(task?.finishNPCs || [])];
    if (people.length && !people.includes(dialogue.npcId)) continue;
    const seen = new Set();
    while (task?.parentId && !seen.has(task.gameId)) {
      seen.add(task.gameId);
      task = quests.get(task.parentId);
    }
    if (task?.gameId !== rule.questId) continue;
    const byText = new Map(choices.map((choice) => [optionText(choice.label), choice]));
    if (byText.size !== choices.length || byText.has('')) continue;
    const matched = dialogue.options.map((option) => ({
      option,
      choice: byText.get(optionText(option.text)),
    }));
    if (
      matched.some((row) => !row.choice) ||
      new Set(matched.map((row) => row.choice)).size !== choices.length
    )
      continue;
    candidates.push({
      ...rule,
      live: true,
      liveSequence: dialogue.sequence,
      decisionActive: true,
      decisionResolved: false,
      deadlineReached: false,
      done: false,
      failed: false,
      conditions: [],
      // Inventory remains a saved reference, never a claim about the live dialogue.
      recommendation: rule.recommendation ? { ...rule.recommendation, materials: [] } : undefined,
      choices: matched.map(({ option, choice }) => ({ ...choice, label: option.text, index: option.index })),
    });
  }
  const current = candidates.length === 1 ? candidates[0] : null;
  return {
    ...base,
    // A different open choice must not inherit a saved recommendation from another conversation.
    decisions: current ? [current] : [],
    liveDialogue: {
      sequence: dialogue.sequence,
      questId: dialogue.questId,
      npcId: dialogue.npcId,
      matched: !!current,
    },
  };
}

module.exports = { readDialogue, withLiveDialogue };
