import { config } from '../config';
import { listNodes } from '../k8s/resources';
import { describeInstanceTypes, instanceType as normalizeInstanceType, type InstanceCatalogEntry } from './instance-catalog';

// Re-export for backward compatibility
export { instanceType } from './instance-catalog';

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
export interface HardwareInspectionDeps { nodes(): Promise<ProbeNode[]>; catalogEntry(name: string): Promise<InstanceCatalogEntry | undefined>; now(): Date }
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
  return {
    nodes: listNodes,
    now: () => new Date(),
    catalogEntry: async (name) => {
      const map = await describeInstanceTypes([name]);
      return map.get(normalizeInstanceType(name) ?? name);
    },
  };
}
/** Catalog memory describes the instance type, not a measured GPU/driver or free resource reservation. */
export async function inspectHardware(d = defaults()): Promise<HardwareSnapshot> {
  const nodes = await d.nodes();
  let catalogAvailable = true;

  const inspectedNodes = await Promise.all(nodes.map(async n => {
    const platform = normalizeInstanceType(n.metadata.labels?.['node.kubernetes.io/instance-type']);
    let type: InstanceCatalogEntry | undefined;
    if (platform) {
      try {
        type = await d.catalogEntry(platform);
      } catch {
        catalogAvailable = false;
      }
    }
    return {
      name: n.metadata.name, instanceType: platform, architecture: n.metadata.labels?.['kubernetes.io/arch'],
      ready: n.status?.conditions?.some(c => c.type === 'Ready' && c.status === 'True') ?? false,
      schedulable: !n.spec?.unschedulable && !n.metadata.deletionTimestamp &&
        (!n.metadata.labels?.['sagemaker.amazonaws.com/node-health-status'] || n.metadata.labels['sagemaker.amazonaws.com/node-health-status'] === 'Schedulable'),
      allocatable: { cpu: quantity(n.status?.allocatable?.cpu, 'cpu'), memoryMiB: quantity(n.status?.allocatable?.memory, 'memory'),
        gpu: n.status?.allocatable?.['nvidia.com/gpu'] === undefined ? undefined : quantity(n.status.allocatable['nvidia.com/gpu'], 'cpu') },
      ...(type ? { catalog: {
        cpu: type.vCpu, memoryMiB: type.memoryMiB,
        architectures: [], // Note: architecture info is not available from the simplified catalog
        gpuCount: type.gpuCount,
        gpuMemoryMiB: type.gpuMemoryMiB,
        gpuNames: type.gpuName ? [type.gpuName] : [],
      } } : {}),
    };
  }));

  return {
    source: 'eks-nodes+ec2-instance-types',
    checkedAt: d.now().toISOString(),
    catalogAvailable,
    nodes: inspectedNodes,
  };
}
