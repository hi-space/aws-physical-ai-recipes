import { describe, expect, it } from 'vitest';
import { layoutDag, relatedNodes, type DagSpec } from './dag-layout';

const task = (name: string, inputs: DagSpec['workflow']['tasks'][number]['inputs'] = []) => ({ name, inputs });
const spec = (tasks: DagSpec['workflow']['tasks']): DagSpec => ({ workflow: { tasks } });

describe('layoutDag', () => {
  it('places tasks in columns by dependency depth and centres each column vertically', () => {
    const layout = layoutDag(spec([task('import'), task('finetune', [{ task: 'import' }]), task('evaluate', [{ task: 'finetune' }, { task: 'import' }])]));
    const byId = new Map(layout.nodes.map((n) => [n.id, n]));
    expect(byId.get('import')!.column).toBe(0);
    expect(byId.get('finetune')!.column).toBe(1);
    expect(byId.get('evaluate')!.column).toBe(2);
    // Single node per column sits on the centre line, so a straight chain is a straight line.
    expect(layout.nodes.map((n) => n.y)).toEqual([0, 0, 0]);
    expect(byId.get('finetune')!.x).toBeGreaterThan(byId.get('import')!.x);
  });

  it('spreads siblings in a column around the centre line', () => {
    const layout = layoutDag(spec([task('a'), task('b1', [{ task: 'a' }]), task('b2', [{ task: 'a' }]), task('c', [{ task: 'b1' }, { task: 'b2' }])]), { rowGap: 100 });
    const byId = new Map(layout.nodes.map((n) => [n.id, n]));
    expect(byId.get('b1')!.y).toBe(-50);
    expect(byId.get('b2')!.y).toBe(50);
    expect(byId.get('a')!.y).toBe(0);
    expect(byId.get('c')!.y).toBe(0);
  });

  it('marks edges that skip over a column so they can be drawn as arcs above the intermediate nodes', () => {
    const layout = layoutDag(spec([task('import'), task('finetune', [{ task: 'import' }]), task('evaluate', [{ task: 'finetune' }, { task: 'import' }])]), { rowGap: 100, nodeHeight: 60 });
    const skip = layout.edges.find((e) => e.source === 'import' && e.target === 'evaluate')!;
    const direct = layout.edges.find((e) => e.source === 'finetune' && e.target === 'evaluate')!;
    expect(skip.span).toBe(2);
    expect(direct.span).toBe(1);
    expect(direct.arcY).toBeUndefined();
    // Arc apex clears the top edge of the tallest intermediate node (top = 0 - 60/2 = -30) by the margin.
    expect(skip.arcY).toBeLessThan(-30);
  });

  it('puts dataset inputs in their own column to the left of the first consumer', () => {
    const layout = layoutDag(spec([task('train', [{ dataset: { name: 'demos', version: 1 } }]), task('evaluate', [{ task: 'train' }])]));
    const byId = new Map(layout.nodes.map((n) => [n.id, n]));
    const dataset = layout.nodes.find((n) => n.kind === 'dataset')!;
    expect(dataset.label).toBe('demos');
    expect(dataset.column).toBe(0);
    expect(byId.get('train')!.column).toBe(1);
    expect(byId.get('evaluate')!.column).toBe(2);
    const edge = layout.edges.find((e) => e.target === 'train')!;
    expect(edge.kind).toBe('dataset');
    expect(edge.source).toBe(dataset.id);
  });

  it('shares one dataset node between several consumers', () => {
    const layout = layoutDag(spec([task('policy', [{ dataset: { name: 'demos', version: 1 } }]), task('evaluate', [{ dataset: { name: 'demos', version: 1 } }])]));
    expect(layout.nodes.filter((n) => n.kind === 'dataset')).toHaveLength(1);
    expect(layout.edges.filter((e) => e.kind === 'dataset')).toHaveLength(2);
  });

  it('lists steps in execution order (column, then row) without dataset nodes', () => {
    const layout = layoutDag(spec([task('evaluate', [{ task: 'finetune' }]), task('finetune', [{ task: 'import' }]), task('import', [{ dataset: { name: 'raw', version: 1 } }])]));
    expect(layout.steps).toEqual(['import', 'finetune', 'evaluate']);
  });

  it('ignores an unknown upstream task instead of throwing', () => {
    const layout = layoutDag(spec([task('a', [{ task: 'missing' }])]));
    expect(layout.nodes.map((n) => n.id)).toEqual(['a']);
    expect(layout.edges).toEqual([]);
  });
});

describe('relatedNodes', () => {
  it('returns the node with its direct upstream and downstream neighbours', () => {
    const layout = layoutDag(spec([task('import'), task('finetune', [{ task: 'import' }]), task('evaluate', [{ task: 'finetune' }, { task: 'import' }]), task('report', [{ task: 'evaluate' }])]));
    expect([...relatedNodes(layout, 'finetune')].sort()).toEqual(['evaluate', 'finetune', 'import']);
    expect(relatedNodes(layout, undefined).size).toBe(0);
  });
});
