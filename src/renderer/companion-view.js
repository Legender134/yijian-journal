export function createCompanionViews({ esc, icon, act, iconButton, picture, qualityText }) {
  function hintContent(h) {
    return h.id?.startsWith('item-') ? qualityText.name(h.id, h.title) : esc(h.title);
  }
  function passive(data) {
    const hints = data?.hints || [{ type: 'help', title: 'Ctrl＋Alt＋J 展开查询', label: '逸剑手札' }];
    const age = data?.reference
      ? Math.max(0, Math.floor((Date.now() - Date.parse(data.reference.modifiedAt)) / 60000))
      : null;
    const elapsed =
      age === 0
        ? '不足1分钟前'
        : age < 60
          ? `${age}分钟前`
          : age < 1440
            ? `${Math.floor(age / 60)}小时前`
            : `${Math.floor(age / 1440)}天前`;
    return `<section class="hint-shell" aria-label="随行轻提示"><div class="hint-head">${icon('leaf')}<span>逸剑手札</span><kbd>Ctrl Alt J</kbd></div>${hints
      .slice(0, 2)
      .map(
        (h) =>
          `<div class="hint-line">${h.type === 'material' && h.id ? picture(h.id) : icon(h.type === 'material' ? 'bag' : 'pin')}<span>${hintContent(h)}</span></div>`,
      )
      .join(
        '',
      )}<div class="hint-source">${data?.reference ? `${data.referenceMode === 'slot' ? '固定' : '存档'} ${esc(data.reference.name)} · ${elapsed}的已保存进度` : '手札记录 · 尚无可读存档'}</div></section>`;
  }
  function materials(data) {
    const plan = data?.materials;
    if (!plan)
      return '<p class="small muted">将配方加入备料清单，或在图鉴中加入制作目标，这里会随有效存档更新。</p>';
    return `<section class="companion-materials"><h3>${icon('bag')} ${esc(data.materialsLabel || '当前备料')} · ${plan.recipes.length} 项配方</h3>${data.materialsCompleted ? '<p class="notice">个人已制作完成 · 用料已释放</p><p class="save-note">下方仅供若重新制作时核对；本计划不再计入待制作安排。</p>' : ''}<p class="small muted">扣除其他任务、制作与赠礼占用后计算本清单；可替代食材按整份清单分配。</p>${data.allocations?.baseMaterialMissingTotal > 0 ? `<p class="small shortage">${data.materialsCompleted ? '其他未完成的任务、制作与赠礼计划' : '全部任务、制作与赠礼计划'}按加工安排的原料共同还缺 ${data.allocations.baseMaterialMissingTotal} 件，可在行程中查看每项需求。</p>${act('navigate', '查看完整行程', 'text-btn', 'journey', 'map')}` : ''}${plan.materials.map((m) => `<div class="companion-material"><span class="row">${picture(`item-${m.ids[0]}`)}<span>${m.ids.length === 1 ? qualityText.name(`item-${m.ids[0]}`, m.name) : esc(m.name)}</span></span><span class="${m.missing > 0 ? 'shortage' : 'muted'}">${data.materialsCompleted ? '若重做：' : ''}${m.missing === null ? `需 ${m.count} · 待核对` : m.missing ? `还缺 ${m.missing}` : '已齐'}</span></div>`).join('')}${plan.stages ? `<p class="small">${data.materialsCompleted ? '若重新制作：' : ''}原料端点还缺 ${plan.stages.rawMissingTotal ?? '待核对'} 件 · 先加工 ${plan.stages.workRemaining.processing} 次 · 再制作 ${plan.stages.workRemaining.final} 次</p><p class="save-note">预计加工产物仍须制作，当前赠礼和其他计划不能使用。</p>` : ''}<p class="small muted">${data.materialsCompleted ? '若重做：' : ''}铜钱${plan.copperMissing === null ? '未核对' : plan.copperMissing ? `还差 ${plan.copperMissing}` : '足够'}；配方是否学会与制作等级请在详细备料中核对。</p>${act('navigate', '调整清单与留用数量', 'btn soft', 'materials', 'bag')}</section>`;
  }
  function frame(body, footer) {
    return `<div class="compact-shell"><div class="compact-title"><div class="row">${icon('leaf')}逸剑手札 · 随行</div>${iconButton('main', 'maximize', '打开完整手札')}${iconButton('companion-collapse', 'minus', '收起随行面板')}</div><div class="companion-tabs">${act('navigate', '追踪', 'text-btn', 'home', 'pin')}${act('search', '查询', 'text-btn', '', 'search')}${act('navigate', '备料', 'text-btn', 'materials', 'bag')}${act('navigate', '历史', 'text-btn', 'saves', 'clock')}</div><div class="compact-body">${body}</div><div class="compact-foot">${footer}<span>Esc 收起 · Ctrl K 查询</span></div></div>`;
  }
  function actions(data) {
    const trip = data?.itinerary;
    if (trip?.steps.length) {
      const next = trip.next;
      const undo = trip.steps.filter(
        (s) => s.handled || s.skipped || (s.status === 'user-done' && s.craftPlanId),
      );
      return `<section data-companion-itinerary><h3 class="companion-section">${esc(trip.name)} · 还剩 ${trip.summary.remaining} 项</h3><p class="small muted">你选定的顺序 · ${trip.status === 'ended' ? '已结束，可继续' : trip.status === 'active' ? '进行中，随时续接' : '已选好，准备开始'}</p>${trip.status !== 'active' ? act('journey-itinerary-status', trip.status === 'ended' ? '继续这一程' : '开始这一程', 'btn soft', 'active') : ''}${next ? `<div class="compact-goal" data-itinerary-next="${esc(next.actionId)}"><strong>下一项 · ${esc(next.title)}</strong><p class="small muted">${next.selectedPlace ? esc(next.selectedPlace.name) + ' · 场景 #' + esc(next.selectedPlace.id.slice(6)) : '未分组事项'}</p><p class="small muted">${esc(next.reason)}</p><div class="row wrap">${next.action ? act('journey-open', '步骤与来源', 'text-btn', next.actionId, 'arrow') : next.continuation?.kind === 'choice-required' ? act('journey-open', '选择接续步骤', 'btn soft', next.actionId, 'arrow') : ''}${next.action?.craftPlanId ? act('craft-plan-complete', '完成整份制作计划…', 'btn soft', next.action.craftPlanId, 'check') : ''}${next.status === 'pending' ? act('journey-itinerary-handle', next.action?.craftPlanId ? '仅个人已处理 · 不释放用料' : '个人已处理', 'btn soft', next.actionId, 'check') : ''}${act('journey-itinerary-skip', '仅本次跳过', 'text-btn', next.actionId)}</div></div>` : '<p class="small muted">本次已无待处理项；可以回顾并写下这一程。</p>'}${
        trip.upcoming.length
          ? `<details open><summary>后续队列 · ${trip.upcoming.length} 项</summary>${trip.upcoming
              .slice(0, 5)
              .map(
                (s) =>
                  `<div class="compact-goal"><strong>${s.position + 1}. ${esc(s.title)}</strong><p class="small muted">${s.selectedPlace ? esc(s.selectedPlace.name) + ' · 场景 #' + esc(s.selectedPlace.id.slice(6)) : '未分组事项'}${s.needsReview ? ' · 需核对原选择' : ''}</p></div>`,
              )
              .join(
                '',
              )}${trip.upcoming.length > 5 ? `<p class="small muted">其余 ${trip.upcoming.length - 5} 项在完整行程中。</p>` : ''}</details>`
          : ''
      }${
        undo.length
          ? `<details><summary>撤回个人处理、完成计划或本次跳过</summary>${undo
              .slice(-6)
              .map(
                (s) =>
                  `<div class="compact-goal"><strong>${esc(s.title)}</strong>${s.skipped ? act('journey-itinerary-skip', '撤回本次跳过', 'text-btn', s.actionId, 'refresh') : ''}${s.status === 'user-done' && s.craftPlanId ? act('craft-plan-complete', '重新打开制作计划', 'text-btn', s.craftPlanId, 'refresh') : ''}${s.handled ? act('journey-itinerary-handle', '撤回个人已处理', 'text-btn', s.actionId, 'refresh') : ''}</div>`,
              )
              .join('')}</details>`
          : ''
      }${trip.status === 'ended' ? `<p class="small muted">个人已处理 ${trip.summary.handled} · 个人已完成 ${trip.summary['user-done']} · 本次跳过 ${trip.summary.skipped} · 待核对 ${trip.summary.unavailable}。游戏完成 ${trip.summary['game-complete']} 和材料已齐 ${trip.summary.prepared} 来自当前参照，不是本次新增进度。</p>${act('journey-itinerary-journal', '写入江湖记录', 'btn soft', '', 'feather')}` : act('journey-itinerary-status', '结束并回顾', 'text-btn', 'ended')}${act('navigate', '查看与调整完整行程', 'btn soft', 'journey', 'book')}</section>`;
    }
    if (!data?.nextActions?.length) return '';
    return `<h3 class="companion-section">这一程做什么 · ${data.journeySummary.pending} 件待处理</h3>${data.nextActions
      .map(
        (a) =>
          `<div class="compact-goal"><strong>${esc(a.title)}</strong>${a.places.length ? `<p class="small muted">地点线索：${a.places.map(esc).join('、')}</p>` : ''}${a.gift ? `<p class="small">${a.gift.allocationKnown ? '此赠礼已分配 ' + a.gift.allocated + ' · 还缺 ' + a.gift.missing : '赠礼库存待核对'}</p>` : ''}<p class="small muted">${a.unknowns ? '含待核对条件，请查看步骤与来源。' : '来自当前周目的记录与计划。'}</p>${act('journey-open', '查看行动与条件', 'text-btn', a.id, 'arrow')}</div>`,
      )
      .join('')}${act('navigate', '按地点查看完整行程', 'btn soft', 'journey', 'book')}`;
  }
  return { passive, materials, actions, frame };
}
