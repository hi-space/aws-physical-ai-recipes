import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import type { ServerResponse } from 'node:http';
import type { AuditEntry } from '@/server/store/types';
import { fixtureMe, json, storageAdminBrowser } from './test-utils/storage-admin-browser';

const audit: AuditEntry[] = [
  { ts: '2026-09-18T00:00:00Z', seq: 1, actor: 'admin@example.test', role: 'admin', action: 'settings.update', target: 'settings', result: 'ok' },
  { ts: '2026-09-18T00:01:00Z', seq: 2, actor: 'admin@example.test', role: 'admin', action: 'user.create', result: 'error', message: 'User already exists' },
];

describe('AdminPage browser contracts', () => {
  let fixture: Awaited<ReturnType<typeof storageAdminBrowser>>, page: Page;
  let auth: 'admin' | 'viewer' | 'researcher' | 'loading' | 'error', authResponse: ServerResponse | undefined;
  let mutationStatus: number, settingsStatus: number;
  beforeAll(async () => {
    fixture = await storageAdminBrowser('admin', (call, response) => {
      const path = call.url.pathname;
      if (path === '/api/me') {
        if (auth === 'loading') { authResponse = response; return; }
        if (auth === 'error') return json(response, { error: 'Session lookup failed' }, 503);
        return json(response, { ...fixtureMe, role: auth });
      }
      if ((call.method === 'POST' && ['/api/admin/users', '/api/admin/users/fixture-admin'].includes(path))
        || (call.method === 'PUT' && path === '/api/admin/settings')) {
        return json(response, mutationStatus < 400 ? { ok: true } : { error: 'Fixture mutation rejected' }, mutationStatus);
      }
      if (call.method !== 'GET') throw new Error(`Missing fixture: ${call.method} ${path}`);
      if (path === '/api/admin/users') return json(response, {
        users: [{ username: 'fixture-admin', subject: 'subject-1', email: 'admin@example.test', status: 'CONFIRMED', enabled: true, created: '2026-09-18T00:00:00Z', groups: ['admins'] }],
        groups: [{ name: 'admins' }, { name: 'researchers' }, { name: 'viewers' }],
      });
      if (path === '/api/admin/audit') return json(response, audit);
      if (path === '/api/admin/settings' && settingsStatus >= 400) return json(response, { error: 'Settings lookup failed' }, settingsStatus);
      if (path === '/api/admin/settings') return json(response, {
        config: { region: 'us-east-1', eks: { clusterName: 'fixture-cluster' } }, env: {},
        settings: { notifyOn: ['FAILED'], defaultPriority: 'fixture-priority' },
        controller: { running: true, holder: 'fixture-controller', lastTick: '2026-09-18T00:00:00Z', ticks: 7, leased: true },
        lease: { holder: 'fixture-controller', expires: 1789689700 },
      });
      if (path === '/api/cost') return json(response, {
        total: 12.5, byService: [{ service: 'Amazon S3', amount: 12.5 }], daily: [{ date: '2026-09-17', amount: 12.5 }],
        currency: 'USD', scope: 'account', source: 'AWS Cost Explorer / UnblendedCost', estimated: false,
        observedAt: '2026-09-18T00:00:00Z', period: { start: '2026-08-19', end: '2026-09-18' },
      });
      throw new Error(`Missing fixture: ${call.method} ${path}`);
    });
  }, 30000);
  beforeEach(async () => {
    auth = 'admin'; authResponse = undefined; mutationStatus = 200; settingsStatus = 200;
    fixture.calls.length = 0; fixture.unexpected.length = 0; page = await fixture.page();
  });
  afterEach(async () => {
    authResponse?.destroy(); await page.close(); expect(fixture.unexpected).toEqual([]);
  });
  afterAll(async () => fixture.close());
  const openAdmin = async () => {
    await page.goto(fixture.origin);
    await page.getByRole('button', { name: '사용자 만들기', exact: true }).waitFor();
  };
  const writes = () => fixture.calls.filter(call => call.method !== 'GET');

  it('auth: waits for identity before deciding authorization or requesting admin data', async () => {
    auth = 'loading';
    await page.goto(fixture.origin);
    await expect.poll(() => Boolean(authResponse)).toBe(true);
    expect(await page.getByText('관리자 역할 필요', { exact: true }).count()).toBe(0);
    expect(await page.getByText('신원을 확인하는 중', { exact: false }).count()).toBeGreaterThan(0);
    expect(fixture.calls.filter(call => call.url.pathname.startsWith('/api/admin'))).toHaveLength(0);
    json(authResponse!, fixtureMe);
    await page.getByRole('button', { name: '사용자 만들기', exact: true }).waitFor();
  });

  it('auth: displays identity errors without claiming the user lacks an admin role', async () => {
    auth = 'error';
    await page.goto(fixture.origin);
    await expect.poll(() => page.getByText('Session lookup failed', { exact: true }).count()).toBe(1);
    expect(await page.getByText('관리자 역할 필요', { exact: true }).count()).toBe(0);
    expect(fixture.calls.filter(call => call.url.pathname.startsWith('/api/admin'))).toHaveLength(0);
  });

  it.each(['viewer', 'researcher'] as const)('auth: denies a resolved %s without fetching administrator tabs', async role => {
    auth = role;
    const identity = page.waitForResponse(response => response.url().endsWith('/api/me'));
    await page.goto(fixture.origin);
    await identity;
    await page.getByText('관리자 역할 필요', { exact: true }).waitFor();
    expect(fixture.calls.filter(call => call.url.pathname.startsWith('/api/admin'))).toHaveLength(0);
    expect(await page.getByRole('button', { name: '저장', exact: true }).count()).toBe(0);
  });

  it('auth: reads a resolved administrator role and opens all four tabs with actual API content', async () => {
    await openAdmin();
    expect(await page.getByRole('cell', { name: 'admin@example.test', exact: true }).count()).toBe(1);
    await page.getByRole('button', { name: '감시 로그', exact: true }).click();
    await page.getByRole('cell', { name: 'settings.update', exact: true }).waitFor();
    expect(await page.getByRole('cell', { name: 'User already exists', exact: true }).count()).toBe(1);
    await page.getByRole('button', { name: '설정', exact: true }).click();
    await page.getByText('fixture-controller', { exact: true }).waitFor();
    expect(await page.locator('input').nth(3).inputValue()).toBe('fixture-priority');
    expect(await page.locator('input[type=checkbox]').evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).checked))).toEqual([false, true, false]);
    expect(await page.getByText('fixture-cluster', { exact: true }).count()).toBe(1);
    await page.getByRole('button', { name: '비용', exact: true }).click();
    await page.getByRole('cell', { name: 'Amazon S3', exact: true }).waitFor();
    expect(await page.getByRole('cell', { name: /12\.5|12,50|12.50/, exact: true }).count()).toBeGreaterThan(0);
    expect(await page.getByText('2026-09-17', { exact: true }).count()).toBe(1);
  });

  it('renders the server audit success/error results with the corresponding status tone', async () => {
    await openAdmin();
    await page.getByRole('button', { name: '감시 로그', exact: true }).click();
    const success = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'settings.update', exact: true }) });
    const failure = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'user.create', exact: true }) });
    await success.waitFor();
    expect(await success.getAttribute('class')).toContain('text-ok');
    expect(await failure.getAttribute('class')).toContain('text-err');
    expect(await success.getByRole('cell', { name: 'ok', exact: true }).count()).toBe(1);
  });

  it('generates a reset password in the active reset form and submits that value', async () => {
    await openAdmin();
    await page.getByRole('button', { name: '재설정', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '자동 생성', exact: true }).click();
    const password = await dialog.locator('input[type=password]').inputValue();
    expect(password.length).toBeGreaterThanOrEqual(12);
    await dialog.getByRole('button', { name: '재설정', exact: true }).click();
    await page.getByText('비밀번호를 재설정했습니다', { exact: true }).waitFor();
    expect(writes().map(call => ({ path: call.url.pathname, body: call.body }))).toEqual([
      { path: '/api/admin/users/fixture-admin', body: { action: 'reset', password } },
    ]);
  });

  it('cannot overwrite saved settings with defaults after a failed load, and can retry the read', async () => {
    settingsStatus = 503;
    await openAdmin();
    await page.getByRole('button', { name: '설정', exact: true }).click();
    await page.getByText('Settings lookup failed', { exact: true }).waitFor();
    const save = page.getByRole('button', { name: '저장', exact: true });
    expect(await save.isDisabled()).toBe(true);
    expect(writes()).toHaveLength(0);

    settingsStatus = 200;
    await page.getByRole('button', { name: '재시도', exact: true }).click();
    await page.getByText('fixture-controller', { exact: true }).waitFor();
    expect(await save.isEnabled()).toBe(true);
    await save.click();
    await page.getByText(/저장했습니다/, { exact: false }).waitFor();
    expect(writes().map(call => call.body)).toEqual([
      { notifyOn: ['FAILED'], defaultPriority: 'fixture-priority' },
    ]);
  });

  it.each(['create', 'role', 'reset', 'settings'] as const)('shows HTTP failures from %s instead of a success toast', async action => {
    mutationStatus = 403;
    await openAdmin();
    if (action === 'settings') {
      await page.getByRole('button', { name: '설정', exact: true }).click();
      await page.getByText('fixture-controller', { exact: true }).waitFor();
      await page.getByRole('button', { name: '저장', exact: true }).click();
    } else {
      await page.getByRole('button', { name: action === 'create' ? '사용자 만들기' : action === 'role' ? '역할' : '재설정', exact: true }).click();
      const dialog = page.getByRole('dialog');
      if (action === 'create') {
        await dialog.locator('input').nth(0).fill('new-user');
        await dialog.locator('input[type=email]').fill('new@example.test');
        await dialog.locator('input[type=password]').fill('FixturePassword123!');
      }
      if (action === 'reset') await dialog.locator('input[type=password]').fill('FixturePassword123!');
      if (action === 'role') await dialog.locator('select').selectOption('viewers');
      await dialog.getByRole('button', { name: action === 'create' ? '만들기' : action === 'role' ? '저장' : '재설정', exact: true }).click();
    }
    await expect.poll(() => writes().length).toBe(1);
    const expected = {
      create: { username: 'new-user', email: 'new@example.test', password: 'FixturePassword123!', group: 'researchers' },
      role: { action: 'groups', groups: ['viewers'] },
      reset: { action: 'reset', password: 'FixturePassword123!' },
      settings: { notifyOn: ['FAILED'], defaultPriority: 'fixture-priority' },
    };
    expect(writes()[0].body).toEqual(expected[action]);
    expect(writes()[0].method).toBe(action === 'settings' ? 'PUT' : 'POST');
    expect(writes()[0].url.pathname).toBe(action === 'settings' ? '/api/admin/settings'
      : action === 'create' ? '/api/admin/users' : '/api/admin/users/fixture-admin');
    await expect.poll(() => page.getByText('Fixture mutation rejected', { exact: true }).count()).toBe(1);
    expect(await page.getByText(/저장했습니다|업데이트했습니다|재설정했습니다|만들었습니다/).count()).toBe(0);
    if (action !== 'settings') expect(await page.getByRole('dialog').count()).toBe(1);
  });
});
