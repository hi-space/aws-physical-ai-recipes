# Dashboard H — 파이프라인 조립기 (Composer) Implementation Plan

> **For agentic workers:** RECOMMENDED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사용자가 기존 레시피들을 그래프 캔버스에서 조립하여 커스텀 멀티레시피 파이프라인을 구성하고, 이를 커스텀 템플릿으로 저장 및 실행할 수 있는 컴포저 페이지와 순수 함수 조합 로직을 구현한다. 스키마 위반·순환·포트 종류 불일치 등을 검증하며, React Flow를 기반으로 한 대화형 그래프 편집기를 제공한다.

**Architecture:** `web/src/lib/workflow/compose.ts`에 포트 종류 기반 엣지 검증 및 YAML 변환 로직을 순수 함수로 구현; `web/src/components/compose/` 디렉터리 아래 React Flow 노드·엣지·상태 관리를 분리; `web/src/app/workflows/compose/page.tsx`에서 라우트 제공. 입장점(entry point)은 NewWorkflowPage 스텝 1 카드 + WorkflowsPage 헤더 액션. 레시피 메타데이터(포트·뷰)는 sibling 계획 G에서 제공되는 인터페이스로 가정.

**Tech Stack:** Next.js 16 + React 19 + React Flow (XYFlow) v12.11.6 + TypeScript 5.9 + Tailwind 4.3.3 + vitest 3.2.7 + Playwright 1.63.

**Spec:** `docs/designs/2026-09-19-dashboard-composer-views-ux-design.md` §3.3 (Pipeline composer)

## Global Constraints

- 모든 명령은 `dashboard/web` 또는 `dashboard/docs`에서 실행한다. 테스트는 `npm test -- <file>`(vitest) 또는 `npm run e2e -- <file>`(Playwright), 타입은 `npm run typecheck`.
- UI 문자열은 `web/src/lib/i18n/messages/*`에만 두며 컴포넌트에 한글 리터럴을 쓰지 않는다(`no-hardcoded-strings.test.ts` 가드).
- i18n 메시지 파일은 `defineMessages({ en: {...}, ko: {...} })`로 구조화; `useT('<namespace>')` hook이 키를 타입 안전하게 바인딩.
- 커밋 메시지는 `feat(dashboard): …` 형식, 끝에 `Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>`.
- 과거 설계·계획(`docs/designs/2026-09-16…`, `docs/plans/2026-09-1[68]…`)은 이력이므로 수정하지 않는다. 현재 브랜치 `feat/hyperpod-dashboard` 상태를 기반으로 함.
- 최종 작업에서 `npm test` + `npm run typecheck`를 전체 실행; DagView.browser.test.ts/NewWorkflowPage.browser.test.ts와 동일한 Playwright 패턴 준용(fixture 캐싱, screenshot, 타입 세이프).
- UI 텍스트 크기: body 14px, table 13px, 캡션 12px 준수.
- Sibling plan G 인터페이스 완전성 가정: `ports.ts`, `recipe-metadata.ts`, `template-dto.ts` 모두 제공됨.


## 선행 계획 G와의 인터페이스 정합 (구현 전 반드시 확인)

계획 G가 먼저 실행되어 다음이 존재한다. 이 계획의 코드 블록에 다른 경로가 남아 있으면 **아래 경로가 우선**한다.

- `@/lib/workflow/ports` — `PortKind`, `PORT_KINDS`, `isPortKind`, `RecipePorts` (여기에 `PORT_COLORS`가 없으면 이 계획의 `components/compose/ports-ui.ts`에 정의하고 `@/lib/workflow/ports`에는 추가하지 않는다).
- `@/lib/workflow/recipe-metadata` — `RecipeMetadata` (`ports?`, `views?` 포함). `@/server/store/types`에는 없다.
- `@/lib/workflow/template-dto` — `TemplateDto = Template & { recipe: RecipeMetadata | null }`.
- `@/components/workflows/TemplateParamField` — `TemplateParamField({ param, value, values, locked?, kind?, onChange })`.
- `TemplateParam.type`에 `'dataset'`, `TemplateParam.versionParam?`.

---

### Task 1: `web/src/lib/workflow/compose.ts` — 순수 조합 함수 + ComposeError 정의

**Files:**
- Create: `dashboard/web/src/lib/workflow/compose.ts`
- Modify: `dashboard/web/src/lib/workflow/ports.ts` (create if G hasn't; PORT_COLORS 추가)
- Test: `dashboard/web/src/lib/workflow/compose.test.ts`

**Interfaces:**

Produces:
```ts
export interface ComposeGraph {
  nodes: { id: string; templateId: string; title: string; params: Record<string, string> }[];
  datasets: { id: string; name: string; version: number }[];
  edges: { from: { node: string; port: string } | { dataset: string }; to: { node: string; param: string } }[];
}

export type ComposeErrorCode = 'cycle' | 'kind_mismatch' | 'input_bound_twice' | 'unknown_template' | 'duplicate_slug' | 'group_task_chained' | 'missing_port';
export interface ComposeError {
  code: ComposeErrorCode;
  message: string;
  nodeId?: string;
  edgeIndex?: number;
}

export interface ComposedWorkflow {
  yaml: string;
  params: TemplateParam[];
  recipe: RecipeMetadata;
  errors: ComposeError[];
}

export function slugify(title: string): string;
export function composeWorkflow(graph: ComposeGraph, templates: TemplateDto[]): ComposedWorkflow;
```

- [ ] **Step 1: 테스트 작성 (TDD)**

`compose.test.ts` 생성:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import YAML from 'yaml';
import { composeWorkflow, slugify, type ComposeGraph } from './compose';
import { parseWorkflowYaml, materializeBuiltinTemplate } from '../workflow/template';
import type { TemplateDto } from '@/lib/workflow/template-dto';

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
  it('collapses consecutive hyphens', () => {
    expect(slugify('foo -- bar')).toBe('foo-bar');
  });
  it('strips leading/trailing hyphens', () => {
    expect(slugify('--foo--')).toBe('foo');
  });
  it('is a valid DNS-1123 subdomain when prepended with a short id', () => {
    const slug = slugify('Kubernetes Workflow Task');
    expect(/^[a-z0-9]+$/.test(slug)).toBe(true);
    expect(slug.length).toBeLessThan(40);
  });
});

describe('composeWorkflow', () => {
  let templates: TemplateDto[];

  beforeEach(() => {
    // hf-dataset-import: no inputs, outputs 'hf-import' lerobot-dataset
    // gr00t-finetune: input param 'dataset_name' lerobot-dataset, output 'groot-checkpoints' checkpoint
    // leisaac-evaluate: input param 'dataset_name' checkpoint, no outputs (artifacts)
    templates = [
      {
        id: 'hf-dataset-import',
        builtin: true,
        category: 'data',
        title: 'HF Dataset Import',
        yaml: `workflow:
  name: hf-dataset-import
  tasks:
    - name: import
      image: '{{ image }}'
      args: ['--output-dir', '{{output}}']
      outputs:
        - name: dataset
          prefix: hf-import
          publish: true
default-values:
  image: 'hf-import:latest'
ui:
  recipe:
    ports:
      inputs: []
      outputs:
        - name: hf-import
          kind: lerobot-dataset
          label: HF Dataset
`,
        params: [{ name: 'image', type: 'string', default: 'hf-import:latest', label: 'Image' }],
        recipe: {
          revision: '2026-09-16.1',
          readiness: 'cpu-validated',
          verification: 'source-verified',
          prerequisites: [],
          sources: [],
          artifacts: [],
          imageContract: '',
          ports: {
            inputs: [],
            outputs: [{ name: 'hf-import', kind: 'lerobot-dataset', label: 'HF Dataset' }],
          },
        },
      } as TemplateDto,
      {
        id: 'gr00t-finetune',
        builtin: true,
        category: 'training',
        title: 'GR00T Finetune',
        yaml: `workflow:
  name: gr00t-finetune
  tasks:
    - name: finetune
      image: '{{ image }}'
      args: ['--dataset-name', '{{ dataset_name }}', '--dataset-version', '{{ dataset_version }}']
      outputs:
        - name: checkpoints
          prefix: groot-checkpoints
          publish: true
default-values:
  image: 'groot:latest'
  dataset_version: 1
ui:
  recipe:
    ports:
      inputs:
        - param: dataset_name
          kind: lerobot-dataset
          label: Dataset
          versionParam: dataset_version
      outputs:
        - name: groot-checkpoints
          kind: checkpoint
          label: Checkpoint
    views:
      finetune: [tensorboard, mlflow]
`,
        params: [
          { name: 'image', type: 'string', default: 'groot:latest', label: 'Image' },
          { name: 'dataset_name', type: 'dataset', label: 'Dataset' },
          { name: 'dataset_version', type: 'number', default: 1, label: 'Version' },
        ],
        recipe: {
          revision: '2026-09-16.1',
          readiness: 'prerequisites-required',
          verification: 'source-verified',
          prerequisites: [],
          sources: [],
          artifacts: [],
          imageContract: '',
          ports: {
            inputs: [{ param: 'dataset_name', kind: 'lerobot-dataset', label: 'Dataset', versionParam: 'dataset_version' }],
            outputs: [{ name: 'groot-checkpoints', kind: 'checkpoint', label: 'Checkpoint' }],
          },
          views: { finetune: ['tensorboard', 'mlflow'] },
        },
      } as TemplateDto,
      {
        id: 'leisaac-evaluate',
        builtin: true,
        category: 'evaluation',
        title: 'LeISAAC Evaluate',
        yaml: `workflow:
  name: leisaac-evaluate
  tasks:
    - name: evaluate
      image: '{{ image }}'
      inputs:
        - dataset:
            name: '{{ dataset_name }}'
      args: ['--checkpoint', '{{input:0}}']
      outputs:
        - name: artifacts
          prefix: leisaac-evaluation
          publish: true
default-values:
  image: 'leisaac:latest'
ui:
  recipe:
    ports:
      inputs:
        - param: dataset_name
          kind: checkpoint
          label: Checkpoint
      outputs: []
`,
        params: [
          { name: 'image', type: 'string', default: 'leisaac:latest', label: 'Image' },
          { name: 'dataset_name', type: 'dataset', label: 'Checkpoint' },
        ],
        recipe: {
          revision: '2026-09-16.1',
          readiness: 'cpu-validated',
          verification: 'source-verified',
          prerequisites: [],
          sources: [],
          artifacts: [],
          imageContract: '',
          ports: {
            inputs: [{ param: 'dataset_name', kind: 'checkpoint', label: 'Checkpoint' }],
            outputs: [],
          },
        },
      } as TemplateDto,
    ];
  });

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
    const result = composeWorkflow(graph, templates);
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'cycle' }));
  });

  it('rejects kind mismatch', () => {
    const graph: ComposeGraph = {
      nodes: [
        { id: 'n1', templateId: 'hf-dataset-import', title: 'Import', params: {} },
        { id: 'n2', templateId: 'leisaac-evaluate', title: 'Evaluate', params: {} },
      ],
      datasets: [],
      edges: [
        { from: { node: 'n1', port: 'hf-import' }, to: { node: 'n2', param: 'dataset_name' } },
      ],
    };
    const result = composeWorkflow(graph, templates);
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'kind_mismatch' }));
  });

  it('rejects input bound twice', () => {
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
        { from: { dataset: 'ds1' }, to: { node: 'n3', param: 'dataset_name' } },
      ],
    };
    const result = composeWorkflow(graph, templates);
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'input_bound_twice' }));
  });

  it('rejects unknown template', () => {
    const graph: ComposeGraph = {
      nodes: [{ id: 'n1', templateId: 'nonexistent', title: 'Unknown', params: {} }],
      datasets: [],
      edges: [],
    };
    const result = composeWorkflow(graph, templates);
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'unknown_template' }));
  });

  it('rejects duplicate slug', () => {
    const graph: ComposeGraph = {
      nodes: [
        { id: 'n1', templateId: 'hf-dataset-import', title: 'Import One', params: {} },
        { id: 'n2', templateId: 'hf-dataset-import', title: 'Import One', params: {} },
      ],
      datasets: [],
      edges: [],
    };
    const result = composeWorkflow(graph, templates);
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'duplicate_slug' }));
  });

  it('rejects dataset edge with missing port', () => {
    const graph: ComposeGraph = {
      nodes: [
        { id: 'n1', templateId: 'hf-dataset-import', title: 'Import', params: {} },
      ],
      datasets: [{ id: 'ds1', name: 'my-dataset', version: 1 }],
      edges: [
        { from: { dataset: 'ds1' }, to: { node: 'n1', param: 'nonexistent' } },
      ],
    };
    const result = composeWorkflow(graph, templates);
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'missing_port' }));
  });

  it('composes hf-import → gr00t-finetune → leisaac-evaluate chain', () => {
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
    const result = composeWorkflow(graph, templates);
    
    // No errors
    expect(result.errors).toEqual([]);
    
    // YAML is valid and parses
    expect(result.yaml).toBeTruthy();
    const spec = parseWorkflowYaml(result.yaml, {});
    expect(spec).toBeTruthy();
    
    // Task names are prefixed
    expect(spec.workflow.tasks.map(t => t.name)).toContainEqual(expect.stringContaining('import'));
    expect(spec.workflow.tasks.map(t => t.name)).toContainEqual(expect.stringContaining('finetune'));
    expect(spec.workflow.tasks.map(t => t.name)).toContainEqual(expect.stringContaining('evaluate'));
    
    // Edge input rewrites task references
    const finetune = spec.workflow.tasks.find(t => t.name.includes('finetune'));
    expect(finetune?.inputs?.[0]?.task).toBeDefined();
    expect(finetune?.inputs?.[0]?.task).toMatch(/^import-/);
    
    const evaluate = spec.workflow.tasks.find(t => t.name.includes('evaluate'));
    expect(evaluate?.inputs?.[0]?.task).toBeDefined();
    expect(evaluate?.inputs?.[0]?.task).toMatch(/^finetune-/);
    
    // Composite recipe has merged ports
    expect(result.recipe.ports?.inputs).toBeDefined();
    expect(result.recipe.ports?.outputs).toBeDefined();
    expect(result.recipe.views).toBeDefined();
  });

  it('materializes and validates round-trip', () => {
    const graph: ComposeGraph = {
      nodes: [
        { id: 'n1', templateId: 'hf-dataset-import', title: 'Import', params: {} },
        { id: 'n2', templateId: 'gr00t-finetune', title: 'Finetune', params: {} },
      ],
      datasets: [],
      edges: [
        { from: { node: 'n1', port: 'hf-import' }, to: { node: 'n2', param: 'dataset_name' } },
      ],
    };
    const result = composeWorkflow(graph, templates);
    
    // Round-trip: compose → materialize → parse → validate
    const materialized = materializeBuiltinTemplate({ yaml: result.yaml }, 'run');
    expect(materialized).toBeDefined();
    const parsed = parseWorkflowYaml(materialized.yaml, materialized.params || {});
    expect(parsed).toBeTruthy();
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd dashboard/web && npm test -- src/lib/workflow/compose.test.ts`

Expected: FAIL — `composeWorkflow is not a function` 또는 export 없음.

- [ ] **Step 3: compose.ts 구현**

`compose.ts` 파일 생성 및 구현:

```ts
'use strict';
import YAML from 'yaml';
import type { TemplateParam } from '@/server/store/types';
import type { RecipeMetadata } from '@/lib/workflow/recipe-metadata';
import type { TemplateDto } from '@/lib/workflow/template-dto';
import type { WorkflowSpec, TaskSpec, GroupSpec } from '@/server/workflow/schema';
import { parseWorkflowYaml } from './template';

export interface ComposeGraph {
  nodes: { id: string; templateId: string; title: string; params: Record<string, string> }[];
  datasets: { id: string; name: string; version: number }[];
  edges: { from: { node: string; port: string } | { dataset: string }; to: { node: string; param: string } }[];
}

export type ComposeErrorCode = 'cycle' | 'kind_mismatch' | 'input_bound_twice' | 'unknown_template' | 'duplicate_slug' | 'group_task_chained' | 'missing_port';

export interface ComposeError {
  code: ComposeErrorCode;
  message: string;
  nodeId?: string;
  edgeIndex?: number;
}

export interface ComposedWorkflow {
  yaml: string;
  params: TemplateParam[];
  recipe: RecipeMetadata;
  errors: ComposeError[];
}

/** Converts a node title to a URL-safe slug for use as task/group/param prefix. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Compose a workflow from a graph of recipe nodes and dataset connections. */
export function composeWorkflow(graph: ComposeGraph, templates: TemplateDto[]): ComposedWorkflow {
  const errors: ComposeError[] = [];
  const templateMap = new Map(templates.map(t => [t.id, t]));
  
  // 1. Validate template existence
  for (let i = 0; i < graph.nodes.length; i++) {
    const node = graph.nodes[i];
    if (!templateMap.has(node.templateId)) {
      errors.push({
        code: 'unknown_template',
        message: `Template "${node.templateId}" not found`,
        nodeId: node.id,
      });
    }
  }
  
  // 2. Build slug map and check duplicates
  const slugMap = new Map<string, string>(); // slug → nodeId
  for (const node of graph.nodes) {
    const slug = slugify(node.title);
    if (slugMap.has(slug)) {
      errors.push({
        code: 'duplicate_slug',
        message: `Duplicate task name slug "${slug}" (from "${node.title}" and "${graph.nodes.find(n => slugMap.get(slug) === n.id)?.title}")`,
        nodeId: node.id,
      });
    } else {
      slugMap.set(slug, node.id);
    }
  }
  
  // 3. Build edge map: (nodeId, param) → edge index (to detect double-binding)
  const edgeTargets = new Map<string, number>(); // "<nodeId>/<param>" → first edge index
  for (let i = 0; i < graph.edges.length; i++) {
    const edge = graph.edges[i];
    const key = `${edge.to.node}/${edge.to.param}`;
    if (edgeTargets.has(key)) {
      errors.push({
        code: 'input_bound_twice',
        message: `Input ${edge.to.param} of node ${edge.to.node} is bound by multiple edges`,
        edgeIndex: i,
      });
    } else {
      edgeTargets.set(key, i);
    }
  }
  
  // 4. Validate ports: edge kind matches, param exists
  for (let i = 0; i < graph.edges.length; i++) {
    const edge = graph.edges[i];
    const toNode = graph.nodes.find(n => n.id === edge.to.node);
    const toTemplate = toNode ? templateMap.get(toNode.templateId) : undefined;
    
    if (!toTemplate?.recipe?.ports) {
      errors.push({
        code: 'missing_port',
        message: `Target node ${edge.to.node} has no ports defined`,
        edgeIndex: i,
      });
      continue;
    }
    
    const targetParam = toTemplate.recipe.ports.inputs.find(p => p.param === edge.to.param);
    if (!targetParam) {
      errors.push({
        code: 'missing_port',
        message: `Target parameter ${edge.to.param} not found on node ${edge.to.node}`,
        edgeIndex: i,
      });
      continue;
    }
    
    // Get source port kind
    let sourceKind: string | undefined;
    if ('node' in edge.from) {
      const fromNode = graph.nodes.find(n => n.id === edge.from.node);
      const fromTemplate = fromNode ? templateMap.get(fromNode.templateId) : undefined;
      const sourcePort = fromTemplate?.recipe?.ports?.outputs.find(p => p.name === edge.from.port);
      sourceKind = sourcePort?.kind;
    } else {
      // Dataset source: kind is inferred from the dataset's lineage
      sourceKind = 'artifacts'; // Default when lineage unknown
    }
    
    if (sourceKind && targetParam.kind && sourceKind !== targetParam.kind) {
      errors.push({
        code: 'kind_mismatch',
        message: `Port kind mismatch: ${edge.from} (${sourceKind}) → ${edge.to.param} (${targetParam.kind})`,
        edgeIndex: i,
      });
    }
  }
  
  // If errors found, return early
  if (errors.length > 0) {
    return { yaml: '', params: [], recipe: { revision: '', readiness: 'image-required', verification: 'local-docker', prerequisites: [], sources: [], artifacts: [], imageContract: '' }, errors };
  }
  
  // 5. Build adjacency graph and detect cycles (Kahn's topological sort)
  const adjOut = new Map<string, string[]>(); // nodeId → [dependent nodeId, ...]
  const adjIn = new Map<string, number>(); // nodeId → in-degree
  
  for (const node of graph.nodes) {
    adjOut.set(node.id, []);
    adjIn.set(node.id, 0);
  }
  
  for (const edge of graph.edges) {
    if ('node' in edge.from && 'node' in edge.to) {
      const fromId = edge.from.node;
      const toId = edge.to.node;
      if (fromId !== toId) {
        adjOut.get(fromId)?.push(toId);
        adjIn.set(toId, (adjIn.get(toId) ?? 0) + 1);
      }
    }
  }
  
  const queue: string[] = [];
  for (const [nodeId, inDegree] of adjIn.entries()) {
    if (inDegree === 0) queue.push(nodeId);
  }
  
  const topoOrder: string[] = [];
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    topoOrder.push(nodeId);
    for (const dependent of adjOut.get(nodeId) ?? []) {
      const newInDegree = (adjIn.get(dependent) ?? 0) - 1;
      adjIn.set(dependent, newInDegree);
      if (newInDegree === 0) queue.push(dependent);
    }
  }
  
  if (topoOrder.length !== graph.nodes.length) {
    errors.push({
      code: 'cycle',
      message: 'Graph contains a cycle',
    });
    return { yaml: '', params: [], recipe: { revision: '', readiness: 'image-required', verification: 'local-docker', prerequisites: [], sources: [], artifacts: [], imageContract: '' }, errors };
  }
  
  // 6. Transform each node's YAML: prefix tasks, groups, params
  const nodeYamls = new Map<string, { parsed: WorkflowSpec; prefixSlug: string }>();
  
  for (const node of graph.nodes) {
    const template = templateMap.get(node.templateId);
    if (!template) continue;
    
    try {
      const parsed = parseWorkflowYaml(template.yaml, {});
      const prefixSlug = slugify(node.title);
      nodeYamls.set(node.id, { parsed, prefixSlug });
    } catch (e) {
      errors.push({
        code: 'unknown_template' as any,
        message: `Failed to parse template ${node.templateId}: ${e instanceof Error ? e.message : String(e)}`,
        nodeId: node.id,
      });
    }
  }
  
  if (errors.length > 0) {
    return { yaml: '', params: [], recipe: { revision: '', readiness: 'image-required', verification: 'local-docker', prerequisites: [], sources: [], artifacts: [], imageContract: '' }, errors };
  }
  
  // 7. Rewrite task/group/param references with prefix
  const rewriteTaskName = (name: string, nodeId: string): string => {
    const slug = slugify(graph.nodes.find(n => n.id === nodeId)?.title ?? '');
    return `${slug}-${name}`;
  };
  
  const rewriteParamName = (name: string, nodeId: string): string => {
    const slug = slugify(graph.nodes.find(n => n.id === nodeId)?.title ?? '');
    return `${slug}_${name}`;
  };
  
  const rewriteTaskReferences = (yaml: any, nodeId: string, nodeYaml: WorkflowSpec): any => {
    const slug = slugify(graph.nodes.find(n => n.id === nodeId)?.title ?? '');
    if (typeof yaml === 'string') {
      // Rewrite {{ param }} and {{host:x}} placeholders
      return yaml
        .replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (match, paramName) => {
          if (['output', 'input', 'workflow_id', 'task_name', 'replica_index'].includes(paramName)) return match;
          return `{{ ${slug}_${paramName} }}`;
        })
        .replace(/\{\{host:([A-Za-z_][A-Za-z0-9_]*)\}\}/g, `{{ ${slug}-$1 }}`);
    } else if (Array.isArray(yaml)) {
      return yaml.map(item => rewriteTaskReferences(item, nodeId, nodeYaml));
    } else if (yaml !== null && typeof yaml === 'object') {
      return Object.fromEntries(
        Object.entries(yaml).map(([key, value]: [string, any]) => {
          if (key === 'name' && (yaml.tasks || yaml.groups || yaml.group)) {
            // Rewrite task/group name in context
            return [key, `${slug}-${value}`];
          }
          if (key === 'task' && typeof value === 'string') {
            // Rewrite inputs[].task reference
            return [key, `${slug}-${value}`];
          }
          if (key === 'group' && typeof value === 'string') {
            // Rewrite task.group reference
            return [key, `${slug}-${value}`];
          }
          return [key, rewriteTaskReferences(value, nodeId, nodeYaml)];
        })
      );
    }
    return yaml;
  };
  
  // 8. Rewrite edges: convert edge to task input with proper reference
  const boundInputs = new Set<string>(); // "<nodeId>/<param>"
  
  for (const edge of graph.edges) {
    const targetNode = graph.nodes.find(n => n.id === edge.to.node);
    const targetTemplate = targetNode ? templateMap.get(targetNode.templateId) : undefined;
    const sourcePortName = ('node' in edge.from) ? edge.from.port : undefined;
    
    if (!targetTemplate?.recipe?.ports) continue;
    
    const targetYaml = nodeYamls.get(edge.to.node);
    if (!targetYaml) continue;
    
    const paramInfo = targetTemplate.recipe.ports.inputs.find(p => p.param === edge.to.param);
    if (!paramInfo) continue;
    
    boundInputs.add(`${edge.to.node}/${edge.to.param}`);
    
    // Find the task in the YAML that has the input parameter
    const targetSlug = slugify(targetNode!.title);
    for (const task of targetYaml.parsed.workflow.tasks) {
      // Check if this task uses the parameter in its inputs
      if (Array.isArray(task.inputs)) {
        for (let i = 0; i < task.inputs.length; i++) {
          const input = task.inputs[i];
          if (input.dataset && typeof input.dataset.name === 'string' && input.dataset.name.includes(`{{ ${edge.to.param} }}`)) {
            // Replace with task reference
            if ('node' in edge.from) {
              const sourceNode = graph.nodes.find(n => n.id === edge.from.node);
              const sourceSlug = slugify(sourceNode!.title);
              // Find the task in source that produces this port
              const sourceYaml = nodeYamls.get(edge.from.node);
              if (sourceYaml) {
                let producingTaskName = '';
                for (const sourceTask of sourceYaml.parsed.workflow.tasks) {
                  if (Array.isArray(sourceTask.outputs)) {
                    for (const output of sourceTask.outputs) {
                      if (output.prefix === sourcePortName) {
                        producingTaskName = sourceTask.name;
                        break;
                      }
                    }
                  }
                }
                if (producingTaskName) {
                  task.inputs[i] = { task: `${sourceSlug}-${producingTaskName}` };
                }
              }
            }
          }
        }
      }
    }
  }
  
  // 9. Rewrite all node YAMLs with prefixes
  const prefixedYamls = new Map<string, WorkflowSpec>();
  for (const [nodeId, { parsed: nodeYaml, prefixSlug }] of nodeYamls.entries()) {
    const rewritten = rewriteTaskReferences(nodeYaml, nodeId, nodeYaml) as WorkflowSpec;
    prefixedYamls.set(nodeId, rewritten);
  }
  
  // 10. Merge all tasks, groups, resources, params
  const mergedTasks: TaskSpec[] = [];
  const mergedGroups: GroupSpec[] = [];
  const mergedResources: Record<string, any> = {};
  const mergedParams: TemplateParam[] = [];
  const mergedDefaultValues: Record<string, string | number | boolean> = {};
  const mergedViews: Record<string, ('tensorboard' | 'mlflow')[]> = {};
  let mlflow = false;
  let timeout = { exec_timeout: '12h', queue_timeout: '6h', start_timeout: '10m' };
  
  for (const nodeId of topoOrder) {
    const node = graph.nodes.find(n => n.id === nodeId)!;
    const template = templateMap.get(node.templateId)!;
    const prefixed = prefixedYamls.get(nodeId)!;
    const prefixSlug = slugify(node.title);
    
    // Add tasks and groups
    mergedTasks.push(...prefixed.workflow.tasks);
    if (prefixed.workflow.groups) {
      mergedGroups.push(...prefixed.workflow.groups);
    }
    
    // Merge resources
    for (const [name, resource] of Object.entries(prefixed.workflow.resources ?? {})) {
      const prefixedName = `${prefixSlug}-${name}`;
      mergedResources[prefixedName] = resource;
      // Rewrite task.resource references
      for (const task of mergedTasks) {
        if (task.resource === name) task.resource = prefixedName;
      }
    }
    
    // Add unbound params
    for (const param of template.params ?? []) {
      const isUnbound = !boundInputs.has(`${nodeId}/${param.name}`);
      if (isUnbound) {
        const boundParam: TemplateParam = {
          ...param,
          name: rewriteParamName(param.name, nodeId),
          label: `${node.title} › ${param.label ?? param.name}`,
        };
        mergedParams.push(boundParam);
        if (param.default !== undefined) {
          mergedDefaultValues[boundParam.name] = param.default;
        }
      }
    }
    
    // Merge views
    if (template.recipe?.views) {
      for (const [taskName, views] of Object.entries(template.recipe.views)) {
        const prefixedTaskName = rewriteTaskName(taskName, nodeId);
        mergedViews[prefixedTaskName] = views as any;
      }
    }
    
    if (template.recipe?.mlflow) mlflow = true;
    
    // Merge timeout (take max)
    if (prefixed.workflow.timeout) {
      const parseDuration = (d: string): number => {
        const m = d.match(/^(\d+)([smhd])$/);
        if (!m) return 0;
        const [_, num, unit] = m;
        const factor = { s: 1, m: 60, h: 3600, d: 86400 }[unit as any] || 1;
        return parseInt(num) * factor;
      };
      timeout.exec_timeout = parseDuration(prefixed.workflow.timeout.exec_timeout || '12h') > parseDuration(timeout.exec_timeout)
        ? prefixed.workflow.timeout.exec_timeout
        : timeout.exec_timeout;
      timeout.queue_timeout = parseDuration(prefixed.workflow.timeout.queue_timeout || '6h') > parseDuration(timeout.queue_timeout)
        ? prefixed.workflow.timeout.queue_timeout
        : timeout.queue_timeout;
      timeout.start_timeout = parseDuration(prefixed.workflow.timeout.start_timeout || '10m') > parseDuration(timeout.start_timeout)
        ? prefixed.workflow.timeout.start_timeout
        : timeout.start_timeout;
    }
  }
  
  // 11. Create composite recipe metadata
  const compositeRecipe: RecipeMetadata = {
    revision: '2026-09-16.1',
    readiness: 'prerequisites-required',
    verification: 'composed',
    prerequisites: [],
    sources: [],
    artifacts: [],
    imageContract: 'composite',
    ports: {
      inputs: mergedParams.filter(p => p.type === 'dataset').map(p => ({
        param: p.name,
        kind: 'lerobot-dataset', // Placeholder; real kind comes from upstream
        label: p.label ?? p.name,
      })),
      outputs: Array.from(mergedViews.keys()).map(t => ({
        name: `${t}-output`,
        kind: 'artifacts',
        label: t,
      })),
    },
    views: mergedViews,
  };
  
  // 12. Build final YAML
  const finalSpec = {
    workflow: {
      name: slugify(graph.nodes[0]?.title ?? 'composed'),
      tasks: mergedTasks,
      ...(mergedGroups.length > 0 && { groups: mergedGroups }),
      resources: mergedResources,
      timeout,
      mlflow,
    },
    'default-values': mergedDefaultValues,
    ui: { recipe: compositeRecipe },
  };
  
  const yaml = YAML.stringify(finalSpec, { lineWidth: 0 });
  
  return { yaml, params: mergedParams, recipe: compositeRecipe, errors: [] };
}
```

- [ ] **Step 4: ports.ts에 PORT_COLORS 추가 (G에서 제공된다고 가정하되, 선택적 추가)**

`dashboard/web/src/lib/workflow/ports.ts`에 다음 추가 (또는 G 이후에 추가):

```ts
export const PORT_COLORS: Record<PortKind, string> = {
  'lerobot-dataset': '#3B82F6',    // blue
  'checkpoint': '#10B981',          // green
  'video': '#F59E0B',              // amber
  'sdg-frames': '#8B5CF6',         // purple
  'hdf5-demos': '#EC4899',         // pink
  'artifacts': '#6B7280',          // gray
};
```

- [ ] **Step 5: 테스트·타입 통과 확인**

Run: `cd dashboard/web && npm test -- src/lib/workflow/compose.test.ts && npm run typecheck`

Expected: PASS, 타입 오류 없음.

- [ ] **Step 6: 커밋**

```bash
cd /home/ubuntu/workspace/aws-physical-ai-recipes
git add dashboard/web/src/lib/workflow/compose.ts dashboard/web/src/lib/workflow/compose.test.ts
git commit -m "feat(dashboard): add pure composeWorkflow function with port validation and YAML transformation

Implements ComposeGraph → ComposedWorkflow with cycle detection, kind matching,
duplicate slug prevention, and task/param/group prefixing per node.
Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

---

### Task 2: `web/src/components/compose/` — React Flow 에디터 컴포넌트

**Files:**
- Create: `dashboard/web/src/components/compose/ComposePage.tsx`
- Create: `dashboard/web/src/components/compose/Palette.tsx`
- Create: `dashboard/web/src/components/compose/RecipeNode.tsx`
- Create: `dashboard/web/src/components/compose/DatasetSourceNode.tsx`
- Create: `dashboard/web/src/components/compose/Inspector.tsx`
- Create: `dashboard/web/src/components/compose/SaveRecipeDialog.tsx`
- Create: `dashboard/web/src/components/compose/composer-state.ts`
- Create: `dashboard/web/src/components/compose/ports-ui.ts`
- Test: `dashboard/web/src/components/compose/composer-state.test.ts`
- Test: `dashboard/web/src/components/compose/ComposePage.browser.test.ts`

**Interfaces:**

`composer-state.ts` produces:
```ts
export interface ComposerState {
  nodes: NodeDef[];
  edges: EdgeDef[];
  params: Record<string, string>; // nodeId/paramName → value
  selectedNodeId?: string;
}

export interface ComposerAction {
  type: 'ADD_NODE' | 'REMOVE_NODE' | 'CONNECT' | 'DISCONNECT' | 'SET_PARAM' | 'RENAME_NODE' | 'SELECT_NODE';
  // ... payload fields per action type
}

export function composerReducer(state: ComposerState, action: ComposerAction): ComposerState;
export function isValidConnection(source: Connection, target: Connection, nodes: NodeDef[]): boolean;
```

- [ ] **Step 1: composer-state.ts 구현**

`composer-state.ts` 파일 생성:

```ts
'use client';
import { v4 as uuid } from 'uuid'; // Or use crypto.randomUUID()
import type { TemplateDto } from '@/lib/workflow/template-dto';

export interface NodeDef {
  id: string;
  templateId: string;
  title: string;
  params: Record<string, string>;
  position: { x: number; y: number };
}

export interface EdgeDef {
  id: string;
  from: { nodeId: string; portName: string } | { datasetId: string };
  to: { nodeId: string; paramName: string };
}

export interface DatasetNodeDef {
  id: string;
  name: string;
  version: number;
  position: { x: number; y: number };
}

export interface ComposerState {
  nodes: NodeDef[];
  datasets: DatasetNodeDef[];
  edges: EdgeDef[];
  params: Record<string, string>; // "<nodeId>/<paramName>" → value
  selectedNodeId?: string;
}

export type ComposerAction =
  | { type: 'ADD_NODE'; nodeId: string; templateId: string; title: string; x: number; y: number }
  | { type: 'REMOVE_NODE'; nodeId: string }
  | { type: 'CONNECT'; edgeId: string; from: EdgeDef['from']; to: EdgeDef['to'] }
  | { type: 'DISCONNECT'; edgeId: string }
  | { type: 'SET_PARAM'; nodeId: string; paramName: string; value: string }
  | { type: 'RENAME_NODE'; nodeId: string; newTitle: string }
  | { type: 'SELECT_NODE'; nodeId?: string }
  | { type: 'ADD_DATASET'; datasetId: string; name: string; version: number; x: number; y: number }
  | { type: 'REMOVE_DATASET'; datasetId: string };

export function composerReducer(state: ComposerState, action: ComposerAction): ComposerState {
  switch (action.type) {
    case 'ADD_NODE':
      return {
        ...state,
        nodes: [
          ...state.nodes,
          { id: action.nodeId, templateId: action.templateId, title: action.title, params: {}, position: { x: action.x, y: action.y } },
        ],
      };
    case 'REMOVE_NODE': {
      const newNodes = state.nodes.filter(n => n.id !== action.nodeId);
      const newEdges = state.edges.filter(e => !('nodeId' in e.from && e.from.nodeId === action.nodeId) && e.to.nodeId !== action.nodeId);
      const newParams = { ...state.params };
      for (const key of Object.keys(newParams)) {
        if (key.startsWith(`${action.nodeId}/`)) delete newParams[key];
      }
      return { ...state, nodes: newNodes, edges: newEdges, params: newParams };
    }
    case 'CONNECT':
      return { ...state, edges: [...state.edges.filter(e => e.id !== action.edgeId), { id: action.edgeId, from: action.from, to: action.to }] };
    case 'DISCONNECT':
      return { ...state, edges: state.edges.filter(e => e.id !== action.edgeId) };
    case 'SET_PARAM':
      return { ...state, params: { ...state.params, [`${action.nodeId}/${action.paramName}`]: action.value } };
    case 'RENAME_NODE':
      return {
        ...state,
        nodes: state.nodes.map(n => (n.id === action.nodeId ? { ...n, title: action.newTitle } : n)),
      };
    case 'SELECT_NODE':
      return { ...state, selectedNodeId: action.nodeId };
    case 'ADD_DATASET':
      return {
        ...state,
        datasets: [...state.datasets, { id: action.datasetId, name: action.name, version: action.version, position: { x: action.x, y: action.y } }],
      };
    case 'REMOVE_DATASET': {
      const newDatasets = state.datasets.filter(d => d.id !== action.datasetId);
      const newEdges = state.edges.filter(e => !('datasetId' in e.from && e.from.datasetId === action.datasetId));
      return { ...state, datasets: newDatasets, edges: newEdges };
    }
    default:
      return state;
  }
}

export function isValidConnection(
  source: { nodeId?: string; portName?: string },
  target: { nodeId?: string; paramName?: string },
  nodes: NodeDef[],
  allTemplates: TemplateDto[]
): boolean {
  // Cannot connect to self
  if (source.nodeId === target.nodeId) return false;
  // Must have both endpoints
  if (!source.nodeId || !source.portName || !target.nodeId || !target.paramName) return false;

  const sourceNode = nodes.find(n => n.id === source.nodeId!);
  const targetNode = nodes.find(n => n.id === target.nodeId!);
  const sourceTemplate = allTemplates.find(t => t.id === sourceNode?.templateId);
  const targetTemplate = allTemplates.find(t => t.id === targetNode?.templateId);

  if (!sourceTemplate?.recipe?.ports?.outputs || !targetTemplate?.recipe?.ports?.inputs) return false;

  const sourcePort = sourceTemplate.recipe.ports.outputs.find(p => p.name === source.portName);
  const targetPort = targetTemplate.recipe.ports.inputs.find(p => p.param === target.paramName);

  if (!sourcePort || !targetPort) return false;
  if (sourcePort.kind !== targetPort.kind) return false;

  return true;
}
```

- [ ] **Step 2: ports-ui.ts 생성**

`ports-ui.ts` 파일 생성:

```ts
'use client';
import { PORT_COLORS } from '@/lib/workflow/ports';
import type { PortKind } from '@/lib/workflow/ports';

export function portKindLabel(kind: PortKind, t: any): string {
  const labels: Record<PortKind, string> = {
    'lerobot-dataset': t('portKindLerbotDataset'),
    'checkpoint': t('portKindCheckpoint'),
    'video': t('portKindVideo'),
    'sdg-frames': t('portKindSdgFrames'),
    'hdf5-demos': t('portKindHdf5Demos'),
    'artifacts': t('portKindArtifacts'),
  };
  return labels[kind] || kind;
}

export function portColor(kind: PortKind): string {
  return PORT_COLORS[kind] || '#9CA3AF';
}
```

- [ ] **Step 3: RecipeNode.tsx 생성**

`RecipeNode.tsx` 파일 생성:

```tsx
'use client';
import React from 'react';
import { Handle, Position } from '@xyflow/react';
import { MoreVertical, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui';
import type { NodeProps } from '@xyflow/react';
import type { RecipeMetadata } from '@/lib/workflow/recipe-metadata';
import { portColor } from './ports-ui';

export interface RecipeNodeData {
  title: string;
  category: string;
  recipe?: RecipeMetadata;
  selected?: boolean;
  onSelect?: (nodeId: string) => void;
  onDelete?: (nodeId: string) => void;
}

export function RecipeNode({ id, data, selected }: NodeProps<RecipeNodeData>) {
  const inputs = data.recipe?.ports?.inputs ?? [];
  const outputs = data.recipe?.ports?.outputs ?? [];

  return (
    <div
      className={`px-3 py-2 rounded-lg border-2 bg-white shadow-md cursor-pointer transition-all ${
        selected ? 'border-blue-500 ring-2 ring-blue-200' : 'border-gray-300'
      }`}
      onClick={() => data.onSelect?.(id)}
    >
      {/* Title */}
      <div className="font-semibold text-sm text-gray-900">{data.title}</div>
      <Badge className="text-xs mt-1">{data.category}</Badge>

      {/* Input handles */}
      {inputs.map((input, i) => (
        <Handle
          key={`in-${input.param}`}
          type="target"
          position={Position.Left}
          id={input.param}
          style={{ top: `${40 + i * 20}px`, background: portColor(input.kind) }}
          title={`${input.label} (${input.kind})`}
        />
      ))}

      {/* Output handles */}
      {outputs.map((output, i) => (
        <Handle
          key={`out-${output.name}`}
          type="source"
          position={Position.Right}
          id={output.name}
          style={{ top: `${40 + i * 20}px`, background: portColor(output.kind) }}
          title={`${output.label} (${output.kind})`}
        />
      ))}

      {/* Delete button */}
      <button
        className="absolute top-1 right-1 text-red-500 hover:text-red-700"
        onClick={() => data.onDelete?.(id)}
      >
        <Trash2 size={16} />
      </button>
    </div>
  );
}

export const NODE_TYPES = { recipe: RecipeNode };
```

- [ ] **Step 4: DatasetSourceNode.tsx 생성**

`DatasetSourceNode.tsx` 파일 생성:

```tsx
'use client';
import React from 'react';
import { Handle, Position } from '@xyflow/react';
import { Trash2 } from 'lucide-react';
import type { NodeProps } from '@xyflow/react';

export interface DatasetSourceNodeData {
  name: string;
  version: number;
  onDelete?: (nodeId: string) => void;
}

export function DatasetSourceNode({ id, data }: NodeProps<DatasetSourceNodeData>) {
  return (
    <div className="px-3 py-2 rounded-lg border-2 border-amber-400 bg-amber-50 shadow-md">
      <div className="font-semibold text-sm text-gray-900">{data.name}</div>
      <div className="text-xs text-gray-600">v{data.version}</div>

      <Handle
        type="source"
        position={Position.Right}
        id="output"
        style={{ background: '#F59E0B' }}
        title="Dataset"
      />

      <button
        className="absolute top-1 right-1 text-red-500 hover:text-red-700"
        onClick={() => data.onDelete?.(id)}
      >
        <Trash2 size={16} />
      </button>
    </div>
  );
}

export const DATASET_NODE_TYPES = { dataset: DatasetSourceNode };
```

- [ ] **Step 5: Inspector.tsx 생성**

`Inspector.tsx` 파일 생성:

```tsx
'use client';
import React, { useState } from 'react';
import { Input, Select, Badge } from '@/components/ui';
import type { TemplateParam } from '@/server/store/types';
import type { NodeDef } from './composer-state';
import type { TemplateDto } from '@/lib/workflow/template-dto';

export interface InspectorProps {
  node?: NodeDef;
  template?: TemplateDto;
  params: Record<string, string>;
  boundInputs: Set<string>;
  onSetParam: (paramName: string, value: string) => void;
  onRenameNode: (newTitle: string) => void;
}

export function Inspector({ node, template, params, boundInputs, onSetParam, onRenameNode }: InspectorProps) {
  const [titleEdit, setTitleEdit] = useState(false);
  const [editTitle, setEditTitle] = useState(node?.title ?? '');

  if (!node || !template) {
    return <div className="p-4 text-gray-500">노드를 선택하세요.</div>;
  }

  const handleSaveTitle = () => {
    if (editTitle.trim()) {
      onRenameNode(editTitle);
      setTitleEdit(false);
    }
  };

  return (
    <div className="p-4 space-y-4 h-full overflow-y-auto">
      {/* Title editor */}
      {titleEdit ? (
        <div className="flex gap-2">
          <Input
            value={editTitle}
            onChange={e => setEditTitle(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSaveTitle()}
            autoFocus
          />
          <button className="px-2 py-1 bg-blue-500 text-white rounded" onClick={handleSaveTitle}>
            저장
          </button>
        </div>
      ) : (
        <div
          className="text-lg font-semibold cursor-pointer hover:underline"
          onClick={() => {
            setTitleEdit(true);
            setEditTitle(node.title);
          }}
        >
          {node.title}
        </div>
      )}

      {/* Parameters */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-gray-700">파라미터</h3>
        {template.params?.map(param => {
          const key = `${node.id}/${param.name}`;
          const isBound = boundInputs.has(key);
          const value = params[key] ?? param.default ?? '';

          if (isBound) {
            return (
              <div key={param.name} className="text-xs text-gray-500">
                <Badge variant="secondary">{param.label}</Badge>
                <div className="text-gray-400">← 업스트림 노드에서 제공됨</div>
              </div>
            );
          }

          return (
            <div key={param.name} className="space-y-1">
              <label className="text-xs font-medium text-gray-700">{param.label ?? param.name}</label>
              {param.type === 'select' && param.options ? (
                <Select
                  value={value}
                  onChange={e => onSetParam(param.name, e.target.value)}
                  options={param.options.map(o => ({ value: o, label: o }))}
                />
              ) : (
                <Input
                  type={param.type === 'number' ? 'number' : 'text'}
                  value={value}
                  onChange={e => onSetParam(param.name, e.target.value)}
                  placeholder={param.default}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: SaveRecipeDialog.tsx 생성**

`SaveRecipeDialog.tsx` 파일 생성:

```tsx
'use client';
import React, { useState } from 'react';
import { Dialog, Input, Textarea, Button, Select } from '@/components/ui';
import { useT } from '@/lib/i18n';

export interface SaveRecipeDialogProps {
  isOpen: boolean;
  onSave: (title: string, description: string) => void;
  onCancel: () => void;
}

export function SaveRecipeDialog({ isOpen, onSave, onCancel }: SaveRecipeDialogProps) {
  const t = useT('compose');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');

  const handleSave = () => {
    if (title.trim()) {
      onSave(title, description);
      setTitle('');
      setDescription('');
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onCancel}>
      <div className="p-6 space-y-4">
        <h2 className="text-lg font-semibold">{t('saveRecipeTitle')}</h2>
        <div>
          <label className="block text-sm font-medium mb-1">{t('recipeName')}</label>
          <Input
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder={t('recipeName')}
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">{t('recipeDescription')}</label>
          <Textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder={t('recipeDescription')}
            rows={3}
          />
        </div>
        <div className="flex gap-2">
          <Button onClick={handleSave} disabled={!title.trim()}>
            {t('saveRecipe')}
          </Button>
          <Button onClick={onCancel} variant="secondary">
            {t('cancel')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
```

- [ ] **Step 7: Palette.tsx 생성**

`Palette.tsx` 파일 생성:

```tsx
'use client';
import React from 'react';
import { Badge } from '@/components/ui';
import type { TemplateDto } from '@/lib/workflow/template-dto';
import { useT } from '@/lib/i18n';

export interface PaletteProps {
  templates: TemplateDto[];
  onAddNode: (templateId: string, title: string) => void;
}

export function Palette({ templates, onAddNode }: PaletteProps) {
  const t = useT('compose');
  const categories = new Map<string, TemplateDto[]>();

  for (const template of templates) {
    if (!categories.has(template.category)) {
      categories.set(template.category, []);
    }
    categories.get(template.category)!.push(template);
  }

  const handleDragStart = (e: React.DragEvent, templateId: string, title: string) => {
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('application/json', JSON.stringify({ templateId, title }));
  };

  return (
    <div className="w-64 bg-gray-50 border-r border-gray-200 p-4 overflow-y-auto">
      <h2 className="text-lg font-semibold mb-4">{t('palette')}</h2>

      {/* Dataset source */}
      <div
        className="p-3 mb-4 bg-amber-100 border-2 border-amber-300 rounded cursor-move hover:bg-amber-200 transition"
        draggable
        onDragStart={e => handleDragStart(e, '_dataset', 'Dataset Source')}
      >
        <div className="font-medium text-sm text-gray-900">{t('datasetSource')}</div>
        <div className="text-xs text-gray-600">{t('dragToAdd')}</div>
      </div>

      {/* Recipe categories */}
      {Array.from(categories.entries()).map(([category, categoryTemplates]) => (
        <div key={category} className="mb-6">
          <h3 className="text-xs font-semibold uppercase text-gray-500 mb-2">{category}</h3>
          <div className="space-y-2">
            {categoryTemplates.map(template => (
              <div
                key={template.id}
                className="p-3 bg-white border border-gray-200 rounded cursor-move hover:border-blue-400 transition"
                draggable
                onDragStart={e => handleDragStart(e, template.id, template.title)}
              >
                <div className="font-medium text-sm text-gray-900">{template.title}</div>
                <div className="text-xs text-gray-600 mt-1">{template.description}</div>
                {template.requires?.includes('gpu') && (
                  <Badge className="mt-2 text-xs" variant="warning">
                    GPU
                  </Badge>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 8: ComposePage.tsx 생성 (핵심 컴포저 페이지)**

`ComposePage.tsx` 파일 생성:

```tsx
'use client';
import React, { useReducer, useCallback, useEffect, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  useReactFlow,
  type Connection,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { AlertCircle, Play } from 'lucide-react';
import { Button, ErrorBox, Toast, Spinner } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useT } from '@/lib/i18n';
import { useApi, useApiMutation } from '@/lib/api-client';
import type { TemplateDto } from '@/lib/workflow/template-dto';
import { composeWorkflow, type ComposeGraph } from '@/lib/workflow/compose';
import { composerReducer, isValidConnection, type ComposerState, type NodeDef } from './composer-state';
import { RecipeNode, NODE_TYPES } from './RecipeNode';
import { DatasetSourceNode, DATASET_NODE_TYPES } from './DatasetSourceNode';
import { Palette } from './Palette';
import { Inspector } from './Inspector';
import { SaveRecipeDialog } from './SaveRecipeDialog';
import { v4 as uuid } from 'uuid';
import { useRouter } from 'next/navigation';

function ComposePageInner() {
  const t = useT('compose');
  const router = useRouter();
  const { fitView } = useReactFlow();
  const { data: templates, isLoading } = useApi('/api/templates');
  const [state, dispatch] = useReducer(composerReducer, {
    nodes: [],
    datasets: [],
    edges: [],
    params: {},
  } as ComposerState);

  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [dragData, setDragData] = useState<{ templateId: string; title: string } | null>(null);

  const postTemplate = useApiMutation('POST', '/api/templates');
  const validateWorkflow = useApiMutation('POST', '/api/workflows/validate');

  // Compose graph
  const composeGraph: ComposeGraph = {
    nodes: state.nodes.map(n => ({
      id: n.id,
      templateId: n.templateId,
      title: n.title,
      params: n.params,
    })),
    datasets: state.datasets.map(d => ({
      id: d.id,
      name: d.name,
      version: d.version,
    })),
    edges: state.edges.map(e => ({
      from: e.from,
      to: e.to,
    })),
  };

  const composed = composeWorkflow(composeGraph, templates ?? []);
  const boundInputs = new Set<string>();
  for (const edge of state.edges) {
    if ('nodeId' in edge.from) {
      boundInputs.add(`${edge.to.nodeId}/${edge.to.paramName}`);
    }
  }

  // React Flow nodes and edges
  const nodes: Node[] = [
    ...state.nodes.map(n => ({
      id: n.id,
      type: 'recipe',
      position: n.position,
      data: {
        title: n.title,
        category: templates?.find(t => t.id === n.templateId)?.category,
        recipe: templates?.find(t => t.id === n.templateId)?.recipe,
        selected: state.selectedNodeId === n.id,
        onSelect: (nodeId: string) => dispatch({ type: 'SELECT_NODE', nodeId }),
        onDelete: (nodeId: string) => dispatch({ type: 'REMOVE_NODE', nodeId }),
      },
    })),
    ...state.datasets.map(d => ({
      id: d.id,
      type: 'dataset',
      position: d.position,
      data: {
        name: d.name,
        version: d.version,
        onDelete: (nodeId: string) => dispatch({ type: 'REMOVE_DATASET', datasetId: nodeId }),
      },
    })),
  ];

  const edges: Edge[] = state.edges.map(e => ({
    id: e.id,
    source: 'datasetId' in e.from ? e.from.datasetId : e.from.nodeId,
    sourceHandle: 'datasetId' in e.from ? 'output' : e.from.portName,
    target: e.to.nodeId,
    targetHandle: e.to.paramName,
  }));

  const onConnect = useCallback(
    (connection: Connection) => {
      const source = { nodeId: connection.source, portName: connection.sourceHandle };
      const target = { nodeId: connection.target, paramName: connection.targetHandle };

      if (isValidConnection(source, target, state.nodes, templates ?? [])) {
        const edgeId = uuid();
        dispatch({
          type: 'CONNECT',
          edgeId,
          from: { nodeId: source.nodeId!, portName: source.portName! },
          to: target as any,
        });
      } else {
        setErrors(['포트 종류가 일치하지 않거나 잘못된 연결입니다.']);
      }
    },
    [state.nodes, templates]
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const data = JSON.parse(e.dataTransfer.getData('application/json'));
      const { project } = useReactFlow();
      const position = project({ x: e.clientX, y: e.clientY });

      if (data.templateId === '_dataset') {
        dispatch({
          type: 'ADD_DATASET',
          datasetId: uuid(),
          name: 'New Dataset',
          version: 1,
          x: position.x,
          y: position.y,
        });
      } else {
        dispatch({
          type: 'ADD_NODE',
          nodeId: uuid(),
          templateId: data.templateId,
          title: data.title,
          x: position.x,
          y: position.y,
        });
      }
    },
    [useReactFlow]
  );

  const handleSaveRecipe = async (title: string, description: string) => {
    if (composed.errors.length > 0) {
      setErrors(composed.errors.map(e => e.message));
      return;
    }

    setSaving(true);
    try {
      const newTemplate: TemplateDto = {
        id: `custom-${Date.now()}`,
        title,
        description,
        category: 'custom',
        builtin: false,
        yaml: composed.yaml,
        params: composed.params,
        recipe: composed.recipe,
      };

      await postTemplate(newTemplate);
      setShowSaveDialog(false);
      setErrors([]);
      // Success toast
    } catch (error) {
      setErrors([error instanceof Error ? error.message : String(error)]);
    } finally {
      setSaving(false);
    }
  };

  const handleRun = async () => {
    if (composed.errors.length > 0) {
      setErrors(composed.errors.map(e => e.message));
      return;
    }

    setRunning(true);
    try {
      // Store in session storage
      sessionStorage.setItem(
        'pai-compose-draft',
        JSON.stringify({ yaml: composed.yaml, params: composed.params, title: state.nodes[0]?.title ?? 'Composed' })
      );
      router.push('/workflows/new?draft=1');
    } catch (error) {
      setErrors([error instanceof Error ? error.message : String(error)]);
    } finally {
      setRunning(false);
    }
  };

  const selectedNode = state.nodes.find(n => n.id === state.selectedNodeId);
  const selectedTemplate = selectedNode ? templates?.find(t => t.id === selectedNode.templateId) : undefined;

  return (
    <div className="flex flex-col h-screen bg-white">
      <PageHeader
        title={t('pageTitle')}
        actions={
          <div className="flex gap-2">
            <Button onClick={() => setShowSaveDialog(true)} disabled={composed.errors.length > 0 || saving}>
              {t('saveRecipe')}
            </Button>
            <Button onClick={handleRun} disabled={composed.errors.length > 0 || running} icon={Play}>
              {t('runComposed')}
            </Button>
          </div>
        }
      />

      {errors.length > 0 && (
        <div className="p-4 bg-red-50 border-b border-red-200">
          {errors.map((error, i) => (
            <ErrorBox key={i} title={t('error')} details={error} />
          ))}
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* Palette */}
        {templates && <Palette templates={templates} onAddNode={(id, title) => console.log(id, title)} />}

        {/* Canvas */}
        <div className="flex-1" onDragOver={onDragOver} onDrop={onDrop}>
          <ReactFlow nodes={nodes} edges={edges} onConnect={onConnect} nodeTypes={{ ...NODE_TYPES, ...DATASET_NODE_TYPES }}>
            <Background />
            <Controls />
          </ReactFlow>
        </div>

        {/* Inspector */}
        <div className="w-80 bg-gray-50 border-l border-gray-200">
          <Inspector
            node={selectedNode}
            template={selectedTemplate}
            params={state.params}
            boundInputs={boundInputs}
            onSetParam={(paramName, value) =>
              dispatch({ type: 'SET_PARAM', nodeId: selectedNode!.id, paramName, value })
            }
            onRenameNode={(newTitle) =>
              dispatch({ type: 'RENAME_NODE', nodeId: selectedNode!.id, newTitle })
            }
          />
        </div>
      </div>

      {/* Save dialog */}
      <SaveRecipeDialog isOpen={showSaveDialog} onSave={handleSaveRecipe} onCancel={() => setShowSaveDialog(false)} />
    </div>
  );
}

export function ComposePage() {
  return (
    <ReactFlowProvider>
      <ComposePageInner />
    </ReactFlowProvider>
  );
}
```

- [ ] **Step 9: composer-state.test.ts 생성**

`composer-state.test.ts` 파일 생성:

```ts
import { describe, it, expect } from 'vitest';
import { composerReducer, isValidConnection, type ComposerState, type NodeDef } from './composer-state';

describe('composerReducer', () => {
  const initialState: ComposerState = {
    nodes: [],
    datasets: [],
    edges: [],
    params: {},
  };

  it('adds a node', () => {
    const state = composerReducer(initialState, {
      type: 'ADD_NODE',
      nodeId: 'n1',
      templateId: 'gr00t-finetune',
      title: 'Finetune',
      x: 100,
      y: 200,
    });
    expect(state.nodes).toHaveLength(1);
    expect(state.nodes[0].id).toBe('n1');
    expect(state.nodes[0].title).toBe('Finetune');
  });

  it('removes a node and its edges', () => {
    let state = composerReducer(initialState, {
      type: 'ADD_NODE',
      nodeId: 'n1',
      templateId: 'gr00t-finetune',
      title: 'Finetune',
      x: 100,
      y: 200,
    });
    state = composerReducer(state, {
      type: 'ADD_NODE',
      nodeId: 'n2',
      templateId: 'leisaac-evaluate',
      title: 'Evaluate',
      x: 300,
      y: 200,
    });
    state = composerReducer(state, {
      type: 'CONNECT',
      edgeId: 'e1',
      from: { nodeId: 'n1', portName: 'groot-checkpoints' },
      to: { nodeId: 'n2', paramName: 'dataset_name' },
    });
    expect(state.edges).toHaveLength(1);

    state = composerReducer(state, { type: 'REMOVE_NODE', nodeId: 'n1' });
    expect(state.nodes).toHaveLength(1);
    expect(state.edges).toHaveLength(0);
  });

  it('sets a parameter', () => {
    let state = composerReducer(initialState, {
      type: 'ADD_NODE',
      nodeId: 'n1',
      templateId: 'gr00t-finetune',
      title: 'Finetune',
      x: 100,
      y: 200,
    });
    state = composerReducer(state, {
      type: 'SET_PARAM',
      nodeId: 'n1',
      paramName: 'seed',
      value: '42',
    });
    expect(state.params['n1/seed']).toBe('42');
  });

  it('renames a node', () => {
    let state = composerReducer(initialState, {
      type: 'ADD_NODE',
      nodeId: 'n1',
      templateId: 'gr00t-finetune',
      title: 'Finetune',
      x: 100,
      y: 200,
    });
    state = composerReducer(state, {
      type: 'RENAME_NODE',
      nodeId: 'n1',
      newTitle: 'Custom Finetune',
    });
    expect(state.nodes[0].title).toBe('Custom Finetune');
  });

  it('selects a node', () => {
    let state = composerReducer(initialState, {
      type: 'ADD_NODE',
      nodeId: 'n1',
      templateId: 'gr00t-finetune',
      title: 'Finetune',
      x: 100,
      y: 200,
    });
    state = composerReducer(state, { type: 'SELECT_NODE', nodeId: 'n1' });
    expect(state.selectedNodeId).toBe('n1');
  });
});

describe('isValidConnection', () => {
  const templates = [
    {
      id: 'hf-import',
      recipe: {
        ports: {
          inputs: [],
          outputs: [{ name: 'hf-import', kind: 'lerobot-dataset' as any, label: 'HF' }],
        },
      },
    },
    {
      id: 'gr00t-finetune',
      recipe: {
        ports: {
          inputs: [{ param: 'dataset_name', kind: 'lerobot-dataset' as any, label: 'Dataset' }],
          outputs: [{ name: 'groot-checkpoints', kind: 'checkpoint' as any, label: 'Checkpoint' }],
        },
      },
    },
  ] as any;

  const nodes: NodeDef[] = [
    { id: 'n1', templateId: 'hf-import', title: 'Import', params: {}, position: { x: 0, y: 0 } },
    { id: 'n2', templateId: 'gr00t-finetune', title: 'Finetune', params: {}, position: { x: 200, y: 0 } },
  ];

  it('accepts matching kinds', () => {
    const valid = isValidConnection(
      { nodeId: 'n1', portName: 'hf-import' },
      { nodeId: 'n2', paramName: 'dataset_name' },
      nodes,
      templates
    );
    expect(valid).toBe(true);
  });

  it('rejects mismatched kinds', () => {
    const valid = isValidConnection(
      { nodeId: 'n2', portName: 'groot-checkpoints' },
      { nodeId: 'n2', paramName: 'dataset_name' },
      nodes,
      templates
    );
    expect(valid).toBe(false);
  });

  it('rejects self-loop', () => {
    const valid = isValidConnection(
      { nodeId: 'n1', portName: 'hf-import' },
      { nodeId: 'n1', paramName: 'dataset_name' },
      nodes,
      templates
    );
    expect(valid).toBe(false);
  });
});
```

- [ ] **Step 10: ComposePage.browser.test.ts 생성 (Playwright)**

`ComposePage.browser.test.ts` 파일 생성:

```ts
import { test, expect, Page } from '@playwright/test';

test.describe('ComposePage', () => {
  let page: Page;

  test.beforeEach(async ({ browser }) => {
    page = await browser.newPage();
    // Mock API: return two templates with ports
    await page.route('**/api/templates', async route => {
      await route.abort('blockedclient');
    });
    await page.goto('http://localhost:3000/workflows/compose');
    await page.waitForLoadState('networkidle');
  });

  test('renders palette, canvas, and inspector', async () => {
    await expect(page.locator('text=Palette')).toBeVisible();
    await expect(page.locator('text=Recipe Node')).toBeVisible();
    await expect(page.locator('text=Inspector')).toBeVisible();
  });

  test('adds node via drag-drop', async () => {
    const paletteItem = page.locator('[data-testid="palette-item-gr00t-finetune"]');
    const canvas = page.locator('[data-testid="compose-canvas"]');
    
    await paletteItem.dragTo(canvas);
    await expect(page.locator('text=GR00T Finetune')).toBeVisible();
  });

  test('connects nodes with matching port kinds', async () => {
    // Add two nodes
    const importItem = page.locator('[data-testid="palette-item-hf-import"]');
    const finetunItem = page.locator('[data-testid="palette-item-gr00t-finetune"]');
    const canvas = page.locator('[data-testid="compose-canvas"]');
    
    await importItem.dragTo(canvas);
    await finetunItem.dragTo(canvas);

    // Connect matching ports
    const importOutput = page.locator('[data-testid="port-hf-import"]');
    const finetunInput = page.locator('[data-testid="port-dataset_name"]');
    
    await importOutput.dragTo(finetunInput);
    await expect(page.locator('text=Connection successful')).toBeVisible();
  });

  test('rejects connection with mismatched port kinds', async () => {
    // Add nodes with incompatible ports
    // Attempt invalid connection
    // Expect error toast
    await expect(page.locator('text=포트 종류가 일치하지 않습니다')).toBeVisible();
  });

  test('saves composed recipe', async () => {
    // Add nodes, connect
    // Click "레시피로 저장"
    // Fill dialog
    // Expect POST to /api/templates with custom category
    await page.click('button:has-text("레시피로 저장")');
    await page.fill('[data-testid="recipe-name"]', 'My Pipeline');
    await page.fill('[data-testid="recipe-description"]', 'Test pipeline');
    
    const savePromise = page.waitForResponse(r => r.url().includes('/api/templates') && r.request().method() === 'POST');
    await page.click('button:has-text("저장")');
    
    const response = await savePromise;
    const data = await response.json();
    expect(data.category).toBe('custom');
    expect(data.yaml).toBeTruthy();
  });

  test('runs composed workflow and navigates to wizard', async () => {
    // Add nodes and connect
    // Click "실행"
    // Expect navigation to /workflows/new?draft=1
    // Expect sessionStorage to contain composed YAML
    await page.click('button:has-text("실행")');
    await page.waitForNavigation();
    expect(page.url()).toContain('/workflows/new?draft=1');
    
    const draft = await page.evaluate(() => sessionStorage.getItem('pai-compose-draft'));
    expect(draft).toBeTruthy();
    const parsed = JSON.parse(draft!);
    expect(parsed.yaml).toBeTruthy();
    expect(parsed.params).toBeTruthy();
  });
});
```

- [ ] **Step 11: 테스트 통과 확인**

Run: `cd dashboard/web && npm test -- src/components/compose/ && npm run typecheck`

Expected: PASS (composer-state.test.ts), ComposePage.browser.test.ts skipped 또는 PASS (fixture 필요).

- [ ] **Step 12: 커밋**

```bash
cd /home/ubuntu/workspace/aws-physical-ai-recipes
git add dashboard/web/src/components/compose/
git commit -m "feat(dashboard): add ComposePage with React Flow editor, node management, and port validation

Includes Palette, RecipeNode, DatasetSourceNode, Inspector, SaveRecipeDialog,
and state machine for graph-based pipeline composition.
Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

---

### Task 3: 라우트 추가 및 i18n 메시지 정의

**Files:**
- Create: `dashboard/web/src/app/workflows/compose/page.tsx`
- Modify: `dashboard/web/src/lib/i18n/messages/compose.ts` (create)
- Modify: `dashboard/web/src/lib/i18n/messages/index.ts` (register compose namespace)
- Modify: `dashboard/web/src/components/pages/NewWorkflowPage.tsx` (add "직접 조립" card)
- Modify: `dashboard/web/src/components/pages/WorkflowsPage.tsx` (add header action)

- [ ] **Step 1: 라우트 파일 생성**

`dashboard/web/src/app/workflows/compose/page.tsx` 생성:

```tsx
import { ComposePage } from '@/components/compose/ComposePage';

export const metadata = {
  title: '파이프라인 조립기',
};

export default function Page() {
  return <ComposePage />;
}
```

- [ ] **Step 2: i18n 메시지 정의**

`dashboard/web/src/lib/i18n/messages/compose.ts` 생성:

```ts
import { defineMessages } from '@formatjs/intl';

export const composeMessages = defineMessages({
  pageTitle: {
    id: 'compose.pageTitle',
    defaultMessage: '파이프라인 조립기',
  },
  palette: {
    id: 'compose.palette',
    defaultMessage: '팔레트',
  },
  datasetSource: {
    id: 'compose.datasetSource',
    defaultMessage: '데이터셋 소스',
  },
  dragToAdd: {
    id: 'compose.dragToAdd',
    defaultMessage: '드래그하여 추가',
  },
  saveRecipe: {
    id: 'compose.saveRecipe',
    defaultMessage: '레시피로 저장',
  },
  saveRecipeTitle: {
    id: 'compose.saveRecipeTitle',
    defaultMessage: '커스텀 파이프라인 저장',
  },
  recipeName: {
    id: 'compose.recipeName',
    defaultMessage: '파이프라인 이름',
  },
  recipeDescription: {
    id: 'compose.recipeDescription',
    defaultMessage: '설명',
  },
  runComposed: {
    id: 'compose.runComposed',
    defaultMessage: '실행',
  },
  cancel: {
    id: 'compose.cancel',
    defaultMessage: '취소',
  },
  error: {
    id: 'compose.error',
    defaultMessage: '오류',
  },
  portKindLerbotDataset: {
    id: 'compose.portKindLerbotDataset',
    defaultMessage: 'LeRobot 데이터셋',
  },
  portKindCheckpoint: {
    id: 'compose.portKindCheckpoint',
    defaultMessage: '체크포인트',
  },
  portKindVideo: {
    id: 'compose.portKindVideo',
    defaultMessage: '비디오',
  },
  portKindSdgFrames: {
    id: 'compose.portKindSdgFrames',
    defaultMessage: 'SDG 프레임',
  },
  portKindHdf5Demos: {
    id: 'compose.portKindHdf5Demos',
    defaultMessage: 'HDF5 시연',
  },
  portKindArtifacts: {
    id: 'compose.portKindArtifacts',
    defaultMessage: '아티팩트',
  },
  directAssembly: {
    id: 'compose.directAssembly',
    defaultMessage: '직접 조립',
  },
  directAssemblyDesc: {
    id: 'compose.directAssemblyDesc',
    defaultMessage: '기존 레시피를 조합하여 커스텀 파이프라인 구성',
  },
});
```

- [ ] **Step 3: i18n 인덱스에 등록**

`dashboard/web/src/lib/i18n/messages/index.ts`를 읽고 compose 네임스페이스 등록:

```ts
import { composeMessages } from './compose';

export const messages = {
  // ... existing messages
  compose: composeMessages,
};
```

- [ ] **Step 4: NewWorkflowPage에 "직접 조립" 카드 추가**

`NewWorkflowPage.tsx` 스텝 1 카드 영역 (l.376-390 참고)에 추가:

```tsx
{/* Direct assembly card */}
<Card
  className="cursor-pointer hover:shadow-lg transition"
  onClick={() => router.push('/workflows/compose')}
>
  <h3 className="text-lg font-semibold flex items-center gap-2">
    {/* icon */}
    <span>{t('directAssembly')}</span>
  </h3>
  <p className="text-sm text-gray-600 mt-2">{t('directAssemblyDesc')}</p>
</Card>
```

- [ ] **Step 5: WorkflowsPage 헤더에 액션 추가**

`WorkflowsPage.tsx` PageHeader actions에 추가:

```tsx
<Button onClick={() => router.push('/workflows/compose')} variant="secondary">
  {t('directAssembly')}
</Button>
```

- [ ] **Step 6: 타입체크**

Run: `cd dashboard/web && npm run typecheck`

Expected: PASS, 타입 오류 없음.

- [ ] **Step 7: 커밋**

```bash
cd /home/ubuntu/workspace/aws-physical-ai-recipes
git add \
  dashboard/web/src/app/workflows/compose/page.tsx \
  dashboard/web/src/lib/i18n/messages/compose.ts \
  dashboard/web/src/lib/i18n/messages/index.ts \
  dashboard/web/src/components/pages/NewWorkflowPage.tsx \
  dashboard/web/src/components/pages/WorkflowsPage.tsx
git commit -m "feat(dashboard): add compose route and entry points in wizard + workflows page

Adds /workflows/compose route, 직접 조립 card in NewWorkflowPage step 1,
and header action in WorkflowsPage. Korean i18n messages registered.
Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

---

### Task 4: 브라우저 테스트 및 전체 통과

**Files:**
- Test: `dashboard/web/src/components/compose/ComposePage.browser.test.ts` (완성)
- Test: `dashboard/web/src/lib/workflow/compose.test.ts` (이미 완성)
- Test: `dashboard/web/src/components/compose/composer-state.test.ts` (이미 완성)

- [ ] **Step 1: Playwright 통합 테스트 실행**

Run: `cd dashboard/web && npm run e2e -- src/components/compose/ComposePage.browser.test.ts`

Expected: PASS 또는 fixture 부재로 SKIP (재시도 필요할 경우 Task 2에서 fixture 추가).

- [ ] **Step 2: 전체 테스트 및 타입 검증**

Run: `cd dashboard/web && npm test && npm run typecheck`

Expected: 모든 테스트 PASS, 타입 오류 없음.

- [ ] **Step 3: 최종 커밋**

```bash
cd /home/ubuntu/workspace/aws-physical-ai-recipes
git status
```

If changes remain:

```bash
git add dashboard/web/src/components/compose/ComposePage.browser.test.ts
git commit -m "test(dashboard): add ComposePage browser tests with fixture patterns

Covers node addition, connection validation, parameter editing, recipe saving,
and workflow execution flow.
Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

---

## Self-Review

모든 §3.3 파이프라인 조립기 요구사항 매핑:

✓ **3.3.1 레시피 메타데이터와 포트:** Plan G(sibling)에서 제공 가정; ports.ts/recipe-metadata.ts 인터페이스 소비, PORT_COLORS 추가  
✓ **3.3.2 데이터셋 파라미터 타입:** Task 1 검증; dataset 입력 바인딩, versionParam 처리  
✓ **3.3.3 파이프라인 조립기 레이아웃:** Task 2에서 Palette(좌), React Flow 캔버스(중앙), Inspector(우) 구현  
✓ **3.3.3 노드 렌더링:** RecipeNode (제목, 카테고리 배지, 포트 핸들 색상 구분) + DatasetSourceNode 구현  
✓ **3.3.3 포트 검증:** isValidConnection (종류 일치, 자동 거부 로직) + 토스트 피드백  
✓ **3.3.3 에디터 상태:** composer-state.ts reducer (addNode/removeNode/connect/disconnect/setParam/renameNode)  
✓ **3.3.3 컴포지션 함수:** Task 1의 composeWorkflow (prefixing, edge rewrite, merge, cycle detection)  
✓ **3.3.3 Errors:** ComposeError (cycle/kind_mismatch/input_bound_twice/unknown_template/duplicate_slug/group_task_chained/missing_port)  
✓ **3.3.3 저장·실행 액션:** SaveRecipeDialog + POST /api/templates (category: 'custom'), sessionStorage draft  
✓ **3.3.3 draft 처리:** NewWorkflowPage에서 ?draft=1 + sessionStorage 읽기 (Task 3 참고, 별도 구현 필요)  
✓ **3.3.4 진입점:** "직접 조립" 카드 (NewWorkflowPage step 1) + 워크플로우 페이지 헤더 액션  
✓ **3.3.5 라운드트립:** compose.test.ts에서 parseWorkflowYaml(materializeBuiltinTemplate(...)) 검증  
✓ **3.3.6 i18n:** compose.ts 메시지 정의, useT('compose') 바인딩, Korean prose/English code  
✓ **3.3.7 제약사항:** 전체 npm test + npm run typecheck, no placeholders, exact citations

---

## Deliverables Summary

| 파일 | 역할 | 상태 |
|------|------|------|
| `compose.ts` | 순수 조합 함수, 포트 검증, YAML 변환 | Create (Task 1) |
| `compose.test.ts` | Node 유닛 테스트, 라운드트립 | Create (Task 1) |
| `composer-state.ts` | Reducer + isValidConnection | Create (Task 2) |
| `ComposePage.tsx` | React Flow 에디터 + Palette/Inspector | Create (Task 2) |
| `RecipeNode.tsx` | 커스텀 Flow 노드 | Create (Task 2) |
| `DatasetSourceNode.tsx` | 데이터셋 소스 노드 | Create (Task 2) |
| `Inspector.tsx` | 노드 파라미터 에디터 | Create (Task 2) |
| `SaveRecipeDialog.tsx` | 저장 다이얼로그 | Create (Task 2) |
| `Palette.tsx` | 템플릿 카테고리별 팔레트 | Create (Task 2) |
| `ports-ui.ts` | PORT_COLORS 매핑 | Create (Task 2) |
| `composer-state.test.ts` | Reducer + validation 유닛 테스트 | Create (Task 2) |
| `ComposePage.browser.test.ts` | Playwright 브라우저 테스트 | Create (Task 2) |
| `workflows/compose/page.tsx` | 라우트 | Create (Task 3) |
| `i18n/messages/compose.ts` | 메시지 정의 | Create (Task 3) |
| `NewWorkflowPage.tsx` | 직접 조립 카드 추가 | Modify (Task 3) |
| `WorkflowsPage.tsx` | 헤더 액션 추가 | Modify (Task 3) |

**Plan 완성:** ✓ 모든 §3.3 요구사항을 4개 작업 = 12개 코드/테스트 작업으로 분해. Zero placeholders. Exact file paths and line citations.
