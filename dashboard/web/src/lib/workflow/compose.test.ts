import { describe, it, expect } from 'vitest';
import YAML from 'yaml';
import { composeWorkflow, slugify, type ComposeGraph } from './compose';
import { BUILTIN_TEMPLATES, getRecipeMetadata, materializeBuiltinTemplate } from '@/server/workflow/builtin-templates';
import { parseWorkflowYaml } from '@/server/workflow/template';
import type { Template } from '@/server/store/types';
import type { TemplateDto } from '@/lib/workflow/template-dto';

/** Build a genuine TemplateDto from a real builtin so composition round-trips through the real parser. */
function dto(id: string): TemplateDto {
  const t = BUILTIN_TEMPLATES.find((x) => x.id === id);
  if (!t) throw new Error(`missing builtin ${id}`);
  return { ...t, recipe: getRecipeMetadata(t) };
}

describe('slugify', () => {
  it('converts title to lowercase kebab-case', () => {
    expect(slugify('My Task Name')).toBe('my-task-name');
    expect(slugify('HF Dataset Import')).toBe('hf-dataset-import');
    expect(slugify('GR00T—Finetune!')).toBe('gr00t-finetune');
  });
  it('removes non-alphanumeric except hyphens', () => {
    expect(slugify('task (v2)')).toBe('task-v2');
    expect(slugify('foo@#$bar')).toBe('foobar');
  });
  it('collapses consecutive hyphens and whitespace', () => {
    expect(slugify('foo -- bar')).toBe('foo-bar');
  });
  it('strips leading/trailing hyphens', () => {
    expect(slugify('--foo--')).toBe('foo');
  });
  it('is a valid DNS-1123 label', () => {
    const slug = slugify('Kubernetes Workflow Task');
    expect(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(slug)).toBe(true);
    expect(slug.length).toBeLessThan(40);
  });
});

describe('composeWorkflow — error classes', () => {
  const templates = () => [dto('hf-dataset-import'), dto('gr00t-finetune'), dto('leisaac-evaluate')];

  it('rejects a cycle', () => {
    const graph: ComposeGraph = {
      nodes: [
        { id: 'n1', templateId: 'gr00t-finetune', title: 'Finetune', params: {} },
        { id: 'n2', templateId: 'leisaac-evaluate', title: 'Evaluate', params: {} },
      ],
      datasets: [],
      edges: [
        { from: { node: 'n1', port: 'groot-checkpoints' }, to: { node: 'n2', param: 'dataset_name' } },
        { from: { node: 'n2', port: 'leisaac-evaluation' }, to: { node: 'n1', param: 'dataset_name' } },
      ],
    };
    const result = composeWorkflow(graph, templates());
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'cycle' }));
    expect(result.yaml).toBe('');
  });

  it('rejects kind mismatch', () => {
    const graph: ComposeGraph = {
      nodes: [
        { id: 'n1', templateId: 'hf-dataset-import', title: 'Import', params: {} },
        { id: 'n2', templateId: 'leisaac-evaluate', title: 'Evaluate', params: {} },
      ],
      datasets: [],
      edges: [
        // hf-import is lerobot-dataset; leisaac dataset_name expects checkpoint.
        { from: { node: 'n1', port: 'hf-import' }, to: { node: 'n2', param: 'dataset_name' } },
      ],
    };
    const result = composeWorkflow(graph, templates());
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'kind_mismatch' }));
  });

  it('rejects an input bound twice', () => {
    const graph: ComposeGraph = {
      nodes: [
        { id: 'n1', templateId: 'hf-dataset-import', title: 'Import', params: {} },
        { id: 'n2', templateId: 'gr00t-finetune', title: 'Finetune', params: {} },
        { id: 'n3', templateId: 'leisaac-evaluate', title: 'Evaluate', params: {} },
      ],
      datasets: [{ id: 'ds1', name: 'my-checkpoints', version: 1 }],
      edges: [
        { from: { node: 'n1', port: 'hf-import' }, to: { node: 'n2', param: 'dataset_name' } },
        { from: { node: 'n2', port: 'groot-checkpoints' }, to: { node: 'n3', param: 'dataset_name' } },
        { from: { dataset: 'ds1' }, to: { node: 'n3', param: 'dataset_name' } },
      ],
    };
    const result = composeWorkflow(graph, templates());
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'input_bound_twice' }));
  });

  it('rejects an unknown template', () => {
    const graph: ComposeGraph = {
      nodes: [{ id: 'n1', templateId: 'nonexistent', title: 'Unknown', params: {} }],
      datasets: [],
      edges: [],
    };
    const result = composeWorkflow(graph, templates());
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'unknown_template', nodeId: 'n1' }));
  });

  it('rejects a duplicate slug', () => {
    const graph: ComposeGraph = {
      nodes: [
        { id: 'n1', templateId: 'hf-dataset-import', title: 'Import One', params: {} },
        { id: 'n2', templateId: 'hf-dataset-import', title: 'Import One', params: {} },
      ],
      datasets: [],
      edges: [],
    };
    const result = composeWorkflow(graph, templates());
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'duplicate_slug' }));
  });

  it('rejects an edge to a missing port', () => {
    const graph: ComposeGraph = {
      nodes: [{ id: 'n1', templateId: 'hf-dataset-import', title: 'Import', params: {} }],
      datasets: [{ id: 'ds1', name: 'my-dataset', version: 1 }],
      edges: [{ from: { dataset: 'ds1' }, to: { node: 'n1', param: 'nonexistent' } }],
    };
    const result = composeWorkflow(graph, templates());
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'missing_port', edgeIndex: 0 }));
  });

  it('rejects a group whose task is chained by inputs', () => {
    // A crafted grouped recipe whose group member `b` depends on member `a` via inputs[].task.
    // The schema forbids task deps inside a concurrent group; the composer surfaces it up-front.
    const yaml = YAML.stringify(
      {
        workflow: {
          name: 'chained-group',
          mlflow: false,
          timeout: { exec_timeout: '12h', queue_timeout: '2h', start_timeout: '20m' },
          resources: { cpu: { cpu: 1, memory: '1Gi', gpu: 0, platform: 'ml.c5.large' } },
          groups: [
            {
              name: 'grp',
              barrier: true,
              ignoreNonleadStatus: false,
              tasks: [
                { name: 'a', resource: 'cpu', image: 'img:latest', command: ['true'], outputs: [] },
                { name: 'b', lead: true, resource: 'cpu', image: 'img:latest', command: ['true'], inputs: [{ task: 'a' }], outputs: [] },
              ],
            },
          ],
        },
        'default-values': {},
        ui: {
          recipe: {
            revision: 'x',
            readiness: 'cpu-validated',
            verification: 'local-docker',
            prerequisites: [],
            sources: [],
            artifacts: [],
            imageContract: '',
            ports: { inputs: [], outputs: [] },
          },
        },
      },
      { lineWidth: 0 },
    );
    const chained: TemplateDto = {
      id: 'chained-group',
      title: 'Chained Group',
      description: '',
      category: 'custom',
      builtin: false,
      yaml,
      params: [],
      createdAt: '2026-09-19T00:00:00Z',
      recipe: getRecipeMetadata({ yaml } as Template),
    };
    const graph: ComposeGraph = {
      nodes: [{ id: 'n1', templateId: 'chained-group', title: 'Chained Group', params: {} }],
      datasets: [],
      edges: [],
    };
    const result = composeWorkflow(graph, [chained]);
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'group_task_chained' }));
  });
});

describe('composeWorkflow — composition', () => {
  const templates = () => [dto('hf-dataset-import'), dto('gr00t-finetune'), dto('leisaac-evaluate')];

  it('composes hf-import → gr00t-finetune → leisaac-evaluate and round-trips through the real parser', () => {
    const graph: ComposeGraph = {
      nodes: [
        { id: 'n1', templateId: 'hf-dataset-import', title: 'Import', params: {} },
        { id: 'n2', templateId: 'gr00t-finetune', title: 'Finetune', params: {} },
        { id: 'n3', templateId: 'leisaac-evaluate', title: 'Evaluate', params: {} },
      ],
      datasets: [],
      edges: [
        { from: { node: 'n1', port: 'hf-import' }, to: { node: 'n2', param: 'dataset_name' } },
        { from: { node: 'n2', port: 'groot-checkpoints' }, to: { node: 'n3', param: 'dataset_name' } },
      ],
    };
    const result = composeWorkflow(graph, templates());

    expect(result.errors).toEqual([]);
    expect(result.yaml).toBeTruthy();

    // The composed YAML parses and validates against the real workflow schema + semantics.
    const parsed = parseWorkflowYaml(result.yaml, {});
    const names = parsed.spec.workflow.tasks.map((t) => t.name);
    expect(names).toContainEqual(expect.stringMatching(/^import-/));
    expect(names).toContainEqual(expect.stringMatching(/^finetune-/));
    expect(names).toContainEqual(expect.stringMatching(/^evaluate-/));

    // gr00t finetune's dataset input is rewritten to a task dependency on the import node.
    const finetune = parsed.spec.workflow.tasks.find((t) => t.name === 'finetune-finetune');
    expect(finetune?.inputs?.[0]).toEqual({ task: 'import-import' });

    // The leisaac group members that consumed the checkpoint dataset now depend on the finetune node.
    const evaluate = parsed.spec.workflow.tasks.find((t) => t.name === 'evaluate-evaluate');
    expect(evaluate?.inputs).toContainEqual({ task: 'finetune-finetune' });

    // Composite recipe merges ports and views. Output ports are namespaced under the node slug.
    expect(result.recipe.ports?.outputs?.some((o) => o.name === 'finetune-groot-checkpoints')).toBe(true);
    expect(result.recipe.views).toHaveProperty('finetune-finetune');

    // Bound params are dropped; unbound params are prefixed with the node slug.
    const paramNames = result.params.map((p) => p.name);
    expect(paramNames).not.toContain('finetune_dataset_name');
    expect(paramNames).toContain('finetune_base_model');
    expect(paramNames).toContain('import_hf_dataset_id');
  });

  it('materializes and validates the round trip', () => {
    const graph: ComposeGraph = {
      nodes: [
        { id: 'n1', templateId: 'hf-dataset-import', title: 'Import', params: {} },
        { id: 'n2', templateId: 'gr00t-finetune', title: 'Finetune', params: {} },
      ],
      datasets: [],
      edges: [{ from: { node: 'n1', port: 'hf-import' }, to: { node: 'n2', param: 'dataset_name' } }],
    };
    const result = composeWorkflow(graph, templates());
    expect(result.errors).toEqual([]);

    const materializedYaml = materializeBuiltinTemplate({ yaml: result.yaml } as Template, 'run');
    const parsed = parseWorkflowYaml(materializedYaml, {});
    expect(parsed.spec.workflow.tasks.length).toBeGreaterThan(0);
    // {{workflow_id}} resolved in the published dataset name, which is namespaced under the node slug.
    const importTask = parsed.spec.workflow.tasks.find((t) => t.name === 'import-import');
    const published = importTask?.outputs?.find((o): o is { dataset: { name: string; path: string } } => 'dataset' in o);
    expect(published?.dataset.name).toBe('import-hf-import-run');
  });

  it('namespaces outputs so two nodes of the same recipe publish distinct datasets', () => {
    const graph: ComposeGraph = {
      nodes: [
        { id: 'n1', templateId: 'gr00t-finetune', title: 'Finetune A', params: {} },
        { id: 'n2', templateId: 'gr00t-finetune', title: 'Finetune B', params: {} },
      ],
      datasets: [
        { id: 'ds1', name: 'set-a', version: 1 },
        { id: 'ds2', name: 'set-b', version: 1 },
      ],
      edges: [
        { from: { dataset: 'ds1' }, to: { node: 'n1', param: 'dataset_name' } },
        { from: { dataset: 'ds2' }, to: { node: 'n2', param: 'dataset_name' } },
      ],
    };
    const result = composeWorkflow(graph, templates());
    expect(result.errors).toEqual([]);

    // Both nodes emit the same recipe's `groot-checkpoints` output, but namespaced under their slugs.
    const outputNames = result.recipe.ports?.outputs?.map((o) => o.name) ?? [];
    expect(outputNames).toContain('finetune-a-groot-checkpoints');
    expect(outputNames).toContain('finetune-b-groot-checkpoints');
    expect(new Set(outputNames).size).toBe(outputNames.length); // no collision

    // The published dataset names in the composed YAML are likewise distinct and still run-scoped, and
    // the whole thing still round-trips through the real parser.
    const parsed = parseWorkflowYaml(result.yaml, {});
    const publishedNames = parsed.spec.workflow.tasks.flatMap((t) => (t.outputs ?? [])
      .filter((o): o is { dataset: { name: string; path: string } } => 'dataset' in o)
      .map((o) => o.dataset.name));
    expect(publishedNames).toContain('finetune-a-groot-checkpoints-{{workflow_id}}');
    expect(publishedNames).toContain('finetune-b-groot-checkpoints-{{workflow_id}}');
    expect(new Set(publishedNames).size).toBe(publishedNames.length); // distinct dataset names
  });

  it('pins default-values and keeps the param for a dataset-source edge', () => {
    const graph: ComposeGraph = {
      nodes: [{ id: 'n1', templateId: 'gr00t-finetune', title: 'Finetune', params: {} }],
      datasets: [{ id: 'ds1', name: 'my-lerobot-set', version: 3 }],
      edges: [{ from: { dataset: 'ds1' }, to: { node: 'n1', param: 'dataset_name' } }],
    };
    const result = composeWorkflow(graph, templates());
    expect(result.errors).toEqual([]);

    const doc = YAML.parse(result.yaml) as { 'default-values': Record<string, unknown> };
    expect(doc['default-values']['finetune_dataset_name']).toBe('my-lerobot-set');
    expect(doc['default-values']['finetune_dataset_version']).toBe(3);

    // The dataset input stays a dataset input (not rewritten to a task dep); the param is retained.
    const parsed = parseWorkflowYaml(result.yaml, {});
    const finetune = parsed.spec.workflow.tasks.find((t) => t.name === 'finetune-finetune');
    expect(finetune?.inputs?.[0]).toHaveProperty('dataset');
    expect(result.params.map((p) => p.name)).toContain('finetune_dataset_name');
  });

  it('applies inspector per-node param overrides to both default-values and params[].default', () => {
    const graph: ComposeGraph = {
      nodes: [{ id: 'n1', templateId: 'gr00t-finetune', title: 'Finetune', params: { max_steps: '2000' } }],
      datasets: [],
      edges: [],
    };
    const result = composeWorkflow(graph, templates());
    expect(result.errors).toEqual([]);

    // The composed YAML's default-values carry the edited value under the prefixed name (the run wizard
    // reads step-2 values straight from here for a composed draft).
    const doc = YAML.parse(result.yaml) as { 'default-values': Record<string, unknown> };
    expect(doc['default-values']['finetune_max_steps']).toBe('2000');

    // The composite param exposes the same edited value as its default (the save/composite path reads this).
    expect(result.params.find((p) => p.name === 'finetune_max_steps')?.default).toBe('2000');

    // A param left unedited keeps the recipe default.
    expect(result.params.find((p) => p.name === 'finetune_base_model')?.default).toBe('nvidia/GR00T-N1.6-3B');
  });

  it('lets a dataset-source binding win over an inspector override on the same input', () => {
    const graph: ComposeGraph = {
      nodes: [{ id: 'n1', templateId: 'gr00t-finetune', title: 'Finetune', params: { dataset_name: 'typed-by-user' } }],
      datasets: [{ id: 'ds1', name: 'bound-set', version: 2 }],
      edges: [{ from: { dataset: 'ds1' }, to: { node: 'n1', param: 'dataset_name' } }],
    };
    const result = composeWorkflow(graph, templates());
    expect(result.errors).toEqual([]);

    const doc = YAML.parse(result.yaml) as { 'default-values': Record<string, unknown> };
    expect(doc['default-values']['finetune_dataset_name']).toBe('bound-set');
    expect(result.params.find((p) => p.name === 'finetune_dataset_name')?.default).toBe('bound-set');
  });

  it('composes a grouped recipe standalone and validates', () => {
    const graph: ComposeGraph = {
      nodes: [{ id: 'n1', templateId: 'leisaac-evaluate', title: 'Closed Loop Eval', params: {} }],
      datasets: [],
      edges: [],
    };
    const result = composeWorkflow(graph, templates());
    expect(result.errors).toEqual([]);
    const parsed = parseWorkflowYaml(result.yaml, {});
    expect(parsed.spec.workflow.groups?.[0]?.name).toBe('closed-loop-eval-evaluation');
    // Unbound dataset input surfaces on the composite recipe ports (params use an identifier-safe prefix).
    expect(result.recipe.ports?.inputs?.some((i) => i.param === 'closed_loop_eval_dataset_name')).toBe(true);
  });
});
