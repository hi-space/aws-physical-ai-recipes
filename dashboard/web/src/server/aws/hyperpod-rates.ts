import { createHash } from 'node:crypto';
import { getRepo, type Repo } from '../store/repo';
import { config } from '../config';
import { HttpError } from '../errors';

export interface ComputeRate {
  instanceType: string; region: string; usdPerHour: number; vCpu: number; gpu: number | null;
  sku: string; rateCode: string; effectiveDate: string;
}
export interface RateSnapshot {
  service: 'AmazonSageMaker'; region: string; currency: 'USD'; term: 'OnDemand';
  sourceUrl: string; retrievedAt: string; publicationDate: string; catalogVersion: string; sha256: string;
  rates: ComputeRate[];
}
export function getPublicRateUrl(region: string): string {
  return `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonSageMaker/current/${region}/index.json`;
}
function getRateKey(region: string) {
  return { pk: `USAGE_PRICING#${region}`, sk: 'CURRENT' };
}
const positive = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0;
export function rateIsFresh(snapshot: RateSnapshot, now: Date) {
  const age = now.getTime() - Date.parse(snapshot.retrievedAt);
  return Number.isFinite(age) && age >= -300_000 && age <= 30 * 86400_000;
}
/** HyperPod Cluster SKUs only. Studio/Training/Reserved/Spot prices must not be substituted. */
export function parseHyperpodRates(text: string, sourceUrl: string, now: Date, region: string = config().region): RateSnapshot {
  const urlPattern = new RegExp(`^https://pricing\\.us-east-1\\.amazonaws\\.com/offers/v1\\.0/aws/AmazonSageMaker/(?:current|\\d+)/${region}/index\\.json$`);
  if (!urlPattern.test(sourceUrl)) throw new Error('Unexpected pricing source');
  const data = JSON.parse(text);
  if (data.offerCode !== 'AmazonSageMaker' || !/^\d+$/.test(data.version) || !Number.isFinite(Date.parse(data.publicationDate)) || Date.parse(data.publicationDate) > now.getTime() + 300_000) throw new Error('Invalid AWS pricing publication');
  if (!sourceUrl.includes('/current/') && !sourceUrl.includes(`/${data.version}/`)) throw new Error('Pricing URL and publication version disagree');
  const rates: ComputeRate[] = [];
  for (const [sku, product] of Object.entries(data.products ?? {}) as Array<[string, { attributes?: Record<string, string> }]>) {
    const a = product.attributes ?? {}, instanceType = a.instanceType?.replace(/-Cluster$/, '');
    if (!a.instanceType?.endsWith('-Cluster') || a.regionCode !== region || a.component !== 'Cluster' || !/^(?:[A-Z0-9]+-)?Cluster:/.test(a.usagetype ?? '') || !a.usagetype.endsWith(`Cluster:${instanceType}`)) continue;
    const vCpu = Number(a.vCpu);
    const gpu = /^\d+$/.test(a.gpu ?? '') ? Number(a.gpu) : /^ml\.(?:c|m|r|t)\d/.test(instanceType) && a.gpu === 'N/A' ? 0 : null;
    if (!positive(vCpu)) continue;
    const dimensions: ComputeRate[] = [];
    for (const term of Object.values(data.terms?.OnDemand?.[sku] ?? {}) as Array<{ effectiveDate: string; priceDimensions: Record<string, { unit: string; beginRange: string; endRange: string; rateCode: string; pricePerUnit: { USD?: string } }> }>) {
      for (const dim of Object.values(term.priceDimensions ?? {})) {
        const usdPerHour = Number(dim.pricePerUnit?.USD);
        if (dim.unit !== 'Hrs' || dim.beginRange !== '0' || dim.endRange !== 'Inf' || !positive(usdPerHour) || !Number.isFinite(Date.parse(term.effectiveDate))) continue;
        dimensions.push({ instanceType, region, usdPerHour, vCpu, gpu, sku, rateCode: dim.rateCode, effectiveDate: term.effectiveDate });
      }
    }
    if (dimensions.length !== 1 || rates.some(rate => rate.instanceType === instanceType)) throw new Error('Ambiguous HyperPod pricing');
    rates.push(dimensions[0]);
  }
  if (!rates.length) throw new Error('No verified HyperPod hourly prices');
  return { service: 'AmazonSageMaker', region, currency: 'USD', term: 'OnDemand', sourceUrl: getPublicRateUrl(region).replace('/current/', `/${data.version}/`),
    retrievedAt: now.toISOString(), publicationDate: data.publicationDate, catalogVersion: data.version,
    sha256: createHash('sha256').update(text).digest('hex'), rates: rates.sort((a, b) => a.instanceType.localeCompare(b.instanceType)) };
}
export async function readRates(region: string = config().region, repo: Repo = getRepo()): Promise<RateSnapshot | undefined> {
  const key = getRateKey(region);
  const row = await repo.kv.get(key.pk, key.sk);
  return row?.snapshot as RateSnapshot | undefined;
}
/** Fetches and stores rates if missing or stale (>30 days). At most once per hour on failure. */
const lastFailure = new Map<string, number>();
const FAILURE_BACKOFF_MS = 3600_000;
/**
 * Returns the stored snapshot; fetches the official price list when none is stored or it is older than 30 days.
 * A failed fetch is not retried for an hour; callers then see the stale snapshot (flagged by `rateIsFresh`) or
 * `undefined`, and must render "unknown" rather than a substitute number.
 */
export async function ensureRates(region: string = config().region, repo: Repo = getRepo(), fetcher: typeof fetch = fetch, now = () => new Date()): Promise<RateSnapshot | undefined> {
  const existing = await readRates(region, repo);
  if (existing && rateIsFresh(existing, now())) return existing;
  const failedAt = lastFailure.get(region);
  if (failedAt !== undefined && now().getTime() - failedAt < FAILURE_BACKOFF_MS) return existing;
  try {
    const snapshot = await refreshRates(region, repo, fetcher, now);
    lastFailure.delete(region);
    return snapshot;
  } catch {
    lastFailure.set(region, now().getTime());
    return existing;
  }
}
/** Explicit admin refresh only; fixed public endpoint, bounded body, no cloud resource mutation. */
export async function refreshRates(region: string = config().region, repo: Repo = getRepo(), fetcher: typeof fetch = fetch, now = () => new Date()) {
  const url = getPublicRateUrl(region);
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body) throw new HttpError(502, 'Could not read official pricing list. Keeping previous retrieval time.');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 16 * 1024 * 1024) throw new Error('Pricing catalog exceeds limit');
      chunks.push(part.value);
    }
  } finally { await reader.cancel(); }
  const snapshot = parseHyperpodRates(Buffer.concat(chunks).toString('utf8'), url, now(), region);
  const key = getRateKey(region);
  const old = await repo.kv.get(key.pk, key.sk);
  if (old?.snapshot && Date.parse((old.snapshot as RateSnapshot).publicationDate) > Date.parse(snapshot.publicationDate)) throw new HttpError(409, 'A more recent pricing table is already saved.');
  const saved = await repo.kv.transaction([{ kind: 'put', item: { ...key, snapshot, revision: Number(old?.revision ?? 0) + 1 },
    condition: old ? { equals: { revision: old.revision } } : { absent: true } }]);
  if (!saved) throw new HttpError(409, 'Pricing table changed concurrently. Refresh.');
  return snapshot;
}
