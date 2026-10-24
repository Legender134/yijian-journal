import { createJourneySummaryViews } from './journey-summary-views.js';
import { craftMoneyNotice } from './material-views.js';
export function createCompanionViews({
  esc,
  icon,
  act,
  iconButton,
  picture,
  qualityText,
  index = () => null,
  updateBadge = () => '',
}) {
  const summary = createJourneySummaryViews({ esc, act, index });
  function hintContent(h) {
    return h.id?.startsWith('item-') ? qualityText.name(h.id, h.title) : esc(h.title);
  }
  function passive(data) {
    const hints = data?.hints || [{ type: 'help', title: 'Ctrl＋Alt＋J 展开查询', label: '逸剑手札' }];
    return `<section class="hint-shell${hints.some((h) => h.type === 'flow-choice') ? ' hint-choice' : ''}" aria-label="随行轻提示"><div class="hint-head">${icon('leaf')}<span>逸剑手札</span><kbd>Ctrl Alt J</kbd></div>${hints
      .slice(0, 2)
      .map(
        (h) =>
          `<div class="hint-line${h.type === 'flow-caution' ? ' hint-caution' : ''}">${h.type === 'material' && h.id ? picture(h.id) : icon(h.type === 'material' ? 'bag' : h.type === 'flow-caution' ? 'info' : 'pin')}<span>${hintContent(h)}</span></div>`,
      )
      .join('')}</section>`;
  }
  function materialIdentity(material) {
    if (material.ids.length === 1) return summary.entityLink(`item-${material.ids[0]}`, material.name);
    return `<details data-compact-detail="material-alternatives-${esc(material.ids.join('-'))}"><summary>${esc(material.name)} · 可替代材料</summary><p class="save-note">补足组内总量即可，不需要备齐每一种。</p><div class="related-items">${material.ids.map((id) => summary.entityLink(`item-${id}`, index()?.entries.find((entry) => entry.id === `item-${id}`)?.name || `物品 #${id}`)).join('')}</div></details>`;
  }
  function materials(data, { managementLink = true } = {}) {
    const plan = data?.materials;
    const sharedMoney = craftMoneyNotice(data?.allocations, esc);
    const ownMoney = plan?.stages ? plan.stages.money : plan?.money;
    if (!plan) return sharedMoney + '<p class="small muted">暂无制作清单</p>';
    return `<section class="companion-materials">${sharedMoney}<h3>${icon('bag')} ${esc(data.materialsLabel || '当前备料')} · ${plan.recipes.length} 项配方</h3>${data.materialsCompleted ? '<p class="notice">个人已制作完成 · 用料已释放</p><p class="save-note">下方仅供若重新制作时核对；本计划不再计入待制作安排。</p>' : ''}${data.allocations?.baseMaterialMissingTotal > 0 ? `<p class="small shortage">${data.materialsCompleted ? '其他未完成的任务、制作与赠礼计划' : '全部任务、制作与赠礼计划'}共同还缺 ${data.allocations.baseMaterialMissingTotal} 件物资。</p>${act('navigate', '查看完整行程', 'text-btn', 'journey', 'map')}` : ''}${plan.materials.map((m) => `<div class="companion-material"><div>${materialIdentity(m)}</div><span class="${m.missing > 0 ? 'shortage' : 'muted'}">${data.materialsCompleted ? '若重做：' : ''}${m.missing === null ? `需 ${m.count} · 待核对` : m.missing ? `还缺 ${m.missing}` : '已齐'}</span></div>`).join('')}${plan.stages ? `<p class="small">${data.materialsCompleted ? '若重新制作：' : ''}原料还缺 ${plan.stages.rawMissingTotal ?? '待核对'} 件 · 先加工 ${plan.stages.workRemaining.processing} 次 · 再制作 ${plan.stages.workRemaining.final} 次</p>` : ''}<p class="small muted">${data.materialsCompleted ? '若重做' : '本清单'}含加工费用 ${ownMoney === null ? '待核对' : ownMoney.toLocaleString() + ' 文'}${data.materialsCompleted ? '，未纳入共同预算' : ''}</p>${managementLink ? act('main-materials', '调整清单与留用数量', 'btn soft', '', 'external') : ''}</section>`;
  }
  function frame(body, footer) {
    return `<div class="compact-shell"><div class="compact-title" title="拖动标题栏调整位置，拖动窗口边缘调整大小"><div class="row"><img class="app-mark" src="../assets/icon.svg" alt=""><span>逸剑手札</span></div>${iconButton('search', 'search', '搜索图鉴')}${iconButton('main', 'external', '打开完整手札')}${iconButton('companion-tuck', 'tuck', '收起随行')}${iconButton('companion-layout', 'more', '布局与显示')}</div><div class="companion-tabs">${act('navigate', '流程', 'text-btn', 'home', 'pin')}${act('navigate', '比武请教', 'text-btn', 'duels', 'duel')}${act('navigate', '图鉴', 'text-btn', 'database', 'book')}${act('navigate', '存档', 'text-btn', 'saves', 'archive')}</div><div class="compact-body">${body}</div><div class="compact-foot"><span data-save-health>${footer}</span><span data-update-badge>${updateBadge()}</span></div></div>`;
  }
  function edge() {
    return `<button id="companion-edge" class="companion-edge" data-action="companion-untuck" aria-label="展开随行" aria-expanded="false" title="展开随行，恢复原大小与位置">${icon('chevron')}<span>随行</span></button>`;
  }
  function actions(data) {
    const trip = data?.itinerary;
    if (trip?.steps.length) {
      const next = trip.next;
      const undo = trip.steps.filter(
        (s) => s.handled || s.skipped || (s.status === 'user-done' && s.craftPlanId),
      );
      return `<section data-companion-itinerary><h3 class="companion-section">${esc(trip.name)} · 还剩 ${trip.summary.remaining} 项</h3><p class="small muted">${trip.status === 'ended' ? '已结束' : trip.status === 'active' ? '进行中' : '待开始'}</p>${trip.status !== 'active' ? act('journey-itinerary-status', trip.status === 'ended' ? '继续这一程' : '开始这一程', 'btn soft', 'active') : ''}${next ? `<div class="compact-goal" data-itinerary-next="${esc(next.actionId)}"><strong>下一项 · ${summary.itineraryTitle(next)}</strong><p class="small muted">${summary.itineraryPlace(next)}</p><p class="small muted">${esc(next.reason)}</p><div class="row wrap">${next.action ? act('journey-open', '步骤与来源', 'text-btn', next.actionId, 'arrow') : next.continuation?.kind === 'choice-required' ? act('journey-open', '选择接续步骤', 'btn soft', next.actionId, 'arrow') : ''}${next.action?.craftPlanId ? act('craft-plan-complete', '完成整份制作计划…', 'btn soft', next.action.craftPlanId, 'check') : ''}${next.status === 'pending' ? act('journey-itinerary-handle', next.action?.craftPlanId ? '仅个人已处理 · 不释放用料' : '个人已处理', 'btn soft', next.actionId, 'check') : ''}${act('journey-itinerary-skip', '仅本次跳过', 'text-btn', next.actionId)}</div></div>` : '<p class="small muted">本次安排已处理完</p>'}${
        trip.upcoming.length
          ? `<details data-persist-detail="companion-itinerary-queue"><summary>后续队列 · ${trip.upcoming.length} 项</summary>${trip.upcoming
              .slice(0, 5)
              .map(
                (s) =>
                  `<div class="compact-goal"><strong>${s.position + 1}. ${summary.itineraryTitle(s)}</strong><p class="small muted">${summary.itineraryPlace(s)}${s.needsReview ? ' · 需核对原选择' : ''}</p></div>`,
              )
              .join('')}</details>`
          : ''
      }${
        undo.length
          ? `<details><summary>撤回个人处理、完成计划或本次跳过</summary>${undo
              .slice(-6)
              .map(
                (s) =>
                  `<div class="compact-goal"><strong>${summary.itineraryTitle(s)}</strong>${s.skipped ? act('journey-itinerary-skip', '撤回本次跳过', 'text-btn', s.actionId, 'refresh') : ''}${s.status === 'user-done' && s.craftPlanId ? act('craft-plan-complete', '重新打开制作计划', 'text-btn', s.craftPlanId, 'refresh') : ''}${s.handled ? act('journey-itinerary-handle', '撤回个人已处理', 'text-btn', s.actionId, 'refresh') : ''}</div>`,
              )
              .join('')}</details>`
          : ''
      }${trip.status === 'ended' ? `<p class="small muted">个人已处理 ${trip.summary.handled} · 个人已完成 ${trip.summary['user-done']} · 本次跳过 ${trip.summary.skipped} · 待核对 ${trip.summary.unavailable}。游戏完成 ${trip.summary['game-complete']} 和材料已齐 ${trip.summary.prepared} 来自当前参照，不是本次新增进度。</p>` : ''}<div class="row wrap mt">${trip.status === 'ended' ? act('journey-itinerary-journal', '写入江湖记录', 'btn soft', '', 'feather') : act('journey-itinerary-status', '结束并回顾', 'text-btn', 'ended')}${act('navigate', '查看与调整完整行程', 'btn soft', 'journey', 'book')}</div></section>`;
    }
    if (!data?.nextActions?.length) return '';
    return `<h3 class="companion-section">这一程做什么 · ${data.journeySummary.pending} 件待处理</h3>${data.nextActions
      .map((a) => {
        const title = a.gift ? a.title.replace(/^赠礼意图：/, '赠送：') : a.title;
        const stock = a.gift
          ? `<p class="small">${a.gift.allocationKnown ? (a.gift.missing ? '已备 ' + a.gift.allocated + ' · 还缺 ' + a.gift.missing : '已备齐 ' + a.gift.allocated + ' 件') : '赠礼数量待核对'}</p>`
          : '';
        return `<div class="compact-goal"><strong>${summary.actionTitle(a, title)}</strong>${a.places.length ? `<p class="small muted">${summary.places(a)}</p>` : ''}${stock}${!a.gift && a.unknowns ? '<p class="small muted">条件待核对</p>' : ''}${act('journey-open', a.gift ? '调整与完成' : '查看行动与条件', 'text-btn', a.id, 'arrow')}</div>`;
      })
      .join('')}${act('navigate', '按地点查看完整行程', 'btn soft', 'journey', 'book')}`;
  }
  return { passive, materials, actions, frame, edge };
}
