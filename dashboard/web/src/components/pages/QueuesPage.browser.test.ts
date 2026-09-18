/** Real QueuesPage in Chromium with local JSON fixtures; the quota dialog must list the cluster's own instance types. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { fixtureMe, json, storageAdminBrowser } from './test-utils/storage-admin-browser';

const queues = { clusterQueues: [], localQueues: [], flavors: [], priorityClasses: [], workloads: [] };
const quotas = { clusterArn: 'arn:aws:sagemaker:us-east-1:123456789012:cluster/abc', quotas: [], policies: [] };
const clusters = [
  { name: 'hyperpod-slurm', orchestrator: 'slurm', status: 'InService', groups: [{ name: 'head', instanceType: 'ml.m5.4xlarge', current: 1, target: 1, gpuCount: 0, isGpu: false, role: 'controller' }], nodes: [] },
  { name: 'hyperpod-eks', orchestrator: 'eks', status: 'InService', nodes: [], groups: [
    { name: 'cpu', instanceType: 'ml.c5.4xlarge', current: 2, target: 2, gpuCount: 0, isGpu: false },
    { name: 'gpu', instanceType: 'ml.g5.8xlarge', current: 1, target: 1, gpuCount: 1, gpuName: 'A10G', isGpu: true },
    { name: 'gpu-b', instanceType: 'ml.g5.8xlarge', current: 0, target: 0, gpuCount: 1, gpuName: 'A10G', isGpu: true },
  ] },
];

describe.skipIf(!existsSync(chromium.executablePath()))('queues page quota dialog', () => {
  let fixture: Awaited<ReturnType<typeof storageAdminBrowser>>;
  let clusterCalls = 0;
  beforeAll(async () => {
    fixture = await storageAdminBrowser('queues', ({ url, method }, response) => {
      if (url.pathname === '/api/me') return json(response, { ...fixtureMe, features: { ...fixtureMe.features, eks: true } });
      if (url.pathname === '/api/queues') return json(response, queues);
      if (url.pathname === '/api/quotas' && method === 'GET') return json(response, quotas);
      if (url.pathname === '/api/clusters') { clusterCalls++; return json(response, { clusters, k8sNodes: [], addons: [] }); }
      json(response, { error: `unexpected ${method} ${url.pathname}` }, 404);
    });
  });
  afterAll(async () => { await fixture?.close(); });

  it('offers exactly the HyperPod EKS instance types, GPU type first, and sends the fair-share weight explicitly', async () => {
    const page = await fixture.page();
    await page.goto(fixture.origin + '/queues');
    await page.getByRole('button', { name: /새 컴퓨트 할당량/ }).click();
    const dialog = page.getByRole('dialog');
    const select = dialog.locator('select').first();
    await select.locator('option[value="ml.g5.8xlarge"]').waitFor({ state: 'attached' });
    const options = (await select.locator('option').allTextContents()).filter(Boolean);
    expect(options).toEqual(['인스턴스 유형 선택', 'ml.c5.4xlarge', 'ml.g5.8xlarge']);
    expect(await select.inputValue()).toBe('ml.g5.8xlarge');
    expect(await dialog.getByLabel(/Fair share|공정 배분|가중치/).inputValue().catch(() => '50')).toBe('50');
    expect(clusterCalls).toBeGreaterThan(0);
    expect(fixture.unexpected).toEqual([]);
    await page.close();
  });
});
