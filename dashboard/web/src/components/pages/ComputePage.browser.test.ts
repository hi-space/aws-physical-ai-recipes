/** ComputePage in Chromium with local JSON fixtures; node recovery dialog must open with warnings and execute disabled until acknowledged. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { fixtureMe, json, storageAdminBrowser } from './test-utils/storage-admin-browser';

describe.skipIf(!existsSync(chromium.executablePath()))('compute page node recovery dialog', () => {
  let fixture: Awaited<ReturnType<typeof storageAdminBrowser>>;
  let recoveryGetCalls = 0;

  beforeAll(async () => {
    fixture = await storageAdminBrowser('compute', ({ url, method }, response) => {
      if (url.pathname === '/api/me') {
        return json(response, {
          ...fixtureMe,
          features: { ...fixtureMe.features, eks: true, fsx: false },
          resources: {
            hyperPodEks: { name: 'hyperpod-eks', logGroupPrefix: '/aws/eks/hyperpod-eks/cluster' },
            fsx: undefined,
          },
          clusters: { eksName: 'hyperpod-eks' },
        });
      }
      if (url.pathname === '/api/clusters' && method === 'GET') {
        return json(response, {
          clusters: [
            {
              name: 'hyperpod-eks',
              orchestrator: 'eks',
              status: 'InService',
              nodeRecovery: 'Automatic',
              groups: [{ name: 'gpu', instanceType: 'ml.g4dn.xlarge', current: 1, target: 1, gpuCount: 1, isGpu: true }],
              nodes: [],
            },
          ],
          k8sNodes: [
            {
              name: 'hyperpod-node-1',
              instanceId: 'i-0123456789abcdef0',
              group: 'gpu',
              health: 'Schedulable',
              ready: true,
              gpuCapacity: 1,
              gpuAllocatable: 1,
              unschedulable: false,
              taints: [],
            },
          ],
          addons: [],
        });
      }
      if (url.pathname === '/api/fsx' && method === 'GET') {
        return json(response, []);
      }
      if (url.pathname.startsWith('/api/clusters/hyperpod-eks/nodes/i-0123456789abcdef0/recovery')) {
        if (method === 'GET') {
          recoveryGetCalls++;
          return json(response, {
            plan: {
              observedAt: new Date().toISOString(),
              action: 'reboot', api: 'BatchRebootClusterNodes',
              node: { instanceId: 'i-0123456789abcdef0', group: 'gpu', instanceType: 'ml.g4dn.xlarge', instanceStatus: 'Running', k8sName: 'hyperpod-node-1', health: 'Schedulable', ready: true, unschedulable: false, gpuCapacity: 1 },
              cluster: { name: 'hyperpod-eks', orchestrator: 'eks', status: 'InService', nodeRecovery: 'Automatic' },
              pods: [
                {
                  namespace: 'default',
                  name: 'job-abc-1',
                  phase: 'Running',
                  owner: 'job',
                  workflowId: 'workflow-123',
                },
              ],
              blockers: [],
              warnings: [
                {
                  code: 'running_pods',
                  message: '1 running pod(s) will be terminated: default/job-abc-1 (workflow-123)',
                  params: { count: '1', pods: 'default/job-abc-1 (workflow-123)' },
                },
              ],
              token: 'token-abc123',
            },
          });
        }
        if (method === 'POST') {
          return json(response, { appliedAt: new Date().toISOString(), api: 'BatchRebootClusterNodes', successful: ['i-0123456789abcdef0'], failed: [] });
        }
      }
      json(response, { error: `unexpected ${method} ${url.pathname}` }, 404);
    });
  });

  afterAll(async () => {
    await fixture?.close();
  });

  it('opens recovery dialog with running pods warning and Execute disabled until acknowledged', async () => {
    const page = await fixture.page();
    await page.goto(fixture.origin + '/compute');

    // Click reboot button on the node
    await page.getByRole('button', { name: /재부팅/ }).first().click();

    // Dialog should open
    const dialog = page.getByRole('dialog');
    await dialog.waitFor({ state: 'visible' });

    // Warning should be visible
    await dialog.getByText(/실행 중인 Pod 1개가 종료됩니다/).waitFor({ state: 'visible' });
    await dialog.getByRole('cell', { name: 'job-abc-1' }).waitFor({ state: 'visible' });

    // Execute button should be disabled
    const executeButton = dialog.getByRole('button', { name: '지금 재부팅' });
    await executeButton.waitFor({ state: 'attached' });
    const disabledBefore = await executeButton.isDisabled();
    expect(disabledBefore).toBe(true);

    // Tick the acknowledgement checkbox
    const checkbox = dialog.locator('input[type="checkbox"]');
    await checkbox.check();

    // Execute button should now be enabled
    const enabledAfter = await executeButton.isEnabled();
    expect(enabledAfter).toBe(true);

    // Do NOT click Execute - we only test the dialog interaction, not the actual recovery
    expect(recoveryGetCalls).toBeGreaterThan(0);
    expect(fixture.unexpected).toEqual([]);
    await page.close();
  });
});
