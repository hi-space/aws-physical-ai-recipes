/**
 * Pure left-to-right layered layout for a workflow DAG. Tasks are placed in columns by dependency depth
 * (longest path from a root), dataset inputs sit in the column left of their first consumer, and every
 * column is centred on y = 0 so a straight chain draws as a straight line. React Flow only consumes the
 * resulting coordinates; keeping the maths here lets it run in plain Node tests.
 */

type TaskInput = { task: string } | { dataset: { name: string; version?: number | 'latest'; path?: string } };
/** Minimal structural subset of WorkflowSpec the layout needs (keeps tests free of the zod schema). */
export interface DagSpec {
  workflow: { tasks: Array<{ name: string; inputs: TaskInput[] }> };
}

export interface DagLayoutNode {
  id: string;
  kind: 'task' | 'dataset';
  label: string;
  column: number;
  row: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Dataset nodes only. */
  datasetVersion?: number | 'latest';
}

export interface DagLayoutEdge {
  id: string;
  source: string;
  target: string;
  kind: 'task' | 'dataset';
  /** Number of columns the edge crosses; > 1 means it passes over other nodes. */
  span: number;
  /** For span > 1: y coordinate the arc apex should clear, above the tallest intermediate node. */
  arcY?: number;
}

export interface DagLayout {
  nodes: DagLayoutNode[];
  edges: DagLayoutEdge[];
  /** Task names in execution (reading) order: column first, then row. */
  steps: string[];
  columns: number;
}

export interface DagLayoutOptions {
  columnGap: number;
  rowGap: number;
  nodeWidth: number;
  nodeHeight: number;
  datasetWidth: number;
  datasetHeight: number;
  /** Clearance between an arc apex and the node it passes over. */
  arcMargin: number;
}

export const DEFAULT_LAYOUT: DagLayoutOptions = {
  columnGap: 290,
  rowGap: 116,
  nodeWidth: 220,
  nodeHeight: 84,
  datasetWidth: 168,
  datasetHeight: 48,
  arcMargin: 36,
};

export const datasetNodeId = (name: string) => `dataset:${name}`;

export function layoutDag(spec: DagSpec, options: Partial<DagLayoutOptions> = {}): DagLayout {
  const opt = { ...DEFAULT_LAYOUT, ...options };
  const tasks = spec.workflow.tasks;
  const byName = new Map(tasks.map((t) => [t.name, t]));

  // Longest-path depth; unknown upstream names are ignored so a half-edited spec still renders.
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (name: string): number => {
    const known = depth.get(name);
    if (known !== undefined) return known;
    if (visiting.has(name)) return 0; // cycle guard: validation rejects cycles, layout must not hang on them
    visiting.add(name);
    const task = byName.get(name);
    const upstream = (task?.inputs ?? []).flatMap((i) => ('task' in i && byName.has(i.task) ? [i.task] : []));
    const d = upstream.length ? Math.max(...upstream.map(depthOf)) + 1 : 0;
    visiting.delete(name);
    depth.set(name, d);
    return d;
  };
  for (const t of tasks) depthOf(t.name);

  // Datasets get their own column left of the first consumer; shift tasks right if a root consumes one.
  const datasetConsumers = new Map<string, { version?: number | 'latest'; consumers: string[] }>();
  for (const t of tasks) for (const i of t.inputs) if ('dataset' in i) {
    const entry = datasetConsumers.get(i.dataset.name) ?? { version: i.dataset.version, consumers: [] };
    entry.consumers.push(t.name);
    datasetConsumers.set(i.dataset.name, entry);
  }
  const rootConsumesDataset = [...datasetConsumers.values()].some((d) => d.consumers.some((c) => depth.get(c) === 0));
  const offset = rootConsumesDataset ? 1 : 0;

  const columnOf = new Map<string, number>();
  for (const t of tasks) columnOf.set(t.name, (depth.get(t.name) ?? 0) + offset);
  for (const [name, d] of datasetConsumers) columnOf.set(datasetNodeId(name), Math.min(...d.consumers.map((c) => columnOf.get(c)!)) - 1);

  // Upstream ids per node, used for barycentre ordering and for the edge list.
  const upstreamOf = new Map<string, string[]>();
  for (const t of tasks) {
    upstreamOf.set(t.name, t.inputs.flatMap((i) => ('task' in i ? (byName.has(i.task) ? [i.task] : []) : [datasetNodeId(i.dataset.name)])));
  }

  const columns = new Map<number, string[]>();
  const push = (col: number, id: string) => columns.set(col, [...(columns.get(col) ?? []), id]);
  for (const [name] of datasetConsumers) push(columnOf.get(datasetNodeId(name))!, datasetNodeId(name));
  for (const t of tasks) push(columnOf.get(t.name)!, t.name);

  // Order rows left to right by the mean row of upstream nodes (one barycentre sweep reduces crossings);
  // ties keep spec order so the picture is stable between renders.
  const rowOf = new Map<string, number>();
  const sortedCols = [...columns.keys()].sort((a, b) => a - b);
  for (const col of sortedCols) {
    const ids = columns.get(col)!;
    const key = (id: string) => {
      const ups = (upstreamOf.get(id) ?? []).filter((u) => rowOf.has(u));
      return ups.length ? ups.reduce((s, u) => s + rowOf.get(u)!, 0) / ups.length : Number.POSITIVE_INFINITY;
    };
    const ordered = ids.map((id, index) => ({ id, index, key: key(id) })).sort((a, b) => (a.key === b.key ? a.index - b.index : a.key - b.key)).map((e) => e.id);
    ordered.forEach((id, row) => rowOf.set(id, row));
    columns.set(col, ordered);
  }

  const nodes: DagLayoutNode[] = [];
  const nodeById = new Map<string, DagLayoutNode>();
  const firstCol = sortedCols[0] ?? 0;
  for (const col of sortedCols) {
    const ids = columns.get(col)!;
    const centre = (ids.length - 1) / 2;
    for (const id of ids) {
      const isDataset = id.startsWith('dataset:');
      const width = isDataset ? opt.datasetWidth : opt.nodeWidth;
      const height = isDataset ? opt.datasetHeight : opt.nodeHeight;
      const node: DagLayoutNode = {
        id,
        kind: isDataset ? 'dataset' : 'task',
        label: isDataset ? id.slice('dataset:'.length) : id,
        column: col - firstCol,
        row: rowOf.get(id)!,
        x: (col - firstCol) * opt.columnGap + (opt.nodeWidth - width) / 2,
        y: (rowOf.get(id)! - centre) * opt.rowGap,
        width,
        height,
        ...(isDataset ? { datasetVersion: datasetConsumers.get(id.slice('dataset:'.length))?.version } : {}),
      };
      nodes.push(node);
      nodeById.set(id, node);
    }
  }

  const edges: DagLayoutEdge[] = [];
  for (const t of tasks) {
    for (const source of upstreamOf.get(t.name) ?? []) {
      const s = nodeById.get(source)!;
      const target = nodeById.get(t.name)!;
      const span = target.column - s.column;
      const edge: DagLayoutEdge = { id: `${source}->${t.name}`, source, target: t.name, kind: s.kind, span };
      if (span > 1) {
        const between = nodes.filter((n) => n.column > s.column && n.column < target.column);
        const top = Math.min(...between.map((n) => n.y - n.height / 2), s.y, target.y);
        edge.arcY = top - opt.arcMargin;
      }
      edges.push(edge);
    }
  }

  const steps = nodes.filter((n) => n.kind === 'task').sort((a, b) => a.column - b.column || a.row - b.row).map((n) => n.id);
  return { nodes, edges, steps, columns: sortedCols.length };
}

/** The selected node plus its direct upstream and downstream neighbours; everything else can be dimmed. */
export function relatedNodes(layout: DagLayout, selected: string | undefined): Set<string> {
  const related = new Set<string>();
  if (!selected) return related;
  related.add(selected);
  for (const e of layout.edges) {
    if (e.source === selected) related.add(e.target);
    if (e.target === selected) related.add(e.source);
  }
  return related;
}
