import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { expect, test, type Download } from '@playwright/test';
import { loginThroughHostedUi, selectResearchProject } from './ui-audit-helpers';

// The dataset scenario creates and tombstones only its own tiny fixture.
test.skip(process.env.DASHBOARD_UI_REGRESSION_E2E !== '1', 'Set DASHBOARD_UI_REGRESSION_E2E=1 for deployed UI regressions.');
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

test('administrator sees every management tab under the authenticated admin session', async ({ page }) => {
  await loginThroughHostedUi(page);
  const me = await (await page.request.get('/api/me')).json();
  expect(me.role).toBe('admin');
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Admin Panel', exact: true })).toBeVisible({ timeout: 30_000 });
  for (const [tab, path, content] of [
    ['Users', '/api/admin/users', 'Users'],
    ['Audit Log', '/api/admin/audit', 'Audit Log'],
    ['Settings', '/api/admin/settings', 'Notifications'],
    ['Cost', '/api/cost', '30-Day Total'],
  ]) {
    await page.getByRole('button', { name: tab, exact: true }).click();
    await expect(page.getByRole('heading', { name: content, exact: true })).toBeVisible({ timeout: 30_000 });
    expect((await page.request.get(path)).status(), path).toBe(200);
  }
  await page.screenshot({ path: test.info().outputPath('administrator.png'), fullPage: true });
});

test('every storage bucket displays its first page without an empty continuation token', async ({ page }) => {
  await loginThroughHostedUi(page);
  const inventory = await page.request.get('/api/s3');
  expect(inventory.status()).toBe(200);
  const { buckets } = await inventory.json() as { buckets: { name: string; label: string }[] };
  expect(buckets.length).toBeGreaterThan(0);
  const responses: { bucket: string; status: number; token: string | null }[] = [];
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.pathname === '/api/s3' && url.searchParams.has('bucket')) {
      responses.push({ bucket: url.searchParams.get('bucket')!, status: response.status(), token: url.searchParams.get('token') });
    }
  });
  await page.goto('/storage');
  for (const bucket of buckets) {
    await page.getByRole('button', { name: bucket.label, exact: true }).click();
    await expect.poll(() => responses.some(response => response.bucket === bucket.name), { timeout: 30_000 }).toBe(true);
    const listings = responses.filter(response => response.bucket === bucket.name);
    expect(listings.every(response => response.status === 200), JSON.stringify(listings)).toBe(true);
    expect(listings.every(response => response.token !== ''), JSON.stringify(listings)).toBe(true);
    await expect(page.getByText('요청을 처리하지 못했습니다.', { exact: false })).toHaveCount(0);
  }
  await page.screenshot({ path: test.info().outputPath('storage.png'), fullPage: true });
});

test('dataset controls upload, finalize and download the same immutable bytes', async ({ page, context }) => {
  test.setTimeout(240_000);
  await loginThroughHostedUi(page);
  await selectResearchProject(page);
  const name = `ui-rootfix-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const bytes = Buffer.from(JSON.stringify({ verification: name, value: 42 }));
  let created = false;
  try {
    await page.goto('/datasets');
    await page.getByRole('button', { name: 'New dataset', exact: true }).click();
    await page.locator('input[name="name"]').fill(name);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByRole('link', { name, exact: true })).toBeVisible();
    created = true;
    await page.getByRole('link', { name, exact: true }).click();
    await page.getByRole('button', { name: '새 버전', exact: true }).click();
    await page.getByRole('button', { name: '생성', exact: true }).click();
    const upload = page.locator('input[type="file"][multiple]');
    await expect(upload).toBeEnabled({ timeout: 30_000 });
    await upload.setInputFiles({ name: 'audit.json', mimeType: 'application/json', buffer: bytes });
    await expect(page.getByText('audit.json', { exact: true }).first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: '검증 및 버전 확정', exact: true }).click();
    await expect(page.getByText('READY', { exact: true }).first()).toBeVisible({ timeout: 120_000 });
    await expect(upload).toBeDisabled();
    const downloads: Download[] = [];
    page.on('download', download => downloads.push(download));
    context.on('page', popup => popup.on('download', download => downloads.push(download)));
    await page.getByRole('button', { name: '다운로드', exact: true }).click();
    await expect.poll(() => downloads.length, { timeout: 30_000 }).toBeGreaterThan(0);
    expect(downloads[0].suggestedFilename()).toBe('audit.json');
    expect(await readFile((await downloads[0].path())!)).toEqual(bytes);
    await page.screenshot({ path: test.info().outputPath('dataset-ready.png'), fullPage: true });
  } finally {
    if (created) {
      await page.goto(`/datasets/${name}`);
      await page.getByRole('button', { name: '데이터셋 삭제', exact: true }).click();
      await page.getByRole('button', { name: '삭제', exact: true }).click();
      await page.waitForURL('**/datasets');
      expect((await page.request.get(`/api/datasets/${name}`)).status()).toBe(404);
    }
  }
});
