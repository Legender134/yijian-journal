import { entityCatalog } from './entity-catalog.js';
import { itemEffectText } from './item-stat-views.js';

// All cross-links use shipped entity IDs. Static outcomes never mutate or
// forecast the active quest state, and rewards from branches are never added.
export function createCodexDetailViews({ esc, act, richText = esc }) {
  const text = (v) => esc(String(v ?? ''));
  const shortName = (s) => String(s || '').replace(/^【[^】]+】\s*/, '');
  const link = (index, id) => {
    const e = entityCatalog(index).entries.get(id);
    return e
      ? act(
          e.kind === '任务' ? 'world-quest' : e.kind === '地点' ? 'world-place' : 'database-detail',
          text(shortName(e.name)),
          'text-btn',
          id,
        )
      : '';
  };
  const more = (rows, render, limit = 4) =>
    rows.slice(0, limit).map(render).join('') +
    (rows.length > limit
      ? `<details><summary>其余 ${rows.length - limit} 项</summary>${rows.slice(limit).map(render).join('')}</details>`
      : '');
  function effect(index, a, quest) {
    const amount = `${a.value > 0 ? '+' : ''}${a.value.toLocaleString('zh-CN')}`;
    const target = (kind) => link(index, kind + '-' + a.id);
    if (a.type === 'CItem' && target('item'))
      return `${target('item')} <strong>${a.value < 0 ? '−' : '+'}${Math.abs(a.value)}</strong>`;
    if (a.type === 'CYHD' && target('npc')) return `${target('npc')} 好感 ${amount}`;
    if (a.type === 'CMoney') return `铜钱 ${amount}`;
    if (a.type === 'ASExp') return `武学点 ${amount}`;
    if (a.type === 'AJingMaiPoint') return `经脉点 ${amount}`;
    if (a.type === 'ASkill' && target('skill')) return `学会 ${target('skill')}`;
    if (['ATeam', 'RTeam'].includes(a.type) && target('npc'))
      return `${target('npc')} ${a.type === 'ATeam' ? '入队' : '离队'}`;
    if (a.type === 'CQuestStep' && a.id !== quest?.gameId && a.id !== quest?.parentId && target('quest')) {
      const state = ['未开始', '进行中', '失败', '未接取', '完成'][a.value];
      return state ? `${target('quest')} → ${state}` : '';
    }
    return '';
  }
  const effectList = (index, actions, quest) => actions.map((a) => effect(index, a, quest)).filter(Boolean);
  function quest(index, entry, reference) {
    const catalog = entityCatalog(index);
    const family = catalog.family(entry);
    const rows = family.flatMap((q) => {
      const detail = index.codex?.quests?.[q.gameId];
      if (!detail) return [];
      const finish = detail.finish.map((actions) => effectList(index, actions, q));
      const choices = detail.choices
        .map((choice) => ({ ...choice, shown: effectList(index, choice.actions, q) }))
        .filter((choice) => choice.shown.length);
      return finish.some((items) => items.length) || choices.length ? [{ q, finish, choices }] : [];
    });
    if (!rows.length) return '';
    const list = (items) => `<ul class="codex-effects">${items.map((s) => `<li>${s}</li>`).join('')}</ul>`;
    const render = ({ q, finish, choices }) => {
      const same = finish.every((items) => JSON.stringify(items) === JSON.stringify(finish[0]));
      const result = same
        ? list(finish[0])
        : finish
            .map((items, n) => (items.length ? `<h4>${['普通', '困难', '极难'][n]}</h4>${list(items)}` : ''))
            .join('');
      return `<div class="codex-outcome-step">${q.gameId !== entry.gameId ? `<h4>${link(index, q.id)}</h4>` : ''}${result}${choices.map((choice) => `<details><summary>选择「${text(choice.text)}」</summary>${choice.requirements.length ? `<details><summary>选项出现条件</summary>${index.renderRequirements ? index.renderRequirements(choice.requirements, index, { reference }) : '<p>需满足对应剧情条件</p>'}</details>` : ''}${list(choice.shown)}</details>`).join('')}</div>`;
    };
    return `<details class="detail-block codex-outcomes" data-persist-detail="quest-outcomes-${text(entry.gameId)}"><summary>奖励与选择影响${rows.length > 1 ? ` · ${rows.length} 个步骤` : ''}</summary>${more(rows, render)}</details>`;
  }
  function item(index, entry) {
    const rows = [];
    for (const q of index.world?.quests || []) {
      const detail = index.codex?.quests?.[q.gameId];
      if (!detail) continue;
      const grants = (actions) =>
        actions
          .filter((a) => a.type === 'CItem' && a.id === entry.gameId && a.value > 0)
          .reduce((n, a) => n + a.value, 0);
      const counts = detail.finish.map(grants);
      if (counts.some(Boolean))
        rows.push({
          q,
          label: counts.every((v) => v === counts[0])
            ? `完成获得 ×${counts[0]}`
            : counts
                .map((v, i) => (v ? `${['普通', '困难', '极难'][i]} ×${v}` : ''))
                .filter(Boolean)
                .join(' · '),
        });
      for (const choice of detail.choices) {
        const count = grants(choice.actions);
        if (count) rows.push({ q, label: `选择「${choice.text}」获得 ×${count}` });
      }
    }
    const gathering = entry.gatheringRoutes || [];
    const routes = gathering.length
      ? `<section class="detail-block item-gathering"><h3>采集与掉落</h3>${more(gathering, (r) => `<div class="codex-source-row">${r.placeId && link(index, r.placeId) ? `${link(index, r.placeId)}<span>${r.kind === 'gather' ? '采集' : '掉落'}</span>` : text(r.label)}</div>`)}<details><summary>获取详情与来源</summary>${gathering.map((r) => `<h4>${text(r.label)}</h4><p>${richText(r.detail)}</p>${r.sources.map((s) => `<p>${act('source', text(s.title), 'text-btn', s.id)}<span class="small muted"> · ${text(s.date)} · ${text(s.version)}</span></p>`).join('')}`).join('')}</details></section>`
      : '';
    return (
      (rows.length
        ? `<section class="detail-block item-quest-sources"><h3>任务获取</h3>${more(rows, (r) => `<div class="codex-source-row">${link(index, r.q.id)}<span>${text(r.label)}</span></div>`)}</section>`
        : '') + routes
    );
  }
  function skill(index, entry, progress, origin = 'saved') {
    const manuals = index.entries.filter(
      (e) => e.kind === '物品' && e.stats?.effects.some((a) => a.type === 'ASkill' && a.id === entry.gameId),
    );
    const contract = index.skillConsultation?.[entry.gameId];
    const currentPeople = new Map((progress?.people || []).map((person) => [person.npcId, person]));
    const learningFor = (person) =>
      currentPeople.get(person.gameId)?.learning.find((row) => row.entityId === entry.id);
    const priority = (person) =>
      learningFor(person)?.status === 'met' ? 0 : currentPeople.has(person.gameId) ? 1 : 2;
    const teachers =
      contract && !contract.excluded
        ? index.entries
            .filter(
              (e) =>
                e.kind === '人物' &&
                e.functions?.includes('Consult') &&
                (e.skills?.some((s) => s.id === entry.id) || learningFor(e)),
            )
            .sort((a, b) => priority(a) - priority(b))
        : [];
    const teacher = (person) => {
      const current = currentPeople.get(person.gameId);
      const learning = learningFor(person);
      const label = learning
        ? { met: '可请教', unmet: '条件未满足', unknown: '查看请教条件' }[learning.status]
        : current?.consult.status === 'unmet'
          ? '暂不能请教'
          : '查看人物条件';
      return `<div class="codex-source-row">${link(index, person.id)}<span>${label}</span></div>`;
    };
    const growth = index.codex?.skills?.[entry.gameId]?.growth || [];
    const levels = growth
      .map((actions, i) => ({
        level: i + 1,
        rows: actions.map((a) => itemEffectText(a, index.itemStats)).filter(Boolean),
      }))
      .filter((r) => r.rows.length);
    const consult = contract
      ? `<details class="detail-block skill-consult"><summary>请教条件${contract.excluded ? ' · 不可常规请教' : ` · 好感 ${text(contract.friendliness)}`}</summary>${contract.excluded ? '' : `<p>基础消耗 ${text(contract.skillPointCost)} 武学点；门派、难度或天赋可能减免。</p>${contract.requirements.length && index.renderRequirements ? index.renderRequirements(contract.requirements, index, { reference: null }) : ''}`}<details><summary>资料来源</summary><p>游戏资料表 · Build ${text(index.build)}</p></details></details>`
      : '';
    return `${manuals.length ? `<section class="detail-block skill-manuals"><h3>学习秘籍</h3><div class="related-items">${manuals.map((e) => link(index, e.id)).join('')}</div></section>` : ''}${consult}${teachers.length ? `<details class="detail-block skill-teachers" data-persist-detail="skill-teachers-${text(entry.gameId)}"><summary>请教线索 · ${teachers.length} 位${progress && origin !== 'live' ? ' · 保存时状态' : ''}</summary>${more(teachers, teacher)}</details>` : ''}${levels.length ? `<details class="detail-block skill-growth"><summary>各级属性提升</summary><div class="codex-growth">${levels.map((r) => `<div><strong>${r.level} 级</strong><span>${r.rows.map((a) => text(a.name + ' ' + a.value)).join(' · ')}</span></div>`).join('')}</div></details>` : ''}`;
  }
  return { quest, item, skill };
}
