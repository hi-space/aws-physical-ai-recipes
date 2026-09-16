import { createHash } from 'node:crypto';
import bundled from './hyperpod-rates.json';
import { getRepo, type Repo } from '../store/repo';
import { HttpError } from '../errors';

export interface ComputeRate {
  instanceType: string; region: string; usdPerHour: number; vCpu: number; gpu: number | null;
  sku: string; rateCode: string; effectiveDate: string;
}
export interface RateSnapshot {
  service: 'AmazonSageMaker'; region: 'us-east-1'; currency: 'USD'; term: 'OnDemand';
  sourceUrl: string; retrievedAt: string; publicationDate: string; catalogVersion: string; sha256: string;
  rates: ComputeRate[];
}
export const PUBLIC_RATE_URL = 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonSageMaker/current/us-east-1/index.json';
export const BUNDLED_RATES = bundled as RateSnapshot;
const RATE_KEY = { pk: 'USAGE_PRICING#us-east-1', sk: 'CURRENT' };
const positive = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0;
export function rateIsFresh(snapshot: RateSnapshot, now: Date) {
  const age = now.getTime() - Date.parse(snapshot.retrievedAt);
  return Number.isFinite(age) && age >= -300_000 && age <= 30 * 86400_000;
}
/** HyperPod Cluster SKUs only. Studio/Training/Reserved/Spot prices must not be substituted. */
export function parseHyperpodRates(text: string, sourceUrl: string, now: Date): RateSnapshot {
  if (!/^https:\/\/pricing\.us-east-1\.amazonaws\.com\/offers\/v1\.0\/aws\/AmazonSageMaker\/(?:current|\d+)\/us-east-1\/index\.json$/.test(sourceUrl)) throw new Error('Unexpected pricing source');
  const data = JSON.parse(text);
  if (data.offerCode !== 'AmazonSageMaker' || !/^\d+$/.test(data.version) || !Number.isFinite(Date.parse(data.publicationDate)) || Date.parse(data.publicationDate) > now.getTime() + 300_000) throw new Error('Invalid AWS pricing publication');
  if (!sourceUrl.includes('/current/') && !sourceUrl.includes(`/${data.version}/`)) throw new Error('Pricing URL and publication version disagree');
  const rates: ComputeRate[] = [];
  for (const [sku, product] of Object.entries(data.products ?? {}) as Array<[string, { attributes?: Record<string, string> }]>) {
    const a = product.attributes ?? {}, instanceType = a.instanceType?.replace(/-Cluster$/, '');
    if (!a.instanceType?.endsWith('-Cluster') || a.regionCode !== 'us-east-1' || a.component !== 'Cluster' || a.usagetype !== `USE1-Cluster:${instanceType}`) continue;
    const vCpu = Number(a.vCpu);
    const gpu = /^\d+$/.test(a.gpu ?? '') ? Number(a.gpu) : /^ml\.(?:c|m|r|t)\d/.test(instanceType) && a.gpu === 'N/A' ? 0 : null;
    if (!positive(vCpu)) continue;
    const dimensions: ComputeRate[] = [];
    for (const term of Object.values(data.terms?.OnDemand?.[sku] ?? {}) as Array<{ effectiveDate: string; priceDimensions: Record<string, { unit: string; beginRange: string; endRange: string; rateCode: string; pricePerUnit: { USD?: string } }> }>) {
      for (const dim of Object.values(term.priceDimensions ?? {})) {
        const usdPerHour = Number(dim.pricePerUnit?.USD);
        if (dim.unit !== 'Hrs' || dim.beginRange !== '0' || dim.endRange !== 'Inf' || !positive(usdPerHour) || !Number.isFinite(Date.parse(term.effectiveDate))) continue;
        dimensions.push({ instanceType, region: 'us-east-1', usdPerHour, vCpu, gpu, sku, rateCode: dim.rateCode, effectiveDate: term.effectiveDate });
      }
    }
    if (dimensions.length !== 1 || rates.some(rate => rate.instanceType === instanceType)) throw new Error('Ambiguous HyperPod pricing');
    rates.push(dimensions[0]);
  }
  if (!rates.length) throw new Error('No verified HyperPod hourly prices');
  return { service: 'AmazonSageMaker', region: 'us-east-1', currency: 'USD', term: 'OnDemand', sourceUrl: PUBLIC_RATE_URL.replace('/current/', `/${data.version}/`),
    retrievedAt: now.toISOString(), publicationDate: data.publicationDate, catalogVersion: data.version,
    sha256: createHash('sha256').update(text).digest('hex'), rates: rates.sort((a, b) => a.instanceType.localeCompare(b.instanceType)) };
}
export async function readRates(repo: Repo = getRepo()): Promise<RateSnapshot> {
  const row = await repo.kv.get(RATE_KEY.pk, RATE_KEY.sk);
  return row?.snapshot as RateSnapshot | undefined ?? BUNDLED_RATES;
}
/** Explicit admin refresh only; fixed public endpoint, bounded body, no cloud resource mutation. */
export async function refreshRates(repo: Repo = getRepo(), fetcher: typeof fetch = fetch, now = () => new Date()) {
  const response = await fetcher(PUBLIC_RATE_URL, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body) throw new HttpError(502, '공식 가격표를 읽지 못했습니다. 기존 조회 시각을 유지합니다.');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 16 * 1024 * 1024) throw new Error('Pricing catalog exceeds limit');
      chunks.push(part.value);
    }
  } finally { await reader.cancel(); }
  const snapshot = parseHyperpodRates(Buffer.concat(chunks).toString('utf8'), PUBLIC_RATE_URL, now());
  const old = await repo.kv.get(RATE_KEY.pk, RATE_KEY.sk);
  if (old?.snapshot && Date.parse((old.snapshot as RateSnapshot).publicationDate) > Date.parse(snapshot.publicationDate)) throw new HttpError(409, '더 최근 가격표가 이미 저장되어 있습니다.');
  const saved = await repo.kv.transaction([{ kind: 'put', item: { ...RATE_KEY, snapshot, revision: Number(old?.revision ?? 0) + 1 },
    condition: old ? { equals: { revision: old.revision } } : { absent: true } }]);
  if (!saved) throw new HttpError(409, '가격표가 동시에 변경되었습니다. 새로고침하세요.');
  return snapshot;
}
