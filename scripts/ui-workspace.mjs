/** Follow the same workspace navigation as a user; domain assertions stay in each suite. */
export async function openWorkspaceTool(page, tool) {
  await page.waitForSelector('.cc-workspace-toggle');
  if (await page.$(`#cc-workspace [data-workspace-page="${tool}"]`)) return;
  if (!(await page.$('#cc-workspace'))) await page.click('.cc-workspace-toggle');
  if (await page.$eval('#cc-workspace .cc-workspace-add', e => e.getAttribute('aria-expanded') !== 'true')) await page.click('#cc-workspace .cc-workspace-add');
  await page.$eval('#cc-workspace [aria-label="查找工作台工具"]', e => { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(e, ''); e.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForSelector(`#cc-workspace [data-workspace-tool="${tool}"]`, { visible: true });
  await page.click(`#cc-workspace [data-workspace-tool="${tool}"]`);
  await page.waitForSelector(`#cc-workspace [data-workspace-page="${tool}"]`, { visible: true });
}
export async function closeWorkspace(page) {
  if (await page.$('#cc-workspace')) await page.click('#cc-workspace [aria-label="关闭工作台"]');
  await page.waitForSelector('#cc-workspace', { hidden: true });
}
