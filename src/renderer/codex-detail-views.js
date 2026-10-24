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
    if (
      ['ARandItem', 'ANormalRandItem'].includes(a.type) &&
      target('item') &&
      Number.isSafeInteger(a.value) &&
      a.value > 0
    )
      return `${target('item')} <strong>+${a.value}</strong>（${a.type === 'ARandItem' ? '随机词条' : '普通随机词条'}）`;
    if (a.type === 'CYHD' && target('npc')) return `${target('npc')} 好感 ${amount}`;
    if (a.type === 'CMoney') return `铜钱 ${amount}`;
    if (a.type === 'ASExp') return `武学点 ${amount}`;
    if (a.type === 'AJingMaiPoint') return `经脉点 ${amount}`;
    if (a.type === 'CGuildHonor') return `门派贡献 ${amount}`;
    if (a.type === 'ASkill' && target('skill')) return `学会 ${target('skill')}`;
    if (['ATeam', 'RTeam'].includes(a.type) && target('npc'))
      return `${target('npc')} ${a.type === 'ATeam' ? '入队' : '离队'}`;
    if (a.type === 'CQuestStep' && a.id !== quest?.gameId && a.id !== quest?.parentId && target('quest')) {
      const state = ['未开始', '进行中', '失败', '未接取', '完成'][a.value];
      return state ? `${target('quest')} → ${state}` : '';
    }
    if (a.type === 'JumpStep' && target('quest')) {
      const state = ['未开始', '进行中', '失败', '未接取', '完成'][a.value];
      return state ? `${target('quest')} → ${state}（剧情跳转）` : '';
    }
    return '';
  }
  const effectList = (index, actions, quest) => actions.map((a) => effect(index, a, quest)).filter(Boolean);
  const outcomeRows = (index) => {
    const published = new Map((index.world?.quests || []).map((q) => [q.gameId, q]));
    return [
      ...[...published.values()].flatMap((q) => {
        const detail = index.codex?.quests?.[q.gameId];
        return detail ? [{ q, detail }] : [];
      }),
      ...Object.entries(index.codex?.hiddenSteps || {}).flatMap(([id, detail]) => {
        const related = published.get(detail.relatedQuestId);
        return related ? [{ q: { gameId: Number(id), parentId: detail.ownerId, related }, detail }] : [];
      }),
    ];
  };
  const sourceLink = (index, q) => link(index, q.related?.id || q.id);
  const sourceDetails = (q, steps = [q.gameId], event) =>
    q.related || event
      ? `<details><summary>资料来源</summary><p>游戏任务表 · 原始步骤 ${steps.map(text).join('、')}${event ? ` · 事件序号 ${text(event)}` : ''}</p></details>`
      : '';
  const conditions = (index, requirements, reference) => {
    const rows = requirements.map((r) => {
      const kind = ['PreQuest', 'NoQuest'].includes(r.type)
        ? 'quest'
        : ['Item', 'ItemMax'].includes(r.type)
          ? 'item'
          : 'npc';
      const entity = entityCatalog(index).entries.get(`${kind}-${r.id}`);
      const relatedId = kind === 'quest' && index.codex?.hiddenSteps?.[r.id]?.relatedQuestId;
      const related = relatedId && entityCatalog(index).entries.get(`quest-${relatedId}`);
      return {
        ...r,
        ...(related ? { relatedQuestId: relatedId } : {}),
        name:
          entity?.name ||
          (kind === 'quest' ? `${related ? shortName(related.name) + '的' : ''}相关剧情条件` : '资料条件'),
      };
    });
    return index.renderRequirements
      ? index.renderRequirements(rows, index, { reference })
      : `<p>${rows.map((r) => text(`${r.name} · ${r.type === 'PreQuest' ? ['未开始', '进行中', '失败', '未接取', '完成'][r.value] || r.value : r.value}`)).join('；')}</p>`;
  };
  function quest(index, entry, reference) {
    const catalog = entityCatalog(index);
    const family = new Set(catalog.family(entry).map((q) => q.gameId));
    const rows = outcomeRows(index).flatMap(({ q, detail }) => {
      if (!family.has(q.related?.gameId ?? q.gameId)) return [];
      const finish = detail.finish.map((actions) => effectList(index, actions, q));
      const choices = detail.choices.map((choice) => ({
        ...choice,
        shown: effectList(index, choice.actions, q),
      }));
      const events = [
        { label: '任务失败后', shown: effectList(index, detail.failed || [], q) },
        ...(detail.events || []).flatMap((event) => [
          { label: '剧情事件成功后', index: event.index, shown: effectList(index, event.success, q) },
          { label: '剧情事件失败后', index: event.index, shown: effectList(index, event.failure, q) },
        ]),
      ].filter((event) => event.shown.length);
      return finish.some((items) => items.length) || choices.length || events.length
        ? [{ q, detail, finish, choices, events }]
        : [];
    });
    if (!rows.length) return '';
    const list = (items) => `<ul class="codex-effects">${items.map((s) => `<li>${s}</li>`).join('')}</ul>`;
    const render = ({ q, detail, finish, choices, events }) => {
      const same = finish.every((items) => JSON.stringify(items) === JSON.stringify(finish[0]));
      const result = same
        ? list(finish[0])
        : finish
            .map((items, n) => (items.length ? `<h4>${['普通', '困难', '极难'][n]}</h4>${list(items)}` : ''))
            .join('');
      const gates = q.related
        ? [
            ['此步骤出现条件', detail.requirements],
            ['此步骤完成条件', detail.finishingRequirements],
          ]
            .filter(([, requirements]) => requirements?.length)
            .map(
              ([label, requirements]) =>
                `<details><summary>${label}</summary>${conditions(index, requirements, reference)}</details>`,
            )
            .join('')
        : '';
      const heading =
        q.related?.gameId === entry.gameId
          ? '相关剧情结算'
          : `${sourceLink(index, q)}${q.related ? ' · 相关剧情结算' : ''}`;
      return `<div class="codex-outcome-step" data-quest-step="${text(q.gameId)}">${q.gameId !== entry.gameId ? `<h4>${heading}</h4>` : ''}${gates}${result}${events.map((event) => `<details><summary>${text(event.label)}</summary>${list(event.shown)}${sourceDetails(q, [q.gameId], event.index)}</details>`).join('')}${choices.map((choice) => `<details><summary>选择「${text(choice.text)}」</summary>${choice.requirements.length ? `<details><summary>选项出现条件</summary>${conditions(index, choice.requirements, reference)}</details>` : ''}${choice.shown.length ? list(choice.shown) : '<p class="small muted">后续影响需结合剧情判断。</p>'}</details>`).join('')}${sourceDetails(q)}</div>`;
    };
    return `<details class="detail-block codex-outcomes" data-persist-detail="quest-outcomes-${text(entry.gameId)}"><summary>奖励与选择影响${rows.length > 1 ? ` · ${rows.length} 个步骤` : ''}</summary><p class="small muted">各步骤独立结算，需触发对应剧情；不同分支不累计，主任务完成不代表全部奖励均已获得。</p>${more(rows, render)}</details>`;
  }
  function item(index, entry) {
    const rows = [];
    for (const { q, detail } of outcomeRows(index)) {
      const grants = (actions, type) =>
        actions
          .filter(
            (a) => a.type === type && a.id === entry.gameId && Number.isSafeInteger(a.value) && a.value > 0,
          )
          .reduce((n, a) => n + a.value, 0);
      const sources = [
        { label: q.related ? '此剧情步骤结算获得' : '完成获得', actions: detail.finish },
        ...detail.choices.map((choice) => ({
          label: `选择「${choice.text}」获得`,
          actions: [choice.actions],
        })),
        { label: '任务失败后获得', actions: [detail.failed || []] },
        ...(detail.events || []).flatMap((event) => [
          { label: '剧情事件成功后获得', event: event.index, actions: [event.success] },
          { label: '剧情事件失败后获得', event: event.index, actions: [event.failure] },
        ]),
      ];
      for (const source of sources) {
        for (const type of ['CItem', 'ARandItem', 'ANormalRandItem']) {
          const counts = source.actions.map((actions) => grants(actions, type));
          if (!counts.some(Boolean)) continue;
          const amount = counts.every((v) => v === counts[0])
            ? `×${counts[0]}`
            : counts
                .map((v, i) => (v ? `${['普通', '困难', '极难'][i]} ×${v}` : ''))
                .filter(Boolean)
                .join(' · ');
          const random = type === 'CItem' ? '' : `（${type === 'ARandItem' ? '随机词条' : '普通随机词条'}）`;
          rows.push({
            q,
            label: `${source.label} ${amount}${random}`,
            event: source.event,
            steps: [q.gameId],
          });
        }
      }
    }
    const grouped = new Map();
    for (const row of rows) {
      // Identical internal sources share a public navigation row. Preserve all
      // original step identities in provenance; do not add their quantities.
      const key = row.q.related ? JSON.stringify([row.q.related.id, row.label, row.event]) : Symbol();
      const previous = grouped.get(key);
      if (previous) previous.steps = [...new Set([...previous.steps, ...row.steps])];
      else grouped.set(key, row);
    }
    const sources = [...grouped.values()];
    const gathering = entry.gatheringRoutes || [];
    const routes = gathering.length
      ? `<section class="detail-block item-gathering"><h3>采集与掉落</h3>${more(gathering, (r) => `<div class="codex-source-row">${r.placeId && link(index, r.placeId) ? `${link(index, r.placeId)}<span>${r.kind === 'gather' ? '采集' : '掉落'}</span>` : text(r.label)}</div>`)}<details><summary>获取详情与来源</summary>${gathering.map((r) => `<h4>${text(r.label)}</h4><p>${richText(r.detail)}</p>${r.sources.map((s) => `<p>${act('source', text(s.title), 'text-btn', s.id)}<span class="small muted"> · ${text(s.date)} · ${text(s.version)}</span></p>`).join('')}`).join('')}</details></section>`
      : '';
    return (
      (sources.length
        ? `<section class="detail-block item-quest-sources"><h3>任务获取</h3><p class="small muted">各来源需触发对应步骤，不同分支不累计。</p>${more(sources, (r) => `<div class="codex-source-row" data-quest-step="${text(r.q.gameId)}" data-quest-steps="${r.steps.map(text).join(',')}">${sourceLink(index, r.q)}<span>${text(r.label)}${r.steps.length > 1 ? ` · ${r.steps.length} 处独立剧情结算` : ''}</span>${sourceDetails(r.q, r.steps, r.event)}</div>`)}</section>`
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
    const unlockRequirements = index.codex?.skills?.[entry.gameId]?.levelUnlockRequirements || [];
    const unlockCondition = (requirement) => {
      if (requirement.type === 'Item')
        return `持有 ${link(index, 'item-' + requirement.id) || text(`物品 #${requirement.id}`)} ×${text(requirement.value)}`;
      if (requirement.type === 'PreQuest') {
        const quest = link(index, 'quest-' + requirement.id);
        if (!quest && !requirement.name && requirement.value === 4) return '剧情解锁';
        const name = quest || text(requirement.name || '剧情条件');
        return `${name}：${text(['未开始', '进行中', '失败', '未接取', '已完成'][requirement.value] || requirement.value)}`;
      }
      return text(`${requirement.name || requirement.type} ${requirement.id} / ${requirement.value}`);
    };
    const unlocks = unlockRequirements.length
      ? `<section class="detail-block skill-level-unlocks"><h3>修炼突破</h3>${unlockRequirements.map((row) => `<div class="codex-source-row"><strong>突破 ${text(row.level)} 级</strong><span>${row.requirements.map(unlockCondition).join('；')}</span></div>`).join('')}</section>`
      : '';
    const consult = contract
      ? `<details class="detail-block skill-consult"><summary>请教条件${contract.excluded ? ' · 不可常规请教' : ` · 好感 ${text(contract.friendliness)}`}</summary>${contract.excluded ? '' : `<p>基础消耗 ${text(contract.skillPointCost)} 武学点；门派、难度或天赋可能减免。</p>${contract.requirements.length && index.renderRequirements ? index.renderRequirements(contract.requirements, index, { reference: null }) : ''}`}<details><summary>资料来源</summary><p>游戏资料表 · Build ${text(index.build)}</p></details></details>`
      : '';
    return `${manuals.length ? `<section class="detail-block skill-manuals"><h3>学习秘籍</h3><div class="related-items">${manuals.map((e) => link(index, e.id)).join('')}</div></section>` : ''}${unlocks}${consult}${teachers.length ? `<details class="detail-block skill-teachers" data-persist-detail="skill-teachers-${text(entry.gameId)}"><summary>请教线索 · ${teachers.length} 位${progress && origin !== 'live' ? ' · 保存时状态' : ''}</summary>${more(teachers, teacher)}</details>` : ''}${levels.length ? `<details class="detail-block skill-growth"><summary>各级属性提升</summary><div class="codex-growth">${levels.map((r) => `<div><strong>${r.level} 级</strong><span>${r.rows.map((a) => text(a.name + ' ' + a.value)).join(' · ')}</span></div>`).join('')}</div></details>` : ''}`;
  }
  return { quest, item, skill };
}
