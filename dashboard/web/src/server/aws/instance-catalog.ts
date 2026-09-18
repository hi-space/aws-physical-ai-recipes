import { DescribeInstanceTypesCommand, EC2Client, type InstanceTypeInfo, type _InstanceType } from '@aws-sdk/client-ec2';
import { config } from '../config';

export interface InstanceCatalogEntry {
  vCpu?: number;
  memoryMiB?: number;
  gpuCount: number;
  gpuName?: string;
  gpuMemoryMiB?: number;
}

/** In-process cache with 6-hour TTL for instance type specs (which do not change). */
const cache = new Map<string, { entry: InstanceCatalogEntry; fetchedAt: number }>();
const TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Normalize an instance type name by stripping the `ml.` prefix if present.
 * Returns undefined if the name does not match the expected format.
 */
export function instanceType(value?: string): string | undefined {
  const name = value?.replace(/^ml\./, '');
  return name && /^[a-z][a-z0-9-]*\.[a-z0-9]+$/.test(name) ? name : undefined;
}

/**
 * Fetch instance type specs from EC2 DescribeInstanceTypes API for the given names.
 * Handles pagination internally. Returns a map keyed by normalized instance type name.
 * Failures return an empty map (caller shows "unknown", never guesses).
 */
export async function describeInstanceTypes(names: string[]): Promise<Map<string, InstanceCatalogEntry>> {
  if (!names.length) return new Map();

  const now = Date.now();
  const toFetch: string[] = [];
  const result = new Map<string, InstanceCatalogEntry>();

  // Check cache first
  for (const name of names) {
    const normalized = instanceType(name);
    if (!normalized) continue;
    const cached = cache.get(normalized);
    if (cached && now - cached.fetchedAt < TTL_MS) {
      result.set(normalized, cached.entry);
    } else {
      toFetch.push(normalized);
    }
  }

  // If everything is cached, return early
  if (toFetch.length === 0) return result;

  // Fetch missing entries from EC2 API
  try {
    const ec2 = new EC2Client({ region: config().region });
    const fetched = await fetchInstanceTypesWithPaging(ec2, toFetch);
    for (const [name, entry] of fetched) {
      cache.set(name, { entry, fetchedAt: now });
      result.set(name, entry);
    }
  } catch {
    // Failure → empty map for unfetched entries
  }

  return result;
}

/**
 * Internal: Fetch instance types from EC2 API with pagination.
 * Returns a map keyed by normalized instance type name.
 */
async function fetchInstanceTypesWithPaging(ec2: EC2Client, names: string[]): Promise<Map<string, InstanceCatalogEntry>> {
  const result = new Map<string, InstanceCatalogEntry>();

  // Paginate in batches of 100 (API limit)
  for (let i = 0; i < names.length; i += 100) {
    const batch = names.slice(i, i + 100);
    let nextToken: string | undefined;
    const seenTokens = new Set<string>();

    do {
      const response = await ec2.send(
        new DescribeInstanceTypesCommand({
          InstanceTypes: batch as _InstanceType[],
          NextToken: nextToken,
        }),
        { abortSignal: AbortSignal.timeout(15_000) },
      );

      for (const type of response.InstanceTypes ?? []) {
        const name = instanceType(type.InstanceType);
        if (!name) continue;

        const gpus = type.GpuInfo?.Gpus;
        const gpuCount = !type.GpuInfo ? 0 : gpus?.every((g) => Number.isInteger(g.Count)) ? gpus.reduce((sum, g) => sum + g.Count!, 0) : undefined;
        const memoryKnown = gpus?.length && gpus.every((g) => Number.isFinite(g.MemoryInfo?.SizeInMiB));

        result.set(name, {
          vCpu: type.VCpuInfo?.DefaultVCpus,
          memoryMiB: type.MemoryInfo?.SizeInMiB,
          gpuCount: gpuCount ?? 0,
          gpuName: gpus?.[0]?.Name,
          gpuMemoryMiB: memoryKnown ? Math.min(...gpus!.map((g) => g.MemoryInfo!.SizeInMiB!)) : undefined,
        });
      }

      nextToken = response.NextToken;
      if (nextToken && (seenTokens.has(nextToken) || seenTokens.size >= 100)) throw new Error('Instance type pagination failed');
      if (nextToken) seenTokens.add(nextToken);
    } while (nextToken);
  }

  return result;
}
