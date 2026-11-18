import { entityCatalog, placeEntityId } from './entity-catalog.js';
import { itemEffectText } from './item-stat-views.js';
import { createQuestEffectViews } from './quest-effect-views.js';
import { martialConsultation, martialConsultationHint } from '../shared/martial-consultation.mjs';
import { storyNpcSkillClues } from './story-npc-skill-clues.js';

// Broken treasures are consumed by distinct repair handoffs; the linked
// public step contains that treasure's actual material requirements.
const brokenTreasureRepairs = {
  10415: 32751, 10416: 32756, 10417: 32761, 10418: 32766,
  10419: 32771, 10420: 32776, 10421: 32781, 10422: 32786,
};

// All cross-links use shipped entity IDs. Static outcomes never mutate or
// forecast the active quest state, and rewards from branches are never added.
export function createCodexDetailViews({ esc, act, richText = esc, guide = () => [] }) {
  const { effectList, choiceRows } = createQuestEffectViews({ esc, act });
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
  const sequenceConditions = {
    'opening-jade-gift': '开局在江吟风家中获赠',
    'opening-heart-manual': '夺回木剑后，回江家领取秘籍',
    'opening-heart-teaching': '夺回木剑后，回江家接受江吟风传授',
    'opening-sword-choice': '洞口选择「剑系武器」',
    'opening-fist-choice': '洞口选择「拳系武器」',
    'opening-knife-choice': '洞口选择「刀系武器」',
    'shaolin-23066-manual': '修行战结果满足条件后，同参心法剧情中',
    'shaolin-23070-manuals': '达摩秘传剧情中',
    'shaolin-23070-teaching': '达摩秘传过场有主角习得线索，是否取得需核对',
    'wuling-closure-teaching': '闭关过场有主角习得线索，是否取得需核对',
    'wudang-5217-manual': '拜师剧情中；使用另有角色条件',
    'shaolin-20531-items': '少林剧情战斗后的过场中；图纸使用条件另核',
    'xunguguan-24073-manual': '峋谷关剧情按前情分流进入此过场时',
    'sequence-clue': '剧情线索，触发条件待确认',
  };
  const sequenceSourceDetails = (condition) =>
    `<details><summary>资料来源</summary><p>${condition.startsWith('opening-') ? '游戏开局剧情' : '游戏任务过场'}</p></details>`;
  const gatherSourceDetails = '<details><summary>资料来源</summary><p>游戏地图与宝箱资料</p></details>';
  const sequenceSources = (index, entry, type) =>
    outcomeRows(index).flatMap(({ q, detail }) =>
      (detail.sequenceOutcomes || []).flatMap((outcome) => {
        const actions = outcome.actions.filter(
          (action) =>
            action.type === type &&
            action.id === entry.gameId &&
            Number.isSafeInteger(action.value) &&
            action.value > 0,
        );
        return actions.length && sequenceConditions[outcome.condition]
          ? [{ q, condition: outcome.condition,
              label: outcome.condition === 'sequence-clue' && q.gameId === 12674
                ? '黑白无常伏诛后，可到谭城留意相关过场'
                : outcome.condition === 'sequence-clue' && q.gameId === 20339
                  ? '玄火神丹回将军府后的相关过场'
                  : outcome.condition === 'sequence-clue' && q.gameId === 12583
                    ? '再遇无情的覆海蛟相关过场'
                    : outcome.condition === 'sequence-clue' && q.gameId === 30113
                      ? '武家旧事拜访吕员外的相关过场'
                      : outcome.condition === 'sequence-clue' && [22366, 22367].includes(q.gameId)
                        ? '天佛窟之战的部分后续；达摩秘传等进度可能影响分流'
                      : sequenceConditions[outcome.condition], actions,
              clueEvent: outcome.condition === 'sequence-clue' ? outcome.source?.event : null }]
          : [];
      }),
    );
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
  function collectionSources(index, entry) {
    const catalog = entityCatalog(index);
    const root = entry.kind === '任务' || entry.id?.startsWith('quest-') ? catalog.root(entry)?.gameId : null;
    const boxes = new Map();
    for (const rule of guide()) {
      if (root !== null && rule.questId !== root) continue;
      for (const stop of rule.collectionStops || []) {
        if (!Number.isSafeInteger(stop.gatherId)) continue;
        if (root === null && !stop.targets?.items?.some((item) => item.id === entry.id)) continue;
        const prior = boxes.get(stop.gatherId);
        if (prior) {
          prior.contexts.add(rule.title || rule.name);
          continue;
        }
        boxes.set(stop.gatherId, { rule, stop, contexts: new Set([rule.title || rule.name]) });
      }
    }
    if (!boxes.size) return '';
    const groups = new Map();
    for (const row of boxes.values()) {
      if (!groups.has(row.rule.id)) groups.set(row.rule.id, []);
      groups.get(row.rule.id).push(row);
    }
    return `<details class="detail-block codex-collection-sources" data-persist-detail="collection-sources-${text(entry.id)}"><summary>${root === null ? '宝箱获取' : '相关宝箱'} · ${boxes.size}</summary>${[
      ...groups.values(),
    ]
      .map((rows) => {
        const rule = rows[0].rule;
        const quest = catalog.entries.get('quest-' + rule.questId);
        const title = richText(rule.title || rule.name, rule.recommendation?.targets);
        const contexts = [...new Set(rows.flatMap((row) => [...row.contexts]))].filter(
          (value) => value !== (rule.title || rule.name),
        );
        return `<section><h4>${title}</h4><ol class="flow-guide-steps">${rows.map(({ stop }) => `<li data-gather-id="${text(stop.gatherId)}"><strong>${richText(stop.label, stop.targets)}</strong><p>${richText(stop.effect, stop.targets)}</p></li>`).join('')}</ol>${contexts.length ? `<details><summary>其他核对时点</summary>${contexts.map((value) => `<p>${text(value)}</p>`).join('')}</details>` : ''}${root === null && quest ? link(index, quest.id) : ''}${rule.sources?.length ? `<details><summary>资料来源</summary>${rule.sources.map((source) => `<p>${act('source', text(source.title), 'text-btn', source.id)}</p>`).join('')}${rule.uncertainty ? `<p>${text(rule.uncertainty)}</p>` : ''}</details>` : ''}</section>`;
      })
      .join('')}</details>`;
  }
  function relatedItemFlow(index, entry) {
    const catalog = entityCatalog(index);
    const groups = new Map();
    const namesItem = (targets) => targets?.items?.some((item) => item.id === entry.id);
    for (const row of guide()) {
      const advice = row.recommendation;
      const hint = advice?.hint || advice?.summary || advice?.action;
      if (
        !hint ||
        !namesItem(advice.targets) ||
        (row.collectionStops || []).some((stop) => namesItem(stop.targets))
      )
        continue;
      const quest = catalog.entries.get('quest-' + row.questId);
      if (!quest) continue;
      if (!groups.has(quest.id)) groups.set(quest.id, { quest, hints: new Map() });
      groups.get(quest.id).hints.set(hint, advice.targets);
    }
    return groups.size
      ? `<details class="detail-block codex-item-flow" data-persist-detail="item-flow-${text(entry.id)}"><summary>相关流程 · ${groups.size}</summary>${more([...groups.values()], ({ quest, hints }) => `<section><h4>${link(index, quest.id)}</h4><ul>${[...hints].map(([hint, targets]) => `<li>${richText(hint, targets)}</li>`).join('')}</ul></section>`)}</details>`
      : '';
  }
  function quest(index, entry, reference) {
    const catalog = entityCatalog(index);
    const family = new Set(catalog.family(entry).map((q) => q.gameId));
    const rows = outcomeRows(index).flatMap(({ q, detail }) => {
      if (!family.has(q.related?.gameId ?? q.gameId)) return [];
      const finish = detail.finish.map((actions) => effectList(index, actions, q));
      const choices = choiceRows(index, detail, q, { all: true });
      const blueprintOutcomes = (detail.blueprintOutcomes || [])
        .map((outcome) => ({ ...outcome, shown: effectList(index, outcome.actions, q) }))
        .filter((outcome) => outcome.shown.length);
      const sequenceOutcomes = (detail.sequenceOutcomes || [])
        .map((outcome) => ({
          label: sequenceConditions[outcome.condition],
          condition: outcome.condition,
          shown: effectList(index, outcome.actions, q),
        }))
        .filter((outcome) => outcome.label && outcome.shown.length);
      const events = [
        { label: '任务失败后', shown: effectList(index, detail.failed || [], q) },
        ...(detail.events || []).flatMap((event) => [
          { label: '剧情事件成功后', index: event.index, shown: effectList(index, event.success, q) },
          { label: '剧情事件失败后', index: event.index, shown: effectList(index, event.failure, q) },
        ]),
      ].filter((event) => event.shown.length);
      return finish.some((items) => items.length) ||
        choices.length ||
        events.length ||
        blueprintOutcomes.length ||
        sequenceOutcomes.length
        ? [{ q, detail, finish, choices, events, blueprintOutcomes, sequenceOutcomes }]
        : [];
    });
    const chests = (index.codex?.gatherSources || []).filter((source) => family.has(source.relatedQuestId));
    const mapHints = (index.questMapHints?.events || []).filter((hint) => hint.questId === entry.gameId);
    const mapCandidates = (index.questMapHints?.streamingParentCandidates || []).filter((hint) => hint.questId === entry.gameId);
    if (!rows.length && !chests.length && !mapHints.length && !mapCandidates.length) return '';
    const list = (items) => `<ul class="codex-effects">${items.map((s) => `<li>${s}</li>`).join('')}</ul>`;
    const render = ({ q, detail, finish, choices, events, blueprintOutcomes, sequenceOutcomes }) => {
      const promotionConditions = {
        'promotion-story-finished': '完成晋升剧情后',
        'promotion-story-followup-finished': '完成晋升剧情及后续结算后',
        'promotion-victory-dialogue-closed': '晋升比武胜利，结束结算对话后',
      };
      const promotions = blueprintOutcomes
        .map(
          (outcome) =>
            `<section class="codex-promotion-outcome"><h4>晋升收益</h4><p>${text(promotionConditions[outcome.condition])}</p>${list(outcome.shown)}<details><summary>资料来源</summary><p>游戏晋升剧情</p></details></section>`,
        )
        .join('');
      const sequences = sequenceOutcomes
        .map(
          (outcome) =>
            `<section class="codex-sequence-outcome"><h4>${text(outcome.label)}</h4>${list(outcome.shown)}${sequenceSourceDetails(outcome.condition)}</section>`,
        )
        .join('');
      const same = finish.every((items) => JSON.stringify(items) === JSON.stringify(finish[0]));
      const result = same
        ? finish[0].length
          ? list(finish[0])
          : ''
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
      const tableShown = finish.some((items) => items.length) || choices.length || events.length;
      const heading =
        q.related?.gameId === entry.gameId
          ? '相关剧情结算'
          : `${sourceLink(index, q)}${q.related ? ' · 相关剧情结算' : ''}`;
      return `<div class="codex-outcome-step" data-quest-step="${text(q.gameId)}">${q.gameId !== entry.gameId && tableShown ? `<h4>${heading}</h4>` : ''}${gates}${result}${promotions}${sequences}${events.map((event) => `<details><summary>${text(event.label)}</summary>${list(event.shown)}${sourceDetails(q, [q.gameId], event.index)}</details>`).join('')}${choices.map((choice) => `<details><summary>选择「${text(choice.text)}」</summary>${choice.requirements.length ? `<details><summary>选项出现条件</summary>${conditions(index, choice.requirements, reference)}</details>` : ''}${choice.shown.length ? list(choice.shown) : '<p class="small muted">后续影响需结合剧情判断。</p>'}</details>`).join('')}${tableShown ? sourceDetails(q) : ''}</div>`;
    };
    const chestBlock = chests.length
      ? `<details class="detail-block codex-chest-outcomes" data-persist-detail="quest-chests-${text(entry.gameId)}"><summary>山寨宝箱 · 按洞口选系</summary><p>${link(index, chests[0].placeId)} · 打开对应宝箱领取</p>${more(chests, (source) => `<section data-gather-id="${text(source.gatherId)}"><h4>${text(source.choice)}</h4>${list(effectList(index, source.actions, entry))}</section>`)}${gatherSourceDetails}</details>`
      : '';
    const mapHintBlock = mapHints.length
      ? `<details class="detail-block quest-map-hints"><summary>地图剧情线索</summary><p class="small muted">静态线索，实际触发情况待确认。</p>${more(mapHints, (hint) => {
          const maps = index.world?.maps || [];
          const places = maps.filter((place) => place.key === hint.mapKey);
          const names = [...new Set(places.map((place) => place.name).filter(Boolean))];
          const place = names.length === 1
            ? link(index, placeEntityId(places[0], maps)) || text(names[0])
            : '地点待确认';
          const descriptions = [];
          let unknown = false;
          for (const condition of hint.conditions || []) {
            const quest = catalog.entries.get(`quest-${condition.id}`);
            const person = catalog.entries.get(`npc-${condition.id}`);
            if (condition.type === 'PreQuest' && quest && [1, 4].includes(condition.value))
              descriptions.push(`${shortName(quest.name)}${condition.value === 1 ? '进行中' : '已完成'}`);
            else if (condition.type === 'NoQuest' && quest)
              descriptions.push(`${shortName(quest.name)}尚无记录`);
            else if (condition.type === 'TeamMember' && person)
              descriptions.push(`${shortName(person.name)}在队`);
            else unknown = true;
          }
          if (unknown) descriptions.push('其他条件待确认');
          return `<div class="codex-source-row"><span>${place}</span>${descriptions.length ? `<span>${descriptions.map(text).join('；')}</span>` : ''}</div>`;
        })}</details>`
      : '';
    return (
      (rows.length
        ? `<details class="detail-block codex-outcomes" data-persist-detail="quest-outcomes-${text(entry.gameId)}"><summary>奖励与选择影响${rows.length > 1 ? ` · ${rows.length} 个步骤` : ''}</summary>${more(rows, render)}</details>`
        : '') +
      chestBlock +
      mapHintBlock +
      (mapCandidates.length ? `<details class="detail-block"><summary>可能相关的地图 · ${mapCandidates.length} 条</summary><p class="small muted">静态线索，实际触发情况待确认。</p>${mapCandidates.map((hint) => {
        const maps = index.world?.maps || [];
        const place = maps.find((row) => row.key === hint.mapKey);
        let unknown = false;
        const descriptions = hint.conditions.flatMap((c) => {
          const quest = link(index, `quest-${c.id}`);
          const person = link(index, `npc-${c.id}`);
          const item = link(index, `item-${c.id}`);
          if (c.type === 'PreQuest' && quest && [1, 4].includes(c.value)) return [`${quest}${c.value === 1 ? '进行中' : '已完成'}`];
          if (c.type === 'NoQuest' && quest) return [`${quest}尚无记录`];
          if (c.type === 'TeamMember' && person) return [`${person}在队`];
          if (item && ['Item', 'ItemMax'].includes(c.type) && Number.isSafeInteger(c.value) && c.value > 0)
            return [c.type === 'Item' ? `${item} × ${c.value}` : `${item}：${c.value === 1 ? '未持有' : `数量少于 ${c.value}`}`];
          unknown = true;
          return [];
        });
        if (unknown) descriptions.push('其他条件待确认');
        return `<div class="codex-source-row"><span>${place ? link(index, placeEntityId(place, maps)) || text(place.name) : '地点待确认'}</span><span>${descriptions.join('；')}</span></div>`;
      }).join('')}</details>` : '') +
      collectionSources(index, entry)
    );
  }
  function item(index, entry) {
    const xuanyangForge = entry.gameId === 10459
      ? `<section class="detail-block"><h3>锻造风云奕</h3><p>庆功相关剧情后，可带玄阳龙骨×1到甘泉村找${link(index, 'npc-16012') || '欧阳海'}，选择兵器类型；词条随机。</p><p>${[[2061, '刀'], [1068, '剑'], [4060, '拳套'], [3061, '枪棍'], [5060, '暗器']].map(([id, name]) => entityCatalog(index).entries.has('item-' + id) ? act('database-detail', text(name), 'text-btn', 'item-' + id) : text(name)).join(' · ')}</p></section>`
      : '';
    const chenghuangSealCondition = entry.gameId === 10451
      ? `<section class="detail-block"><h3>使用后续</h3><p>${link(index, 'skill-833') || '晦朔心法'}、${link(index, 'skill-834') || '冥灵蛊诀'}和${link(index, 'skill-835') || '椿龄无尽玄'}均为10级时，相关剧情可能获得另一枚${link(index, 'item-10439') || '乘黄之印'}；任一不为10级时，可能再次获得此印。</p></section>`
      : '';
    const chenghuangSealSource = entry.gameId === 10439
      ? `<section class="detail-block item-story-source"><h3>剧情获取</h3><p>使用另一枚${link(index, 'item-10451') || '乘黄之印'}后，${link(index, 'skill-833') || '晦朔心法'}、${link(index, 'skill-834') || '冥灵蛊诀'}和${link(index, 'skill-835') || '椿龄无尽玄'}当次均恰为10级时，相关剧情可能获得此印。</p></section>`
      : '';
    const shaolinMartialStorySource = [13207, 13806].includes(entry.gameId)
      ? `<section class="detail-block item-story-source"><h3>剧情获取</h3><p>${link(index, 'quest-13000') || '晦明朝夕'}相关进度后，可到${link(index, 'place-1002') || '少林寺'}留意后续剧情，可能获得。</p></section>`
      : '';
    const qingyunManualSource = entry.gameId === 13480
      ? `<section class="detail-block item-story-source"><h3>剧情获取</h3><p>主角尚未习得青云扇法时，满足相关任务与扩展内容条件后，使用任务物品${link(index, 'item-10438') || '青云扇法'}可能获得此秘籍。</p></section>`
      : '';
    const tunafaManualSource = entry.gameId === 13804
      ? `<section class="detail-block item-story-source"><h3>剧情获取</h3><p>${link(index, 'npc-5505') || '慧达'}好感达到80后，可留意${link(index, 'quest-14010') || '春雷龙吟'}；取得并使用${link(index, 'item-10348') || '春雷龙吟曲谱'}，可能获得此秘籍。</p></section>`
      : '';
    const landscapePaintingSource = entry.gameId === 10081
      ? `<section class="detail-block item-story-source"><h3>剧情获取</h3><p>完成${link(index, 'quest-11200') || '千金难求'}后，带${link(index, 'npc-10221') || '陈麟熙'}到${link(index, 'place-610') || '无名岛'}留意剧情；满足前情时可能获得。</p></section>`
      : '';
    const islandHatSource = entry.gameId === 6019
      ? `<section class="detail-block item-story-source"><h3>剧情获取</h3><p>带${link(index, 'npc-11708') || '司马铃'}到${link(index, 'place-610') || '无名岛'}留意剧情，可能获得。</p></section>`
      : '';
    const islandTeaSource = entry.gameId === 10118
      ? `<section class="detail-block item-story-source"><h3>剧情获取</h3><p>带${link(index, 'npc-8001') || '冷鹰'}到${link(index, 'place-610') || '无名岛'}，可留意与他相关的互动；后续剧情可能获得。</p></section>`
      : '';
    const islandBottleSource = entry.gameId === 8026
      ? `<section class="detail-block item-story-source"><h3>剧情获取</h3><p>在${link(index, 'place-610') || '无名岛'}带${link(index, 'npc-12010') || '荀杳杳'}同行，留意家园同伴事件及后续；满足相关进度时可能获得。</p></section>`
      : '';
    const dragonTeaSource = entry.gameId === 10126
      ? `<section class="detail-block item-story-source"><h3>剧情获取</h3><p>带${link(index, 'npc-10131') || '白锦'}和${link(index, 'npc-7502') || '李元兴'}到${link(index, 'place-610') || '无名岛'}留意剧情，可能获得。</p></section>`
      : '';
    const erjunMedicineSource = [10478, 10479].includes(entry.gameId)
      ? `<section class="detail-block item-story-source"><h3>剧情获取</h3><p>在${link(index, 'place-914') || '洱郡'}留意相关剧情；考虑向${link(index, 'npc-10309') || '商葶苧'}求助时，选择「求助」，满足进度时可能获得。五仙教后续剧情可能消耗。</p></section>`
      : '';
    const eightTreasuresManualSource = [302, 303].includes(entry.gameId)
      ? `<section class="detail-block item-story-source"><h3>剧情获取</h3><p>修复八件奇珍后，留意${link(index, 'npc-19898') || '李清浊'}的后续，可能获得2本。</p></section>`
      : '';
    const lankavataraBookSource = entry.gameId === 10145
      ? `<section class="detail-block item-story-source"><h3>剧情获取</h3><p>尽早带${link(index, 'npc-5513') || '涤罪僧'}到${link(index, 'place-610') || '无名岛'}留意剧情；接取${link(index, 'quest-22050') || '找寻清霄'}可能影响入口，后续可能获得。</p></section>`
      : '';
    const pureYangFingerSource = entry.gameId === 13461
      ? `<section class="detail-block item-story-source"><h3>剧情获取</h3><p>${link(index, 'quest-5780') || '天水祝寿'}相关剧情时带${link(index, 'npc-8506') || '娜乌'}同行；后续留住程钰并完成喝粥剧情后，带她在${link(index, 'place-1000') || '武当派'}留意剧情，满足前情时可能获得。取得后使用。</p></section>`
      : '';
    const forbiddenTokenSource = entry.gameId === 10462
      ? `<section class="detail-block item-story-source"><h3>剧情获取</h3><p>${link(index, 'place-1000') || '武当派'}的相关剧情可能获得；后续可留意${link(index, 'quest-17542') || '云相太极'}。</p></section>`
      : '';
    const yanxiaRobeSource = entry.gameId === 9062
      ? `<section class="detail-block item-story-source"><h3>剧情获取</h3><p>带${link(index, 'npc-11708') || '司马铃'}同行，在${link(index, 'place-55') || '青木舫'}留意相关剧情；满足前情时可能获得。</p></section>`
      : '';
    const chaosFragmentSource = entry.gameId === 331
      ? `<section class="detail-block item-story-source"><h3>剧情获取</h3><p>持有${link(index, 'item-10429') || '混沌武典'}时，可留意绮罗筵相关后续过场，可能获得；使用需满足人物条件。</p></section>`
      : '';
    const xiaoRecordUse = entry.gameId === 10410
      ? `<section class="detail-block item-story-source"><h3>后续用途</h3><p>持有食录时，可留意峋谷关士兵的「萧家食谱」后续；与萧大爷交谈选「如实相告」，结算可能额外获得祖母绿、陨铁锭和钱。</p><details><summary>后续奖励</summary><p>两种回答的后续都可能获得${link(index, 'item-163') || '二十四气馄饨'}×1、${link(index, 'item-10539') || '海参'}×1、${link(index, 'item-10335') || '松茸'}×1、${link(index, 'item-10333') || '竹荪'}×2和${link(index, 'item-10325') || '竹笋'}×3；如实相告的后续还配置${link(index, 'item-10244') || '祖母绿'}×1、${link(index, 'item-10232') || '陨铁锭'}×1及800钱。</p></details></section>`
      : '';
    const gunpowderRegisterUse = entry.gameId === 10494
      ? `<section class="detail-block item-story-source"><h3>用途</h3><p>在背包打开并关闭名单后，留意向祝由询问详情。</p></section>`
      : '';
    const greenBambooSource = entry.gameId === 10392
      ? `<section class="detail-block item-story-source"><h3>采集获取</h3><p>「往竹海寻找青竹」进行时，可在${link(index, 'place-32') || '竹海'}留意青竹采集点。</p></section>`
      : '';
    const repairQuest = brokenTreasureRepairs[entry.gameId];
    const repairLink = repairQuest && link(index, `quest-${repairQuest}`);
    const repairUse = repairLink
      ? `<section class="detail-block item-repair-use"><h3>用途</h3><p>交给${link(index, 'npc-19898') || '李清浊'}后，留意${repairLink}。</p></section>`
      : '';
    const starChartUse = [10448, 10449].includes(entry.gameId)
      ? `<section class="detail-block"><h3>研习顺序</h3><p>完成欧阳衡会谈并带${link(index, 'npc-19112') || '叶飞'}同行，先用${entry.gameId === 10449 ? '紫微星图' : link(index, 'item-10449') || '紫微星图'}完成初研剧情，再用${entry.gameId === 10448 ? '紫微星图解' : link(index, 'item-10448') || '紫微星图解'}；主角与叶飞尚未掌握时，分别可能习得${link(index, 'skill-136') || '紫庭七元剑'}。</p></section>`
      : '';
    const starChartSource = entry.gameId === 10441
      ? `<section class="detail-block item-story-source"><h3>剧情获取</h3><p>完成${link(index, 'quest-24062') || '欧阳衡的请求'}后，带${link(index, 'npc-19112') || '叶飞'}同行使用另一份${link(index, 'item-10449') || '紫微星图'}，相关剧情可能获得此图。</p></section>`
      : '';
    const bambooManualSource = entry.gameId === 13871
      ? `<section class="detail-block item-story-source"><h3>剧情获取</h3><p>${link(index, 'quest-11855') || '白帝剑器'}第二次试炼相关剧情完成后，带${link(index, 'npc-10268') || '上官虹'}到${link(index, 'place-32') || '竹海'}找${link(index, 'npc-10309') || '商葶苧'}，后续可能获得；${link(index, 'quest-7005') || '龙蛇不辨'}的后续进度会影响触发。取得后使用。</p></section>`
      : '';
    const sixyaoManualSource = entry.gameId === 13884
      ? `<section class="detail-block item-story-source"><h3>剧情获取</h3><p>${link(index, 'place-936') || '藏宝洞'}机关后的剧情可能获得；未持有${link(index, 'item-10492') || '帛书'}时也有获取线索，持有时再按${link(index, 'item-10466') || '六爻无形剑气总纲'}分流。</p></section>`
      : '';
    const sixyaoQuestScroll = entry.gameId === 10465
      ? `<section class="detail-block"><h3>用途</h3><p>这是任务卷，不能直接使用；后续剧情可能获得另一份同名${link(index, 'item-13884') || '秘籍'}。</p></section>`
      : '';
    const pingkangManualSource = [13863, 13463].includes(entry.gameId)
      ? `<section class="detail-block item-story-source"><h3>剧情获取</h3><p>${link(index, 'quest-12090') || '平康麟子'}共饮时，${link(index, 'npc-10221') || '陈麟熙'}好感低于70的后续可能获得。${entry.gameId === 13463 ? `「通臂拳」秘籍对应武学${link(index, 'skill-463') || '通背拳'}。` : ''}</p></section>`
      : '';
    const jiuzhouManualSource = entry.gameId === 13906
      ? `<section class="detail-block item-story-source"><h3>剧情获取</h3><p>收齐九卷，带${link(index, 'npc-19830') || '步微月'}同行后使用${link(index, 'item-12505') || '天柱之卷'}；满足相关条件时，后续可能获得。剧情可能消耗其余八卷。</p><details><summary>查看九卷</summary><div class="related-items">${[10433, 10436, 12503, 12505, 12506, 12507, 12508, 12509, 12510].map((id) => link(index, `item-${id}`)).filter(Boolean).join('')}</div></details></section>`
      : '';
    const tongguiManualSource = entry.gameId === 13309
      ? `<section class="detail-block item-story-source"><h3>剧情获取</h3><p>${link(index, 'quest-5831') || '不告而别'}后，可在${link(index, 'place-400') || '天水城'}留意相关剧情，可能获得；触发也受${link(index, 'quest-13000') || '晦明朝夕'}、${link(index, 'quest-13250') || '再探苦水'}和主线进度影响。取得后使用。</p></section>`
      : '';
    const specialEquipmentSource = entry.gameId === 4063
      ? `<section class="detail-block item-story-source"><h3>剧情获取</h3><p>${link(index, 'quest-20100') || '回天剑宗'}的部分后续点醒元启后，可留意${link(index, 'npc-5013') || '道妙'}的对话，结算可能获得。</p></section>`
      : entry.gameId === 3070
        ? `<section class="detail-block item-story-source"><h3>宝箱获取</h3><p>取得并使用${link(index, 'item-10560') || '破旧的神秘宝箱'}后，开启结算可能获得。</p></section>`
        : '';
    const spicePouchSource = entry.gameId === 12502
      ? `<section class="detail-block item-story-source"><h3>获取与用途</h3><p>向${link(index, 'npc-19887') || '香料商人'}购买乳香，再从麝香、沉香、避神香中购买两种，可留意龙涎香囊的后续；修复${link(index, 'item-9071') || '凤凰衫'}需要麝香、沉香、乳香和香囊各1。</p></section>`
      : entry.gameId === 9071
        ? `<section class="detail-block item-story-source"><h3>修复材料</h3><p>修复遗珍凤凰衫时，需要麝香、沉香、乳香和${link(index, 'item-12502') || '龙涎香囊'}各1。</p></section>`
        : '';
    const islandCostumeSource = [10425, 10426].includes(entry.gameId)
      ? `<section class="detail-block item-story-source"><h3>剧情获取</h3><p>荒岛相关任务需要${link(index, 'item-10427') || '凌波仙子手札下册'}，可在${link(index, 'place-615') || '暮霞岛'}宝箱中寻找。使用后的剧情受前情及${link(index, 'npc-10268') || '上官虹'}、${link(index, 'npc-11708') || '司马铃'}是否同行影响。取得服饰后，带${link(index, entry.gameId === 10425 ? 'npc-10268' : 'npc-11708') || (entry.gameId === 10425 ? '上官虹' : '司马铃')}同行并满足使用条件，使用后可能解锁外观。</p></section>`
      : '';
    const lingboJournalUse = [10434, 10437].includes(entry.gameId)
      ? `<section class="detail-block item-story-source"><h3>剧情用途</h3><p>游仙村${link(index, 'quest-28702') || '解开机关'}前，持任一种同名上册并带${link(index, 'npc-10268') || '上官虹'}、${link(index, 'npc-11708') || '司马铃'}同行，可留意相关对话。</p></section>`
      : '';
    const jinglongMedicineSource = [165, 166].includes(entry.gameId)
      ? `<section class="detail-block item-story-source"><h3>剧情获取</h3><p>${link(index, 'quest-7005') || '龙蛇不辨'}相关剧情后、${link(index, 'quest-7220') || '五神殿商议'}前，可在${link(index, 'place-913') || '景陇'}留意后续；满足相关进度时可能获得。</p></section>`
      : '';
    const fishingKingSource = [304, 10585, 10581].includes(entry.gameId)
      ? `<section class="detail-block item-story-source"><h3>委托获取</h3><p>在${link(index, 'place-612') || '蟹岛'}完成${link(index, 'npc-19897') || '孤海钓叟'}的钓鱼委托，打开${link(index, 'item-10560') || '破旧的神秘宝箱'}后回访；完成后续可能获得。</p></section>`
      : '';
    const crabIslandChestSource = [100258, 100253, 10420, 304].includes(entry.gameId)
      ? `<section class="detail-block item-story-source"><h3>宝箱获取</h3><p>${link(index, 'place-612') || '蟹岛'}${[10420, 304].includes(entry.gameId) ? '上锁宝箱：完成当地钓鱼相关剧情后可留意' : '宝箱'}，可能获得。${[100258, 100253].includes(entry.gameId) ? '菜谱取得后需使用。' : ''}</p></section>`
      : '';
    const islandRelicSources = [10419, 100249, 280, 10335].includes(entry.gameId)
      ? `<section class="detail-block item-story-source"><h3>宝箱获取</h3><p>${link(index, 'place-611') || '霹雳岛'}钥匙相关剧情完成后，可留意岛上宝箱，可能获得。${entry.gameId === 100249 ? '菜谱取得后需使用。' : ''}</p></section>`
      : entry.gameId === 10418
        ? `<section class="detail-block item-story-source"><h3>宝箱获取</h3><p>${link(index, 'place-603') || '灵龟岛'}的宝箱可能获得。</p></section>`
        : '';
    const relicPlaces = {
      10415: ['place-609', '仙猿山'], 10416: ['place-613', '霓光岛'],
      10417: ['place-619', '水下岩洞'], 10421: ['place-614', '雾岛'],
      10422: ['place-615', '暮霞岛'],
    };
    const relicPlace = relicPlaces[entry.gameId];
    const relicChestSource = relicPlace
      ? `<section class="detail-block item-story-source"><h3>宝箱获取</h3><p>${link(index, relicPlace[0]) || relicPlace[1]}的宝箱可能获得。</p></section>`
      : '';
    const recipeChestPlaces = {
      100340: ['place-614', '雾岛'], 100336: ['place-610', '无名岛'],
      100338: ['place-609', '仙猿山'],
      100041: ['place-9', '梧桐村'], 100081: ['place-13', '洛村'],
      100011: ['place-14', '碗子山'], 100051: ['place-24', '碧幽林'],
      100321: ['place-57', '莲心湖'], 100022: ['place-44', '青萝山'],
      100002: ['place-23', '北山村'], 100082: ['place-20', '程家村'],
      100049: ['place-78', '野林地'], 100048: ['place-607', '幻林'],
      100025: ['place-26', '万劫窟宝库'], 100222: ['place-26', '万劫窟宝库'],
    };
    const recipeChestPlace = recipeChestPlaces[entry.gameId];
    const recipeChestSource = recipeChestPlace
      ? `<section class="detail-block item-story-source"><h3>宝箱获取</h3><p>${link(index, recipeChestPlace[0]) || recipeChestPlace[1]}的宝箱可能获得；取得后${[100340, 100336, 100338].includes(entry.gameId) ? '需满足扩展内容条件并' : ''}使用。</p></section>`
      : '';
    const mainlandChestSource = [100242, 10271, 10542].includes(entry.gameId)
      ? `<section class="detail-block item-story-source"><h3>宝箱获取</h3><p>${link(index, 'place-913') || '景陇'}的宝箱可能获得。${entry.gameId === 100242 ? '菜谱取得后需使用。' : ''}</p></section>`
      : [10377, 160, 100333].includes(entry.gameId)
        ? `<section class="detail-block item-story-source"><h3>宝箱获取</h3><p>${link(index, 'place-71') || '连鼓山'}的宝箱可能获得。${entry.gameId === 100333 ? '丹方取得后需使用。' : ''}</p></section>`
        : '';
    const bufengChestSource = [10358, 10359, 100074, 13707].includes(entry.gameId)
      ? `<section class="detail-block item-story-source"><h3>宝箱获取</h3><p>${link(index, 'place-307') || '不风山'}的宝箱可能获得。${entry.gameId === 100074 ? '图纸取得后需使用。' : entry.gameId === 13707 ? '取得后需满足使用条件。' : ''}</p></section>`
      : '';
    const specialMaterialChestSource = [10154, 10200].includes(entry.gameId)
      ? `<section class="detail-block item-story-source"><h3>宝箱获取</h3><p>${entry.gameId === 10154 ? link(index, 'place-23') || '北山村' : link(index, 'place-78') || '野林地'}的宝箱可能获得；${entry.gameId === 10154 ? `可留意${link(index, 'quest-14000') || '慧达'}的相关委托` : `修复${link(index, 'item-10418') || '紫竹篮'}时需要`}。</p></section>`
      : '';
    const offeringChestPlace = {
      10190: ['place-54', '桃花林'], 10181: ['place-921', '通幽沼'],
      10229: ['place-85', '仙人渡'], 10288: ['place-412', '一线天山谷'],
      10306: ['place-55', '青木舫'], 10230: ['place-40', '白龟洞'], 10234: ['place-406', '甘泉村'],
      10514: ['place-13', '洛村'], 10272: ['place-19', '博坊地窖'],
      10212: ['place-307', '不风山'], 10213: ['place-307', '不风山'], 10248: ['place-23', '北山村'],
      10260: ['place-11', '后山山洞'], 10289: ['place-25', '万劫窟'],
      10231: ['place-51', '樊城'], 10316: ['place-901', '石屏村'],
      10236: ['place-415', '卧秋山'], 10239: ['place-34', '饿虎坡'], 10237: ['place-320', '龙门峡'],
      10238: ['place-307', '不风山'], 10314: ['place-904', '幽云泽渡口'], 10553: ['place-613', '霓光岛'],
      10548: ['place-26', '万劫窟宝库'], 10557: ['place-614', '雾岛'],
      10270: ['place-610', '无名岛'], 10580: ['place-616', '玉璧岛'], 10588: ['place-612', '蟹岛'],
      10520: ['place-303', '黎城'],
    }[entry.gameId];
    const additionalChestPlace = {
      10230: ['place-85', '仙人渡'], 10234: ['place-415', '卧秋山'],
      10237: ['place-43', '素节林'], 10238: ['place-34', '饿虎坡'], 10239: ['place-68', '丐帮总舵'],
      10306: ['place-60', '谭城'], 10514: ['place-20', '程家村'],
    }[entry.gameId];
    const offeringChestSource = offeringChestPlace
      ? `<section class="detail-block item-story-source"><h3>宝箱获取</h3><p>${link(index, offeringChestPlace[0]) || offeringChestPlace[1]}${additionalChestPlace ? `、${link(index, additionalChestPlace[0]) || additionalChestPlace[1]}` : ''}的宝箱可能获得。</p></section>`
      : entry.gameId === 10304
        ? `<section class="detail-block item-story-source"><h3>宝箱获取</h3><p>${link(index, 'place-14') || '碗子山'}、${link(index, 'place-24') || '碧幽林'}和${link(index, 'place-27') || '姑苏城'}的宝箱可能获得。</p></section>`
      : '';
    const antiqueCoinChestSource = entry.gameId === 10055
      ? `<section class="detail-block item-story-source"><h3>其他宝箱</h3><p>${link(index, 'place-411') || '一线天'}、${link(index, 'place-409') || '苍岚村'}和${link(index, 'place-913') || '景陇'}的宝箱可能获得。</p></section>`
      : '';
    const additionalGatherPlaces = {
      10248: ['place-47', '断天崖'], 10502: ['place-61', '紫竹林'],
      10272: ['place-61', '紫竹林'], 10276: ['place-901', '石屏村'],
    };
    const additionalGatherPlace = additionalGatherPlaces[entry.gameId];
    const additionalResourceSource = entry.gameId === 10256
      ? `<section class="detail-block item-story-source"><h3>采集与宝箱</h3><p>${link(index, 'place-53') || '雷山'}可留意采集点，${link(index, 'place-603') || '灵龟岛'}的宝箱也可能获得；修复芭蕉扇时需要。</p></section>`
      : entry.gameId === 10213
        ? `<section class="detail-block item-story-source"><h3>采集</h3><p>${link(index, 'place-314') || '葬龙谷谷口'}可留意采集点。</p></section>`
      : additionalGatherPlace
        ? `<section class="detail-block item-story-source"><h3>采集</h3><p>${link(index, additionalGatherPlace[0]) || additionalGatherPlace[1]}可留意采集点。</p></section>`
      : entry.gameId === 10212
        ? `<section class="detail-block item-story-source"><h3>采集</h3><p>${link(index, 'place-40') || '白龟洞'}可留意采集点。</p></section>`
      : entry.gameId === 10232
        ? `<section class="detail-block item-story-source"><h3>宝箱获取</h3><p>${link(index, 'place-607') || '幻林'}的宝箱可能获得。</p></section>`
        : '';
    const lingboLowerChestSource = entry.gameId === 10427
      ? `<section class="detail-block item-story-source"><h3>宝箱获取</h3><p>${link(index, 'place-615') || '暮霞岛'}的宝箱可能获得；使用需满足扩展内容等条件，可留意后续剧情。</p></section>`
      : '';
    const lingboLowerStorySource = entry.gameId === 10428
      ? `<section class="detail-block item-story-source"><h3>剧情获取</h3><p>满足扩展内容等条件，使用另一册${link(index, 'item-10427') || '凌波仙子手札下册'}后，特定前情成立，或${link(index, 'npc-10268') || '上官虹'}和${link(index, 'npc-11708') || '司马铃'}同行时，相关剧情可能获得此册。</p></section>`
      : '';
    const bodhiBeadsSource = entry.gameId === 8077
      ? `<section class="detail-block item-story-source"><h3>剧情获取</h3><p>${link(index, 'quest-9254') || '少林诡夜'}前往东侧禅房的相关过场中，${link(index, 'npc-5513') || '涤罪僧'}好感达到60时可能获得。</p></section>`
      : '';
    const tigerCaveChestSource = [10360, 100085, 10291, 10215, 141].includes(entry.gameId)
      ? `<section class="detail-block item-story-source"><h3>宝箱获取</h3><p>击败插翅虎王猛后，可留意${link(index, 'place-35') || '饿虎坡山洞'}宝箱；还需相关任务进度满足条件。${entry.gameId === 100085 ? '图纸取得后需使用。' : ''}</p></section>`
      : '';
    const martialChestSource = [13722, 13310].includes(entry.gameId)
      ? `<section class="detail-block item-story-source"><h3>宝箱获取</h3><p>${entry.gameId === 13722 ? link(index, 'place-42') || '天剑宗' : link(index, 'place-56') || '落英林'}的宝箱可能获得；取得后需满足人物使用条件。</p></section>`
      : '';
    const otherMartialChestPlaces = {
      13851: ['place-22', '野猪林'], 13300: ['place-41', '檀林'],
      13162: ['place-1000', '武当派'], 13204: ['place-1002', '少林寺'],
      13214: ['place-413', '恶人谷'],
      13207: ['place-1009', '少林寺后山'], 13823: ['place-417', '神鹰门'],
      13222: ['place-917', '霹雳门库房'], 13443: ['place-1018', '达摩洞'],
    };
    const otherMartialChestPlace = otherMartialChestPlaces[entry.gameId];
    const otherMartialChestSource = otherMartialChestPlace
      ? `<section class="detail-block item-story-source"><h3>宝箱获取</h3><p>${link(index, otherMartialChestPlace[0]) || otherMartialChestPlace[1]}的宝箱可能获得，取得后使用。</p></section>`
      : '';
    const southernChestPlaces = {
      13511: ['place-902', '蝴蝶村'], 5019: ['place-902', '蝴蝶村'],
      13500: ['place-915', '蔓阴林'], 13502: ['place-911', '五仙教禁地'],
      100088: ['place-911', '五仙教禁地'],
    };
    const southernChestPlace = southernChestPlaces[entry.gameId];
    const southernChestSource = southernChestPlace
      ? `<section class="detail-block item-story-source"><h3>宝箱获取</h3><p>${link(index, southernChestPlace[0]) || southernChestPlace[1]}的宝箱可能获得。${entry.gameId === 5019 ? '' : '取得后使用。'}</p></section>`
      : '';
    const yogaManualChestSource = entry.gameId === 13860
      ? `<section class="detail-block item-story-source"><h3>宝箱获取</h3><p>断天崖底${link(index, 'place-49') || '崖底山洞'}的宝箱可能获得，取得后使用。</p></section>`
      : '';
    const hepuQuizSource = [10138, 10142].includes(entry.gameId)
      ? `<section class="detail-block item-story-source"><h3>问答获取</h3><p>在${link(index, 'place-88') || '和璞山庄'}找${entry.gameId === 10138 ? '慕仁' : '慕信'}，完成相关问答后可能获得。</p><details><summary>查看问答选项</summary><p>${entry.gameId === 10138 ? '广开言路 · 勤俭节约 · 牺牲与忍耐 · 送子为质 · 秦国虎视眈眈 · 诸侯国联合反对' : '道、天、地、将、法 · 取用于敌 · 不战而屈人之兵 · 避实击虚 · 山地应靠近山谷驻扎 · 通形、挂形、支形等'}</p></details></section>`
      : '';
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
            label: q.gameId === 11295 && entry.gameId === 100215 && type === 'CItem' && source.label === '完成获得'
              ? `碧幽林入口需铜钱超过1000，迎战后的特定结算可能获得 ${amount}`
              : `${source.label} ${amount}${random}`,
            event: source.event,
            steps: [q.gameId],
          });
        }
      }
    }
    for (const source of sequenceSources(index, entry, 'CItem'))
      rows.push({
        q: source.q,
        label: `${source.label} ×${source.actions.reduce((sum, action) => sum + action.value, 0)}`,
        steps: [source.q.gameId],
        condition: source.condition,
        clueEvent: source.clueEvent,
        sequence: true,
      });
    const grouped = new Map();
    for (const row of rows) {
      // Identical internal sources share a public navigation row. Preserve all
      // original step identities in provenance; do not add their quantities.
      const key = row.q.related
        ? JSON.stringify([row.q.related.id, row.label, row.event, row.sequence,
            row.clueEvent ? [row.q.gameId, row.clueEvent.frame, row.clueEvent.arrayByte, row.clueEvent.callByte] : null])
        : Symbol();
      const previous = grouped.get(key);
      if (previous) previous.steps = [...new Set([...previous.steps, ...row.steps])];
      else grouped.set(key, row);
    }
    const sources = [...grouped.values()];
    const chestRows = (index.codex?.gatherSources || []).flatMap((source) => {
      const amount = source.actions
        .filter(
          (action) =>
            action.type === 'CItem' &&
            action.id === entry.gameId &&
            Number.isSafeInteger(action.value) &&
            action.value > 0,
        )
        .reduce((sum, action) => sum + action.value, 0);
      return amount ? [{ ...source, amount }] : [];
    });
    const chests = chestRows.length
      ? `<section class="detail-block item-chest-sources"><h3>宝箱获取</h3>${more(chestRows, (source) => `<div class="codex-source-row" data-gather-id="${text(source.gatherId)}">${link(index, source.placeId)}<span>洞口选择「${text(source.choice)}」后，开山寨宝箱 ×${text(source.amount)}</span>${gatherSourceDetails}</div>`)}</section>`
      : '';
    const gathering = entry.gatheringRoutes || [];
    const routes = gathering.length
      ? `<section class="detail-block item-gathering"><h3>采集与掉落</h3>${more(gathering, (r) => `<div class="codex-source-row">${r.placeId && link(index, r.placeId) ? `${link(index, r.placeId)}<span>${r.kind === 'gather' ? '采集' : '掉落'}</span>` : text(r.label)}</div>`)}<details><summary>获取详情与来源</summary>${gathering.map((r) => `<h4>${text(r.label)}</h4><p>${richText(r.detail)}</p>${r.sources.map((s) => `<p>${act('source', text(s.title), 'text-btn', s.id)}<span class="small muted"> · ${text(s.date)} · ${text(s.version)}</span></p>`).join('')}`).join('')}</details></section>`
      : '';
    return (
      xuanyangForge +
      chenghuangSealCondition +
      chenghuangSealSource +
      shaolinMartialStorySource +
      qingyunManualSource +
      tunafaManualSource +
      landscapePaintingSource +
      islandHatSource +
      islandTeaSource +
      islandBottleSource +
      dragonTeaSource +
      erjunMedicineSource +
      eightTreasuresManualSource +
      lankavataraBookSource +
      pureYangFingerSource +
      forbiddenTokenSource +
      yanxiaRobeSource +
      chaosFragmentSource +
      xiaoRecordUse +
      gunpowderRegisterUse +
      greenBambooSource +
      repairUse +
      starChartUse +
      starChartSource +
      bambooManualSource +
      sixyaoManualSource +
      sixyaoQuestScroll +
      pingkangManualSource +
      jiuzhouManualSource +
      tongguiManualSource +
      specialEquipmentSource +
      spicePouchSource +
      islandCostumeSource +
      lingboJournalUse +
      jinglongMedicineSource +
      fishingKingSource +
      crabIslandChestSource +
      islandRelicSources +
      relicChestSource +
      recipeChestSource +
      mainlandChestSource +
      bufengChestSource +
      specialMaterialChestSource +
      offeringChestSource +
      antiqueCoinChestSource +
      additionalResourceSource +
      lingboLowerChestSource +
      lingboLowerStorySource +
      bodhiBeadsSource +
      tigerCaveChestSource +
      martialChestSource +
      otherMartialChestSource +
      southernChestSource +
      yogaManualChestSource +
      hepuQuizSource +
      (sources.length
        ? `<section class="detail-block item-quest-sources"><h3>任务获取</h3>${more(sources, (r) => `<div class="codex-source-row" data-quest-step="${text(r.q.gameId)}" data-quest-steps="${r.steps.map(text).join(',')}">${sourceLink(index, r.q)}<span>${text(r.label)}${entry.gameId === 13875 && r.steps.includes(16210) && r.steps.includes(16211) ? ' · 不同分支不累计' : r.steps.length > 1 ? ` · ${r.steps.length} 处剧情结算` : ''}</span>${r.sequence ? sequenceSourceDetails(r.condition) : sourceDetails(r.q, r.steps, r.event)}</div>`)}</section>`
        : '') +
      chests +
      routes +
      collectionSources(index, entry) +
      relatedItemFlow(index, entry)
    );
  }
  function skill(index, entry, progress, origin = 'saved') {
    const story = sequenceSources(index, entry, 'ASkill');
    const wudangStoryQuest = { 100: 5229, 800: 5229, 801: 5273, 101: 5302 }[entry.gameId];
    const openingWeapon = { 152: '剑', 153: '剑', 452: '拳', 453: '拳', 252: '刀', 253: '刀' }[entry.gameId];
    const hiddenStory = [132, 133, 134, 723].includes(entry.gameId)
      ? `<section class="detail-block skill-story-sources"><h3>剧情传授</h3><p>${link(index, 'place-304') || '峋谷关'}相关过场可能传授；${link(index, 'npc-19112') || '叶飞'}同行及${link(index, 'quest-24062') || '欧阳衡的请求'}进度可能影响触发。</p></section>`
      : [314, 421].includes(entry.gameId)
        ? `<section class="detail-block skill-story-sources"><h3>剧情传授</h3><p>${link(index, 'quest-12710') || '同游西凉'}的后续过场可能传授；若出现二选一，选择「${entry.gameId === 314 ? '镇派棒法' : '降龙神掌'}」。</p></section>`
      : entry.gameId === 840
        ? `<section class="detail-block skill-story-sources"><h3>剧情传授</h3><p>${link(index, 'quest-30080') || '流转'}的相关战斗后，后续过场可能传授。</p></section>`
      : [477, 478, 479].includes(entry.gameId)
        ? `<section class="detail-block skill-story-sources"><h3>剧情传授</h3><p>${link(index, 'quest-28000') || '东海明珠'}相关剧情过场可能传授；部分后续分支会检查太极神功。</p></section>`
      : [105, 403].includes(entry.gameId)
        ? `<section class="detail-block skill-story-sources"><h3>剧情传授</h3><p>${link(index, 'quest-5860') || '南疆之行'}的相关传功对话中，可选择「${entry.gameId === 105 ? '太极剑法' : '太极拳'}」；后续过场可能传授。</p></section>`
      : entry.gameId === 884
        ? `<section class="detail-block skill-story-sources"><h3>剧情传授</h3><p>${link(index, 'place-936') || '藏宝洞'}机关后的部分过场可能传授；分支受${link(index, 'item-10492') || '帛书'}和${link(index, 'item-10466') || '六爻无形剑气总纲'}影响。</p></section>`
      : entry.gameId === 802
        ? `<section class="detail-block skill-story-sources"><h3>剧情传授</h3><p>${link(index, 'quest-5330') || '武当大比'}的「初显锋芒」相关过场可能传授。</p></section>`
      : wudangStoryQuest
        ? `<section class="detail-block skill-story-sources"><h3>剧情传授</h3><p>${link(index, 'quest-' + wudangStoryQuest) || '武当相关剧情'}的过场可能传授。</p></section>`
      : openingWeapon
        ? `<section class="detail-block skill-story-sources"><h3>剧情传授</h3><p>开局选择${openingWeapon}系武器后，${link(index, 'quest-5087') || '木桩演练'}的过场可能传授。</p></section>`
      : entry.gameId === 136
        ? '<section class="detail-block skill-story-sources"><h3>剧情线索</h3><p>剧情分支有主角习得该武学的线索；触发条件未知，是否取得需核对。</p></section>'
        : '';
    // These bound sequence actions are clues, not guarantees that a route triggers.
    const replacementClues = {
      852: { questId: 5150, steps: '5160', label: '剧情过场有主角习得 1 级五灵心经-残的线索；触发条件待确认。' },
      854: { questId: 5368, steps: '5390', label: '剧情过场有替换线索：移除原残卷后习得此版本 3 级；触发条件待确认。' },
      856: { questId: 5940, steps: '5941', label: '剧情过场有替换线索：旧阶段风云诀-残替换为 6 级风云诀-残；触发条件待确认。' },
      857: { questId: 23200, steps: '23204、23205', label: '真武的两段相关过场均配置移除风云诀-残，并习得 8 级上清风云诀；实际触发和结果需核对。' },
    }[entry.gameId];
    const replacement = replacementClues
      ? `<section class="detail-block skill-story-sources"><h3>剧情线索</h3>${entry.gameId === 857 ? `<p>${link(index, 'quest-5990') || '英雄大会'}、${link(index, 'quest-9133') || '返回武当，向清虚复命'}的相关过场也有替换旧风云诀-残的线索。</p>` : ''}<div class="codex-source-row">${link(index, 'quest-' + replacementClues.questId)}<span>${text(replacementClues.label)}</span><details><summary>资料来源</summary><p>游戏任务过场 · 原始步骤 ${text(replacementClues.steps)}；实际触发与结果需在游戏内核对。</p></details></div></section>`
      : '';
    const manuals = index.entries.filter(
      (e) => e.kind === '物品' && e.stats?.effects.some((a) => a.type === 'ASkill' && a.id === entry.gameId),
    );
    const contract = index.skillConsultation?.[entry.gameId];
    // The default path has not established this flag as a hard gate for these
    // skills. Keep their teachers as leads, not confirmed options.
    const uncertainConsult = contract?.openForPlayer === false && !contract.excluded;
    const canConsult = contract && !contract.excluded && (contract.openForPlayer !== false || uncertainConsult);
    const consultation = canConsult
      ? martialConsultation(contract.grade, progress?.difficulty, index.martialConsultation)
      : null;
    const methodHint = martialConsultationHint(consultation);
    const currentPeople = new Map((progress?.people || []).map((person) => [person.npcId, person]));
    const learningFor = (person) =>
      currentPeople.get(person.gameId)?.learning.find((row) => row.entityId === entry.id);
    const storyTeacher = (person) =>
      storyNpcSkillClues.some((clue) => clue.npcId === person.gameId && clue.skillIds.includes(entry.gameId));
    const priority = (person) =>
      learningFor(person)?.status === 'met' ? 0 : currentPeople.has(person.gameId) ? 1 : 2;
    const teachers = canConsult
      ? index.entries
          .filter(
            (e) =>
              e.kind === '人物' &&
              ((e.functions?.includes('Consult') && (e.skills?.some((s) => s.id === entry.id) || storyTeacher(e))) || learningFor(e)),
          )
          .sort((a, b) => priority(a) - priority(b))
      : [];
    const teacher = (person) => {
      const current = currentPeople.get(person.gameId);
      const learning = learningFor(person);
      const label = uncertainConsult && learning?.status === 'met'
        ? '请教资格待确认'
        : learning
        ? learning.status === 'met' && learning.consultation?.method === 'battle'
          ? '需比试'
          : { met: '可请教', unmet: '条件未满足', unknown: '查看请教条件' }[learning.status]
        : current?.consult.status === 'unmet'
          ? '暂不能请教'
          : storyTeacher(person) ? '剧情后可能掌握，查看人物条件' : '查看人物条件';
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
      if (requirement.type === 'CurSaveDataItem') return '突破条件待确认';
      if (requirement.type === 'Item')
        return `持有 ${link(index, 'item-' + requirement.id) || text(`物品 #${requirement.id}`)} ×${text(requirement.value)}`;
      if (requirement.type === 'PreQuest') {
        if (entry.gameId === 872 && requirement.id === 17355 && requirement.value === 4)
          return `剧情解锁；可在${link(index, 'place-925') || '长生殿'}留意${link(index, 'npc-10309') || '商葶苧'}的相关后续`;
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
      ? `<details class="detail-block skill-consult"><summary>请教条件${uncertainConsult ? ' · 资格待确认' : !canConsult ? ' · 默认列表通常不显示' : ` · 好感 ${text(contract.friendliness)}${methodHint ? ' · ' + methodHint : ''}`}</summary>${!canConsult ? '' : `${uncertainConsult ? `<p>若可请教，品质对应好感 ${text(contract.friendliness)}${methodHint ? ` · ${text(methodHint)}` : ''}。</p>` : ''}<p>基础消耗 ${text(contract.skillPointCost)} 武学点；门派、难度或天赋可能减免。</p>${consultation ? `<p>初学 ${text(consultation.initialLevel)} 级${methodHint ? '；比试获胜才扣请教消耗' : ''}。</p>` : ''}${contract.requirements.length && index.renderRequirements ? index.renderRequirements(contract.requirements, index, { reference: null }) : ''}`}<details><summary>资料来源</summary><p>${methodHint ? '游戏资料与请教流程' : '游戏资料表'} · Build ${text(index.build)}</p></details></details>`
      : '';
    return `${hiddenStory}${replacement}${manuals.length ? `<section class="detail-block skill-manuals"><h3>${entry.gameId === 367 ? '秘籍线索，适用对象与条件待确认' : '学习秘籍'}</h3><div class="related-items">${manuals.map((e) => link(index, e.id)).join('')}</div></section>` : ''}${story.length ? `<section class="detail-block skill-story-sources"><h3>剧情传授</h3>${more(story, (row) => `<div class="codex-source-row" data-quest-step="${text(row.q.gameId)}">${sourceLink(index, row.q)}<span>${text(row.label)}</span>${sequenceSourceDetails(row.condition)}</div>`)}</section>` : ''}${unlocks}${consult}${teachers.length ? `<details class="detail-block skill-teachers" data-persist-detail="skill-teachers-${text(entry.gameId)}"><summary>请教线索 · ${teachers.length} 位${progress && origin !== 'live' ? ' · 保存时状态' : ''}</summary>${more(teachers, teacher)}</details>` : ''}${levels.length ? `<details class="detail-block skill-growth"><summary>各级修炼效果（资料）</summary><div class="codex-growth">${levels.map((r) => `<div><strong>${r.level} 级</strong><span>${r.rows.map((a) => text(a.name + ' ' + a.value)).join(' · ')}</span></div>`).join('')}</div></details>` : ''}`;
  }
  return { quest, item, skill };
}
