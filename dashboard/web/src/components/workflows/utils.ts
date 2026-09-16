import { topoOrder } from '@/server/workflow/schema';
import type { TaskPhase, WorkflowStatus } from '@/server/store/types';

export const PHASE_COLORS: Record<TaskPhase, string> = {
  WAITING: 'bg-gray-600',
  QUEUED: 'bg-amber-500',
  PENDING: 'bg-amber-600',
  RUNNING: 'bg-blue-500',
  SUCCEEDED: 'bg-emerald-500',
  FAILED: 'bg-red-500',
  CANCELLED: 'bg-gray-600',
  SKIPPED: 'bg-gray-600',
};

export const STATUS_COLORS: Record<WorkflowStatus, string> = {
  PENDING: 'bg-amber-600',
  RUNNING: 'bg-blue-500',
  SUCCEEDED: 'bg-emerald-500',
  FAILED: 'bg-red-500',
  CANCELLED: 'bg-gray-600',
};

export function topologicalLayout(
  taskNames: string[],
  deps: Map<string, string[]>,
  itemHeight: number = 110,
  itemWidth: number = 260
) {
  const order = topologicalLayoutOrder(taskNames, deps);
  const positions = new Map<string, { x: number; y: number }>();
  const depthMap = new Map<string, number>();

  // Calculate depths
  const calculateDepth = (name: string, visited = new Set<string>()): number => {
    if (visited.has(name)) return depthMap.get(name) ?? 0;
    visited.add(name);
    const inputs = deps.get(name) ?? [];
    if (inputs.length === 0) {
      depthMap.set(name, 0);
      return 0;
    }
    const maxDepth = Math.max(...inputs.map((input) => calculateDepth(input, visited)));
    depthMap.set(name, maxDepth + 1);
    return maxDepth + 1;
  };

  for (const name of taskNames) calculateDepth(name);

  // Assign positions by depth and index within depth
  const byDepth = new Map<number, string[]>();
  for (const name of taskNames) {
    const depth = depthMap.get(name) ?? 0;
    if (!byDepth.has(depth)) byDepth.set(depth, []);
    byDepth.get(depth)!.push(name);
  }

  for (const [depth, names] of byDepth.entries()) {
    names.forEach((name, idx) => {
      positions.set(name, {
        x: depth * itemWidth,
        y: idx * itemHeight,
      });
    });
  }

  return positions;
}

function topologicalLayoutOrder(taskNames: string[], deps: Map<string, string[]>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (n: string) => {
    if (seen.has(n)) return;
    seen.add(n);
    for (const dep of deps.get(n) ?? []) if (taskNames.includes(dep)) visit(dep);
    out.push(n);
  };
  for (const t of taskNames) visit(t);
  return out;
}
