/** Trusted pool registration; order is physical hierarchy, never YAML list order. */
export interface TopologyLevel { key: string; label: string }
export interface TopologyNode {
  name: string;
  uid: string;
  labels: Record<string, string>;
  ready: boolean;
  unschedulable?: boolean;
  taints: { key: string; value?: string; effect: string }[];
  /** Allocatable minus bound, nonterminal Pod requests; canonical cores/bytes/counts. */
  available: Record<string, number>;
  unavailableReason?: string;
}
export interface TopologyInventory {
  namespace: string;
  queue: string;
  revision: string;
  observedAt: string;
  levels: TopologyLevel[];
  /** Nodes already restricted to the registered pool/flavor selector. */
  nodes: TopologyNode[];
}
export interface TaskPlacement {
  required: Record<string, string>;
  preferred: Record<string, string>[];
  nodes: { name: string; uid: string }[];
}
export interface TopologyPlan {
  schema: 1;
  workflowId: string;
  epoch: string;
  namespace: string;
  queue: string;
  revision: string;
  observedAt: string;
  levels: TopologyLevel[];
  tasks: Record<string, TaskPlacement>;
  witness: { task: string; replica: number; node: string }[];
  relaxed: string[];
  diagnostics: string[];
  hash: string;
}
