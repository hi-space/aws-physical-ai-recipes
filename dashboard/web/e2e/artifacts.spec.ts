import { expect, test, type Page } from '@playwright/test';

/**
 * Live check of the workflow Artifacts tab against the deployed dashboard: for each workflow, the
 * gallery must render at least one image/video from a presigned URL (when the run published media),
 * the file view must show an inline JSON preview, and legacy runs must explain why files are hidden.
 *
 *   DASHBOARD_URL=https://... DASHBOARD_PASSWORD=... ARTIFACT_WORKFLOWS=id1,id2 npx playwright test e2e/artifacts.spec.ts
 */
const WORKFLOWS = (process.env.ARTIFACT_WORKFLOWS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
test.skip(WORKFLOWS.length === 0, 'Set ARTIFACT_WORKFLOWS to the workflow IDs to inspect.');
test.use({ screenshot: 'off', trace: 'off', video: 'off' });

interface Artifacts { fileCount: number; mediaCount: number; tasks: { task: string; versions: { dataset: string; version: number; state: string; message?: string; files: { path: string; kind: string; previewable: boolean }[] }[] }[] }

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

for (const id of WORKFLOWS) {
  test(`artifacts tab renders published outputs of ${id}`, async ({ page }) => {
    test.setTimeout(240_000);
    await login(page);
    const summary = await page.evaluate(async (wid) => {
      const res = await fetch(`/api/workflows/${wid}/artifacts`);
      return { status: res.status, body: (await res.json()) as Artifacts };
    }, id);
    expect(summary.status, JSON.stringify(summary.body)).toBe(200);
    const versions = summary.body.tasks.flatMap((t) => t.versions.map((v) => ({ task: t.task, ...v })));
    console.log(id, JSON.stringify({ files: summary.body.fileCount, media: summary.body.mediaCount, versions: versions.map((v) => `${v.task}:${v.dataset}v${v.version}=${v.state}${v.message ? ` (${v.message})` : ''}`) }));

    await page.goto(`/workflows/${id}`);
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Artifacts', exact: true }).click();
    const viewer = page.getByTestId('artifact-viewer');
    await expect(viewer.or(page.getByText('표시할 결과 파일이 없습니다'))).toBeVisible({ timeout: 30_000 });

    const ready = versions.filter((v) => v.state === 'ready');
    for (const v of versions.filter((v) => v.state !== 'ready')) await expect(viewer.getByText(v.message ?? 'unavailable', { exact: false }).first()).toBeVisible();

    if (summary.body.mediaCount > 0) {
      const media = viewer.locator('img[alt], video[aria-label]').first();
      await expect(media).toHaveAttribute('src', /X-Amz-Signature=/, { timeout: 30_000 });
      await expect.poll(() => media.evaluate((el) => (el instanceof HTMLVideoElement ? el.readyState >= 1 : (el as HTMLImageElement).naturalWidth > 0)), { timeout: 45_000 }).toBe(true);
      await page.screenshot({ path: `test-results/artifacts-${id}-gallery.png`, fullPage: true });
    }

    const json = ready.flatMap((v) => v.files.filter((f) => f.kind === 'json' && f.previewable).map((f) => f.path))[0];
    if (json) {
      await viewer.getByRole('radio', { name: '파일', exact: true }).click();
      await viewer.getByRole('button', { name: new RegExp(json.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first().click();
      await expect(viewer.locator('pre')).toContainText('{', { timeout: 30_000 });
      await page.screenshot({ path: `test-results/artifacts-${id}-files.png`, fullPage: true });
    } else if (ready.length) {
      await viewer.getByRole('radio', { name: '파일', exact: true }).click();
      await page.screenshot({ path: `test-results/artifacts-${id}-files.png`, fullPage: true });
    } else {
      await page.screenshot({ path: `test-results/artifacts-${id}-legacy.png`, fullPage: true });
    }
  });
}
