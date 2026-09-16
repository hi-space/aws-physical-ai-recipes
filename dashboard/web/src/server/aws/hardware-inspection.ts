import { DescribeInstanceTypesCommand, EC2Client, type InstanceTypeInfo, type _InstanceType } from '@aws-sdk/client-ec2';
import { config } from '../config';
import { listNodes } from '../k8s/resources';

export interface HardwareNode {
  name: string; instanceType?: string; architecture?: string; ready: boolean; schedulable: boolean;
  allocatable: { cpu?: number; memoryMiB?: number; gpu?: number };
  catalog?: { cpu?: number; memoryMiB?: number; architectures: string[]; gpuCount?: number; gpuMemoryMiB?: number; gpuNames: string[] };
}
export interface HardwareSnapshot {
  source: 'eks-nodes+ec2-instance-types'; checkedAt: string; catalogAvailable: boolean; nodes: HardwareNode[];
}
interface ProbeNode {
  metadata: { name: string; labels?: Record<string, string>; deletionTimestamp?: string; uid?: string };
  spec?: { unschedulable?: boolean };
  status?: { conditions?: { type: string; status: string }[]; allocatable?: Record<string, string> };
}
export interface HardwareInspectionDeps { nodes(): Promise<ProbeNode[]>; instanceTypes(names: string[]): Promise<InstanceTypeInfo[]>; now(): Date }
export function instanceType(value?: string) {
  const name = value?.replace(/^ml\./, '');
  return name && /^[a-z][a-z0-9-]*\.[a-z0-9]+$/.test(name) ? name : undefined;
}
export function quantity(value: unknown, kind: 'cpu' | 'memory'): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(m|Ki|Mi|Gi|Ti|k|K|M|G|T)?$/.exec(String(value ?? ''));
  if (!match) return;
  const n = Number(match[1]), unit = match[2] ?? '';
  if (kind === 'cpu') return ['', 'm'].includes(unit) ? n / (unit === 'm' ? 1000 : 1) : undefined;
  const scales: Record<string, number> = { '': 1, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, k: 1000, K: 1000, M: 1e6, G: 1e9, T: 1e12 };
  return unit in scales ? n * scales[unit] / 1024 ** 2 : undefined;
}
const arch = (value: string) => value === 'x86_64' ? 'amd64' : value;
function defaults(): HardwareInspectionDeps {
  const ec2 = new EC2Client({ region: config().region });
  return { nodes: listNodes, now: () => new Date(), instanceTypes: async (names) => {
    const result: InstanceTypeInfo[] = [];
    for (let i = 0; i < names.length; i += 100) {
      let next: string | undefined;
      const seen = new Set<string>();
      do {
        const response = await ec2.send(new DescribeInstanceTypesCommand({ InstanceTypes: names.slice(i, i + 100) as _InstanceType[], NextToken: next }), { abortSignal: AbortSignal.timeout(15_000) });
        result.push(...(response.InstanceTypes ?? [])); next = response.NextToken;
        if (next && (seen.has(next) || seen.size >= 100)) throw new Error('Instance type pagination failed');
        if (next) seen.add(next);
      } while (next);
    }
    return result;
  } };
}
/** Catalog memory describes the instance type, not a measured GPU/driver or free resource reservation. */
export async function inspectHardware(d = defaults()): Promise<HardwareSnapshot> {
  const nodes = await d.nodes();
  const names = [...new Set(nodes.map(n => instanceType(n.metadata.labels?.['node.kubernetes.io/instance-type'])).filter((n): n is string => !!n))];
  let types: InstanceTypeInfo[] = [], catalogAvailable = true;
  try { if (names.length) types = await d.instanceTypes(names); } catch { catalogAvailable = false; }
  return { source: 'eks-nodes+ec2-instance-types', checkedAt: d.now().toISOString(), catalogAvailable,
    nodes: nodes.map(n => {
      const platform = instanceType(n.metadata.labels?.['node.kubernetes.io/instance-type']);
      const type = types.find(t => t.InstanceType === platform);
      const gpus = type?.GpuInfo?.Gpus;
      const memoryKnown = gpus?.length && gpus.every(g => Number.isFinite(g.MemoryInfo?.SizeInMiB));
      return {
        name: n.metadata.name, instanceType: platform, architecture: n.metadata.labels?.['kubernetes.io/arch'],
        ready: n.status?.conditions?.some(c => c.type === 'Ready' && c.status === 'True') ?? false,
        schedulable: !n.spec?.unschedulable && !n.metadata.deletionTimestamp &&
          (!n.metadata.labels?.['sagemaker.amazonaws.com/node-health-status'] || n.metadata.labels['sagemaker.amazonaws.com/node-health-status'] === 'Schedulable'),
        allocatable: { cpu: quantity(n.status?.allocatable?.cpu, 'cpu'), memoryMiB: quantity(n.status?.allocatable?.memory, 'memory'),
          gpu: n.status?.allocatable?.['nvidia.com/gpu'] === undefined ? undefined : quantity(n.status.allocatable['nvidia.com/gpu'], 'cpu') },
        ...(type ? { catalog: {
          cpu: type.VCpuInfo?.DefaultVCpus, memoryMiB: type.MemoryInfo?.SizeInMiB,
          architectures: (type.ProcessorInfo?.SupportedArchitectures ?? []).map(arch),
          gpuCount: !type.GpuInfo ? 0 : gpus?.every(g => Number.isInteger(g.Count)) ? gpus.reduce((sum, g) => sum + g.Count!, 0) : undefined,
          gpuMemoryMiB: memoryKnown ? Math.min(...gpus!.map(g => g.MemoryInfo!.SizeInMiB!)) : undefined,
          gpuNames: gpus?.flatMap(g => g.Name ? [g.Name] : []) ?? [],
        } } : {}),
      };
    }),
  };
}
