'use strict';

async function revealMainPage(page, id) {
  const button = page.locator(`.sidebar-nav [data-action="navigate"][data-id="${id}"]`);
  if (!(await button.isVisible())) {
    const more = page.locator('.sidebar-nav > .nav-more');
    if (!(await more.evaluate((node) => node.open))) await more.locator(':scope > summary').click();
  }
  return button;
}

async function openMainPage(page, id) {
  await (await revealMainPage(page, id)).click();
}

async function openJournalFilters(page) {
  const filters = page.locator('[data-journal-filters]');
  if (!(await filters.evaluate((node) => node.open))) await filters.locator(':scope > summary').click();
}

async function openIntentEditorActions(page) {
  const more = page.locator('.gift-editor-actions');
  if ((await more.count()) && !(await more.evaluate((node) => node.open)))
    await more.locator(':scope > summary').click();
}

async function revealJournalAction(page, action) {
  const button = page.locator(`[data-action="${action}"]`);
  if (!(await button.isVisible())) {
    const management = page.locator('[data-journal-management]');
    if (!(await management.evaluate((node) => node.open)))
      await management.locator(':scope > summary').click();
  }
  return button;
}

async function chooseCodexKind(page, kind) {
  const picker = page.locator('#database-kind-picker');
  if (await picker.isVisible()) await picker.selectOption(kind);
  else await page.locator(`.database-tabs [data-action="database-kind"][data-id="${kind}"]`).click();
}

async function openTimelineEditor(page) {
  const editor = page.locator('.timeline-node-editor');
  await editor.waitFor({ state: 'attached' });
  if (!(await editor.evaluate((node) => node.open))) await editor.locator(':scope > summary').click();
}

async function openTimelinePreview(page, id) {
  const selector = `[data-action="timeline-preview"][data-id="${id}"]:visible`;
  const unused = page.locator('details[data-persist-detail="unused-timeline"]');
  if ((await unused.count()) && !(await unused.evaluate((node) => node.open)))
    await unused.locator(':scope > summary').click();
  if (!(await page.locator(selector).first().isVisible())) {
    const history = page.locator('.timeline-history-disclosure');
    if (!(await history.evaluate((node) => node.open))) await history.locator(':scope > summary').click();
  }
  await page.locator(selector).first().click();
}

module.exports = {
  revealMainPage,
  openMainPage,
  openJournalFilters,
  openIntentEditorActions,
  revealJournalAction,
  chooseCodexKind,
  openTimelineEditor,
  openTimelinePreview,
};
