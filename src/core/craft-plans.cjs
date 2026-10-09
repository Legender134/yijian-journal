'use strict';
const { validateCraftList } = require('./material-plan.cjs');
const { validateCraftChoices } = require('./crafting-stages.cjs');
function validateCraftPlans(plans = []) {
  if (!Array.isArray(plans) || plans.length > 40) throw Error('每周目最多保存 40 份制作计划');
  const ids = new Set();
  for (const plan of plans) {
    if (
      !plan ||
      typeof plan !== 'object' ||
      Array.isArray(plan) ||
      Object.keys(plan).some(
        (k) => !['id', 'name', 'list', 'choices', 'reserved', 'done', 'createdAt', 'updatedAt'].includes(k),
      ) ||
      typeof plan.id !== 'string' ||
      !/^[a-zA-Z0-9-]{1,80}$/.test(plan.id) ||
      plan.id === 'current' ||
      ids.has(plan.id)
    )
      throw Error('制作计划编号或格式无效');
    ids.add(plan.id);
    if (typeof plan.name !== 'string' || !plan.name.trim() || plan.name.length > 80)
      throw Error('请为制作计划填写 80 字以内的名称');
    validateCraftList(plan.list);
    if (plan.choices !== undefined) validateCraftChoices(plan.choices);
    if (plan.reserved !== undefined && typeof plan.reserved !== 'boolean')
      throw Error('计划物资保留设置无效');
    if (plan.done !== undefined && typeof plan.done !== 'boolean') throw Error('制作计划完成状态无效');
    if (!plan.list.length) throw Error('制作计划至少需要一份配方');
    for (const key of ['createdAt', 'updatedAt'])
      if (typeof plan[key] !== 'string' || !Number.isFinite(Date.parse(plan[key])))
        throw Error('制作计划时间无效');
  }
  return plans;
}
module.exports = { validateCraftPlans };
