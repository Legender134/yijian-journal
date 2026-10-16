import { entityCatalog, questStatus } from './entity-catalog.js';

export function createEntityDetailViews({ esc, act, pill, guide = () => [], richText = esc }) {
  const link = (e) =>
    act(
      e.kind === '任务' ? 'world-quest' : e.kind === '地点' ? 'world-place' : 'database-detail',
      esc(e.name),
      'text-btn',
      e.id,
    );
  const folded = (rows, render, limit = 8) =>
    rows.slice(0, limit).map(render).join('') +
    (rows.length > limit
      ? `<details class="entity-more"><summary>展开其余 ${rows.length - limit} 条</summary>${rows.slice(limit).map(render).join('')}</details>`
      : '');
  const steps = (rows) => [...new Map(rows.map((q) => [q.id, q])).values()].map(link).join('、');
  function pickupLocations(index, rows) {
    const catalog = entityCatalog(index);
    const locations = rows.filter((row) => row.pickup?.personId && row.pickup.place);
    if (!locations.length) return '';
    return `<div class="detail-block" data-community-pickup><h3>接取地点</h3>${locations
      .map((row) => {
        const quest = catalog.entries.get('quest-' + String(row.questId).replace(/^quest-/, ''));
        const person = catalog.entries.get(row.pickup.personId);
        return `<div class="entity-relation-row">${quest ? link(quest) : ''}<p><strong>地点：</strong>${richText(row.pickup.place)}${person ? ` · ${link(person)}` : ''}</p>${row.pickup.action ? `<p>${richText(row.pickup.action)}</p>` : ''}${row.uncertainty ? `<details><summary>资料说明</summary><p class="small">${richText(row.uncertainty)}</p></details>` : ''}${row.sources?.length ? `<details><summary>来源与参考版本</summary>${row.sources.map((source) => `<p>${act('source', esc(source.title), 'text-btn', source.id)}<span class="small muted"> · ${[source.date, source.version].filter(Boolean).map(esc).join(' · ')}</span></p>`).join('')}</details>` : ''}</div>`;
      })
      .join('')}</div>`;
  }
  function person(index, e, reference) {
    const related = entityCatalog(index).personRelations(e);
    const locations = pickupLocations(
      index,
      guide().filter((row) => row.pickup?.personId === e.id),
    );
    const quests = [...related.quests].sort(
      (a, b) =>
        Number(questStatus(b.entity.gameId, reference) === '进行中') -
        Number(questStatus(a.entity.gameId, reference) === '进行中'),
    );
    if (!locations && !quests.length && !related.people.length && !related.items.length) return '';
    const taskRow = (row) =>
      `<div class="entity-relation-row"><div>${link(row.entity)} ${pill(questStatus(row.entity.gameId, reference))}</div><details><summary>对应步骤 · ${row.via.length}</summary><p class="small muted">${esc(row.roles.join(' / '))}</p><div class="related-items">${steps(row.via)}</div></details></div>`;
    const peopleRow = (row) =>
      `<div class="entity-relation-row">${link(row.entity)}<p class="small muted">在关联任务中：${esc(row.roles.join(' / '))}</p><details><summary>在哪些步骤出现</summary>${steps(row.via)}</details></div>`;
    const itemsRow = (row) =>
      `<div class="entity-relation-row">${link(row.entity)}${row.via.map(({ quest, count }) => `<p class="small">${link(quest)} · 该步骤需 ${esc(count)} 件</p>`).join('')}</div>`;
    return `<section class="detail-block entity-relations" data-person-relations>${locations}${quests.length ? `<details data-persist-detail="person-related-quests-${esc(e.id)}"><summary>相关任务 · ${quests.length}</summary>${folded(quests, taskRow)}</details>` : ''}${related.people.length ? `<details class="detail-block"><summary>关联任务中的其他人物 · ${related.people.length} · 可能涉及剧情</summary>${folded(related.people, peopleRow)}</details>` : ''}${related.items.length ? `<details class="detail-block"><summary>关联步骤需要的物品 · ${related.items.length}</summary>${folded(related.items, itemsRow)}</details>` : ''}</section>`;
  }
  function task(index, q, reference) {
    const related = entityCatalog(index).taskRelations(q);
    const personRow = (row) =>
      `<div class="entity-relation-row">${link(row.entity)}<p class="small muted">${esc(row.roles.join(' / '))}</p><details><summary>对应任务步骤 · ${row.via.length}</summary>${steps(row.via)}</details></div>`;
    const itemRow = (row) =>
      `<div class="entity-relation-row">${link(row.entity)}${row.via.map(({ quest, count }) => `<p class="small">${link(quest)} · 需 ${esc(count)} 件 ${pill(questStatus(quest.gameId, reference))}</p>`).join('')}</div>`;
    const requirementRow = (row) =>
      `<div class="entity-relation-row">${link(row.entity)}<p class="small">${row.type === 'NoQuest' ? '排除条件' : '所需状态：' + esc(['未开始', '进行中', '已失败', '未接取', '已完成'][row.value] || row.value)} · ${pill(questStatus(row.entity.gameId, reference))}</p><details><summary>哪些步骤有此条件</summary>${steps(row.via)}</details></div>`;
    const ids = new Set(related.group.map((step) => step.gameId));
    const curated = guide().filter(
      (row) =>
        ids.has(Number(String(row.questId || '').replace('quest-', ''))) ||
        (row.affectedTasks || []).some((t) => ids.has(Number(String(t.questId || '').replace('quest-', '')))),
    );
    const locations = pickupLocations(
      index,
      guide().filter((row) => {
        const id = Number(String(row.questId || '').replace(/^quest-/, ''));
        return ids.has(id) || id === entityCatalog(index).root(q)?.gameId;
      }),
    );
    const affectedName = (affected) => {
      const id = 'quest-' + String(affected.questId || '').replace(/^quest-/, '');
      return entityCatalog(index).entries.has(id)
        ? act('world-quest', esc(affected.name), 'text-btn', id)
        : richText(affected.name);
    };
    const advice = curated
      .map(
        (row) =>
          `<details class="entity-related-advice"><summary>${richText(row.name || row.title)}</summary>${row.recommendation?.action ? `<p><strong>推荐做法：</strong>${richText(row.recommendation.action)}</p><p><strong>为什么：</strong>${richText(row.recommendation.reason)}</p>` : ''}${row.recommendation?.goal ? `<p>适合：${richText(row.recommendation.goal)}</p>` : ''}${row.recommendation?.tradeoff ? `<p>取舍：${richText(row.recommendation.tradeoff)}</p>` : ''}${row.warning ? `<p>${richText(row.warning)}</p>` : ''}${(row.affectedTasks || []).map((affected) => `<p><strong>${affectedName(affected)}：</strong>${richText(affected.effect)}</p>`).join('')}${row.uncertainty ? `<p class="save-note">${richText(row.uncertainty)}</p>` : ''}${(row.sources || []).map((source) => act('source', esc(source.title), 'text-btn', source.id)).join(' · ')}</details>`,
      )
      .join('');
    if (
      !locations &&
      !related.people.length &&
      !related.items.length &&
      !related.requirements.length &&
      !advice
    )
      return '';
    return `<section class="detail-block entity-relations" data-task-relations>${locations}${related.people.length ? `<details><summary>涉及人物 · ${related.people.length}</summary>${folded(related.people, personRow)}</details>` : ''}${related.items.length ? `<details><summary>步骤需要的物品 · ${related.items.length}</summary>${folded(related.items, itemRow)}</details>` : ''}${related.requirements.length ? `<details><summary>前置与排除任务 · ${related.requirements.length}</summary>${folded(related.requirements, requirementRow)}</details>` : ''}${advice ? `<details><summary>已整理的选择、收益与推进影响 · ${curated.length}</summary>${advice}</details>` : ''}</section>`;
  }
  return { person, task };
}
