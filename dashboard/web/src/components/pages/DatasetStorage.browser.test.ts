import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Page } from 'playwright';
import type { ServerResponse } from 'node:http';
import type { UploadSession } from '@/lib/multipart-upload';
import { fixtureMe, json, storageAdminBrowser } from './test-utils/storage-admin-browser';

const opaque = 'a+b/c==&next';
const versionPath = '/api/datasets/fixture-data/versions/1';
const folder = 'clips +&/';

describe.each(['storage', 'dataset'] as const)('%s listing URL contracts', component => {
  let fixture: Awaited<ReturnType<typeof storageAdminBrowser>>, page: Page;
  beforeAll(async () => {
    fixture = await storageAdminBrowser(component, (call, response) => {
      const { pathname, searchParams } = call.url;
      if (pathname === '/api/me') return json(response, fixtureMe);
      if (pathname === '/api/datasets/fixture-data') return json(response, dataset());
      if (pathname === versionPath + '/uploads') return json(response, []);
      if (pathname === '/api/s3' || pathname === versionPath) {
        const token = searchParams.get('token');
        if (token && token !== opaque) return json(response, { error: 'Corrupted continuation token' }, 400);
        const prefix = searchParams.get('prefix') ?? '';
        const root = component === 'dataset' ? 'datasets/upload/' : '';
        return json(response, {
          bucket: 'fixture-bucket', prefix: root + prefix,
          entries: [
            { name: token ? 'second.txt' : 'first.txt', key: root + prefix + (token ? 'second.txt' : 'first.txt'), size: 3, isPrefix: false },
            { name: 'clips +&', key: root + folder, isPrefix: true },
          ],
          nextToken: token || prefix ? undefined : opaque,
        });
      }
      throw new Error(`Missing fixture: ${call.method} ${pathname}`);
    });
  }, 30000);
  beforeEach(async () => { fixture.calls.length = 0; fixture.unexpected.length = 0; page = await fixture.page(); });
  afterEach(async () => { await page.close(); expect(fixture.unexpected).toEqual([]); });
  afterAll(async () => fixture.close());
  const listings = () => fixture.calls.filter(call => call.url.pathname === (component === 'storage' ? '/api/s3' : versionPath));

  it('omits the first-page token and renders the returned files', async () => {
    await page.goto(fixture.origin);
    await page.getByText('first.txt', { exact: true }).waitFor();
    expect(listings().length).toBeGreaterThan(0);
    expect(listings().every(call => !call.url.searchParams.has('token'))).toBe(true);
  });

  it('round-trips an opaque next token and clears it when navigating to a folder', async () => {
    await page.goto(fixture.origin);
    await page.getByRole('button', { name: component === 'storage' ? 'Load more' : '다음', exact: true }).click();
    await expect.poll(() => listings().some(call => Boolean(call.url.searchParams.get('token')))).toBe(true);
    expect(listings().at(-1)!.url.searchParams.get('token')).toBe(opaque);
    expect(listings().at(-1)!.url.searchParams.has('next')).toBe(false);
    await page.getByText('second.txt', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'clips +&/', exact: true }).click();
    await expect.poll(() => listings().at(-1)!.url.searchParams.get('prefix')).toBe(folder);
    expect(listings().at(-1)!.url.searchParams.has('token')).toBe(false);
    await page.getByRole('button', { name: component === 'storage' ? 'fixture-bucket' : 'fixture-data / v1', exact: true }).click();
    await expect.poll(() => listings().at(-1)!.url.searchParams.get('prefix')).toBe('');
    expect(listings().at(-1)!.url.searchParams.has('token')).toBe(false);
  });
});

function version(state: 'PENDING' | 'READY' = 'PENDING', imported = false) {
  return {
    dataset: 'fixture-data', version: 1, uri: 's3://fixture-bucket/datasets/upload/',
    state, imported, tags: [], createdAt: '2026-09-18T00:00:00Z', createdBy: 'fixture-admin',
  };
}
function dataset(versions = [version()]) {
  return {
    dataset: { name: 'fixture-data', owner: 'fixture-admin', tags: [], latestVersion: 1, createdAt: '2026-09-18T00:00:00Z', updatedAt: '2026-09-18T00:00:00Z' },
    versions, lineage: { produced: [], consumers: [] },
  };
}

describe('DatasetDetailPage upload availability', () => {
  let fixture: Awaited<ReturnType<typeof storageAdminBrowser>>, page: Page;
  let listingMode: 'ok' | 'error' | 'loading', versions: ReturnType<typeof version>[], role: 'admin' | 'viewer';
  let sessions: UploadSession[], heldResponses: ServerResponse[];
  beforeAll(async () => {
    fixture = await storageAdminBrowser('dataset', (call, response) => {
      const { pathname } = call.url;
      if (pathname === '/api/me') return json(response, { ...fixtureMe, role });
      if (pathname === '/api/datasets/fixture-data') return json(response, dataset(versions));
      if (pathname === versionPath && call.method === 'GET') {
        if (listingMode === 'loading') { heldResponses.push(response); return; }
        if (listingMode === 'error') return json(response, { error: 'Listing is temporarily unavailable' }, 503);
        return json(response, { bucket: 'fixture-bucket', prefix: 'datasets/upload/', entries: [], immutable: versions[0].state === 'READY' });
      }
      if (pathname === versionPath && call.method === 'POST') {
        versions = [version('READY')];
        return json(response, versions[0]);
      }
      if (pathname === versionPath + '/uploads') {
        if (call.method === 'GET') return json(response, sessions);
        const session: UploadSession = {
          id: 'session-1', filename: String(call.body.filename), size: Number(call.body.size),
          lastModified: Number(call.body.lastModified), partSize: 5, partCount: 1, state: 'UPLOADING', parts: [],
        };
        sessions = [session];
        return json(response, session);
      }
      if (pathname === versionPath + '/uploads/session-1') {
        if (call.method === 'DELETE') {
          sessions[0].state = 'ABORTED';
          return json(response, sessions[0]);
        }
        if (call.body.action === 'part') return json(response, { url: fixture.origin + '/upload/part', headers: {} });
        if (call.body.action === 'complete') sessions[0].state = 'COMPLETED';
        return json(response, sessions[0]);
      }
      if (pathname === '/upload/part' && call.method === 'PUT') return json(response, {});
      throw new Error(`Missing fixture: ${call.method} ${pathname}`);
    });
  }, 30000);
  beforeEach(async () => {
    listingMode = 'ok'; versions = [version()]; role = 'admin'; sessions = []; heldResponses = [];
    fixture.calls.length = 0; fixture.unexpected.length = 0; page = await fixture.page();
  });
  afterEach(async () => {
    for (const response of heldResponses) response.destroy();
    await page.close(); expect(fixture.unexpected).toEqual([]);
  });
  afterAll(async () => fixture.close());
  const fileInput = () => page.locator('input[type="file"][multiple]');
  const waitForMetadata = async () => {
    await page.getByRole('button', { name: '검증 및 버전 확정', exact: true }).waitFor();
    await expect.poll(() => fixture.calls.some(call => call.url.pathname === versionPath + '/uploads')).toBe(true);
  };
  const selectFile = async (selector: string) => {
    await page.locator(selector).evaluate((input: HTMLInputElement) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['hello'], 'sample.txt', { type: 'text/plain', lastModified: 42 }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };

  it.each(['loading', 'error'] as const)('keeps pending upload controls enabled while the listing is %s', async mode => {
    listingMode = mode;
    await page.goto(fixture.origin);
    await waitForMetadata();
    if (mode === 'error') await page.getByText('Listing is temporarily unavailable', { exact: true }).waitFor();
    expect(await fileInput().count()).toBe(1);
    expect(await fileInput().isEnabled()).toBe(true);
  });

  it('uploads actual bytes and finalizes a pending version despite a failed listing', async () => {
    listingMode = 'error';
    await page.goto(fixture.origin); await waitForMetadata();
    await page.getByText('Listing is temporarily unavailable', { exact: true }).waitFor();
    expect(await fileInput().count()).toBe(1);
    await selectFile('input[type="file"][multiple]');
    await page.getByText('파일 업로드를 확인했습니다.', { exact: false }).waitFor();
    const start = fixture.calls.find(call => call.url.pathname === versionPath + '/uploads' && call.method === 'POST')!;
    expect(start.body).toMatchObject({ filename: 'sample.txt', size: 5, lastModified: 42 });
    expect(fixture.calls.find(call => call.url.pathname === '/upload/part')!.bytes.toString()).toBe('hello');
    const complete = fixture.calls.find(call => call.body.action === 'complete')!;
    expect(complete.body.checksums).toEqual(['LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=']);
    await page.getByRole('button', { name: '검증 및 버전 확정', exact: true }).click();
    await page.getByRole('button', { name: '확정된 메타데이터 조회', exact: true }).waitFor();
    expect(await fileInput().isDisabled()).toBe(true);
  });

  it.each(['resume', 'abort'] as const)('allows %s of an unfinished upload while listing fails', async action => {
    listingMode = 'error';
    sessions = [{ id: 'session-1', filename: 'nested/sample.txt', size: 5, lastModified: 42, partSize: 5, partCount: 1, state: 'UPLOADING', parts: [] }];
    await page.addInitScript(() => localStorage.setItem('pai-multipart:fixture-data:1:nested/sample.txt', '{"id":"session-1"}'));
    await page.goto(fixture.origin); await waitForMetadata();
    await page.getByText('Listing is temporarily unavailable', { exact: true }).waitFor();
    const resume = page.getByLabel('nested/sample.txt 이어올리기');
    expect(await resume.count()).toBe(1);
    expect(await resume.isEnabled()).toBe(true);
    expect(await page.getByRole('button', { name: '검증 및 버전 확정', exact: true }).isDisabled()).toBe(true);
    if (action === 'resume') {
      await selectFile('input[aria-label="nested/sample.txt 이어올리기"]');
      await page.getByText('파일 업로드를 확인했습니다.', { exact: false }).waitFor();
      expect(fixture.calls.some(call => call.method === 'POST' && call.url.pathname === versionPath + '/uploads')).toBe(false);
      expect(fixture.calls.find(call => call.url.pathname === '/upload/part')!.bytes.toString()).toBe('hello');
    } else {
      await page.getByRole('button', { name: '업로드 중단', exact: true }).click();
      await expect.poll(() => fixture.calls.some(call => call.method === 'DELETE' && call.url.pathname.endsWith('/uploads/session-1'))).toBe(true);
    }
    await expect.poll(() => resume.count()).toBe(0);
    expect(await page.getByRole('button', { name: '검증 및 버전 확정', exact: true }).isEnabled()).toBe(true);
  });

  it.each([
    { state: 'READY' as const, imported: false },
    { state: 'PENDING' as const, imported: true },
  ])('disables file mutation for $state imported=$imported', async ({ state, imported }) => {
    versions = [version(state, imported)];
    await page.goto(fixture.origin);
    await fileInput().waitFor({ state: 'attached' });
    expect(await fileInput().isDisabled()).toBe(true);
    expect(fixture.calls.some(call => call.url.pathname.endsWith('/uploads'))).toBe(false);
    expect(await page.getByRole('button', { name: '업로드 중단', exact: true }).count()).toBe(0);
  });

  it('does not expose upload controls to a viewer when listing fails', async () => {
    role = 'viewer'; listingMode = 'error';
    await page.goto(fixture.origin);
    await page.getByText('Listing is temporarily unavailable', { exact: true }).waitFor();
    expect(await fileInput().count()).toBe(0);
    expect(fixture.calls.some(call => call.url.pathname.endsWith('/uploads'))).toBe(false);
  });
});
