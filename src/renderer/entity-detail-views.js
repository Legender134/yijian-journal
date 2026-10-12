import { entityCatalog, questStatus } from './entity-catalog.js';

export function createEntityDetailViews({ esc, act, pill, guide = () => [] }) {
  const link = (e) =>
    act(e.kind === '任务' ? 'world-quest' : 'database-detail', esc(e.name), 'text-btn', e.id);
  const folded = (rows, render, limit = 8) =>
    rows.slice(0, limit).map(render).join('') +
    (rows.length > limit
      ? `<details class="entity-more"><summary>展开其余 ${rows.length - limit} 条</summary>${rows.slice(limit).map(render).join('')}</details>`
      : '');
  const steps = (rows) => [...new Map(rows.map((q) => [q.id, q])).values()].map(link).join('、');
  function person(index, e, reference) {
    const related = entityCatalog(index).personRelations(e);
    const quests = [...related.quests].sort(
      (a, b) =>
        Number(questStatus(b.entity.gameId, reference) === '进行中') -
        Number(questStatus(a.entity.gameId, reference) === '进行中'),
    );
    const taskRow = (row) =>
      `<div class="entity-relation-row"><div>${link(row.entity)} ${pill(questStatus(row.entity.gameId, reference))}</div><p class="small muted">${esc(row.roles.join(' / '))}</p><details><summary>对应步骤 · ${row.via.length}</summary><div class="related-items">${steps(row.via)}</div></details></div>`;
    const peopleRow = (row) =>
      `<div class="entity-relation-row">${link(row.entity)}<p class="small muted">在关联任务中：${esc(row.roles.join(' / '))}</p><details><summary>在哪些步骤出现</summary>${steps(row.via)}</details></div>`;
    const itemsRow = (row) =>
      `<div class="entity-relation-row">${link(row.entity)}${row.via.map(({ quest, count }) => `<p class="small">${link(quest)} · 该步骤需 ${esc(count)} 件</p>`).join('')}</div>`;
    return `<section class="detail-block entity-relations" data-person-relations><h3>相关任务 · ${quests.length}</h3><p class="save-note">${reference ? `对照 ${esc(reference.name)} 的已保存记录。` : '仅查资料，尚未核对存档。'}按接取、完成、条件和文字提及区分；提名或场景配置不等于当前能接任务。</p>${folded(quests, taskRow) || '<p class="small muted">当前索引没有列出具名任务关联。</p>'}${related.people.length ? `<details class="detail-block"><summary>关联任务中的其他人物 · ${related.people.length} · 可能涉及剧情</summary><p class="save-note">这是同一任务步骤中的人物线索，不推断亲属、阵营或剧情关系。</p>${folded(related.people, peopleRow)}</details>` : ''}${related.items.length ? `<details class="detail-block"><summary>关联步骤需要的物品 · ${related.items.length}</summary><p class="save-note">逐步骤列用量；不同分支可能互斥，不把所有材料相加为必需量。</p>${folded(related.items, itemsRow)}</details>` : ''}</section>`;
  }
  function task(index, q, reference) {
    const related = entityCatalog(index).taskRelations(q);
    const personRow = (row) =>
      `<div class="entity-relation-row">${link(row.entity)}<p class="small muted">${esc(row.roles.join(' / '))}</p><details><summary>对应任务步骤 · ${row.via.length}</summary>${steps(row.via)}</details></div>`;
    const itemRow = (row) =>
      `<div class="entity-relation-row">${link(row.entity)}${row.via.map(({ quest, count }) => `<p class="small">${link(quest)} · 需 ${esc(count)} 件 ${pill(questStatus(quest.gameId, reference))}</p>`).join('')}</div>`;
    const requirementRow = (row) =>
      `<div class="entity-relation-row">${link(row.entity)}<p class="small">${row.type === 'NoQuest' ? '资料中的排除条件 · 判定待游戏内核对' : '资料中的前置状态：' + esc(['未开始', '进行中', '已失败', '未接取', '已完成'][row.value] || row.value)} · ${pill(questStatus(row.entity.gameId, reference))}</p><details><summary>哪些步骤有此条件</summary>${steps(row.via)}</details></div>`;
    const ids = new Set(related.group.map((step) => step.gameId));
    const curated = guide().filter(
      (row) =>
        ids.has(Number(String(row.questId || '').replace('quest-', ''))) ||
        (row.affectedTasks || []).some((t) => ids.has(Number(String(t.questId || '').replace('quest-', '')))),
    );
    const advice = curated
      .map(
        (row) =>
          `<details class="entity-related-advice"><summary>${esc(row.name || row.title)}</summary>${row.recommendation?.action ? `<p><strong>推荐做法：</strong>${esc(row.recommendation.action)}</p><p><strong>为什么：</strong>${esc(row.recommendation.reason)}</p>` : ''}${row.recommendation?.goal ? `<p>适合：${esc(row.recommendation.goal)}</p>` : ''}${row.recommendation?.tradeoff ? `<p>取舍：${esc(row.recommendation.tradeoff)}</p>` : ''}${row.warning ? `<p>${esc(row.warning)}</p>` : ''}${(row.affectedTasks || []).map((affected) => `<p><strong>${esc(affected.name)}：</strong>${esc(affected.effect)}</p>`).join('')}${row.uncertainty ? `<p class="save-note">${esc(row.uncertainty)}</p>` : ''}${(row.sources || []).map((source) => act('source', esc(source.title), 'text-btn', source.id)).join(' · ')}</details>`,
      )
      .join('');
    return `<section class="detail-block entity-relations" data-task-relations><h3>${q.parentId ? '本步骤与子步骤关联' : '整条任务关联汇总'}</h3><p class="save-note">汇总 ${related.group.length} 个资料步骤。分支不保证全部执行，任务提名与事件场景不是当前人物位置。</p><details open><summary>涉及人物 · ${related.people.length}</summary>${folded(related.people, personRow) || '<p class="small muted">资料未列出可识别的人物关系。</p>'}</details>${related.items.length ? `<details open><summary>步骤需要的物品 · ${related.items.length}</summary>${folded(related.items, itemRow)}<p class="save-note">按各步骤分别列用量，不合并互斥分支，也不推断任务奖励。</p></details>` : ''}${related.requirements.length ? `<details><summary>前置与排除任务 · ${related.requirements.length}</summary>${folded(related.requirements, requirementRow)}</details>` : ''}${advice ? `<details><summary>已整理的选择、收益与推进影响 · ${curated.length}</summary><p class="save-note">攻略供查询，不表示此提醒当前仍开放。及时提醒请以随行的已保存参照为准。</p>${advice}</details>` : ''}</section>`;
  }
  return { person, task };
}
