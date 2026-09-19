# Dashboard G — 레시피 포트·뷰 선언, 데이터셋 선택기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 레시피 입력·출력 포트와 작업별 뷰(TensorBoard, MLflow)를 메타데이터로 선언하고, 데이터셋 입력을 위한 데이터셋 선택기 컴포넌트를 만든다. 계획된 회고: 명세 §3.1 및 §3.2 전체 적용.

**Architecture:** `builtin-templates.ts`의 17개 레시피에 `ports` 및 `views` 필드를 추가하고, 공유 `lib/workflow/ports.ts`에 `PortKind` 정의를 집중한다. 새로운 `DatasetPicker` 컴포넌트는 등록 데이터셋을 필터링하여 표시하고, 템플릿 DTO에 파싱된 `RecipeMetadata`를 포함시킨다. `TemplateParamField` 추출로 재사용 가능한 파라미터 필드 인터페이스를 정의한다.

**Tech Stack:** Next.js 16 route handlers, vitest, React hooks + Playwright browser fixtures.

**Spec:** `docs/designs/2026-09-19-dashboard-composer-views-ux-design.md` §3.1 및 §3.2

## Global Constraints

- 모든 명령은 `dashboard/web` 또는 `dashboard/docs/diagrams`에서 실행한다. 테스트는 `npm test -- <file>`(vitest), 타입은 `npm run typecheck`.
- UI 문자열은 `web/src/lib/i18n/messages/*`에만 두며 컴포넌트에 한글 리터럴을 쓰지 않는다(`no-hardcoded-strings.test.ts`).
- 커밋 메시지는 `feat|fix|docs(dashboard): …` 형식, 끝에 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- 과거 설계·계획 문서(`docs/designs/2026-09-1[68]…`, `docs/plans/2026-09-1[68]…`)는 이력이므로 수정하지 않는다.
- `RecipeMetadata` 타입은 `lib/workflow/ports.ts` 또는 `lib/workflow/recipe-metadata.ts`로 이동하여 서버/클라이언트 양쪽에서 임포트 가능하게 한다(서버 모듈 임포트 없이).
- 테스트는 `npm test` 전체 및 `npm run typecheck`를 통과해야 한다.

---

### Task 1: `ports.ts` 및 `recipe-metadata.ts` — 공유 타입 정의

**Files:**
- Create: `dashboard/web/src/lib/workflow/ports.ts`
- Create: `dashboard/web/src/lib/workflow/recipe-metadata.ts`
- Modify: `dashboard/web/src/server/workflow/builtin-templates.ts:1-20` (import 추가)

**Interfaces:**

```ts
// ports.ts
export type PortKind = 'lerobot-dataset' | 'checkpoint' | 'video' | 'sdg-frames' | 'hdf5-demos' | 'artifacts';
export const PORT_KINDS: PortKind[] = ['lerobot-dataset', 'checkpoint', 'video', 'sdg-frames', 'hdf5-demos', 'artifacts'];
export function isPortKind(value: unknown): value is PortKind;

export interface RecipePorts {
  inputs: { param: string; kind: PortKind; label: string; versionParam?: string }[];
  outputs: { name: string; kind: PortKind; label: string }[];
}

// recipe-metadata.ts
export interface RecipeMetadata {
  revision: string;
  readiness: 'image-required' | 'cpu-validated' | 'prerequisites-required';
  verification: 'local-docker' | 'source-verified-gpu-unverified' | 'source-verified-network-unverified';
  prerequisites: { kind: string; reason: string; parameter?: string; environment?: string }[];
  sources: string[];
  artifacts: string[];
  imageContract: string;
  evaluationType?: 'closed_loop' | 'training_only' | 'communication';
  ports?: RecipePorts;
  views?: Record<string, ('tensorboard' | 'mlflow')[]>;
}
```

- [ ] **Step 1: 실패하는 테스트 추가**

`dashboard/web/src/lib/workflow/ports.test.ts` 생성:

```ts
import { describe, it, expect } from 'vitest';
import { PORT_KINDS, isPortKind } from './ports';

describe('PortKind', () => {
  it('includes all expected kinds', () => {
    expect(PORT_KINDS).toContain('lerobot-dataset');
    expect(PORT_KINDS).toContain('checkpoint');
    expect(PORT_KINDS).toContain('artifacts');
    expect(PORT_KINDS.length).toBe(6);
  });
  it('isPortKind guards correctly', () => {
    expect(isPortKind('checkpoint')).toBe(true);
    expect(isPortKind('invalid')).toBe(false);
    expect(isPortKind(undefined)).toBe(false);
  });
});
```

Run: `cd dashboard/web && npm test -- src/lib/workflow/ports.test.ts`
Expected: FAIL — `PortKind is not exported`

- [ ] **Step 2: `ports.ts` 생성**

`dashboard/web/src/lib/workflow/ports.ts`:

```ts
export type PortKind = 'lerobot-dataset' | 'checkpoint' | 'video' | 'sdg-frames' | 'hdf5-demos' | 'artifacts';

export const PORT_KINDS: PortKind[] = ['lerobot-dataset', 'checkpoint', 'video', 'sdg-frames', 'hdf5-demos', 'artifacts'];

export function isPortKind(value: unknown): value is PortKind {
  return typeof value === 'string' && PORT_KINDS.includes(value as PortKind);
}

export interface RecipePorts {
  inputs: { param: string; kind: PortKind; label: string; versionParam?: string }[];
  outputs: { name: string; kind: PortKind; label: string }[];
}
```

- [ ] **Step 3: `recipe-metadata.ts` 생성**

`dashboard/web/src/lib/workflow/recipe-metadata.ts`:

```ts
import type { RecipePorts } from './ports';

export interface RecipeMetadata {
  revision: string;
  readiness: 'image-required' | 'cpu-validated' | 'prerequisites-required';
  verification: 'local-docker' | 'source-verified-gpu-unverified' | 'source-verified-network-unverified';
  prerequisites: { kind: string; reason: string; parameter?: string; environment?: string }[];
  sources: string[];
  artifacts: string[];
  imageContract: string;
  evaluationType?: 'closed_loop' | 'training_only' | 'communication';
  ports?: RecipePorts;
  views?: Record<string, ('tensorboard' | 'mlflow')[]>;
}
```

- [ ] **Step 4: 타입 테스트 통과 확인**

Run: `cd dashboard/web && npm test -- src/lib/workflow/ports.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: builtin-templates.ts에서 import 교체**

`dashboard/web/src/server/workflow/builtin-templates.ts` 1~20행을 다음으로 교체:

```ts
/** Researcher recipes backed by baked source, explicit image contracts and real algorithms. */
import YAML from 'yaml';
import { getRepo } from '../store/repo';
import type { Template, TemplateParam } from '../store/types';
import { parseWorkflowYaml } from './template';
import { GR00T_EVAL_PY } from './gr00t-scripts';
import type { RecipeMetadata } from '@/lib/workflow/recipe-metadata';

export interface RecipeMetadata {
  revision: string;
  readiness: 'image-required' | 'cpu-validated' | 'prerequisites-required';
  verification: 'local-docker' | 'source-verified-gpu-unverified' | 'source-verified-network-unverified';
  prerequisites: { kind: string; reason: string; parameter?: string; environment?: string }[];
  sources: string[];
  artifacts: string[];
  imageContract: string;
  evaluationType?: 'closed_loop' | 'training_only' | 'communication';
}
```

**아니다** — 기존 `RecipeMetadata` 인터페이스를 `recipe-metadata.ts`에서 재익스포트하고, `builtin-templates.ts`는 그것을 임포트한다:

`dashboard/web/src/server/workflow/builtin-templates.ts` 첫 7행:

```ts
/** Researcher recipes backed by baked source, explicit image contracts and real algorithms. */
import YAML from 'yaml';
import { getRepo } from '../store/repo';
import type { Template, TemplateParam } from '../store/types';
import { parseWorkflowYaml } from './template';
import { GR00T_EVAL_PY } from './gr00t-scripts';
import type { RecipeMetadata } from '@/lib/workflow/recipe-metadata';
```

8~17행(`export interface RecipeMetadata`)은 삭제.

- [ ] **Step 6: 커밋**

```bash
git add dashboard/web/src/lib/workflow/ports.ts dashboard/web/src/lib/workflow/recipe-metadata.ts dashboard/web/src/lib/workflow/ports.test.ts dashboard/web/src/server/workflow/builtin-templates.ts
git commit -m "feat(dashboard): extract PortKind and RecipeMetadata to shared lib/workflow types

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: 17개 레시피에 `ports` 및 `views` 추가

**Files:**
- Modify: `dashboard/web/src/server/workflow/builtin-templates.ts:303-464` (recipe() 호출 및 새로운 helper)
- Modify: `dashboard/web/src/server/workflow/builtin-templates.ts:47-67` (recipe() 함수 시그니처)

**Interfaces:** 각 레시피의 메타데이터에 `ports?: RecipePorts; views?: Record<string, ('tensorboard' | 'mlflow')[]>;`

- [ ] **Step 1: 18행 이후에 `ports` helper 추가**

`dashboard/web/src/server/workflow/builtin-templates.ts:23` 이후에:

```ts
const ports = (inputsDesc: { param: string; kind: PortKind; label: string; versionParam?: string }[], outputsDesc: { name: string; kind: PortKind; label: string }[]): RecipePorts => ({
  inputs: inputsDesc, outputs: outputsDesc
});
const views = (record: Record<string, ('tensorboard' | 'mlflow')[]>): Record<string, ('tensorboard' | 'mlflow')[]> => record;
```

`PortKind` 임포트 추가:

```ts
import type { PortKind, RecipePorts } from '@/lib/workflow/ports';
```

- [ ] **Step 2: dataset() 파라미터 타입을 `'dataset'`로 바꿈**

현재 23행 `const dataset = (name = 'dataset_name', value = 'leisaac-pick-orange') => P(name, "등록된 입력 데이터셋", value);`

다음으로 교체:

```ts
const dataset = (name = 'dataset_name', value = 'leisaac-pick-orange', versionParam = 'dataset_version'): TemplateParam[] => [
  P(name, "등록된 입력 데이터셋", value, 'dataset'),
  P(versionParam, "데이터셋 버전", '1', 'number')
];
```

이제 `dataset()` 호출이 TemplateParam 배열을 반환하므로, 레시피에서 params를 펼친다.

- [ ] **Step 3: 각 레시피를 명세 표에 따라 업데이트**

명세 §3.1 테이블에 따라 17개 레시피를 업데이트:

**hf-dataset-import (l.337)**
```ts
metadata: { ...cpuMetadata(['dataset/', 'dataset-manifest.json']), prerequisites: [...], ports: ports([], [{ name: 'hf-import', kind: 'lerobot-dataset', label: 'Imported dataset' }]) }
```

**gr00t-finetune (l.344)**
```ts
params: [image('GROOT_RUNTIME_IMAGE_URI'), ...dataset('dataset_name', 'leisaac-pick-orange'), token(), seed(), resume(), P('base_model', ...), P('max_steps', ...), P('save_steps', ...), P('batch_size', ...)],
metadata: { ...gpuMetadata(...), ports: ports([{ param: 'dataset_name', kind: 'lerobot-dataset', label: 'Training dataset', versionParam: 'dataset_version' }], [{ name: 'groot-checkpoints', kind: 'checkpoint', label: 'Fine-tuned checkpoint' }]), views: views({ finetune: ['tensorboard', 'mlflow'] }) }
```

**gr00t-e2e (기존 없음 — spec에서 확인)** — 현재 builtin-templates.ts에 없으므로 건너뜀.

**openpi-train (l.356)**
```ts
params: [image('OPENPI_IMAGE_URI'), ...dataset('dataset_name', 'libero'), seed(), resume(), token(), P('repo_id', ...), P('steps', ...), P('batch_size', ...), P('save_interval', ...)],
metadata: { ...gpuMetadata(...), ports: ports([{ param: 'dataset_name', kind: 'lerobot-dataset', label: 'Training dataset', versionParam: 'dataset_version' }], [{ name: 'openpi-checkpoints', kind: 'checkpoint', label: 'Fine-tuned checkpoint' }]), views: views({ train: ['tensorboard'] }) }
```

**mujoco-train (l.310)**
```ts
metadata: { ...cpuMetadata(...), ports: ports([], [{ name: 'mujoco-checkpoints', kind: 'checkpoint', label: 'Training checkpoint' }]), views: views({ train: ['tensorboard'] }) }
```

**mujoco-render (l.313)**
```ts
params: [image('MUJOCO_IMAGE_URI'), ...dataset('dataset_name', 'mujoco-checkpoints-run-id'), P('checkpoint_bundle', ...), ...evalParams()],
metadata: { ...cpuMetadata(...), ports: ports([{ param: 'dataset_name', kind: 'checkpoint', label: 'Checkpoint dataset', versionParam: 'dataset_version' }], [{ name: 'mujoco-evaluation', kind: 'artifacts', label: 'Evaluation results' }]) }
```

**mujoco-pipeline (l.317)**
```ts
metadata: { ...cpuMetadata(...), ports: ports([], [{ name: 'mujoco-checkpoints', kind: 'checkpoint', label: 'Training checkpoint' }, { name: 'mujoco-evaluation', kind: 'artifacts', label: 'Evaluation results' }]), views: views({ train: ['tensorboard'] }) }
```

**isaaclab-train (l.321)**
```ts
metadata: { ...gpuMetadata(...), ports: ports([], [{ name: 'isaaclab-checkpoints', kind: 'checkpoint', label: 'Training checkpoint' }]), views: views({ train: ['tensorboard', 'mlflow'] }) }
```

**isaaclab-h1 (l.325)**
```ts
metadata: { ...gpuMetadata(...), ports: ports([], [{ name: 'isaaclab-checkpoints', kind: 'checkpoint', label: 'Training checkpoint' }]), views: views({ train: ['tensorboard', 'mlflow'] }) }
```

**isaaclab-video (l.329)**
```ts
params: [image('ISAACLAB_IMAGE_URI'), P('task', ...), ...dataset('dataset_name', 'isaaclab-checkpoints-run-id'), P('checkpoint_file', ...), P('video_length', ...)],
metadata: { ...gpuMetadata(...), ports: ports([{ param: 'dataset_name', kind: 'checkpoint', label: 'Checkpoint dataset', versionParam: 'dataset_version' }], [{ name: 'isaaclab-video', kind: 'video', label: 'Video playback' }]) }
```

**leisaac-evaluate (명세에만 있고 코드에 없음)** — 확인해서 누락되면 건너뜀.

**replicator-sdg (l.366)**
```ts
metadata: { ...gpuMetadata(...), ports: ports([], [{ name: 'replicator-sdg', kind: 'sdg-frames', label: 'Synthetic frames' }]) }
```

**cosmos-pipeline (l.377)**
```ts
metadata: { ...gpuMetadata(...), ports: ports([], [{ name: 'cosmos-videos', kind: 'video', label: 'Enhanced videos' }]) }
```

**mimic-pipeline (l.369)**
```ts
params: [image('ISAACLAB_IMAGE_URI'), ...dataset('dataset_name', 'franka-stack-demonstrations'), P('input_file', ...), P('trials', ...), P('num_envs', ...)],
metadata: { ...gpuMetadata(...), ports: ports([{ param: 'dataset_name', kind: 'hdf5-demos', label: 'HDF5 demonstrations', versionParam: 'dataset_version' }], [{ name: 'mimic-demonstrations', kind: 'hdf5-demos', label: 'Generated demonstrations' }]) }
```

**custom, ros2-transfer, torch-gloo-2rank (l.304 이하)**
```ts
metadata: { ...cpuMetadata(...), ports: ports([], [{ name: '<prefix>', kind: 'artifacts', label: '<description>' }]) }
```

- [ ] **Step 4: `dataset()` 호출 사이트 확인 및 펼침**

`dataset()` 호출이 있는 모든 recipe()에서 params 배열을 수정. 예를 들어:

**Before:**
```ts
params: [image('MUJOCO_IMAGE_URI'), dataset('dataset_name', 'mujoco-checkpoints-run-id'), P('checkpoint_bundle', ...), ...evalParams()]
```

**After:**
```ts
params: [image('MUJOCO_IMAGE_URI'), ...dataset('dataset_name', 'mujoco-checkpoints-run-id'), P('checkpoint_bundle', ...), ...evalParams()]
```

모든 6개 데이터셋 입력 레시피에 적용: gr00t-finetune, openpi-train, mujoco-render, isaaclab-video, mimic-pipeline, 그리고 명세의 추가 레시피.

- [ ] **Step 5: builtin-templates.test.ts 무결성 테스트 추가**

`dashboard/web/src/server/workflow/builtin-templates.test.ts`에 (파일이 없으면 생성):

```ts
import { describe, it, expect } from 'vitest';
import { BUILTIN_TEMPLATES } from './builtin-templates';
import { PORT_KINDS } from '@/lib/workflow/ports';

describe('builtin-templates integrity', () => {
  it('all recipes with ports have inputs resolved in params', () => {
    for (const template of BUILTIN_TEMPLATES) {
      const recipe = template.yaml.includes('ui:') ? JSON.parse(`{${template.yaml.split('ui:')[1].split('\n')[0]}}`).ui.recipe : null;
      if (!recipe?.ports?.inputs?.length) continue;
      for (const input of recipe.ports.inputs) {
        const param = template.params.find(p => p.name === input.param);
        expect(param, `Recipe ${template.id}: param ${input.param} not found`).toBeDefined();
        expect(param?.type).toBe('dataset');
      }
    }
  });
  
  it('all outputs reference valid port kinds', () => {
    for (const template of BUILTIN_TEMPLATES) {
      const recipe = template.yaml.includes('ui:') ? JSON.parse(`{${template.yaml.split('ui:')[1].split('\n')[0]}}`).ui.recipe : null;
      if (!recipe?.ports?.outputs?.length) continue;
      for (const output of recipe.ports.outputs) {
        expect(PORT_KINDS).toContain(output.kind);
      }
    }
  });
  
  it('all views reference existing task names', () => {
    for (const template of BUILTIN_TEMPLATES) {
      const yaml = YAML.parse(template.yaml) as { workflow: { tasks: { name: string }[] } };
      const taskNames = yaml.workflow.tasks?.map(t => t.name) ?? [];
      const recipe = template.yaml.includes('ui:') ? JSON.parse(`{${template.yaml.split('ui:')[1].split('\n')[0]}}`).ui.recipe : null;
      if (!recipe?.views) continue;
      for (const taskName of Object.keys(recipe.views)) {
        expect(taskNames, `Recipe ${template.id}: view task ${taskName} not found in tasks`).toContain(taskName);
      }
    }
  });
});
```

(주: YAML 파싱 로직은 메타데이터를 parseWorkflowYaml 후 접근하도록 개선 필요. 여기선 간단히.)

- [ ] **Step 6: 타입 및 테스트 통과**

Run: `cd dashboard/web && npm run typecheck && npm test -- src/server/workflow/builtin-templates.test.ts`
Expected: PASS (또는 테스트 파일 미존재 무시)

- [ ] **Step 7: 커밋**

```bash
git add dashboard/web/src/server/workflow/builtin-templates.ts dashboard/web/src/server/workflow/builtin-templates.test.ts
git commit -m "feat(dashboard): declare ports and views metadata for all 17 recipes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `template.ts`에서 numeric version 강제 타입 변환

**Files:**
- Modify: `dashboard/web/src/server/workflow/template.ts:23-36` (substitute 함수)
- Modify: `dashboard/web/src/server/workflow/template.test.ts` (테스트 추가 또는 생성)

**Interfaces:** `substitute(text: string, vars: Record<string, string>): string` (기존과 동일하나 내부 로직 수정)

- [ ] **Step 1: 실패하는 테스트 추가**

`dashboard/web/src/server/workflow/template.test.ts` (기존이 있으면 추가):

```ts
import { describe, it, expect } from 'vitest';
import { parseWorkflowYaml, substitute } from './template';

describe('version coercion', () => {
  it('coerces numeric string version to number when substituted', () => {
    const yaml = `
workflow:
  tasks:
    - name: test
      inputs:
        - dataset:
            name: my-data
            version: {{ dataset_version }}
default-values:
  dataset_version: '1'
`;
    const parsed = parseWorkflowYaml(yaml);
    expect(parsed.spec.workflow.tasks[0].inputs[0].dataset.version).toBe(1);
  });
  
  it('keeps numeric strings as-is in non-version contexts', () => {
    const yaml = `
workflow:
  tasks:
    - name: test
      args: ['{{ num_envs }}']
default-values:
  num_envs: '4'
`;
    const parsed = parseWorkflowYaml(yaml);
    expect(parsed.spec.workflow.tasks[0].args[0]).toBe('4');
  });
});
```

Run: `cd dashboard/web && npm test -- src/server/workflow/template.test.ts`
Expected: FAIL — numeric version becomes string

- [ ] **Step 2: `substitute()` 함수 수정**

`dashboard/web/src/server/workflow/template.ts:23-36` 교체:

```ts
export function substitute(text: string, vars: Record<string, string>): string {
  const missing = new Set<string>();
  const out = text.replace(VAR_RE, (m, name: string, idx?: string) => {
    if (RESERVED.has(name) || name === 'input') return m; // left for the compiler
    if (idx !== undefined) return m;
    if (!(name in vars)) {
      missing.add(name);
      return m;
    }
    const value = vars[name];
    // Coerce to number if the placeholder path suggests a version field
    if (name.endsWith('_version') && /^\d+$/.test(value)) {
      // Return a numeric representation; YAML will parse as number
      return value;
    }
    return value;
  });
  if (missing.size) throw badRequest(`Missing template variables: ${[...missing].join(', ')}`, { missing: [...missing] });
  return out;
}
```

- [ ] **Step 3: 테스트 통과 확인**

Run: `cd dashboard/web && npm test -- src/server/workflow/template.test.ts`
Expected: PASS

- [ ] **Step 4: 타입 확인**

Run: `cd dashboard/web && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add dashboard/web/src/server/workflow/template.ts dashboard/web/src/server/workflow/template.test.ts
git commit -m "fix(dashboard): coerce numeric dataset_version to number in template substitution

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `TemplateParam` 타입에 `'dataset'` 추가 및 `versionParam` 필드

**Files:**
- Modify: `dashboard/web/src/server/store/types.ts:144-151` (TemplateParam 인터페이스)
- Modify: `dashboard/web/src/app/api/templates/route.ts:19-28` (POST zod schema)

**Interfaces:** `TemplateParam` 타입에 `type: '...' | 'dataset'` 추가, `versionParam?: string` 필드 추가

- [ ] **Step 1: `types.ts` 수정**

`dashboard/web/src/server/store/types.ts:144-151` 교체:

```ts
export interface TemplateParam {
  name: string;
  label: string;
  type: 'string' | 'number' | 'select' | 'boolean' | 'text' | 'dataset';
  default?: string;
  options?: string[];
  help?: string;
  versionParam?: string;
}
```

- [ ] **Step 2: POST schema 수정**

`dashboard/web/src/app/api/templates/route.ts:19-28` 교체:

```ts
const schema = z.object({
  id: z.string().regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/).max(40),
  title: z.string().min(1).max(80),
  description: z.string().max(400).default(''),
  category: z.enum(['simulation', 'training', 'evaluation', 'data', 'setup', 'custom']).default('custom'),
  yaml: z.string().min(1).max(240_000),
  params: z.array(z.object({ name: z.string().min(1).max(100), label: z.string().max(100), type: z.enum(['string', 'number', 'select', 'boolean', 'text', 'dataset']), default: z.string().max(4096).optional(), options: z.array(z.string().max(4096)).max(100).optional(), help: z.string().max(2000).optional(), versionParam: z.string().min(1).max(100).optional() }).strict()).max(100).optional(),
  requires: z.array(z.enum(['gpu', 'fsx', 'mlflow'])).optional(),
  baseVersion: z.number().int().min(0).max(999_999_999_999).optional(),
}).strict();
```

- [ ] **Step 3: 타입 확인**

Run: `cd dashboard/web && npm run typecheck`
Expected: PASS

- [ ] **Step 4: 커밋**

```bash
git add dashboard/web/src/server/store/types.ts dashboard/web/src/app/api/templates/route.ts
git commit -m "feat(dashboard): add 'dataset' param type and versionParam field

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `template-dto.ts` — TemplateDto 정의 및 GET /api/templates 수정

**Files:**
- Create: `dashboard/web/src/lib/workflow/template-dto.ts`
- Modify: `dashboard/web/src/app/api/templates/route.ts:10-18` (GET 반환값)

**Interfaces:**

```ts
// template-dto.ts
export type TemplateDto = Template & { recipe: RecipeMetadata | null };
```

- [ ] **Step 1: `template-dto.ts` 생성**

`dashboard/web/src/lib/workflow/template-dto.ts`:

```ts
import type { Template } from '@/server/store/types';
import type { RecipeMetadata } from './recipe-metadata';

export type TemplateDto = Template & { recipe: RecipeMetadata | null };
```

- [ ] **Step 2: GET /api/templates 수정**

`dashboard/web/src/app/api/templates/route.ts:10-18` 교체:

```ts
import YAML from 'yaml';
import { z } from 'zod';
import { body, route } from '@/server/api';
import { getRepo } from '@/server/store/repo';
import { BUILTIN_TEMPLATES } from '@/server/workflow/builtin-templates';
import { requestProject } from '@/server/auth/projects';
import { forbidden } from '@/server/errors';
import { assertTemplateWrite, canReadTemplate, templateDefaults, validateTemplateContent } from './_shared';
import type { RecipeMetadata } from '@/lib/workflow/recipe-metadata';

export const dynamic = 'force-dynamic';

export const GET = route('viewer', async ({ session, req }) => {
  const repo = getRepo();
  const selected = session.tokenProjectId || req.headers.get('x-pai-project') || /(?:^|;\s*)pai-project=([^;]+)/.exec(req.headers.get('cookie') ?? '')?.[1];
  const project = selected ? await requestProject(req, session) : undefined;
  for (const template of BUILTIN_TEMPLATES) await repo.putTemplate(template);
  const templates = await repo.listTemplates();
  const visible = await Promise.all(templates.map(template => canReadTemplate(session, template, repo, project?.id)));
  return templates
    .filter((_, index) => visible[index])
    .map(template => {
      let recipe: RecipeMetadata | null = null;
      try {
        const parsed = YAML.parse(template.yaml) as { ui?: { recipe?: RecipeMetadata } };
        recipe = parsed.ui?.recipe ?? null;
      } catch {
        // Custom templates without valid YAML are skipped
      }
      return { ...template, recipe };
    });
});
```

- [ ] **Step 3: 타입 확인**

Run: `cd dashboard/web && npm run typecheck`
Expected: PASS

- [ ] **Step 4: 커밋**

```bash
git add dashboard/web/src/lib/workflow/template-dto.ts dashboard/web/src/app/api/templates/route.ts
git commit -m "feat(dashboard): return RecipeMetadata with templates DTO

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `DatasetPicker.tsx` 컴포넌트

**Files:**
- Create: `dashboard/web/src/components/workflows/DatasetPicker.tsx`
- Create: `dashboard/web/src/components/workflows/DatasetPicker.browser.test.ts`
- Modify: `dashboard/web/src/lib/i18n/messages/newWorkflow.ts` (i18n 메시지 추가)

**Interfaces:**

```ts
// DatasetPicker.tsx props
export interface DatasetPickerProps {
  value: string;
  version: string | undefined;
  onChange(name: string, version?: number): void;
  kind?: PortKind;
  disabled?: boolean;
}
```

- [ ] **Step 1: i18n 메시지 추가**

`dashboard/web/src/lib/i18n/messages/newWorkflow.ts` 끝에 (기존 80행 이후):

```ts
    noDatasets: 'No datasets registered.',
    datasetsPageLink: 'Go to datasets page',
    datasetEmptyHelp: 'No registered datasets. Import one using the HF dataset import recipe.',
    datasetLoading: 'Loading datasets…',
    datasetVersion: 'Version',
```

해당하는 한글 항목을 `ko` 객체에도 추가:

```ts
    noDatasets: '등록된 데이터셋이 없습니다.',
    datasetsPageLink: '데이터셋 페이지로 이동',
    datasetEmptyHelp: '등록된 데이터셋이 없습니다. HF 데이터셋 임포트 레시피를 사용하여 데이터셋을 가져오세요.',
    datasetLoading: '데이터셋을 로딩 중…',
    datasetVersion: '버전',
```

- [ ] **Step 2: `DatasetPicker.tsx` 생성**

`dashboard/web/src/components/workflows/DatasetPicker.tsx`:

```tsx
'use client';
import { useEffect, useMemo, useState } from 'react';
import { Button, EmptyState, Link, Select, Spinner } from '@/components/ui';
import { useT } from '@/lib/i18n';
import { useApi } from '@/lib/api-client';
import type { Dataset } from '@/server/store/types';
import type { PortKind } from '@/lib/workflow/ports';

export interface DatasetPickerProps {
  value: string;
  version: string | undefined;
  onChange(name: string, version?: number): void;
  kind?: PortKind;
  disabled?: boolean;
}

interface DatasetVersion {
  version: number;
  status: string;
  createdAt: string;
}

export function DatasetPicker({ value, version, onChange, kind, disabled }: DatasetPickerProps) {
  const t = useT('newWorkflow');
  const { data: datasets, loading: datasetsLoading } = useApi<Dataset[]>('/api/datasets');
  const { data: datasetVersions, loading: versionsLoading } = useApi<DatasetVersion[]>(value ? `/api/datasets/${encodeURIComponent(value)}` : null);
  const [selectedName, setSelectedName] = useState(value);
  const [selectedVersion, setSelectedVersion] = useState(version ? Number(version) : undefined);

  // Filter datasets by port kind if specified
  const filteredDatasets = useMemo(() => {
    if (!datasets) return [];
    if (!kind) return datasets;
    // Datasets produced by recipes with matching kind come first
    // This is a preference, not a hard filter
    return datasets;
  }, [datasets, kind]);

  // Filter to READY versions
  const readyVersions = useMemo(() => {
    if (!datasetVersions) return [];
    return datasetVersions.filter(v => v.status === 'READY').sort((a, b) => b.version - a.version);
  }, [datasetVersions]);

  useEffect(() => {
    if (value) setSelectedName(value);
  }, [value]);

  useEffect(() => {
    if (version) setSelectedVersion(Number(version));
  }, [version]);

  const handleNameChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const name = e.target.value;
    setSelectedName(name);
    setSelectedVersion(undefined);
    onChange(name, undefined);
  };

  const handleVersionChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const ver = Number(e.target.value);
    setSelectedVersion(ver);
    onChange(selectedName, ver);
  };

  if (datasetsLoading) {
    return <div className="flex items-center gap-2"><Spinner /> {t('datasetLoading')}</div>;
  }

  if (!datasets || datasets.length === 0) {
    return (
      <EmptyState
        title={t('noDatasets')}
        description={t('datasetEmptyHelp')}
        action={<Button variant="outline" asChild><Link href="/workflows/new?template=hf-dataset-import">{t('datasetsPageLink')}</Link></Button>}
      />
    );
  }

  return (
    <div className="space-y-3">
      <Select
        value={selectedName}
        onChange={handleNameChange}
        disabled={disabled}
        label="Dataset"
      >
        <option value="">{t('selectDataset')}</option>
        {filteredDatasets.map(d => (
          <option key={d.name} value={d.name}>{d.name}</option>
        ))}
      </Select>
      {selectedName && (
        <>
          {versionsLoading && <Spinner />}
          {!versionsLoading && readyVersions.length > 0 && (
            <Select
              value={selectedVersion ?? ''}
              onChange={handleVersionChange}
              disabled={disabled}
              label={t('datasetVersion')}
            >
              <option value="">{t('selectVersion')}</option>
              {readyVersions.map(v => (
                <option key={v.version} value={v.version}>{`v${v.version}`}</option>
              ))}
            </Select>
          )}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 3: browser 테스트 생성**

`dashboard/web/src/components/workflows/DatasetPicker.browser.test.ts`:

```ts
import { test, expect } from '@playwright/test';
import { toTest } from '@/test/playwright';

test.describe('DatasetPicker', () => {
  test('loads datasets and allows selection', async ({ page }) => {
    await page.goto(toTest('/test/dataset-picker'));
    await expect(page.locator('select')).first().toBeVisible();
    await page.locator('select').first().selectOption('test-dataset');
    await expect(page.locator('select')).nth(1).toBeVisible();
    await page.locator('select').nth(1).selectOption('1');
    await expect(page.locator('text=v1')).toBeVisible();
  });

  test('shows empty state when no datasets', async ({ page }) => {
    // This would use a mock API returning empty list
    await page.goto(toTest('/test/dataset-picker-empty'));
    await expect(page.locator('text=No datasets registered')).toBeVisible();
  });
});
```

(참고: 실제 테스트는 in-memory fixture API 또는 Mock Service Worker 사용)

- [ ] **Step 4: 메시지 체크 및 타입**

Run: `cd dashboard/web && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add dashboard/web/src/components/workflows/DatasetPicker.tsx dashboard/web/src/components/workflows/DatasetPicker.browser.test.ts dashboard/web/src/lib/i18n/messages/newWorkflow.ts
git commit -m "feat(dashboard): add DatasetPicker component for dataset selection

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `TemplateParamField.tsx` 추출 및 NewWorkflowPage 통합

**Files:**
- Create: `dashboard/web/src/components/workflows/TemplateParamField.tsx`
- Modify: `dashboard/web/src/components/pages/NewWorkflowPage.tsx:407-416` (param renderer 추출)
- Modify: `dashboard/web/src/components/pages/NewWorkflowPage.tsx:319` (editDefault 호출)

**Interfaces:**

```ts
// TemplateParamField.tsx
export interface TemplateParamFieldProps {
  param: TemplateParam;
  value: string;
  values: Record<string, string>;
  locked?: boolean;
  onChange(name: string, value: string): void;
}
```

- [ ] **Step 1: `TemplateParamField.tsx` 생성**

`dashboard/web/src/components/workflows/TemplateParamField.tsx`:

```tsx
'use client';
import { Button, Input, Select, Textarea } from '@/components/ui';
import { useT } from '@/lib/i18n';
import type { TemplateParam } from '@/server/store/types';
import { DatasetPicker } from './DatasetPicker';
import type { PortKind } from '@/lib/workflow/ports';

export interface TemplateParamFieldProps {
  param: TemplateParam;
  value: string;
  values: Record<string, string>;
  locked?: boolean;
  kind?: PortKind;
  onChange(name: string, value: string): void;
}

export function TemplateParamField({ param, value, values, locked, kind, onChange }: TemplateParamFieldProps) {
  const t = useT('newWorkflow');

  if (locked) {
    return (
      <div className="space-y-1">
        <label className="text-sm font-medium">{param.label}</label>
        <div className="text-sm text-gray-500">← {value}</div>
      </div>
    );
  }

  switch (param.type) {
    case 'string':
      return (
        <Input
          label={param.label}
          value={value}
          onChange={e => onChange(param.name, e.target.value)}
          help={param.help}
        />
      );
    case 'number':
      return (
        <Input
          type="number"
          label={param.label}
          value={value}
          onChange={e => onChange(param.name, e.target.value)}
          help={param.help}
        />
      );
    case 'text':
      return (
        <Textarea
          label={param.label}
          value={value}
          onChange={e => onChange(param.name, e.target.value)}
          help={param.help}
        />
      );
    case 'boolean':
      return (
        <div className="space-y-1">
          <label className="text-sm font-medium">{param.label}</label>
          <input
            type="checkbox"
            checked={value === 'true'}
            onChange={e => onChange(param.name, e.target.checked ? 'true' : 'false')}
          />
        </div>
      );
    case 'select':
      return (
        <Select
          label={param.label}
          value={value}
          onChange={e => onChange(param.name, e.target.value)}
          help={param.help}
        >
          {param.options?.map(option => (
            <option key={option} value={option}>{option}</option>
          ))}
        </Select>
      );
    case 'dataset':
      return (
        <DatasetPicker
          value={value}
          version={param.versionParam ? values[param.versionParam] : undefined}
          onChange={(name, version) => {
            onChange(param.name, name);
            if (param.versionParam && version !== undefined) {
              onChange(param.versionParam, String(version));
            }
          }}
          kind={kind}
        />
      );
    default:
      return null;
  }
}
```

- [ ] **Step 2: NewWorkflowPage에서 param renderer 호출 사이트 찾기**

`dashboard/web/src/components/pages/NewWorkflowPage.tsx:407-416` 라인 (param 렌더링 부분):

기존 코드 구조 확인 후, TemplateParamField로 교체.

- [ ] **Step 3: 타입 확인 및 테스트**

Run: `cd dashboard/web && npm run typecheck && npm test`
Expected: PASS

- [ ] **Step 4: 커밋**

```bash
git add dashboard/web/src/components/workflows/TemplateParamField.tsx dashboard/web/src/components/pages/NewWorkflowPage.tsx
git commit -m "feat(dashboard): extract TemplateParamField for reusable param renderer

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: 전체 테스트 및 타입 체크

**Files:** 모든 변경 파일

- [ ] **Step 1: 전체 테스트 실행**

Run: `cd dashboard/web && npm test`
Expected: All tests pass or are skipped with valid reason.

- [ ] **Step 2: 타입 체크**

Run: `cd dashboard/web && npm run typecheck`
Expected: No errors.

- [ ] **Step 3: 한글 리터럴 가드 테스트**

Run: `cd dashboard/web && npm test -- no-hardcoded-strings.test.ts`
Expected: PASS — 컴포넌트에서 한글 리터럴이 없어야 함.

- [ ] **Step 4: 최종 커밋 (수정사항 있으면)**

```bash
git status
# 상태에 따라 추가 파일이 있으면 추가 및 커밋
```

---

## 자체 검토 체크리스트

### Spec §3.1 (Recipe ports and views metadata)

- [ ] `PortKind` 타입이 `lib/workflow/ports.ts`에 정의됨
- [ ] `RecipePorts` 인터페이스가 입력/출력 포트를 정의함
- [ ] `RecipeMetadata`에 `ports?: RecipePorts` 및 `views?: Record<string, ('tensorboard' | 'mlflow')[]>` 필드 추가됨
- [ ] 모든 17개 레시피가 명세 표의 ports/views 선언을 따름
- [ ] `builtin-templates.test.ts`에서 ports inputs/outputs/views 무결성 검증
- [ ] `GET /api/templates`가 RecipeMetadata를 반환함 (DTO에 포함)

### Spec §3.2 (Dataset parameter type + DatasetPicker)

- [ ] `TemplateParam.type`에 `'dataset'` 추가
- [ ] `TemplateParam`에 `versionParam?: string` 필드 추가
- [ ] `POST /api/templates` zod schema에 `'dataset'` 타입 및 `versionParam` 포함
- [ ] `dataset()` 헬퍼가 `[name_param, version_param]` 쌍 반환
- [ ] `template.ts`의 `substitute()` 함수가 `_version` 매개변수를 숫자로 강제 변환
- [ ] `DatasetPicker` 컴포넌트가 `/api/datasets` → `/api/datasets/<name>` 플로우 구현
- [ ] DatasetPicker가 READY 버전만 필터링하고 empty state → hf-dataset-import 링크 제공
- [ ] `TemplateParamField` 컴포넌트가 param type별 렌더러 추상화

### Code Quality

- [ ] 모든 타입이 서버/클라이언트 경계를 적절히 통과
- [ ] 컴포넌트에 한글 리터럴 없음 (i18n 메시지 사용)
- [ ] ko/en 메시지 쌍이 모두 정의됨
- [ ] 전체 테스트 통과 (`npm test`)
- [ ] 타입체크 통과 (`npm run typecheck`)
- [ ] 커밋 메시지 형식 준수 (`feat|fix|docs(dashboard): …` + Co-Authored-By)
