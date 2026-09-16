import { expect, test, type Page } from '@playwright/test';

/**
 * Live pipeline run through the deployed dashboard: logs in via Cognito, opens the template in the
 * UI, submits it with the given overrides, then follows the workflow detail page until it reaches a
 * terminal phase, taking DAG screenshots along the way.
 *
 *   DASHBOARD_URL=https://... DASHBOARD_PASSWORD=... \
 *   PIPELINE_TEMPLATE=gr00t-pipeline PIPELINE_OVERRIDES='{"max_steps":"300"}' PIPELINE_TIMEOUT_MIN=120 \
 *   npx playwright test e2e/pipeline.spec.ts
 * Set PIPELINE_WORKFLOW_ID to follow an already-submitted workflow instead of submitting a new one.
 */
const TEMPLATE = process.env.PIPELINE_TEMPLATE ?? 'gr00t-pipeline';
const OVERRIDES: Record<string, string> = JSON.parse(process.env.PIPELINE_OVERRIDES ?? '{}');
const TIMEOUT_MIN = Number(process.env.PIPELINE_TIMEOUT_MIN ?? '120');
const TERMINAL = ['SUCCEEDED', 'FAILED', 'CANCELLED'];
const EXISTING = process.env.PIPELINE_WORKFLOW_ID;

/** GET /api/workflows/:id returns { workflow, tasks }. */
async function fetchWorkflow(page: Page, id: string): Promise<{ status: string; tasks: { name: string; phase: string; message?: string; outputPath?: string }[] }> {
  return page.evaluate(async (wid) => {
    const d = await (await fetch(`/api/workflows/${wid}`)).json();
    return { status: d.workflow?.status ?? d.status, tasks: d.tasks ?? [] };
  }, id);
}

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

test(`submit ${TEMPLATE} and follow it to completion`, async ({ page }) => {
  test.setTimeout((TIMEOUT_MIN + 5) * 60_000);
  await login(page);

  let id = EXISTING ?? '';
  let status = '';
  if (!EXISTING) {
    // Template gallery → parameter form (screenshot the form the researcher sees).
    await page.goto(`/workflows/new?template=${TEMPLATE}`);
    await page.waitForLoadState('load');
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `test-results/${TEMPLATE}-form.png`, fullPage: true });

    // Submit through the API with the template YAML + overrides (same call the form makes).
    const submitted = await page.evaluate(
      async ({ template, overrides }) => {
        const tpl = await (await fetch(`/api/templates/${template}`)).json();
        const res = await fetch('/api/workflows', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ yaml: tpl.yaml, overrides, templateId: template }) });
        return { status: res.status, body: await res.json() };
      },
      { template: TEMPLATE, overrides: OVERRIDES },
    );
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    id = submitted.body.id as string;
    status = submitted.body.status as string;
    console.log(`workflow ${id} submitted (${TEMPLATE})`, OVERRIDES);
  } else {
    console.log(`following existing workflow ${id}`);
  }

  await page.goto(`/workflows/${id}`);
  await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 });

  let lastLine = '';
  const deadline = Date.now() + TIMEOUT_MIN * 60_000;
  let shot = 0;
  while (Date.now() < deadline && !TERMINAL.includes(status)) {
    await page.waitForTimeout(30_000);
    const wf = await fetchWorkflow(page, id);
    status = wf.status;
    const line = `${status} | ${wf.tasks.map((t) => `${t.name}=${t.phase}`).join(' ')}`;
    if (line !== lastLine) {
      console.log(new Date().toISOString(), line);
      lastLine = line;
      await page.reload().catch(() => undefined);
      await page.waitForTimeout(3000);
      await page.screenshot({ path: `test-results/${TEMPLATE}-${String(shot++).padStart(2, '0')}-${status}.png`, fullPage: true });
    }
  }
  await page.reload().catch(() => undefined);
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `test-results/${TEMPLATE}-final-${status}.png`, fullPage: true });

  const detail = await fetchWorkflow(page, id);
  console.log('final', JSON.stringify({ status: detail.status, tasks: detail.tasks.map((t) => ({ name: t.name, phase: t.phase, message: t.message, outputPath: t.outputPath })) }, null, 2));
  expect(status, `workflow ${id} ended ${status}`).toBe('SUCCEEDED');
});
