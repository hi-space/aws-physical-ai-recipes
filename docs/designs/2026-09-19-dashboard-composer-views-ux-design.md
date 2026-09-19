# Dashboard: 파이프라인 조립기, 보기(views) 선언, 데이터셋 선택, Isaac 라이브 뷰, ID·비용 정리

- Date: 2026-09-19
- Branch: `feat/hyperpod-dashboard`
- Scope: `dashboard/web`, `dashboard/recipes`, `dashboard/images/isaaclab`, `dashboard/docs`
- Status: approved in conversation (user chose the free graph editor; block = recipe)

## 1. Problem

The workshop dashboard lists 17 runnable recipes, but a first-time user hits five walls:

1. Recipes that take a dataset expose `dataset_name` as a free-text field. If nothing is registered the run fails
   at submit time, and nothing in the form tells the user what exists or how to import one.
2. Recipes are fixed lists of tasks hardcoded in `web/src/server/workflow/builtin-templates.ts`. The workflow
   engine already supports DAGs (`inputs: [{task}]`, cycle check, topo order) but the only way for a user to
   chain "학습 → 평가 → …" is to edit YAML in step 3 of the run wizard.
3. The run detail page offers "TensorBoard 준비" for every task whose output path is under the project FSx
   prefix, regardless of whether the recipe writes TensorBoard events (data import tasks included).
4. DCV is a single admin EC2 workstation unrelated to runs, and every Isaac Lab recipe hardcodes `--headless`.
   There is no way to watch an Isaac Lab training run from the dashboard. MuJoCo recipes already have a
   working MJPEG live view (`live: true` → sidecar on port `pai-live`).
5. Raw identifiers (workflow ids, K8s job/pod names, image URIs, ARNs) sit next to human labels on every page,
   and the run detail page shows an *estimated* USD figure computed from requested resources × list price.
   The user's standing rule is: no number in the UI that is not traceable to an AWS/K8s API record.

## 2. Goals / Non-goals

Goals

- Pick registered datasets (and a READY version) from a list wherever a recipe takes a dataset input.
- Compose multi-recipe pipelines on a graph canvas from the existing recipes, save them as custom templates,
  and run them through the existing submit path. No controller or compiler change.
- Show TensorBoard / MLflow entry points only for tasks whose recipe declares them.
- Isaac Lab training runs publish live frames to the existing MJPEG sidecar; the run page's "실시간 보기"
  works for them exactly as it does for MuJoCo.
- Move identifiers behind a single "기술 정보" disclosure pattern; keep names as the primary label.
- Remove estimated USD from the UI and the code that exists only to produce it. Keep GPU/CPU hours (facts)
  and the admin-only Cost Explorer actuals.

Non-goals

- Per-run DCV desktops, Isaac Sim WebRTC livestream, or any change to the DCV workstation flow.
- Free-form task blocks (image + command). Palette blocks are recipes only.
- A new persistence model for composed pipelines. They are custom templates (existing `POST /api/templates`).
- Multi-language server messages (tracked separately).

## 3. Design

### 3.1 Recipe metadata: ports and views

`RecipeMetadata` (`builtin-templates.ts`) gains two optional fields. Both live under `ui.recipe` in the
template YAML, so the workflow schema (`ui: z.unknown()`) and the compiler are untouched.

```ts
export type PortKind = 'lerobot-dataset' | 'checkpoint' | 'video' | 'sdg-frames' | 'hdf5-demos' | 'artifacts';

export interface RecipePorts {
  inputs: { param: string; kind: PortKind; label: string; versionParam?: string }[];
  outputs: { name: string; kind: PortKind; label: string }[];   // name = published dataset prefix, e.g. 'isaaclab-checkpoints'
}
export interface RecipeMetadata {
  …existing…
  ports?: RecipePorts;
  views?: Record<string, ('tensorboard' | 'mlflow')[]>;         // keyed by task name
}
```

- `PortKind` vocabulary is defined once in `web/src/lib/workflow/ports.ts` (shared client/server) with Korean and
  English labels in the i18n catalog namespace `compose`.
- Every builtin recipe declares its ports. Initial mapping (input param → kind; published prefix → kind):

| recipe | inputs | outputs | views |
|---|---|---|---|
| hf-dataset-import | – | `hf-import` → lerobot-dataset | – |
| gr00t-finetune | `dataset_name` lerobot-dataset (`dataset_version`) | `groot-checkpoints` → checkpoint | finetune: tensorboard, mlflow |
| gr00t-e2e | – (HF id param) | dataset → lerobot-dataset, checkpoints → checkpoint, evaluation → artifacts | finetune: tensorboard, mlflow |
| openpi-train | `dataset_name` lerobot-dataset | `openpi-checkpoints` → checkpoint | train: tensorboard |
| mujoco-train / mujoco-pipeline | – | `mujoco-checkpoints` → checkpoint (+ evaluation → artifacts) | train: tensorboard |
| mujoco-render | `dataset_name` checkpoint | `mujoco-evaluation` → artifacts | – |
| isaaclab-train / isaaclab-h1 | – | `isaaclab-checkpoints` → checkpoint | train: tensorboard, mlflow |
| isaaclab-video | `dataset_name` checkpoint | `isaaclab-video` → video | – |
| leisaac-evaluate | `dataset_name` checkpoint | `leisaac-evaluation` → artifacts | – |
| replicator-sdg | – | `replicator-sdg` → sdg-frames | – |
| cosmos-pipeline | – | `cosmos-videos` → video | – |
| mimic-pipeline | `dataset_name` hdf5-demos | `mimic-demonstrations` → hdf5-demos | – |
| custom, ros2-transfer, torch-gloo-2rank | – | `…` → artifacts | – |

- `builtin-templates.test.ts` gains integrity checks: every `ports.inputs[].param` exists in `params` and is
  referenced by a `{{ dataset: {name} }}` input of some task; every `ports.outputs[].name` matches a published
  output prefix; every `views` key is a task name in the recipe.
- `GET /api/templates` returns each template with a parsed `recipe: RecipeMetadata | null` field
  (pure accessor `getRecipeMetadata`, wrapped in try/catch for custom templates without metadata). The
  `Template` store type is unchanged; the DTO is `Template & { recipe?: RecipeMetadata | null }`.

### 3.2 Dataset parameter type

- `TemplateParam.type` gains `'dataset'`. `TemplateParam` gains `versionParam?: string`. The `POST /api/templates`
  zod enum mirrors it.
- Builtin recipes that take a dataset switch to `dataset()` producing `type: 'dataset'`, plus a companion numeric
  param `dataset_version` (default `1`) and `version: {{ dataset_version }}` in the task input. `recipe()` renders
  the YAML via `YAML.stringify`, so the placeholder is quoted; `parseWorkflowYaml` substitution must therefore
  coerce `version` to a number when the substituted value is all digits (one-line change in `template.ts`
  substitute, covered by a test). Legacy recipes without `dataset_version` keep `version: 1`.
- Run wizard step 2: a `DatasetPicker` component renders for `type: 'dataset'`. It loads `/api/datasets`
  (project scoped via the existing header/cookie), shows name + `v{latestVersion}` + updated time, and on
  selection loads `/api/datasets/<name>` to list READY versions in a second select bound to `versionParam`.
  Empty list → message "등록된 데이터셋이 없습니다" and a button to `/workflows/new?template=hf-dataset-import`.
  Optional filter: if the recipe declares a port kind for the param, datasets produced by a recipe whose output
  port has the same kind are listed first; others remain selectable (facts over guesses: we do not hide them).
- The Models page / Datasets page deep links that pre-fill `dataset_name` continue to work: the picker
  initialises from the current `default-values`.

### 3.3 Pipeline composer

New route `web/src/app/workflows/compose/page.tsx` → `ComposePage`. Entry: a "직접 조립" card at the top of the
run wizard step 1 and a header action on the Workflows page.

Layout (three columns, React Flow in the middle, same library DagView uses):

- **Palette (left)**: recipes from `/api/templates` grouped by category, plus a "데이터셋" source block.
  Click adds a node at the next free position; drag also works. Recipes without any ports still appear
  (they can be run standalone inside a pipeline).
- **Canvas**: nodes render title, category pill, input handles on the left (one per `ports.inputs`) and output
  handles on the right (one per `ports.outputs`), colored by `PortKind`. `isValidConnection` accepts an edge
  only when kinds match and the target input is not already connected. Rejected drags show the reason in a
  toast. A dataset source node has one output handle whose kind is inferred from the producing recipe when the
  dataset has lineage, else `artifacts` (connectable to any input; the user is told the kind is unverified).
- **Inspector (right)**: the selected node's params rendered with the same param renderer as wizard step 2
  (extracted into `TemplateParamField`). Params bound by an edge are shown read-only as "← <node title> 출력".
  Node title is editable (used as the task-name prefix after slugging).
- **Footer**: live validation status, "레시피로 저장" (opens name/description dialog → `POST /api/templates`
  with category `custom`), "실행" (navigates to `/workflows/new?draft=<id>` where the wizard loads the composed
  template from session storage and starts at step 2).

Composition is a pure function in `web/src/lib/workflow/compose.ts`:

```ts
export interface ComposeGraph {
  nodes: { id: string; templateId: string; title: string; params: Record<string, string> }[];
  datasets: { id: string; name: string; version: number }[];
  edges: { from: { node: string; port: string } | { dataset: string }; to: { node: string; param: string } }[];
}
export function composeWorkflow(graph: ComposeGraph, templates: TemplateDto[]): { yaml: string; params: TemplateParam[]; recipe: RecipeMetadata; errors: ComposeError[] }
```

Rules:

- Each node's template YAML is parsed; task names, group names, `{{host:x}}` references and `inputs[].task`
  are prefixed `<slug>-`; params and `{{ param }}` placeholders are prefixed `<slug>_`; labels become
  "<node title> › <param label>". `default-values` merge accordingly.
- An edge to `(node, param)` replaces that task input `{ dataset: { name: '{{ param }}', version: … } }` with
  `{ task: '<upstreamSlug>-<producingTask>' }` where the producing task is the one whose outputs include the
  port's dataset prefix. The bound param and its `versionParam` are dropped from `params`.
- A dataset edge sets `default-values` for the param (and version) and marks the param `locked` in the UI.
- Unbound `type: 'dataset'` params stay as params (the wizard's picker handles them).
- `resources` maps are merged by name; identical definitions dedupe, conflicting ones are prefixed and task
  `resource` references rewritten.
- `workflow.mlflow` = any node mlflow. `timeout` = max per field. `views` and `ports` are prefixed and merged.
  Composite `ports.inputs` = unbound dataset inputs; `ports.outputs` = every published output.
- Errors (block save/run): cycle, kind mismatch, target input bound twice, node with no template, duplicate
  slug, a group task chained by `inputs` (schema forbids task deps inside a group → surface as a clear message).
- The result must pass `parseWorkflowYaml(materializeBuiltinTemplate(...))`; the composer also calls
  `POST /api/workflows/validate` for server confirmation before enabling actions.

### 3.4 Views gating on the run detail page

`TaskConnections.tsx` receives `views: string[]` for the task (from the workflow's stored spec `ui.recipe.views`,
parsed server-side in `GET /api/workflows/:id` and exposed per task as `task.views`). Rules:

- TensorBoard block renders only if `views` includes `tensorboard` and the existing role/session/output-path
  checks pass.
- MLflow link renders only if `views` includes `mlflow` and the workflow has `mlflow: true`.
- Live view keeps its current fact-based gate (pod exposes port `pai-live`).
- Workflows whose spec has no `ui.recipe.views` (custom YAML, pre-change runs) keep today's behaviour.

### 3.5 Isaac Lab live view

- Move `LiveFrames` from `recipes/mujoco/common.py` to `recipes/pai_live.py` (stdlib + imageio only);
  `mujoco/common.py` re-exports it. `recipes/FILES.txt`/provenance updated if they enumerate files.
- `recipes/isaaclab/train.py`:
  - Adds `--live-view` (store_true). When set **and** `PAI_LIVE_DIR` is present, the env is created with
    `render_mode="rgb_array"` and the RSL-RL wrapper is wrapped by `LiveStepPublisher`, which after each `step()`
    calls `LiveFrames.due()` and only then `env.unwrapped.render()` + `publish`. Rendering is thus bounded to
    ≤10 fps regardless of simulation rate.
  - When `--live-view` is set the wrapper also forces `args.enable_cameras = True` before `AppLauncher(args)`
    (Isaac Lab requires offscreen render for `rgb_array` in headless mode). Without the flag behaviour is
    byte-for-byte today's.
  - `test_image_contract.py` asserts `--live-view` appears in `--help`.
- The wrapper flag takes a value, `--live-view {on,off}` (default `off`), because template args are fixed argv
  words with `{{ }}` substitution and an empty word is not a valid argparse flag. Builtin `isaacTrain()` gets
  `live: true`, passes `'--live-view', '{{ live_view }}'`, and declares `live_view` as a `select` param
  (`on`/`off`, default `on`, label "실시간 보기 프레임 게시"). `--live-view on` without `PAI_LIVE_DIR` (sidecar
  image not configured) is a no-op, matching MuJoCo.
- The sidecar image stays `ctx.liveImage` (MuJoCo image). No compiler change.
- Docs: `dashboard/docs/dashboard-features-and-aws-architecture.md` §9 gets a paragraph: DCV = admin
  workstation; per-run viewing = live view (MuJoCo, Isaac Lab training).

### 3.6 Identifier presentation

- New `TechnicalDetails` component in `ui/index.tsx`: a `Disclosure` titled "기술 정보" with rows
  `{ label, value, copy?: boolean, href?: string }` in 12px mono values. Uses existing `CopyButton`.
- Changes:
  - WorkflowsPage: remove the id line under the name; name links to detail. ResourceStrip stays.
  - WorkflowDetailPage header: show template title (from `templateId` → templates map) instead of the raw id;
    `shortId` + copy moves into `TechnicalDetails` together with owner, namespace, queue, templateId.
  - TaskTable: drop `jobName` and image columns; `TaskDetailPanel`: jobName, image URI, logs path, output path go
    into `TechnicalDetails`.
  - LogViewer target selector: label pods as "복제본 N" (task name + replica index) with the pod name in `title`.
  - JobsPage, SessionsPage, PipelinesPage, PipelineExecutionPage: ARNs, job/pod names, session ids →
    `TechnicalDetails`; primary columns are names/status/time.
- Guard: a unit test scanning rendered list rows (existing browser test fixtures) asserts no `arn:` string and
  no 32-hex id appears outside a `TechnicalDetails` region on WorkflowsPage and JobsPage.

### 3.7 Estimated cost removal

- `usage.ts` `estimateRunUsage`/`projectUsage` drop `estimatedUsd`, `dedicatedInstanceUsd`, `rate`, and the
  `no_rates`/`stale_rates`/`unpriced_platform` issue codes. Remaining DTO: `cpuHours`, `gpuHours`, per-task
  timing, `known*`, `issues` (`missing_ledger`, `incomplete_timing`, `unknown_resources`).
- Delete `hyperpod-rates.ts` (+ test/fixture), `app/api/usage/rates/route.ts`, the `USAGE_PRICING#` store
  accessors, the admin "단가 갱신" button, and the Price List IAM statement in `infra/lib` and
  `terraform/`. Remove `PricingBasis` from `UsageSummary.tsx`. Update `UsageScaling.browser.test.ts`.
- i18n keys for removed strings are deleted (ko/en mirror test enforces).
- Cost Explorer actuals (admin Overview + Admin → Cost) are unchanged.

## 4. Data flow summary

```
templates (TS) ──seed──▶ DynamoDB ──GET /api/templates (+recipe)──▶ Palette / Wizard
Composer graph ──composeWorkflow()──▶ {yaml, params, recipe} ──POST /api/templates──▶ custom template
                                                         └──▶ wizard step 2 ──POST /api/workflows──▶ controller (unchanged)
Run detail ◀── GET /api/workflows/:id (task.views from spec ui.recipe.views) ── TaskConnections gating
Isaac pod: train.py --live-view on ──frame.jpg──▶ pai-live sidecar ──port-forward session──▶ "실시간 보기"
```

## 5. Testing

- vitest (node): `compose.test.ts` (prefixing, edge rewrite, dataset binding, merges, every error class,
  round-trip through `parseWorkflowYaml`), `ports.test.ts`, `builtin-templates.test.ts` integrity additions,
  `template.test.ts` numeric version coercion, `usage.test.ts` updated, `TaskConnections.test.ts` views gating.
- Browser (esbuild + Chromium): `ComposePage.browser.test.ts` (add two nodes, connect, reject mismatch,
  inspector lock, save payload), `DatasetPicker.browser.test.ts`, updated `NewWorkflowPage.browser.test.ts`,
  identifier guard on WorkflowsPage/JobsPage.
- Python: `recipes/isaaclab/test_image_contract.py` (`--live-view`), a unit test for `LiveStepPublisher`
  with a fake env, `recipes/mujoco` tests still pass after the `LiveFrames` move.
- Live (GPU allowed by the user): deploy, submit `isaaclab-train` with `live_view=on` and small
  `num_envs`/`iterations`, confirm "실시간 보기" streams frames; compose `hf-dataset-import → gr00t-finetune`,
  save, run, confirm the DAG runs and TensorBoard appears only on `finetune`. Scale the GPU group back to 0.

## 6. Rollout notes

- Recipe Python changes rebuild all workload images → image-profile re-approval per the runbook in memory.
- Deploy only when no workflow is RUNNING/FINALIZING (controller rollout kills runtime-wrapped tasks).
- `docs/superpowers` is gitignored in this repo; plans go to `docs/plans/`.
