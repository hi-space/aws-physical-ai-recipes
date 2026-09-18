import { expect, it } from 'vitest';
import { parseHyperpodRates, getPublicRateUrl, refreshRates, ensureRates } from './hyperpod-rates';
import { createTestSnapshot, syntheticOfferFile } from './hyperpod-rates.fixture';
import { Repo } from '../store/repo';
import { MemoryKV } from '../store/dynamo';

const now = new Date('2026-09-16T18:00:00Z');

it('parses synthetic fixture: CPU and GPU SKUs, excludes Studio/reserved, validates region', () => {
  const region = 'us-east-1';
  const url = getPublicRateUrl(region);
  const result = parseHyperpodRates(JSON.stringify(syntheticOfferFile(region)), url, now, region);
  expect(result.rates).toHaveLength(2);
  expect(result.rates.find(r => r.instanceType === 'ml.c5.4xlarge')).toMatchObject({ usdPerHour: 0.816, vCpu: 16, gpu: 0 });
  expect(result.rates.find(r => r.instanceType === 'ml.g5.8xlarge')).toMatchObject({ usdPerHour: 3.06, vCpu: 32, gpu: 1 });
  expect(result.region).toBe(region);
  expect(result.retrievedAt).toBe(now.toISOString());
  expect(result.sha256).toHaveLength(64);
});

it('rejects untrusted pricing source URLs', () => {
  const region = 'us-east-1';
  expect(() => parseHyperpodRates(JSON.stringify(syntheticOfferFile(region)), 'https://untrusted.test', now, region)).toThrow();
});

it('supports different regions in pricing URL and validation', () => {
  const region = 'us-west-2';
  const url = getPublicRateUrl(region);
  expect(url).toContain(`/${region}/`);
  const result = createTestSnapshot(region, now);
  expect(result.region).toBe(region);
});

it('does not replace a saved snapshot with failed, malformed or older pricing responses', async () => {
  const repo = new Repo(new MemoryKV());
  const region = 'us-east-1';
  await refreshRates(region, repo, async () => new Response(JSON.stringify(syntheticOfferFile(region))) as never, () => now);
  const before = await repo.kv.get(`USAGE_PRICING#${region}`, 'CURRENT');
  await expect(refreshRates(region, repo, async () => new Response('error', { status: 503 }) as never, () => now)).rejects.toThrow();
  const older = { ...syntheticOfferFile(region), publicationDate: '2026-09-01T00:00:00Z' };
  await expect(refreshRates(region, repo, async () => new Response(JSON.stringify(older)) as never, () => now)).rejects.toThrow();
  expect(await repo.kv.get(`USAGE_PRICING#${region}`, 'CURRENT')).toEqual(before);
});

it('ensureRates returns existing fresh snapshot without fetching', async () => {
  const repo = new Repo(new MemoryKV());
  const region = 'us-east-1';
  const snapshot = createTestSnapshot(region, now);
  // Store with a timestamp that was just retrieved so it's fresh
  await repo.kv.put({ pk: `USAGE_PRICING#${region}`, sk: 'CURRENT', snapshot, revision: 1 });

  let fetched = false;
  const neverFetch: typeof fetch = () => { fetched = true; return Promise.reject(new Error('should not fetch')); };

  const result = await ensureRates(region, repo, neverFetch, () => now);
  expect(result?.region).toBe(region);
  expect(result?.rates.length).toBeGreaterThan(0);
  expect(fetched).toBe(false);
});
