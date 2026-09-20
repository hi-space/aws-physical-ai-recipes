import { describe, it, expect } from 'vitest';
import {
  composerReducer,
  connectionReason,
  handleCompatible,
  boundInputs,
  paramsForNode,
  toComposeGraph,
  initialComposerState,
  type ComposerState,
  type NodeDef,
  type DatasetNodeDef,
} from './composer-state';
import type { TemplateDto } from '@/lib/workflow/template-dto';

const seed = (): ComposerState => structuredClone(initialComposerState);

describe('composerReducer', () => {
  it('adds a node and selects it', () => {
    const state = composerReducer(seed(), { type: 'ADD_NODE', nodeId: 'n1', templateId: 'gr00t-finetune', title: 'Finetune', x: 100, y: 200 });
    expect(state.nodes).toHaveLength(1);
    expect(state.nodes[0]).toMatchObject({ id: 'n1', templateId: 'gr00t-finetune', title: 'Finetune', position: { x: 100, y: 200 } });
    expect(state.selectedNodeId).toBe('n1');
  });

  it('removes a node with its edges and params, clearing selection', () => {
    let state = composerReducer(seed(), { type: 'ADD_NODE', nodeId: 'n1', templateId: 'hf-import', title: 'Import', x: 0, y: 0 });
    state = composerReducer(state, { type: 'ADD_NODE', nodeId: 'n2', templateId: 'gr00t-finetune', title: 'Finetune', x: 200, y: 0 });
    state = composerReducer(state, { type: 'SET_PARAM', nodeId: 'n1', paramName: 'hf_id', value: 'lerobot/x' });
    state = composerReducer(state, { type: 'CONNECT', edgeId: 'e1', from: { nodeId: 'n1', portName: 'hf-import' }, to: { nodeId: 'n2', paramName: 'dataset_name' } });
    expect(state.edges).toHaveLength(1);

    state = composerReducer(state, { type: 'SELECT_NODE', nodeId: 'n1' });
    state = composerReducer(state, { type: 'REMOVE_NODE', nodeId: 'n1' });
    expect(state.nodes).toHaveLength(1);
    expect(state.edges).toHaveLength(0); // edge whose source was n1 is gone
    expect(state.params['n1/hf_id']).toBeUndefined();
    expect(state.selectedNodeId).toBeUndefined();
  });

  it('removes edges pointing into a deleted node', () => {
    let state = composerReducer(seed(), { type: 'ADD_NODE', nodeId: 'n1', templateId: 'hf-import', title: 'Import', x: 0, y: 0 });
    state = composerReducer(state, { type: 'ADD_NODE', nodeId: 'n2', templateId: 'gr00t-finetune', title: 'Finetune', x: 200, y: 0 });
    state = composerReducer(state, { type: 'CONNECT', edgeId: 'e1', from: { nodeId: 'n1', portName: 'hf-import' }, to: { nodeId: 'n2', paramName: 'dataset_name' } });
    state = composerReducer(state, { type: 'REMOVE_NODE', nodeId: 'n2' });
    expect(state.edges).toHaveLength(0);
  });

  it('adds and removes a dataset source, dropping its edges', () => {
    let state = composerReducer(seed(), { type: 'ADD_NODE', nodeId: 'n2', templateId: 'gr00t-finetune', title: 'Finetune', x: 200, y: 0 });
    state = composerReducer(state, { type: 'ADD_DATASET', datasetId: 'd1', name: 'pick-place', version: 3, x: 0, y: 0 });
    state = composerReducer(state, { type: 'CONNECT', edgeId: 'e1', from: { datasetId: 'd1' }, to: { nodeId: 'n2', paramName: 'dataset_name' } });
    expect(state.datasets).toHaveLength(1);
    expect(state.edges).toHaveLength(1);
    state = composerReducer(state, { type: 'REMOVE_DATASET', datasetId: 'd1' });
    expect(state.datasets).toHaveLength(0);
    expect(state.edges).toHaveLength(0);
  });

  it('binds a dataset node to a name, version and derived kind', () => {
    let state = composerReducer(seed(), { type: 'ADD_DATASET', datasetId: 'd1', name: '', version: 0, x: 0, y: 0 });
    expect(state.datasets[0]).toMatchObject({ name: '', version: 0 });
    expect(state.datasets[0].kind).toBeUndefined();
    state = composerReducer(state, { type: 'SET_DATASET', datasetId: 'd1', name: 'pick-place', version: 4, kind: 'checkpoint' });
    expect(state.datasets[0]).toMatchObject({ name: 'pick-place', version: 4, kind: 'checkpoint' });
  });

  it('clears the derived kind when an untagged dataset is chosen', () => {
    let state = composerReducer(seed(), { type: 'ADD_DATASET', datasetId: 'd1', name: '', version: 0, x: 0, y: 0 });
    state = composerReducer(state, { type: 'SET_DATASET', datasetId: 'd1', name: 'tagged', version: 1, kind: 'video' });
    state = composerReducer(state, { type: 'SET_DATASET', datasetId: 'd1', name: 'untagged', version: 2 });
    expect(state.datasets[0].kind).toBeUndefined();
  });

  it('replaces an edge already bound to the same input', () => {
    let state = composerReducer(seed(), { type: 'CONNECT', edgeId: 'e1', from: { nodeId: 'a', portName: 'out' }, to: { nodeId: 'n2', paramName: 'dataset_name' } });
    state = composerReducer(state, { type: 'CONNECT', edgeId: 'e2', from: { nodeId: 'b', portName: 'out' }, to: { nodeId: 'n2', paramName: 'dataset_name' } });
    expect(state.edges).toHaveLength(1);
    expect(state.edges[0].id).toBe('e2');
  });

  it('disconnects, sets params, renames and moves', () => {
    let state = composerReducer(seed(), { type: 'ADD_NODE', nodeId: 'n1', templateId: 'gr00t-finetune', title: 'Finetune', x: 0, y: 0 });
    state = composerReducer(state, { type: 'SET_PARAM', nodeId: 'n1', paramName: 'seed', value: '42' });
    expect(state.params['n1/seed']).toBe('42');
    state = composerReducer(state, { type: 'RENAME_NODE', nodeId: 'n1', newTitle: 'Custom Finetune' });
    expect(state.nodes[0].title).toBe('Custom Finetune');
    state = composerReducer(state, { type: 'MOVE_NODE', nodeId: 'n1', x: 5, y: 6 });
    expect(state.nodes[0].position).toEqual({ x: 5, y: 6 });
    state = composerReducer(state, { type: 'CONNECT', edgeId: 'e1', from: { nodeId: 'x', portName: 'out' }, to: { nodeId: 'n1', paramName: 'p' } });
    state = composerReducer(state, { type: 'DISCONNECT', edgeId: 'e1' });
    expect(state.edges).toHaveLength(0);
  });
});

describe('paramsForNode / boundInputs', () => {
  it('strips the node prefix from param keys', () => {
    const params = { 'n1/seed': '42', 'n1/lr': '1e-4', 'n2/seed': '7' };
    expect(paramsForNode(params, 'n1')).toEqual({ seed: '42', lr: '1e-4' });
  });
  it('collects every edge target as a bound input', () => {
    const bound = boundInputs([
      { id: 'e1', from: { nodeId: 'a', portName: 'o' }, to: { nodeId: 'n2', paramName: 'dataset_name' } },
      { id: 'e2', from: { datasetId: 'd1' }, to: { nodeId: 'n3', paramName: 'in' } },
    ]);
    expect(bound.has('n2/dataset_name')).toBe(true);
    expect(bound.has('n3/in')).toBe(true);
    expect(bound.has('n2/other')).toBe(false);
  });
});

describe('toComposeGraph', () => {
  it('translates editor field names into the compose graph shape', () => {
    let state = seed();
    state = composerReducer(state, { type: 'ADD_NODE', nodeId: 'n1', templateId: 'hf-import', title: 'Import', x: 0, y: 0 });
    state = composerReducer(state, { type: 'ADD_NODE', nodeId: 'n2', templateId: 'gr00t-finetune', title: 'Finetune', x: 1, y: 0 });
    state = composerReducer(state, { type: 'ADD_DATASET', datasetId: 'd1', name: 'pick', version: 2, x: 0, y: 1 });
    state = composerReducer(state, { type: 'SET_PARAM', nodeId: 'n2', paramName: 'seed', value: '42' });
    state = composerReducer(state, { type: 'CONNECT', edgeId: 'e1', from: { nodeId: 'n1', portName: 'hf-import' }, to: { nodeId: 'n2', paramName: 'dataset_name' } });
    state = composerReducer(state, { type: 'CONNECT', edgeId: 'e2', from: { datasetId: 'd1' }, to: { nodeId: 'n2', paramName: 'aux' } });

    const graph = toComposeGraph(state);
    expect(graph.nodes).toEqual([
      { id: 'n1', templateId: 'hf-import', title: 'Import', params: {} },
      { id: 'n2', templateId: 'gr00t-finetune', title: 'Finetune', params: { seed: '42' } },
    ]);
    expect(graph.datasets).toEqual([{ id: 'd1', name: 'pick', version: 2 }]);
    expect(graph.edges).toEqual([
      { from: { node: 'n1', port: 'hf-import' }, to: { node: 'n2', param: 'dataset_name' } },
      { from: { dataset: 'd1' }, to: { node: 'n2', param: 'aux' } },
    ]);
  });
});

// ---- Connection validation ----
const templates = [
  { id: 'hf-import', recipe: { ports: { inputs: [], outputs: [{ name: 'hf-import', kind: 'lerobot-dataset', label: 'HF' }] } } },
  { id: 'gr00t-finetune', recipe: { ports: { inputs: [{ param: 'dataset_name', kind: 'lerobot-dataset', label: 'Dataset' }], outputs: [{ name: 'groot-checkpoints', kind: 'checkpoint', label: 'Checkpoint' }] } } },
  { id: 'leisaac-evaluate', recipe: { ports: { inputs: [{ param: 'dataset_name', kind: 'checkpoint', label: 'Checkpoint' }], outputs: [] } } },
] as unknown as TemplateDto[];

const nodes: NodeDef[] = [
  { id: 'n1', templateId: 'hf-import', title: 'Import', position: { x: 0, y: 0 } },
  { id: 'n2', templateId: 'gr00t-finetune', title: 'Finetune', position: { x: 200, y: 0 } },
  { id: 'n3', templateId: 'leisaac-evaluate', title: 'Evaluate', position: { x: 400, y: 0 } },
];
const datasets: DatasetNodeDef[] = [
  { id: 'd1', name: 'pick', version: 1, position: { x: 0, y: 100 } }, // untagged → unverified kind
  { id: 'd2', name: 'ckpt', version: 1, kind: 'checkpoint', position: { x: 0, y: 200 } }, // tagged checkpoint
  { id: 'd3', name: 'lr', version: 1, kind: 'lerobot-dataset', position: { x: 0, y: 300 } }, // tagged lerobot
];

describe('connectionReason', () => {
  const cand = (source: string, sourceHandle: string, target: string, targetHandle: string) => ({ source, sourceHandle, target, targetHandle });

  it('accepts a matching recipe→recipe edge', () => {
    expect(connectionReason(cand('n1', 'hf-import', 'n2', 'dataset_name'), nodes, datasets, templates, [])).toBeNull();
  });
  it('accepts an untagged dataset source into any input (unverified kind)', () => {
    expect(connectionReason(cand('d1', 'dataset', 'n3', 'dataset_name'), nodes, datasets, templates, [])).toBeNull();
  });
  it('accepts a tagged dataset source into a matching input', () => {
    // d2 is tagged checkpoint; n3.dataset_name is a checkpoint input.
    expect(connectionReason(cand('d2', 'dataset', 'n3', 'dataset_name'), nodes, datasets, templates, [])).toBeNull();
  });
  it('rejects a tagged dataset source into a mismatched input', () => {
    // d3 is tagged lerobot-dataset; n3.dataset_name is a checkpoint input.
    expect(connectionReason(cand('d3', 'dataset', 'n3', 'dataset_name'), nodes, datasets, templates, [])).toBe('kind_mismatch');
    // d2 is tagged checkpoint; n2.dataset_name is a lerobot-dataset input.
    expect(connectionReason(cand('d2', 'dataset', 'n2', 'dataset_name'), nodes, datasets, templates, [])).toBe('kind_mismatch');
  });
  it('reports a self-loop', () => {
    expect(connectionReason(cand('n2', 'groot-checkpoints', 'n2', 'dataset_name'), nodes, datasets, templates, [])).toBe('self');
  });
  it('reports kind mismatch between recipes', () => {
    expect(connectionReason(cand('n1', 'hf-import', 'n3', 'dataset_name'), nodes, datasets, templates, [])).toBe('kind_mismatch');
  });
  it('reports an already-bound input', () => {
    const edges = [{ id: 'e1', from: { datasetId: 'd1' }, to: { nodeId: 'n2', paramName: 'dataset_name' } }] as const;
    expect(connectionReason(cand('n1', 'hf-import', 'n2', 'dataset_name'), nodes, datasets, templates, [...edges])).toBe('input_bound');
  });
  it('reports unknown ports and incomplete endpoints', () => {
    expect(connectionReason(cand('n1', 'hf-import', 'n2', 'nope'), nodes, datasets, templates, [])).toBe('unknown_port');
    expect(connectionReason({ source: null, sourceHandle: 'x', target: 'n2', targetHandle: 'dataset_name' }, nodes, datasets, templates, [])).toBe('incomplete');
  });
});

describe('SET_DATASET edge pruning', () => {
  // A dataset source fanned out to two inputs: n2.dataset_name is lerobot-dataset, n3.dataset_name is checkpoint.
  const build = (): ComposerState => {
    let s = seed();
    s = composerReducer(s, { type: 'ADD_NODE', nodeId: 'n2', templateId: 'gr00t-finetune', title: 'Finetune', x: 0, y: 0 });
    s = composerReducer(s, { type: 'ADD_NODE', nodeId: 'n3', templateId: 'leisaac-evaluate', title: 'Evaluate', x: 0, y: 0 });
    s = composerReducer(s, { type: 'ADD_DATASET', datasetId: 'd1', name: 'set', version: 1, x: 0, y: 0 });
    s = composerReducer(s, { type: 'CONNECT', edgeId: 'e-lr', from: { datasetId: 'd1' }, to: { nodeId: 'n2', paramName: 'dataset_name' } });
    s = composerReducer(s, { type: 'CONNECT', edgeId: 'e-ckpt', from: { datasetId: 'd1' }, to: { nodeId: 'n3', paramName: 'dataset_name' } });
    return s;
  };

  it('drops edges into inputs of a different kind once the dataset kind becomes verified', () => {
    const state = composerReducer(build(), { type: 'SET_DATASET', datasetId: 'd1', name: 'set', version: 2, kind: 'checkpoint', templates });
    // Edge into the checkpoint input survives; edge into the lerobot-dataset input is severed.
    expect(state.edges.map((e) => e.id)).toEqual(['e-ckpt']);
    expect(state.datasets[0].kind).toBe('checkpoint');
  });

  it('keeps every edge when the chosen dataset is untagged (kind stays unverified)', () => {
    const state = composerReducer(build(), { type: 'SET_DATASET', datasetId: 'd1', name: 'set', version: 2, templates });
    expect(state.edges).toHaveLength(2);
    expect(state.datasets[0].kind).toBeUndefined();
  });
});

describe('handleCompatible', () => {
  const out = (nodeId: string, kind?: 'checkpoint' | 'lerobot-dataset'): Parameters<typeof handleCompatible>[0] => ({ nodeId, type: 'source', kind });
  const inp = (nodeId: string, kind: 'checkpoint' | 'lerobot-dataset', bound = false): Parameters<typeof handleCompatible>[0] => ({ nodeId, type: 'target', kind, bound });

  it('accepts an input of the same kind on another node', () => {
    expect(handleCompatible(out('a', 'checkpoint'), inp('b', 'checkpoint'))).toBe(true);
  });
  it('rejects a kind mismatch, the same node, and same-direction handles', () => {
    expect(handleCompatible(out('a', 'checkpoint'), inp('b', 'lerobot-dataset'))).toBe(false);
    expect(handleCompatible(out('a', 'checkpoint'), inp('a', 'checkpoint'))).toBe(false);
    expect(handleCompatible(out('a', 'checkpoint'), out('b', 'checkpoint'))).toBe(false);
  });
  it('rejects an input that is already bound, whichever end the drag started from', () => {
    expect(handleCompatible(out('a', 'checkpoint'), inp('b', 'checkpoint', true))).toBe(false);
    expect(handleCompatible(inp('b', 'checkpoint', true), out('a', 'checkpoint'))).toBe(false);
  });
  it('treats an unverified dataset kind as matching anything, in both drag directions', () => {
    expect(handleCompatible(out('ds', undefined), inp('b', 'lerobot-dataset'))).toBe(true);
    expect(handleCompatible(inp('b', 'lerobot-dataset'), out('ds', undefined))).toBe(true);
  });
  it('works when the drag starts from an input handle', () => {
    expect(handleCompatible(inp('b', 'checkpoint'), out('a', 'checkpoint'))).toBe(true);
    expect(handleCompatible(inp('b', 'checkpoint'), out('a', 'lerobot-dataset'))).toBe(false);
  });
});
