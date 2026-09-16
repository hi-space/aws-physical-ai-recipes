import { createHash } from 'node:crypto';
import type { TopologyPlan } from './types';
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
/** DynamoDB Map serialization does not preserve JavaScript object key order. */
export function placementHash(plan: Omit<TopologyPlan, 'hash'>): string {
  return createHash('sha256').update(canonical(plan)).digest('hex');
}
