'use strict';

// Progress is a read-only projection of the selected save. Never persist a
// completion inferred from a save: changing slots or loading an older save
// must show that save's progress without losing the user's own completion.
function selectedReference(profile, reference, error = '') {
  const mode = profile.referenceMode || (profile.saveSlot ? 'slot' : 'latest');
  return !error && mode !== 'none' && reference && (mode !== 'slot' || reference.name === profile.saveSlot)
    ? reference
    : null;
}
function goalProgress(profile, reference, error = '') {
  const mode = profile.referenceMode || (profile.saveSlot ? 'slot' : 'latest');
  const matches = selectedReference(profile, reference, error);
  const records = matches && Array.isArray(reference.metadata?.quests) ? reference.metadata.quests : null;
  const source = records
    ? {
        name: reference.name,
        modifiedAt: reference.modifiedAt,
        hash: reference.hash,
      }
    : null;
  const byId = new Map((records || []).map((q) => [q.id, q]));
  return Object.fromEntries(
    profile.goals.map((goal) => {
      const tracked = goal.source?.type === 'quest' && goal.progressMode !== 'manual';
      const id = /^quest-(\d+)$/.exec(goal.source?.id || '');
      const record = tracked && id ? byId.get(Number(id[1])) : null;
      const status = !tracked
        ? 'manual'
        : !record || !Number.isInteger(record.step)
          ? 'unknown'
          : { 0: 'not-started', 1: 'active', 2: 'failed', 3: 'not-accepted', 4: 'complete' }[record.step] ||
            'unknown';
      const labels = {
        manual: '手动管理',
        unknown: '任务进度待核对',
        'not-started': '存档中尚未开始',
        active: '存档中进行中',
        failed: '存档中已失败',
        'not-accepted': '存档中尚未接取',
        complete: '存档中已完成',
      };
      const automaticDone = tracked && status === 'complete';
      const planDone =
        goal.source?.type === 'planner' &&
        profile.craftPlans?.some((plan) => plan.id === goal.source.id && plan.done === true);
      return [
        goal.id,
        {
          tracked,
          status,
          label: planDone ? '制作计划已完成（个人记录）' : labels[status],
          done: goal.done || automaticDone || !!planDone,
          ...(planDone ? { planDone: true } : {}),
          automaticDone: !goal.done && automaticDone,
          manualDone: goal.done,
          source: tracked && record && status !== 'unknown' ? source : null,
          reason:
            status === 'unknown'
              ? error ||
                (mode === 'none'
                  ? '此周目未读取游戏进度'
                  : !matches
                    ? '尚无匹配的可读存档'
                    : !records
                      ? '这份存档未提供任务记录'
                      : '这份存档没有该任务的可核对记录')
              : '',
        },
      ];
    }),
  );
}

module.exports = { goalProgress, selectedReference };
