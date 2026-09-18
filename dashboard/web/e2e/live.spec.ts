import { expect, test, type Page } from '@playwright/test';

/**
 * Live view check against the deployed dashboard: submit a MuJoCo run (its tasks are `live: true`),
 * wait until the train task is RUNNING, prepare a "실시간 보기" session from the workflow page, embed it
 * and assert that real JPEG frames arrive through the gateway. Then follow the run to completion.
 *
 *   DASHBOARD_URL=... DASHBOARD_PASSWORD=... DASHBOARD_LIVE_E2E=1 LIVE_TEMPLATE=mujoco-pipeline \
 *   LIVE_OVERRIDES='{"total_steps":"300000","episodes":"3"}' npx playwright test e2e/live.spec.ts
 */
const TEMPLATE = process.env.LIVE_TEMPLATE ?? 'mujoco-pipeline';
const OVERRIDES: Record<string, string> = JSON.parse(process.env.LIVE_OVERRIDES ?? '{"total_steps":"300000","episodes":"3"}');
const PROJECT = process.env.PIPELINE_PROJECT ?? 'workshop';
const TIMEOUT_MIN = Number(process.env.LIVE_TIMEOUT_MIN ?? '40');
const TERMINAL = ['SUCCEEDED', 'FAILED', 'CANCELLED'];
test.skip(process.env.DASHBOARD_LIVE_E2E !== '1', 'Set DASHBOARD_LIVE_E2E=1 to submit a live-view run.');
test.use({ screenshot: 'off', trace: 'off', video: 'off' });

async function login(page: Page) {
  await page.goto('/');
  if (page.url().includes('amazoncognito.com') || page.url().includes('/login')) {
    const pass = process.env.DASHBOARD_PASSWORD;
    if (!pass) throw new Error('DASHBOARD_PASSWORD is required');
    const userInput = page.locator('input[name="username"]:visible').first();
    await userInput.waitFor({ state: 'visible', timeout: 30_000 });
    await userInput.fill(process.env.DASHBOARD_USER ?? 'admin');
    await page.locator('input[name="password"]:visible').first().fill(pass);
    await page.locator('input[name="signInSubmitButton"]:visible, button[type="submit"]:visible').first().click();
    await page.waitForURL((u) => !u.href.includes('amazoncognito.com'), { timeout: 60_000 });
  }
  await expect(page.getByText('Physical AI')).toBeVisible();
}
async function fetchWorkflow(page: Page, id: string) {
  return page.evaluate(async (wid) => {
    const d = await (await fetch(`/api/workflows/${wid}`)).json();
    return { status: (d.workflow?.status ?? d.status) as string, tasks: (d.tasks ?? []) as { name: string; phase: string; message?: string }[] };
  }, id);
}

test(`live view of a running ${TEMPLATE} task`, async ({ page }) => {
  test.setTimeout((TIMEOUT_MIN + 5) * 60_000);
  await login(page);
  const submitted = await page.evaluate(async ({ template, overrides, project }) => {
    const tpl = await (await fetch(`/api/templates/${template}`)).json();
    const res = await fetch('/api/workflows', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pai-project': project },
      body: JSON.stringify({ yaml: tpl.yaml, overrides, templateId: template, templateVersion: tpl.templateVersion, acknowledgePreflight: true }) });
    return { status: res.status, body: await res.json() };
  }, { template: TEMPLATE, overrides: OVERRIDES, project: PROJECT });
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(202);
  const id = submitted.body.id as string;
  console.log(`workflow ${id} submitted (${TEMPLATE})`, OVERRIDES);
  let status = submitted.body.status as string;
  try {
    // 1. wait for the first live task to run
    const deadline = Date.now() + TIMEOUT_MIN * 60_000;
    let running: string | undefined;
    while (Date.now() < deadline && !running && !TERMINAL.includes(status)) {
      await page.waitForTimeout(10_000);
      const wf = await fetchWorkflow(page, id);
      status = wf.status;
      running = wf.tasks.find((t) => t.phase === 'RUNNING')?.name;
      console.log(new Date().toISOString(), status, wf.tasks.map((t) => `${t.name}=${t.phase}`).join(' '));
    }
    expect(running, `no task reached RUNNING (status ${status})`).toBeTruthy();

    // 2. prepare and embed the live view from the workflow page
    await page.goto(`/workflows/${id}`);
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 });
    const card = page.getByLabel('실행 중인 작업');
    await page.locator('label:has-text("작업") select').first().selectOption(running!);
    const prepare = card.getByRole('button', { name: '실시간 보기 준비' });
    await expect(prepare).toBeEnabled({ timeout: 90_000 });
    await prepare.click();
    const here = page.getByRole('button', { name: '여기서 보기' });
    await expect(here).toBeEnabled({ timeout: 60_000 });
    await here.click();
    const frame = page.frameLocator('iframe[title="실시간 시뮬레이션 화면"]');
    await expect(frame.locator('#t')).toContainText('live · frame', { timeout: 120_000 });
    const src = await frame.locator('#v').getAttribute('src');
    expect(src).toContain('/stream');
    // The <img> decodes the first multipart frame asynchronously; wait for real pixels, not just the status line.
    await expect.poll(() => frame.locator('#v').evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 60_000 }).toBeGreaterThan(0);
    const size = await frame.locator('#v').evaluate((el) => [(el as HTMLImageElement).naturalWidth, (el as HTMLImageElement).naturalHeight]);
    console.log('live frame size', size, 'status', await frame.locator('#t').textContent());
    await page.screenshot({ path: `test-results/live-${TEMPLATE}-${running}.png`, fullPage: true });

    // 3. follow to completion so the run leaves published artifacts behind
    let lastLine = '';
    while (Date.now() < deadline && !TERMINAL.includes(status)) {
      await page.waitForTimeout(30_000);
      const wf = await fetchWorkflow(page, id);
      status = wf.status;
      const line = `${status} | ${wf.tasks.map((t) => `${t.name}=${t.phase}`).join(' ')}`;
      if (line !== lastLine) { console.log(new Date().toISOString(), line); lastLine = line; }
    }
    const detail = await fetchWorkflow(page, id);
    console.log('final', JSON.stringify(detail));
    expect(status, `workflow ${id} ended ${status}`).toBe('SUCCEEDED');
  } finally {
    if (!TERMINAL.includes(status)) {
      const cleanup = await page.evaluate(async (wid) => (await fetch(`/api/workflows/${wid}/cancel`, { method: 'POST' })).status, id);
      console.log('cancelled unfinished run', id, cleanup);
    }
  }
});
