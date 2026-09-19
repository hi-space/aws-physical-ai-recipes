'use client';
import type { TemplateDto } from '@/lib/workflow/template-dto';
import type { ComposeGraph } from '@/lib/workflow/compose';
import type { PortKind } from '@/lib/workflow/ports';

// ---------------------------------------------------------------------------------------------------
// Editor state. This mirrors the on-canvas view: recipe nodes, dataset-source nodes and typed edges,
// plus a flat param map keyed "<nodeId>/<paramName>". It is deliberately close to — but NOT identical
// to — `ComposeGraph` from lib/workflow/compose.ts: the editor keeps React-Flow-friendly field names
// (`nodeId`/`portName`/`paramName`/`datasetId`) and node positions, while `composeWorkflow` wants the
// terser `{node,port}`/`{dataset}`/`{node,param}` shape. `toComposeGraph` is the single translation
// point between the two, so the rest of the editor never has to think about the compiler's shape.
// ---------------------------------------------------------------------------------------------------

export interface NodeDef {
  id: string;
  templateId: string;
  title: string;
  position: { x: number; y: number };
}

export interface DatasetNodeDef {
  id: string;
  /** Registered dataset name; empty until the user picks one in the inspector. */
  name: string;
  version: number;
  /**
   * Output port kind, derived from the picked dataset's `kind:<PortKind>` tag (written by
   * artifacts.ts at publication). `undefined` means the kind is unverified — the source connects to
   * any input (facts over guesses); a tagged kind only connects to matching inputs.
   */
  kind?: PortKind;
  position: { x: number; y: number };
}

export type EdgeSource = { nodeId: string; portName: string } | { datasetId: string };

export interface EdgeDef {
  id: string;
  from: EdgeSource;
  to: { nodeId: string; paramName: string };
}

export interface ComposerState {
  nodes: NodeDef[];
  datasets: DatasetNodeDef[];
  edges: EdgeDef[];
  /** "<nodeId>/<paramName>" → value. Node param values the user set in the inspector. */
  params: Record<string, string>;
  selectedNodeId?: string;
}

export type ComposerAction =
  | { type: 'ADD_NODE'; nodeId: string; templateId: string; title: string; x: number; y: number }
  | { type: 'REMOVE_NODE'; nodeId: string }
  | { type: 'ADD_DATASET'; datasetId: string; name: string; version: number; x: number; y: number }
  | { type: 'SET_DATASET'; datasetId: string; name: string; version: number; kind?: PortKind; templates?: TemplateDto[] }
  | { type: 'REMOVE_DATASET'; datasetId: string }
  | { type: 'CONNECT'; edgeId: string; from: EdgeSource; to: EdgeDef['to'] }
  | { type: 'DISCONNECT'; edgeId: string }
  | { type: 'SET_PARAM'; nodeId: string; paramName: string; value: string }
  | { type: 'RENAME_NODE'; nodeId: string; newTitle: string }
  | { type: 'MOVE_NODE'; nodeId: string; x: number; y: number }
  | { type: 'MOVE_DATASET'; datasetId: string; x: number; y: number }
  | { type: 'SELECT_NODE'; nodeId?: string };

export const initialComposerState: ComposerState = { nodes: [], datasets: [], edges: [], params: {} };

const paramKey = (nodeId: string, paramName: string) => `${nodeId}/${paramName}`;
const edgeFromNode = (from: EdgeSource): from is { nodeId: string; portName: string } => 'nodeId' in from;

export function composerReducer(state: ComposerState, action: ComposerAction): ComposerState {
  switch (action.type) {
    case 'ADD_NODE':
      return {
        ...state,
        nodes: [
          ...state.nodes,
          { id: action.nodeId, templateId: action.templateId, title: action.title, position: { x: action.x, y: action.y } },
        ],
        selectedNodeId: action.nodeId,
      };
    case 'REMOVE_NODE': {
      const params = { ...state.params };
      for (const key of Object.keys(params)) if (key.startsWith(`${action.nodeId}/`)) delete params[key];
      return {
        ...state,
        nodes: state.nodes.filter((n) => n.id !== action.nodeId),
        // Drop edges touching the node on either end.
        edges: state.edges.filter((e) => e.to.nodeId !== action.nodeId && !(edgeFromNode(e.from) && e.from.nodeId === action.nodeId)),
        params,
        selectedNodeId: state.selectedNodeId === action.nodeId ? undefined : state.selectedNodeId,
      };
    }
    case 'ADD_DATASET':
      return {
        ...state,
        datasets: [...state.datasets, { id: action.datasetId, name: action.name, version: action.version, position: { x: action.x, y: action.y } }],
        selectedNodeId: action.datasetId,
      };
    case 'SET_DATASET': {
      const datasets = state.datasets.map((d) => (d.id === action.datasetId ? { ...d, name: action.name, version: action.version, kind: action.kind } : d));
      // A newly-verified (tagged) kind can invalidate edges already drawn from this dataset while its
      // kind was still unverified. Drop only edges into inputs of a *known, different* kind; leave edges
      // into inputs of unknown kind connected (facts over guesses — mirrors connectionReason).
      let edges = state.edges;
      if (action.kind) {
        edges = edges.filter((e) => {
          if (edgeFromNode(e.from) || e.from.datasetId !== action.datasetId) return true;
          const targetNode = state.nodes.find((n) => n.id === e.to.nodeId);
          const targetTemplate = action.templates?.find((t) => t.id === targetNode?.templateId);
          const inputKind = targetTemplate?.recipe?.ports?.inputs.find((p) => p.param === e.to.paramName)?.kind;
          return inputKind === undefined || inputKind === action.kind;
        });
      }
      return { ...state, datasets, edges };
    }
    case 'REMOVE_DATASET':
      return {
        ...state,
        datasets: state.datasets.filter((d) => d.id !== action.datasetId),
        edges: state.edges.filter((e) => edgeFromNode(e.from) || e.from.datasetId !== action.datasetId),
      };
    case 'CONNECT': {
      // A target input holds at most one edge, so replacing any existing edge into the same input keeps
      // the graph consistent even if a stale edge lingers. Also dedupe by edgeId.
      const kept = state.edges.filter(
        (e) => e.id !== action.edgeId && !(e.to.nodeId === action.to.nodeId && e.to.paramName === action.to.paramName),
      );
      return { ...state, edges: [...kept, { id: action.edgeId, from: action.from, to: action.to }] };
    }
    case 'DISCONNECT':
      return { ...state, edges: state.edges.filter((e) => e.id !== action.edgeId) };
    case 'SET_PARAM':
      return { ...state, params: { ...state.params, [paramKey(action.nodeId, action.paramName)]: action.value } };
    case 'RENAME_NODE':
      return { ...state, nodes: state.nodes.map((n) => (n.id === action.nodeId ? { ...n, title: action.newTitle } : n)) };
    case 'MOVE_NODE':
      return { ...state, nodes: state.nodes.map((n) => (n.id === action.nodeId ? { ...n, position: { x: action.x, y: action.y } } : n)) };
    case 'MOVE_DATASET':
      return { ...state, datasets: state.datasets.map((d) => (d.id === action.datasetId ? { ...d, position: { x: action.x, y: action.y } } : d)) };
    case 'SELECT_NODE':
      return { ...state, selectedNodeId: action.nodeId };
    default:
      return state;
  }
}

/** Param values the user set for one node, with the "<nodeId>/" prefix stripped. */
export function paramsForNode(params: Record<string, string>, nodeId: string): Record<string, string> {
  const prefix = `${nodeId}/`;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key.startsWith(prefix)) out[key.slice(prefix.length)] = value;
  }
  return out;
}

/** The set of "<nodeId>/<paramName>" inputs that an edge already binds (node- or dataset-sourced). */
export function boundInputs(edges: EdgeDef[]): Set<string> {
  return new Set(edges.map((e) => paramKey(e.to.nodeId, e.to.paramName)));
}

/** Translate editor state into the `ComposeGraph` shape that `composeWorkflow` consumes. */
export function toComposeGraph(state: ComposerState): ComposeGraph {
  return {
    nodes: state.nodes.map((n) => ({ id: n.id, templateId: n.templateId, title: n.title, params: paramsForNode(state.params, n.id) })),
    datasets: state.datasets.map((d) => ({ id: d.id, name: d.name, version: d.version })),
    edges: state.edges.map((e) => ({
      from: edgeFromNode(e.from) ? { node: e.from.nodeId, port: e.from.portName } : { dataset: e.from.datasetId },
      to: { node: e.to.nodeId, param: e.to.paramName },
    })),
  };
}

// ---------------------------------------------------------------------------------------------------
// Connection validation. Used both as React Flow's `isValidConnection` predicate (synchronous, during
// a drag) and to produce a human reason for the rejection toast.
// ---------------------------------------------------------------------------------------------------

export type ConnectionRejectReason = 'self' | 'incomplete' | 'unknown_port' | 'kind_mismatch' | 'input_bound';

export interface ConnectionCandidate {
  source: string | null | undefined;
  sourceHandle: string | null | undefined;
  target: string | null | undefined;
  targetHandle: string | null | undefined;
}

/**
 * Why a candidate connection is invalid, or `null` if it is valid. A dataset source has an unverified
 * kind, so it connects into any input (facts over guesses — see compose.ts). Recipe→recipe edges must
 * match `PortKind`. An input already bound by another edge is rejected.
 */
export function connectionReason(
  candidate: ConnectionCandidate,
  nodes: NodeDef[],
  datasets: DatasetNodeDef[],
  templates: TemplateDto[],
  edges: EdgeDef[],
): ConnectionRejectReason | null {
  const { source, sourceHandle, target, targetHandle } = candidate;
  if (!source || !sourceHandle || !target || !targetHandle) return 'incomplete';
  if (source === target) return 'self';

  const targetNode = nodes.find((n) => n.id === target);
  const targetTemplate = templates.find((t) => t.id === targetNode?.templateId);
  const targetPort = targetTemplate?.recipe?.ports?.inputs.find((p) => p.param === targetHandle);
  if (!targetPort) return 'unknown_port';

  if (edges.some((e) => e.to.nodeId === target && e.to.paramName === targetHandle)) return 'input_bound';

  // Dataset source: a tagged (verified) kind must match the target input; an untagged dataset has an
  // unverified kind and connects to any input (facts over guesses — see compose.ts).
  const dataset = datasets.find((d) => d.id === source);
  if (dataset) {
    if (dataset.kind && dataset.kind !== targetPort.kind) return 'kind_mismatch';
    return null;
  }

  const sourceNode = nodes.find((n) => n.id === source);
  const sourceTemplate = templates.find((t) => t.id === sourceNode?.templateId);
  const sourcePort = sourceTemplate?.recipe?.ports?.outputs.find((p) => p.name === sourceHandle);
  if (!sourcePort) return 'unknown_port';
  if (sourcePort.kind !== targetPort.kind) return 'kind_mismatch';
  return null;
}
