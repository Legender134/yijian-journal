'use strict';
const assert = require('node:assert/strict');

async function progressValue(page) {
  return page.evaluate(async () => {
    const result = await window.journal.bootstrap();
    if (!result.ok) throw Error(result.error);
    const profile = result.data.state.profiles.find((row) => row.id === result.data.state.activeProfileId);
    return profile.referenceMode === 'none' ? '' : profile.saveSlot || '@latest';
  });
}

// Existing smoke flows can change the shared Settings reference and then resume
// their actual query UI. No renderer internals or synthetic selector controls are exposed.
async function selectProgress(page, value, { reopen = true } = {}) {
  const reading = await page.evaluate(() => {
    const recipe = document.querySelector('#recipe-quantity');
    const id =
      recipe?.dataset.id ||
      document.querySelector('.drawer [data-action="reserve-save"]')?.dataset.id ||
      document.querySelector('.drawer [data-action="world-person"]')?.dataset.id ||
      document.querySelector('.world-drawer [data-action="world-quest-goal"]')?.dataset.id;
    const pagination = document.querySelector('.person-gifts .history-pagination')?.textContent;
    return {
      route: document.querySelector('.nav-btn.active')?.dataset.id || 'home',
      fields: ['world-scope', 'world-status', 'world-search', 'list-search', 'craft-search'].flatMap((id) => {
        const field = document.getElementById(id);
        return field ? [{ id, value: field.value, select: field.tagName === 'SELECT' }] : [];
      }),
      id,
      quantity: recipe?.value,
      giftPage: Math.max(0, Number(pagination?.match(/第\s*(\d+)\s*\//)?.[1] || 1) - 1),
    };
  });
  const close = page.locator('#overlay [data-action="close-overlay"]');
  if (await close.count()) await close.first().click();
  await page.locator('.nav-btn[data-id="settings"]').click();
  await page.locator('[data-action="save-slot"]').click();
  await page.locator('#save-slot-select').selectOption(value || '@none');
  await page.locator('[data-action="save-slot-save"]').click();
  await page.locator('#save-slot-select').waitFor({ state: 'detached' });
  assert.equal(await progressValue(page), value === '@none' ? '' : value);
  await page.locator(`.nav-btn[data-id="${reading.route}"]`).click();
  for (const field of reading.fields) {
    const control = page.locator('#' + field.id);
    if (!(await control.count())) continue;
    if ((await control.inputValue()) === field.value) continue;
    const disclosures = page.locator('details').filter({ has: control });
    for (let i = 0; i < (await disclosures.count()); i++) {
      const disclosure = disclosures.nth(i);
      if (!(await disclosure.evaluate((element) => element.open)))
        await disclosure.locator(':scope > summary').click();
    }
    if (field.select) await control.selectOption(field.value);
    else await control.fill(field.value);
  }
  if (reopen && reading.id) {
    const target = await page.evaluate(async (id) => {
      const index = (await window.journal.bootstrap()).data.gameIndex;
      return [...index.entries, ...index.world.quests, ...index.world.maps].find((row) => row.id === id);
    }, reading.id);
    assert(target, 'the exact reading entry remains available');
    const kind = reading.id.startsWith('quest-') ? '任务' : target.kind;
    await page.keyboard.press('Control+k');
    await page.locator('#global-search').fill(`种类:${kind} 名称:${JSON.stringify(target.name)}`);
    await page.locator(`.search-result[data-id="${reading.id}"]`).click();
    await page.locator('.drawer h1').waitFor();
    if (reading.quantity !== undefined) await page.locator('#recipe-quantity').fill(reading.quantity);
    for (let index = 1; index <= reading.giftPage; index++) {
      const next = page.locator(`.person-gifts [data-action="gift-page"][data-id="${index}"]`);
      if (await next.count()) await next.click();
    }
  }
  assert.equal(
    await page.locator('#person-save, #item-save, #recipe-save, #world-save, #craft-save').count(),
    0,
  );
}

module.exports = { progressValue, selectProgress };
