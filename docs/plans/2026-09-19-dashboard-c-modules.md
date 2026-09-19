# Dashboard C — 스택 모듈화와 공통 태그 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 대시보드 CDK 스택을 context 토글로 모듈 선택이 가능하게 분해하고(gateway, images, sourceBuild, edge, waf, alarms), 모든 관련 스택에 공통 태그 `PhysicalAI=true`를 붙인다. 기본값은 현재 배포와 CloudFormation 논리 ID·리소스가 동일해야 한다.

**Architecture:** `infra/lib/modules.ts`가 context를 검증해 `DashboardModules`를 만든다. `constructs/service.ts`(한 construct 안에 ALB·3서비스·WAF가 모두 있음)를 같은 construct 경로(`Web/...`)를 유지하는 함수 모듈들로 나눠 논리 ID를 보존하면서 gateway·WAF를 조건부로 만든다. `WorkloadImages`는 빌드 목록과 URI override를 받는다. 앱은 `RESOURCE_TAG_KEY/VALUE` env를 읽고 `edge` 기본값 폴백을 제거한다.

**Tech Stack:** AWS CDK v2 (TypeScript), node:test + aws-cdk-lib/assertions, vitest(web config).

**Spec:** `docs/designs/2026-09-19-dashboard-modular-http-logs-design.md` §6

## Global Constraints

- 기본 모듈(모두 켬, https)로 synth한 템플릿의 **리소스 논리 ID 집합은 이 플랜 시작 시점과 동일**해야 한다(Task 1이 스냅샷 fixture를 만든다). 로컬 ID를 바꾸면 ALB·서비스·IAM 역할·인증서가 교체되므로 금지.
- context 키: `domainName`, `hostedZoneId`, `hostedZoneName`(셋 모두 또는 셋 다 없음), `gateway`(기본 true), `images`(기본 `mujoco,isaaclab,ros2,workspace`; `extendedImages=true`는 `groot,openpi` 추가), `imageOverrides`(JSON), `sourceBuild`(기본 true), `edge`(기본 true), `waf`(기본 true), `alarms`(기본 true), `resourceTagKey`(기본 `PhysicalAI`), `resourceTagValue`(기본 `true`). 기존 `optionalImages`, `eksBackends`, `workflowNamespaces`, `notifyEmail`, `vpcId`, `sourceBuildDirectory`, `controllerSplitMigration`는 그대로.
- 도메인이 없는 `ingress.mode='http'`는 이 플랜에서는 **검증만** 하고, 스택 조립 시 `Error('HTTP ingress needs AUTH_MODE=cognito (sub-project E)')`로 거부한다.
- infra 명령: `cd dashboard/infra && npx tsc --noEmit -p . && node --require ts-node/register --test test/*.test.ts`. `cdk.out.deploy/` 잔재로 tsc가 실패하면 `mv cdk.out.deploy /tmp/` 후 재시도(gitignored).
- web 명령: `cd dashboard/web && npm run typecheck && npm test -- src/server/config.test.ts`.
- 커밋 형식 `feat|refactor|test|docs(dashboard): …`, 트레일러 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

### Task 1: 논리 ID 스냅샷과 테스트 헬퍼

**Files:**
- Create: `dashboard/infra/test/helpers/synth.ts`
- Create: `dashboard/infra/test/helpers/dump-logical-ids.ts`
- Create: `dashboard/infra/test/fixtures/default-logical-ids.json` (생성물)
- Create: `dashboard/infra/test/logical-ids.test.ts`

**Interfaces:**
- Produces: `synthesize(overrides?: Partial<DashboardStackProps> & { context?: Record<string, unknown> }): Template` — `edge-hardening.test.ts`의 fixture 값(account `913524902871`, region `us-east-1`, vpc/subnet ids, `dashboard.example.com`, zone `Z0123456789ABCDEF`/`example.com`)을 기본으로 쓴다.

- [ ] **Step 1: 헬퍼 작성** — `test/helpers/synth.ts`

```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { DashboardStack, type DashboardStackProps } from '../../lib/dashboard-stack';

export const ACCOUNT = '913524902871', REGION = 'us-east-1';
export function synthesize(overrides: Partial<DashboardStackProps> & { context?: Record<string, unknown> } = {}): Template {
  const outputRoot = path.resolve(__dirname, '../../cdk.out');
  fs.mkdirSync(outputRoot, { recursive: true });
  const outdir = fs.mkdtempSync(path.join(outputRoot, 'module-test-'));
  try {
    const { context, ...props } = overrides;
    const app = new cdk.App({ outdir, context: { 'aws:cdk:asset-staging': false, ...(context ?? {}) } });
    const stack = new DashboardStack(app, 'ModuleTest', {
      env: { account: ACCOUNT, region: REGION }, accountId: ACCOUNT, region: REGION,
      discovered: { accountId: ACCOUNT, region: REGION },
      network: { vpcId: 'vpc-0123456789abcdef0', azs: ['us-east-1a', 'us-east-1b'],
        publicSubnetIds: ['subnet-00000000000000001', 'subnet-00000000000000002'],
        privateSubnetIds: ['subnet-00000000000000003', 'subnet-00000000000000004'], vpcCidr: '10.0.0.0/16' },
      domainName: 'dashboard.example.com', hostedZoneId: 'Z0123456789ABCDEF', hostedZoneName: 'example.com',
      adminUsername: 'admin', adminEmail: 'admin@example.com',
      webAppPath: path.resolve(__dirname, '../../../web'), buckets: [],
      ...props,
    });
    return Template.fromStack(stack);
  } finally { fs.rmSync(outdir, { recursive: true, force: true }); }
}
export const logicalIds = (t: Template) => Object.keys(t.toJSON().Resources ?? {}).sort();
```

- [ ] **Step 2: 스냅샷 덤프 스크립트** — `test/helpers/dump-logical-ids.ts`

```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { logicalIds, synthesize } from './synth';
const out = path.resolve(__dirname, '../fixtures/default-logical-ids.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(logicalIds(synthesize()), null, 2) + '\n');
console.log(`wrote ${out}`);
```

Run: `cd dashboard/infra && node --require ts-node/register test/helpers/dump-logical-ids.ts && wc -l test/fixtures/default-logical-ids.json`
Expected: 파일 생성, 수십 개 ID (예: `WebAlb…`, `WebService…`, `WebGateway…`, `WebWebAcl…`, `StoreTable…`, `OrchestrationArtifacts…`). **이 스냅샷은 리팩터 전(현재 코드) 상태를 기록한다. 이후 Task에서 재생성하지 않는다.**

- [ ] **Step 3: 스냅샷 테스트** — `test/logical-ids.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { logicalIds, synthesize } from './helpers/synth';

test('default modules keep every CloudFormation logical id of the deployed stack', () => {
  const expected = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'fixtures/default-logical-ids.json'), 'utf8')) as string[];
  const actual = logicalIds(synthesize());
  assert.deepEqual(actual.filter(id => !expected.includes(id)), [], 'unexpected new logical ids');
  assert.deepEqual(expected.filter(id => !actual.includes(id)), [], 'missing logical ids (resource would be replaced or deleted)');
});
```

Run: `cd dashboard/infra && node --require ts-node/register --test test/logical-ids.test.ts`
Expected: PASS (스냅샷 직후이므로 동일).

- [ ] **Step 4: 커밋**

```bash
git add dashboard/infra/test/helpers dashboard/infra/test/fixtures dashboard/infra/test/logical-ids.test.ts
git commit -m "test(dashboard): snapshot the deployed stack's logical ids before modularisation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `modules.ts` — context 계약

**Files:**
- Create: `dashboard/infra/lib/modules.ts`
- Test: `dashboard/infra/test/modules.test.ts`

**Interfaces:**
- Produces:
```ts
export const WORKLOAD_IMAGES = ['mujoco', 'isaaclab', 'ros2', 'workspace', 'groot', 'openpi'] as const;
export type WorkloadImageName = typeof WORKLOAD_IMAGES[number];
export const IMAGE_ENV: Record<WorkloadImageName, string> = { mujoco: 'MUJOCO_IMAGE_URI', isaaclab: 'ISAACLAB_IMAGE_URI', ros2: 'ROS2_IMAGE_URI', workspace: 'WORKSPACE_IMAGE_URI', groot: 'GROOT_RUNTIME_IMAGE_URI', openpi: 'OPENPI_IMAGE_URI' };
export interface DashboardModules {
  ingress: { mode: 'https'; domainName: string; hostedZoneId: string; hostedZoneName: string } | { mode: 'http' };
  gateway: boolean; sourceBuild: boolean; edge: boolean; waf: boolean; alarms: boolean;
  images: { build: WorkloadImageName[]; overrides: Partial<Record<WorkloadImageName, string>> };
  resourceTag: { key: string; value: string };
}
export type ContextReader = (key: string) => unknown;
export function resolveModules(ctx: ContextReader): DashboardModules;
export function describeModules(m: DashboardModules): string;
export const DEFAULT_MODULES: DashboardModules = resolveModules(() => undefined);
```

- [ ] **Step 1: 실패하는 테스트** — `test/modules.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveModules, describeModules } from '../lib/modules';
const ctx = (values: Record<string, unknown>) => (key: string) => values[key];
const domain = { domainName: 'd.example.com', hostedZoneId: 'Z1', hostedZoneName: 'example.com' };

test('defaults reproduce the current deployment: https, every module on, four base images', () => {
  const m = resolveModules(ctx(domain));
  assert.equal(m.ingress.mode, 'https');
  assert.deepEqual([m.gateway, m.sourceBuild, m.edge, m.waf, m.alarms], [true, true, true, true, true]);
  assert.deepEqual(m.images.build, ['mujoco', 'isaaclab', 'ros2', 'workspace']);
  assert.deepEqual(m.images.overrides, {});
  assert.deepEqual(m.resourceTag, { key: 'PhysicalAI', value: 'true' });
});
test('extendedImages adds groot and openpi; images= narrows the list; unknown names fail', () => {
  assert.deepEqual(resolveModules(ctx({ ...domain, extendedImages: 'true' })).images.build, ['mujoco', 'isaaclab', 'ros2', 'workspace', 'groot', 'openpi']);
  assert.deepEqual(resolveModules(ctx({ ...domain, images: 'mujoco, ros2' })).images.build, ['mujoco', 'ros2']);
  assert.throws(() => resolveModules(ctx({ ...domain, images: 'mujoco,nope' })), /Unknown workload image "nope"/);
});
test('imageOverrides must be ECR URIs pinned by digest or tag and remove the image from the build list', () => {
  const uri = '913524902871.dkr.ecr.us-east-1.amazonaws.com/pai/mujoco@sha256:' + 'a'.repeat(64);
  const m = resolveModules(ctx({ ...domain, imageOverrides: JSON.stringify({ mujoco: uri }) }));
  assert.equal(m.images.overrides.mujoco, uri);
  assert.deepEqual(m.images.build, ['isaaclab', 'ros2', 'workspace']);
  assert.throws(() => resolveModules(ctx({ ...domain, imageOverrides: '{"mujoco":"docker.io/library/python:3"}' })), /imageOverrides\.mujoco must be an ECR image URI/);
  assert.throws(() => resolveModules(ctx({ ...domain, imageOverrides: 'not json' })), /imageOverrides must be a JSON object/);
});
test('boolean toggles accept true/false strings only', () => {
  const m = resolveModules(ctx({ ...domain, gateway: 'false', waf: false, alarms: 'false', edge: 'false', sourceBuild: 'false' }));
  assert.deepEqual([m.gateway, m.sourceBuild, m.edge, m.waf, m.alarms], [false, false, false, false, false]);
  assert.throws(() => resolveModules(ctx({ ...domain, gateway: 'yes' })), /gateway must be true or false/);
});
test('domain keys are all-or-nothing; none means http ingress', () => {
  assert.equal(resolveModules(ctx({})).ingress.mode, 'http');
  assert.throws(() => resolveModules(ctx({ domainName: 'd.example.com' })), /domainName, hostedZoneId and hostedZoneName must be given together/);
});
test('resource tag key and value are overridable and validated', () => {
  assert.deepEqual(resolveModules(ctx({ ...domain, resourceTagKey: 'Team', resourceTagValue: 'robotics' })).resourceTag, { key: 'Team', value: 'robotics' });
  assert.throws(() => resolveModules(ctx({ ...domain, resourceTagKey: 'aws:reserved' })), /resourceTagKey/);
});
test('describeModules lists every decision on one line each', () => {
  const text = describeModules(resolveModules(ctx({ ...domain, gateway: 'false' })));
  assert.match(text, /ingress: https d\.example\.com/);
  assert.match(text, /gateway: off/);
  assert.match(text, /images: mujoco, isaaclab, ros2, workspace/);
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd dashboard/infra && node --require ts-node/register --test test/modules.test.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현** — `lib/modules.ts`

```ts
export const WORKLOAD_IMAGES = ['mujoco', 'isaaclab', 'ros2', 'workspace', 'groot', 'openpi'] as const;
export type WorkloadImageName = typeof WORKLOAD_IMAGES[number];
export const IMAGE_ENV: Record<WorkloadImageName, string> = {
  mujoco: 'MUJOCO_IMAGE_URI', isaaclab: 'ISAACLAB_IMAGE_URI', ros2: 'ROS2_IMAGE_URI',
  workspace: 'WORKSPACE_IMAGE_URI', groot: 'GROOT_RUNTIME_IMAGE_URI', openpi: 'OPENPI_IMAGE_URI',
};
const BASE_IMAGES: WorkloadImageName[] = ['mujoco', 'isaaclab', 'ros2', 'workspace'];
const EXTENDED_IMAGES: WorkloadImageName[] = ['groot', 'openpi'];
const ECR_URI = /^\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9._/-]+(@sha256:[a-f0-9]{64}|:[A-Za-z0-9._-]{1,128})$/;

export interface DashboardModules {
  ingress: { mode: 'https'; domainName: string; hostedZoneId: string; hostedZoneName: string } | { mode: 'http' };
  gateway: boolean; sourceBuild: boolean; edge: boolean; waf: boolean; alarms: boolean;
  images: { build: WorkloadImageName[]; overrides: Partial<Record<WorkloadImageName, string>> };
  resourceTag: { key: string; value: string };
}
export type ContextReader = (key: string) => unknown;

function flag(ctx: ContextReader, key: string, fallback: boolean): boolean {
  const v = ctx(key);
  if (v === undefined || v === '') return fallback;
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  throw new Error(`${key} must be true or false`);
}
function text(ctx: ContextReader, key: string): string | undefined {
  const v = ctx(key);
  if (v === undefined || v === '') return undefined;
  if (typeof v !== 'string') throw new Error(`${key} must be a string`);
  return v;
}
export function resolveModules(ctx: ContextReader): DashboardModules {
  const domainName = text(ctx, 'domainName'), hostedZoneId = text(ctx, 'hostedZoneId'), hostedZoneName = text(ctx, 'hostedZoneName');
  const given = [domainName, hostedZoneId, hostedZoneName].filter(Boolean).length;
  if (given !== 0 && given !== 3) throw new Error('domainName, hostedZoneId and hostedZoneName must be given together (or all omitted for HTTP ingress)');
  const ingress: DashboardModules['ingress'] = given === 3 ? { mode: 'https', domainName: domainName!, hostedZoneId: hostedZoneId!, hostedZoneName: hostedZoneName! } : { mode: 'http' };

  const listed = text(ctx, 'images');
  let build: WorkloadImageName[] = listed
    ? listed.split(',').map(s => s.trim()).filter(Boolean).map(name => {
        if (!(WORKLOAD_IMAGES as readonly string[]).includes(name)) throw new Error(`Unknown workload image "${name}"; known: ${WORKLOAD_IMAGES.join(', ')}`);
        return name as WorkloadImageName;
      })
    : [...BASE_IMAGES, ...(flag(ctx, 'extendedImages', false) ? EXTENDED_IMAGES : [])];
  const overridesRaw = ctx('imageOverrides');
  let overrides: Partial<Record<WorkloadImageName, string>> = {};
  if (overridesRaw !== undefined && overridesRaw !== '') {
    let parsed: unknown = overridesRaw;
    if (typeof overridesRaw === 'string') { try { parsed = JSON.parse(overridesRaw); } catch { throw new Error('imageOverrides must be a JSON object'); } }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('imageOverrides must be a JSON object');
    for (const [name, uri] of Object.entries(parsed as Record<string, unknown>)) {
      if (!(WORKLOAD_IMAGES as readonly string[]).includes(name)) throw new Error(`Unknown workload image "${name}" in imageOverrides`);
      if (typeof uri !== 'string' || !ECR_URI.test(uri)) throw new Error(`imageOverrides.${name} must be an ECR image URI pinned by digest or tag`);
      overrides[name as WorkloadImageName] = uri;
    }
    build = build.filter(name => !(name in overrides));
  }
  const key = text(ctx, 'resourceTagKey') ?? 'PhysicalAI', value = text(ctx, 'resourceTagValue') ?? 'true';
  if (!/^(?!aws:)[A-Za-z0-9 _.:/=+\-@]{1,128}$/.test(key)) throw new Error('resourceTagKey must be a valid tag key not starting with aws:');
  if (!/^[A-Za-z0-9 _.:/=+\-@]{0,256}$/.test(value)) throw new Error('resourceTagValue must be a valid tag value');
  return {
    ingress, gateway: flag(ctx, 'gateway', true), sourceBuild: flag(ctx, 'sourceBuild', true), edge: flag(ctx, 'edge', true),
    waf: flag(ctx, 'waf', true), alarms: flag(ctx, 'alarms', true), images: { build, overrides }, resourceTag: { key, value },
  };
}
export function describeModules(m: DashboardModules): string {
  const onOff = (b: boolean) => (b ? 'on' : 'off');
  return [
    `ingress: ${m.ingress.mode}${m.ingress.mode === 'https' ? ` ${m.ingress.domainName}` : ' (ALB DNS name, no TLS)'}`,
    `gateway: ${onOff(m.gateway)}`, `sourceBuild: ${onOff(m.sourceBuild)}`, `edge: ${onOff(m.edge)}`, `waf: ${onOff(m.waf)}`, `alarms: ${onOff(m.alarms)}`,
    `images: ${m.images.build.join(', ') || '(none)'}${Object.keys(m.images.overrides).length ? ` + overrides ${Object.keys(m.images.overrides).join(', ')}` : ''}`,
    `resourceTag: ${m.resourceTag.key}=${m.resourceTag.value}`,
  ].join('\n');
}
export const DEFAULT_MODULES: DashboardModules = resolveModules(() => undefined);
```
주의: `DEFAULT_MODULES`는 도메인이 없으므로 `ingress.mode==='http'`다. 스택 기본값으로 쓸 때는 Task 4에서 `domainName` props로 https를 만든다(아래 참조).

- [ ] **Step 4: 통과 확인, 커밋**

Run: `cd dashboard/infra && npx tsc --noEmit -p . && node --require ts-node/register --test test/modules.test.ts`
Expected: PASS (7).
```bash
git add dashboard/infra/lib/modules.ts dashboard/infra/test/modules.test.ts
git commit -m "feat(dashboard): module contract for stack toggles, image list/overrides and resource tag

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `WorkloadImages` — 빌드 목록과 override

**Files:**
- Modify: `dashboard/infra/lib/constructs/workload-images.ts`
- Test: `dashboard/infra/test/workload-images.test.ts`

**Interfaces:**
- Consumes: `WorkloadImageName`, `IMAGE_ENV` (Task 2).
- Produces: `new WorkloadImages(scope, 'WorkloadImages', { repositoryRoot, build: WorkloadImageName[], overrides, optionalImages? })`; `environment: Record<string,string>` (env 이름은 `IMAGE_ENV`).
- Construct 자식 ID는 지금처럼 `mujoco|isaaclab|ros2|groot|openpi|workspace` (논리 ID 보존). `workspace`도 목록 항목이 된다(기본 포함).

- [ ] **Step 1: 실패하는 테스트**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { WorkloadImages } from '../lib/constructs/workload-images';
const root = path.resolve(__dirname, '../../..');
function build(props: ConstructorParameters<typeof WorkloadImages>[2]) {
  const app = new cdk.App({ context: { 'aws:cdk:asset-staging': false } });
  const stack = new cdk.Stack(app, 'T', { env: { account: '913524902871', region: 'us-east-1' } });
  const images = new WorkloadImages(stack, 'WorkloadImages', props);
  return { images, template: Template.fromStack(stack) };
}
test('builds only the listed images and names env by IMAGE_ENV', () => {
  const { images, template } = build({ repositoryRoot: root, build: ['mujoco', 'workspace'], overrides: {} });
  assert.deepEqual(Object.keys(images.environment).sort(), ['MUJOCO_IMAGE_URI', 'WORKSPACE_IMAGE_URI']);
  const outputs = Object.keys(template.toJSON().Outputs ?? {});
  assert.ok(outputs.some(o => o.startsWith('WorkloadImagesmujocoImage')));
  assert.ok(!outputs.some(o => o.startsWith('WorkloadImagesisaaclabImage')));
});
test('overrides become env values verbatim without an asset', () => {
  const uri = '913524902871.dkr.ecr.us-east-1.amazonaws.com/pai/ros2@sha256:' + 'b'.repeat(64);
  const { images } = build({ repositoryRoot: root, build: ['mujoco'], overrides: { ros2: uri } });
  assert.equal(images.environment.ROS2_IMAGE_URI, uri);
  assert.ok(images.environment.MUJOCO_IMAGE_URI && !images.environment.MUJOCO_IMAGE_URI.includes('@sha256'));
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd dashboard/infra && node --require ts-node/register --test test/workload-images.test.ts`
Expected: FAIL — props 형태 불일치(`extended` 기대).

- [ ] **Step 3: 구현** — `WorkloadImages` 생성자 교체

```ts
import { IMAGE_ENV, type WorkloadImageName } from '../modules';
export interface WorkloadImagesProps { repositoryRoot: string; build: WorkloadImageName[]; overrides: Partial<Record<WorkloadImageName, string>>; optionalImages?: OptionalWorkloadImages }
export class WorkloadImages extends Construct {
  readonly environment: Record<string, string> = {};
  constructor(scope: Construct, id: string, props: WorkloadImagesProps) {
    super(scope, id);
    const optional = optionalImageDefinitions(props.optionalImages, cdk.Stack.of(this).account, cdk.Stack.of(this).region);
    const modelImages = props.build.filter(name => name !== 'workspace');
    const context = modelImages.length ? workloadContext(props.repositoryRoot) : undefined;
    for (const name of modelImages) {
      const image = new assets.DockerImageAsset(this, name, { directory: context!, file: `dashboard/images/${name}/Dockerfile`, platform: assets.Platform.LINUX_AMD64 });
      this.environment[IMAGE_ENV[name]] = image.imageUri;
      new cdk.CfnOutput(this, `${name}Image`, { value: image.imageUri });
    }
    // keep the existing `for (const definition of optional) { … }` block from the current file verbatim here
    if (props.build.includes('workspace')) {
      const workspace = new assets.DockerImageAsset(this, 'workspace', { directory: path.join(props.repositoryRoot, 'dashboard/session-image'), platform: assets.Platform.LINUX_AMD64 });
      this.environment.WORKSPACE_IMAGE_URI = workspace.imageUri;
    }
    for (const [name, uri] of Object.entries(props.overrides) as [WorkloadImageName, string][]) {
      this.environment[IMAGE_ENV[name]] = uri;
      new cdk.CfnOutput(this, `${name}Image`, { value: uri });
    }
  }
}
```
`dashboard-stack.ts`의 호출부는 Task 4에서 바꾼다. 이 Task에서는 컴파일을 위해 임시로 `build: [...]`/`overrides: {}`를 넘기는 최소 수정을 함께 한다:
`new WorkloadImages(this, 'WorkloadImages', { repositoryRoot: …, build: ['mujoco','isaaclab','ros2','workspace', ...(props.extendedImages ? ['groot','openpi'] as const : [])], overrides: {}, optionalImages: … })`.

- [ ] **Step 4: 통과 확인(논리 ID 포함), 커밋**

Run: `cd dashboard/infra && npx tsc --noEmit -p . && node --require ts-node/register --test test/workload-images.test.ts test/logical-ids.test.ts test/optional-workload-images.test.ts`
Expected: PASS. 논리 ID 테스트가 실패하면 자식 ID나 출력 이름이 바뀐 것이다.
```bash
git add dashboard/infra/lib/constructs/workload-images.ts dashboard/infra/lib/dashboard-stack.ts dashboard/infra/test/workload-images.test.ts
git commit -m "feat(dashboard): workload images take an explicit build list and ECR overrides

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `service.ts` 분해 — 같은 construct 경로에서 ingress·web·controller·gateway 함수 모듈

**Files:**
- Create: `dashboard/infra/lib/constructs/ingress.ts`, `web-service.ts`, `controller-service.ts`, `gateway-service.ts`
- Rewrite: `dashboard/infra/lib/constructs/service.ts` (조립만)
- Modify: `dashboard/infra/lib/constructs/alarms.ts` (`webAclName?: string`)
- Test: `dashboard/infra/test/stack-modules.test.ts` (Task 5에서 확장), `test/logical-ids.test.ts` (기존)

**Interfaces:**
- 모든 리소스는 **기존 `ServiceConstruct`(id `Web`) 인스턴스를 scope로**, 기존 자식 ID(`Certificate`, `AlbSg`, `Alb`, `AliasRecord`, `AppSessionsRecord`, `Cluster`, `Logs`, `TaskRole`, `Image`, `TaskDef`, `ServiceSg`, `Service`, `ControllerRole`, `ControllerTask`, `Controller`, `GatewayRole`, `GatewayTask`, `Gateway`, `Tg`, `Https`(listener), `Health`/`Logout`/`ApiTokens`/`SessionHosts` 액션, `Http`(listener), `AccessLogs`, `WebAcl`, `WebAclAssociation`)를 그대로 쓴다. 리스너 자식 ID는 `loadBalancer.addListener('Https')`가 만드는 경로라서 동일 호출을 유지한다.
- Produces:
```ts
// ingress.ts
export interface IngressProps { vpc; namePrefix; mode: DashboardModules['ingress']; hostedZone?: route53.IHostedZone; auth?: { userPool; userPoolClient; userPoolDomain }; waf: boolean; gateway: boolean }
export interface Ingress { loadBalancer; albSg; certificate?: acm.Certificate; webAcl?: wafv2.CfnWebACL; accessLogs: s3.Bucket; listener: elbv2.ApplicationListener; attachWeb(service: ecs.FargateService): elbv2.ApplicationTargetGroup; attachGateway(service: ecs.FargateService): void }
export function createIngress(scope: Construct, props: IngressProps): Ingress
// web-service.ts
export interface Platform { cluster: ecs.Cluster; logGroup: logs.LogGroup; image: ecs.ContainerImage; serviceSecurityGroup: ec2.SecurityGroup }
export function createPlatform(scope: Construct, props: { vpc; namePrefix; webAppPath; albSg: ec2.ISecurityGroup }): Platform
export function createWebService(scope: Construct, platform: Platform, props: { environment; taskRole: iam.Role; cpu?; memoryMiB? }): ecs.FargateService
export function createTaskRole(scope: Construct, namePrefix: string): iam.Role
// controller-service.ts
export function createControllerService(scope, platform, props: { environment; runtimeSigningSecret; cpu?; memoryMiB?; dependsOn: ecs.FargateService }): { role: iam.Role; service: ecs.FargateService }
// gateway-service.ts
export function createGatewayService(scope, platform, props: { environment; domainName: string }): { role: iam.Role; service: ecs.FargateService }
```
- `ServiceConstruct` 공개 필드는 유지하되 `gatewayRole?`, `gatewayService?`, `webAcl?`, `certificate?`로 optional.

- [ ] **Step 1: 코드 이동**

현재 `service.ts` 본문을 위 네 파일의 함수로 잘라 옮긴다. 규칙: `new X(this, 'Id', …)` → `new X(scope, 'Id', …)`; 변수 이름 유지. 조건부:
- `ingress.ts`: `mode.mode === 'https'`일 때만 `Certificate`, `AliasRecord`, `Https` 리스너(Cognito 기본 액션 + Health/Logout/ApiTokens 규칙), `Http` 리다이렉트 리스너. `gateway`일 때만 SAN `*.apps.<domain>`, `AppSessionsRecord`, `attachGateway`(SessionHosts 규칙). `mode.mode === 'http'`이면 `throw new Error('HTTP ingress needs AUTH_MODE=cognito (sub-project E)')` — 이 플랜 범위에서는 검증만.
- WAF: `props.waf`일 때만 `WebAcl` + `WebAclAssociation`. `AccessLogs` 버킷과 `logAccessLogs`는 항상.
- `attachWeb`은 `Tg` 타깃 그룹을 만들고 리스너 기본 액션·규칙에 연결(현재 코드 순서 유지: 타깃 그룹 → 리스너 생성 시 기본 액션에 사용).
- `web-service.ts`: `Cluster`(+CloudMap ns), `Logs`, `Image` 자산, `ServiceSg`(+ALB→3000 인그레스), `TaskDef`, `Service`. `TaskRole`은 별도 함수.
- `controller-service.ts`: `ControllerRole`, `ControllerTask`, `Controller`(+ `node.addDependency(dependsOn)`, cloudMapOptions name `controller`).
- `gateway-service.ts`: `GatewayRole`, `GatewayTask`, `Gateway`; `svcSg.addIngressRule(albSg, 3002)`는 여기서.
- `alarms.ts`: `webAclName?: string`; `if (props.webAclName) alarm('WafBlockedSpike', …)`.

- [ ] **Step 2: `service.ts` 조립**

```ts
export interface ServiceConstructProps {
  vpc: ec2.IVpc; namePrefix: string; webAppPath: string; environment: Record<string, string>;
  modules: Pick<DashboardModules, 'ingress' | 'gateway' | 'waf'>;
  hostedZone?: route53.IHostedZone; userPool: cognito.IUserPool; userPoolClient: cognito.IUserPoolClient; userPoolDomain: cognito.IUserPoolDomain;
  runtimeSigningSecret: secretsmanager.ISecret; cpu?: number; memoryMiB?: number; controllerCpu?: number; controllerMemoryMiB?: number;
}
export class ServiceConstruct extends Construct {
  readonly taskRole: iam.Role; readonly loadBalancer: elbv2.ApplicationLoadBalancer; readonly service: ecs.FargateService;
  readonly certificate?: acm.Certificate; readonly logGroup: logs.LogGroup; readonly serviceSecurityGroup: ec2.SecurityGroup;
  readonly controllerRole: iam.Role; readonly controllerService: ecs.FargateService;
  readonly gatewayRole?: iam.Role; readonly gatewayService?: ecs.FargateService; readonly webAcl?: wafv2.CfnWebACL; readonly accessLogs: s3.Bucket;
  constructor(scope: Construct, id: string, props: ServiceConstructProps) {
    super(scope, id);
    const ingress = createIngress(this, { vpc: props.vpc, namePrefix: props.namePrefix, mode: props.modules.ingress, hostedZone: props.hostedZone,
      auth: { userPool: props.userPool, userPoolClient: props.userPoolClient, userPoolDomain: props.userPoolDomain }, waf: props.modules.waf, gateway: props.modules.gateway });
    const domainName = props.modules.ingress.mode === 'https' ? props.modules.ingress.domainName : undefined;
    const platform = createPlatform(this, { vpc: props.vpc, namePrefix: props.namePrefix, webAppPath: props.webAppPath, albSg: ingress.albSg });
    this.taskRole = createTaskRole(this, props.namePrefix);
    const shared = { ...props.environment, ALB_ARN: ingress.loadBalancer.loadBalancerArn, COGNITO_USER_POOL_ID: props.userPool.userPoolId,
      COGNITO_CLIENT_ID: props.userPoolClient.userPoolClientId,
      COGNITO_DOMAIN: `${props.userPoolDomain.domainName}.auth.${cdk.Stack.of(this).region}.amazoncognito.com`,
      DASHBOARD_ORIGIN: `https://${domainName}` };
    this.service = createWebService(this, platform, { environment: shared, taskRole: this.taskRole, cpu: props.cpu, memoryMiB: props.memoryMiB });
    ingress.attachWeb(this.service);
    const controller = createControllerService(this, platform, { environment: { ...props.environment, COGNITO_USER_POOL_ID: props.userPool.userPoolId },
      runtimeSigningSecret: props.runtimeSigningSecret, cpu: props.controllerCpu, memoryMiB: props.controllerMemoryMiB, dependsOn: this.service });
    this.controllerRole = controller.role; this.controllerService = controller.service;
    if (props.modules.gateway && domainName) {
      const gateway = createGatewayService(this, platform, { environment: { ...props.environment, COGNITO_USER_POOL_ID: props.userPool.userPoolId }, domainName });
      this.gatewayRole = gateway.role; this.gatewayService = gateway.service;
      ingress.attachGateway(gateway.service);
    }
    this.loadBalancer = ingress.loadBalancer; this.certificate = ingress.certificate; this.webAcl = ingress.webAcl; this.accessLogs = ingress.accessLogs;
    this.logGroup = platform.logGroup; this.serviceSecurityGroup = platform.serviceSecurityGroup;
  }
}
```
web 컨테이너 env는 현재와 동일한 키 집합이어야 한다(`WORKFLOW_CONTROLLER: '0'`, `PORT`, `HOSTNAME`은 `createWebService` 안에서 추가). controller/gateway env의 `AUTH_MODE: 'alb'`, `WORKFLOW_CONTROLLER: '0'`, `NODE_ENV`, `GATEWAY_BASE_DOMAIN`, `GATEWAY_ASSET_DIR`도 각 함수 안에서 현재 값 그대로.

- [ ] **Step 3: `dashboard-stack.ts` 조립 변경(최소)**

- `DashboardStackProps`에 `modules?: DashboardModules` 추가. 생성자 첫 줄: `const modules = props.modules ?? resolveModules(k => ({ domainName: props.domainName, hostedZoneId: props.hostedZoneId, hostedZoneName: props.hostedZoneName, extendedImages: props.extendedImages ? 'true' : undefined } as Record<string, unknown>)[k]);` — 기존 테스트(props로 도메인을 넘기는)와 호환.
- `WorkloadImages` 호출을 `{ repositoryRoot, build: modules.images.build, overrides: modules.images.overrides, optionalImages }`로.
- `ServiceConstruct` 호출에 `modules: { ingress: modules.ingress, gateway: modules.gateway, waf: modules.waf }`, `hostedZone: zone`(https일 때만 생성).
- `svc.gatewayRole`/`svc.gatewayService`를 쓰는 모든 곳(`table.grantReadWriteData(svc.gatewayRole)`, gateway IAM 두 statement, DCV `ssm:StartSession` 두 statement, `GatewayEksAccessEntry`, `GatewayServiceName` 출력)을 `if (svc.gatewayRole && svc.gatewayService)`로 감싼다.
- `AlarmsConstruct`에 `webAclName: svc.webAcl ? `${prefix}-web` : undefined`.
- `GATEWAY_BASE_DOMAIN` env: `modules.gateway && modules.ingress.mode==='https' ? `apps.${domainName}` : undefined` → `buildEnv`가 빈 값을 제거하므로 env 객체에서 `undefined`를 걸러 넣는다.
- `DashboardUrl` 출력: https일 때만 도메인 URL, 아니면 ALB DNS.

- [ ] **Step 4: 검증**

Run: `cd dashboard/infra && npx tsc --noEmit -p . && node --require ts-node/register --test test/*.test.ts`
Expected: 전부 PASS — 특히 `logical-ids.test.ts`(기본 모듈에서 ID 집합 동일)와 `edge-hardening.test.ts`(WAF·알람 5개). 실패하면 자식 ID 또는 호출 순서가 바뀐 것이다(예: 리스너 액션 우선순위/ID).

- [ ] **Step 5: 커밋**

```bash
git add dashboard/infra/lib
git commit -m "refactor(dashboard): split the service construct into ingress/web/controller/gateway modules with unchanged logical ids

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: sourceBuild·edge·waf·alarms·gateway 토글을 스택에 연결하고 테스트

**Files:**
- Modify: `dashboard/infra/lib/dashboard-stack.ts`
- Modify: `dashboard/infra/lib/env-contract.ts` (Greengrass env를 `extra`로 이동)
- Create: `dashboard/infra/test/stack-modules.test.ts`

**Interfaces:**
- Consumes: Task 2 `DashboardModules`, Task 4 optional gateway/webAcl.

- [ ] **Step 1: 실패하는 테스트**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Match } from 'aws-cdk-lib/assertions';
import { synthesize } from './helpers/synth';
import { resolveModules } from '../lib/modules';
const domain = { domainName: 'dashboard.example.com', hostedZoneId: 'Z0123456789ABCDEF', hostedZoneName: 'example.com' };
const modules = (extra: Record<string, unknown>) => resolveModules(k => ({ ...domain, ...extra } as Record<string, unknown>)[k]);

test('gateway=false removes the gateway service, its listener rule, the wildcard record and GATEWAY_BASE_DOMAIN', () => {
  const t = synthesize({ modules: modules({ gateway: 'false' }) });
  t.resourceCountIs('AWS::ECS::Service', 2);
  t.resourceCountIs('AWS::Route53::RecordSet', 1);
  const rules = t.findResources('AWS::ElasticLoadBalancingV2::ListenerRule');
  assert.ok(!Object.values(rules).some(r => JSON.stringify(r).includes('*.apps.')));
  const cert = Object.values(t.findResources('AWS::CertificateManager::Certificate'))[0] as { Properties: { SubjectAlternativeNames?: string[] } };
  assert.equal(cert.Properties.SubjectAlternativeNames, undefined);
  assert.ok(!JSON.stringify(t.toJSON()).includes('GATEWAY_BASE_DOMAIN'));
});
test('waf=false removes the web ACL and the WAF alarm; alarms=false removes every alarm', () => {
  const noWaf = synthesize({ modules: modules({ waf: 'false' }) });
  noWaf.resourceCountIs('AWS::WAFv2::WebACL', 0);
  noWaf.resourceCountIs('AWS::CloudWatch::Alarm', 4);
  synthesize({ modules: modules({ alarms: 'false' }) }).resourceCountIs('AWS::CloudWatch::Alarm', 0);
});
test('sourceBuild=false removes the CodeBuild project, ECR repository and build env', () => {
  const t = synthesize({ modules: modules({ sourceBuild: 'false' }) });
  t.resourceCountIs('AWS::CodeBuild::Project', 0);
  t.resourceCountIs('AWS::ECR::Repository', 0);
  const env = JSON.stringify(t.toJSON());
  assert.ok(env.includes('"SOURCE_BUILD_TARGETS_JSON","Value":"[]"'));
});
test('edge=false omits Greengrass env and IAM', () => {
  const t = synthesize({ modules: modules({ edge: 'false' }) });
  const text = JSON.stringify(t.toJSON());
  assert.ok(!text.includes('GREENGRASS_THING_GROUP'));
  assert.ok(!text.includes('greengrass:CreateDeployment'));
});
test('images=mujoco builds one model image plus nothing else and leaves other *_IMAGE_URI unset', () => {
  const t = synthesize({ modules: modules({ images: 'mujoco' }) });
  const text = JSON.stringify(t.toJSON());
  assert.ok(text.includes('MUJOCO_IMAGE_URI'));
  assert.ok(!text.includes('ISAACLAB_IMAGE_URI') && !text.includes('WORKSPACE_IMAGE_URI'));
});
test('the resource tag is applied to taggable resources', () => {
  const t = synthesize({ modules: modules({}) });
  t.hasResourceProperties('AWS::DynamoDB::Table', Match.objectLike({ Tags: Match.arrayWith([{ Key: 'PhysicalAI', Value: 'true' }]) }));
});
test('http ingress is rejected until sub-project E lands', () => {
  assert.throws(() => synthesize({ modules: resolveModules(() => undefined), domainName: undefined as unknown as string }), /HTTP ingress needs AUTH_MODE=cognito/);
});
```
태그 테스트를 위해 스택 생성자에서 `cdk.Tags.of(this).add(modules.resourceTag.key, modules.resourceTag.value)`를 추가한다(app.ts의 `Tags.of(app)`와 별개로 스택 자체에도 붙여 테스트 가능하게).

- [ ] **Step 2: 실패 확인**

Run: `cd dashboard/infra && node --require ts-node/register --test test/stack-modules.test.ts`
Expected: FAIL (sourceBuild/edge/waf 분기 없음).

- [ ] **Step 3: 스택 분기 구현**

- `sourceBuild`: `const sourceBuild = modules.sourceBuild ? new SourceBuildProject(...) : undefined;` `SOURCE_BUILD_TARGETS_JSON: sourceBuild ? toJsonString([sourceBuild.target]) : '[]'`; `BUILD_PROJECTS`는 `[modules.alarms /*무관*/ …]` 대신 `[d.hyperPodEks?.EksClusterName ? `${prefix}-operations` : undefined, d.groot?.SmTrainingBuildProjectName, d.groot?.RuntimeCodeBuildProjectName].filter(Boolean).join(',')`(sourceBuild와 무관, 기존 값 유지). `sourceBuild?.grantControlPlane(role)`; CodeBuild IAM statement는 `builds.length ? … : skip`.
- `edge`: `env-contract.ts`에서 `GREENGRASS_*` 두 줄을 제거하고 `dashboard-stack.ts`에서 `...(modules.edge ? { GREENGRASS_THING_GROUP: `groot-${accountId}-group`, GREENGRASS_INFERENCE_COMPONENT: `com.workshop.${accountId}.inference` } : {})`로 `extra`에 넣는다. Greengrass IAM statement(sid `Greengrass`)는 `if (modules.edge)`.
- `alarms`: `if (modules.alarms) new AlarmsConstruct(...)`.
- 태그: 생성자 상단 `cdk.Tags.of(this).add(modules.resourceTag.key, modules.resourceTag.value);`.
- 논리 ID 스냅샷은 기본 모듈에서 여전히 동일해야 한다(태그는 속성이므로 ID 영향 없음).

- [ ] **Step 4: 검증·커밋**

Run: `cd dashboard/infra && npx tsc --noEmit -p . && node --require ts-node/register --test test/*.test.ts`
Expected: PASS 전부.
```bash
git add dashboard/infra/lib dashboard/infra/test/stack-modules.test.ts
git commit -m "feat(dashboard): sourceBuild/edge/waf/alarms/gateway stack toggles and the PhysicalAI resource tag

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `bin/app.ts` 배선, 부모 스택 태그, 앱 config

**Files:**
- Modify: `dashboard/infra/bin/app.ts`
- Modify: `hyperpod-training/infra/lib/hyperpod-eks-stack.ts:59-61`, `e2e-workshop/infra/groot/lib/groot-finetune-stack.ts:84-85`, `e2e-workshop/infra/isaaclab/lib/isaac-lab-stack.ts:92-94`
- Modify: `dashboard/web/src/server/config.ts` (ENV_KEYS + `resourceTag`, edge 폴백 제거), `dashboard/web/src/server/config.test.ts:31`

- [ ] **Step 1: `app.ts`**

- `const modules = resolveModules(k => app.node.tryGetContext(k));` — 기존 `domainName/hostedZoneId/hostedZoneName` 필수 검사(86행)를 삭제하고 `modules.ingress`로 대체. `if (modules.ingress.mode === 'http') console.error('[dashboard] HTTP ingress selected: not supported until sub-project E');`(스택이 throw).
- `cdk.Tags.of(app).add(modules.resourceTag.key, modules.resourceTag.value);`
- `console.error('[dashboard] modules\n' + describeModules(modules));`
- `new DashboardStack(..., { …, modules, domainName: modules.ingress.mode === 'https' ? modules.ingress.domainName : '', hostedZoneId: …, hostedZoneName: …, extendedImages: modules.images.build.includes('groot') })`. `adminEmail` 기본값은 `hostedZoneName`이 없으면 `admin@example.invalid`.
- env: `RESOURCE_TAG_KEY`, `RESOURCE_TAG_VALUE`를 `buildEnv(..., extra)`에 추가.

- [ ] **Step 2: 부모 스택 태그** — 각 파일의 기존 `Tags.of(this).add('Project', …)` 바로 아래에 `cdk.Tags.of(this).add('PhysicalAI', 'true');`

- [ ] **Step 3: web config**

- `ENV_KEYS`에 `'RESOURCE_TAG_KEY', 'RESOURCE_TAG_VALUE'` 추가; `DashboardConfig`에 `resourceTag?: { key: string; value: string }`; `loadConfig`에서 두 값이 모두 있으면 설정.
- `edge` 폴백 제거: `thingGroup: opt(env, 'GREENGRASS_THING_GROUP'), inferenceComponent: opt(env, 'GREENGRASS_INFERENCE_COMPONENT')`.
- `config.test.ts:31`을 `expect(c.edge?.thingGroup).toBeUndefined();`로 바꾸고, 같은 describe에 `GREENGRASS_THING_GROUP: 'g'`를 준 케이스에서 `'g'`를 기대하는 단언 한 줄 추가.

- [ ] **Step 4: 검증**

Run: `cd dashboard/infra && npx tsc --noEmit -p . && node --require ts-node/register --test test/*.test.ts && cd ../web && npm run typecheck && npm test -- src/server/config.test.ts src/app/api`
Expected: PASS. `cd hyperpod-training/infra && npx tsc --noEmit -p .`, `cd e2e-workshop/infra/groot && npx tsc --noEmit -p .`, `cd e2e-workshop/infra/isaaclab && npx tsc --noEmit -p .` 각각 통과(`node_modules`가 없으면 `npm ci` 후).

- [ ] **Step 5: 커밋**

```bash
git add dashboard/infra/bin/app.ts dashboard/infra/lib hyperpod-training/infra/lib/hyperpod-eks-stack.ts e2e-workshop/infra/groot/lib/groot-finetune-stack.ts e2e-workshop/infra/isaaclab/lib/isaac-lab-stack.ts dashboard/web/src/server/config.ts dashboard/web/src/server/config.test.ts
git commit -m "feat(dashboard): module context in the CDK app, PhysicalAI tag on every stack, edge feature follows env only

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: 문서

**Files:**
- Modify: `dashboard/README.md` (설치 절)
- Modify: `dashboard/docs/dashboard-features-and-aws-architecture.md` §25

- [ ] **Step 1: README 설치 절에 모듈 표 추가** (기존 `npx cdk deploy` 예시 아래)

```
### 모듈 선택

| context | 기본 | 설명 |
|---|---|---|
| `domainName`·`hostedZoneId`·`hostedZoneName` | (없음) | 셋을 모두 주면 HTTPS + ALB Cognito 로그인. 모두 생략하면 ALB DNS 이름으로 HTTP 접속(하위 프로젝트 E 이후 지원) |
| `gateway` | `true` | 세션 게이트웨이(Jupyter·터미널·실시간 보기). `false`면 세션 화면 비활성 |
| `images` | `mujoco,isaaclab,ros2,workspace` | 빌드할 워크로드 이미지. `extendedImages=true`는 `groot,openpi` 추가 |
| `imageOverrides` | `{}` | 이미 있는 ECR 이미지 재사용. 예 `'{"mujoco":"<acct>.dkr.ecr.us-east-1.amazonaws.com/pai/mujoco@sha256:…"}'` |
| `sourceBuild` | `true` | 연구자 소스 이미지 CodeBuild + ECR |
| `edge` | `true` | Greengrass/IoT 권한과 엣지 화면 |
| `waf` / `alarms` | `true` | WAF 웹 ACL / CloudWatch 알람 5개 |
| `resourceTagKey` / `resourceTagValue` | `PhysicalAI` / `true` | 모든 리소스에 붙는 태그. 리소스 화면이 이 태그로 조회 |

같은 태그가 GrootFinetune·IsaacLab·HyperPodEks 스택에도 붙습니다(각 스택을 다시 배포하면 적용).
```

- [ ] **Step 2: 기능 문서 §25에 "모듈 context는 `infra/lib/modules.ts`가 검증하며 기본값은 기존 배포와 동일하다" 한 줄과 표 링크 추가.**

- [ ] **Step 3: 커밋**

```bash
git add dashboard/README.md dashboard/docs/dashboard-features-and-aws-architecture.md
git commit -m "docs(dashboard): module selection table and resource tag

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
