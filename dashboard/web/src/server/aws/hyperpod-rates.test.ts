import { expect, it } from 'vitest';
import { BUNDLED_RATES, parseHyperpodRates, PUBLIC_RATE_URL, refreshRates } from './hyperpod-rates';
import { Repo } from '../store/repo';
import { MemoryKV } from '../store/dynamo';
const now = new Date('2026-09-16T18:00:00Z');
function catalog() {
  const product = (instanceType: string, usagetype: string) => ({ attributes: { instanceType, usagetype, component: 'Cluster', regionCode: 'us-east-1', vCpu: '32', gpu: '1' } });
  const price = { effectiveDate: '2026-09-01T00:00:00Z', priceDimensions: { d: { rateCode: 'rate', beginRange: '0', endRange: 'Inf', unit: 'Hrs', pricePerUnit: { USD: '3.06' } } } };
  return { offerCode: 'AmazonSageMaker', version: '20260916', publicationDate: '2026-09-16T17:00:00Z',
    products: { cluster: product('ml.g5.8xlarge-Cluster', 'USE1-Cluster:ml.g5.8xlarge'), studio: product('ml.g5.8xlarge', 'USE1-Studio:ml.g5.8xlarge'), reserved: product('ml.g5.8xlarge-Cluster', 'USE1-ReservedCluster:ml.g5.8xlarge') },
    terms: { OnDemand: { cluster: { term: price }, studio: { term: price }, reserved: { term: price } } } };
}
it('uses only exact HyperPod Cluster USD/hour SKUs with source timestamps and excludes Studio/reserved lookalikes', () => {
  const result = parseHyperpodRates(JSON.stringify(catalog()), PUBLIC_RATE_URL, now);
  expect(result.rates).toEqual([{ instanceType: 'ml.g5.8xlarge', region: 'us-east-1', usdPerHour: 3.06, vCpu: 32, gpu: 1, sku: 'cluster', rateCode: 'rate', effectiveDate: '2026-09-01T00:00:00Z' }]);
  expect(result.retrievedAt).toBe(now.toISOString()); expect(result.sha256).toHaveLength(64);
  expect(() => parseHyperpodRates(JSON.stringify(catalog()), 'https://untrusted.test', now)).toThrow();
});
it('contains the freshly verified CPU and GPU source SKUs, without substituting EC2 pricing', () => {
  expect(BUNDLED_RATES.rates.find(r => r.instanceType === 'ml.c5.4xlarge')).toMatchObject({ usdPerHour: 0.816, sku: '2U5MN8YSN9U9U5HZ', vCpu: 16, gpu: 0 });
  expect(BUNDLED_RATES.rates.find(r => r.instanceType === 'ml.g5.8xlarge')).toMatchObject({ usdPerHour: 3.06, sku: 'YQXD4PZ3BTQ5N2P4', vCpu: 32, gpu: 1 });
  expect(BUNDLED_RATES.sourceUrl).toContain('/AmazonSageMaker/20260916170501/us-east-1/');
});
it('does not replace a saved snapshot with failed, malformed or older pricing responses', async () => {
  const repo = new Repo(new MemoryKV());
  await refreshRates(repo, async () => new Response(JSON.stringify(catalog())) as never, () => now);
  const before = await repo.kv.get('USAGE_PRICING#us-east-1', 'CURRENT');
  await expect(refreshRates(repo, async () => new Response('error', { status: 503 }) as never, () => now)).rejects.toThrow();
  const older = { ...catalog(), publicationDate: '2026-09-01T00:00:00Z' };
  await expect(refreshRates(repo, async () => new Response(JSON.stringify(older)) as never, () => now)).rejects.toThrow(/최근/);
  expect(await repo.kv.get('USAGE_PRICING#us-east-1', 'CURRENT')).toEqual(before);
});
