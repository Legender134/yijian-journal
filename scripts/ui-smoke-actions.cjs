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

async function chooseCodexKind(page, kind) {
  const picker = page.locator('#database-kind-picker');
  if (await picker.isVisible()) await picker.selectOption(kind);
  else await page.locator(`.database-tabs [data-action="database-kind"][data-id="${kind}"]`).click();
}

module.exports = { revealMainPage, openMainPage, chooseCodexKind };
