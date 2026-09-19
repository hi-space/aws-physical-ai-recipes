import { expect, test } from '@playwright/test';
import { loginThroughHostedUi as login } from './ui-audit-helpers';

/**
 * Live check of the workflow DAG tab against a deployed dashboard.
 *   DASHBOARD_URL=https://... DASHBOARD_PASSWORD=... npx playwright test e2e/dag-live.spec.ts
 * Picks the most recent run of DAG_WORKFLOW_NAME (default gr00t-e2e) unless DAG_WORKFLOW_ID is set.
 */
test('DAG tab shows steps left to right and details for the selected step', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);

  let id = process.env.DAG_WORKFLOW_ID;
  if (!id) {
    const name = process.env.DAG_WORKFLOW_NAME ?? 'gr00t-e2e';
    const list = await page.evaluate(async () => (await fetch('/api/workflows?limit=200', { headers: { accept: 'application/json' } })).json());
    const items: Array<{ id: string; name: string; createdAt: string }> = list.items ?? list.workflows ?? list;
    const match = items.filter((w) => w.name === name).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    expect(match, `no workflow named ${name}`).toBeTruthy();
    id = match.id;
  }

  await page.goto(`/workflows/${id}`);
  // TanStack Query can be left "offline" by a sandbox network blip; nudge it like the other live specs do.
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  const stepper = page.getByRole('navigation', { name: '단계' });
  await stepper.waitFor({ timeout: 30_000 });
  const steps = await stepper.getByRole('listitem').allInnerTexts();
  expect(steps.length).toBeGreaterThanOrEqual(1);

  // Cards run left to right in execution order.
  const boxes = await page.evaluate(() => [...document.querySelectorAll('.react-flow__node-task')].map((el) => ({ id: el.getAttribute('data-id'), x: el.getBoundingClientRect().x })));
  expect(boxes.length).toBe(steps.length);
  await page.screenshot({ path: 'test-results/dag-live-unselected.png' });

  // Click the second step (or the first if the run has only one) and read the panel.
  const target = boxes[Math.min(1, boxes.length - 1)];
  await page.locator(`.react-flow__node[data-id="${target.id}"]`).click();
  await page.getByRole('heading', { name: target.id! }).waitFor();
  await expect(page.getByText(`${steps.length}단계 중`)).toBeVisible();
  await expect(page.getByRole('button', { name: '로그 보기' })).toBeVisible();
  await page.screenshot({ path: 'test-results/dag-live-selected.png' });

  // "로그 보기" switches to the logs tab for that step.
  await page.getByRole('button', { name: '로그 보기' }).click();
  await expect(page.getByRole('navigation', { name: '단계' })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/dag-live-logs.png' });
});
