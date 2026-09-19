# Dashboard D — 태그 기반 리소스 화면 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 공통 태그(`PhysicalAI=true`, C에서 도입)가 붙은 AWS 리소스를 Resource Groups Tagging API로 조회하고 EC2 인스턴스는 상태·타입·IP로 보강해, 읽기 전용 "리소스" 화면으로 보여준다.

**Architecture:** `server/aws/tagged-resources.ts`가 `tag:GetResources`를 페이지네이션해 ARN을 서비스별로 분류하고 EC2만 `DescribeInstances`로 보강한다(60초 모듈 캐시). `GET /api/resources`(viewer)가 이를 반환하고, `components/pages/ResourcesPage.tsx`가 서비스별 접이식 표와 콘솔 링크로 렌더링한다. CDK는 웹 태스크 역할에 `tag:GetResources`를 추가한다.

**Tech Stack:** Next.js 16 route handlers, `@aws-sdk/client-resource-groups-tagging-api`(신규 의존성), `@aws-sdk/client-ec2`, TanStack Query(`useApi`), vitest.

**Spec:** `docs/designs/2026-09-19-dashboard-modular-http-logs-design.md` §7 (C의 `RESOURCE_TAG_KEY/VALUE` env·`config().resourceTag` 전제)

## Global Constraints

- 태그 키·값은 `config().resourceTag`에서 읽는다(C가 `RESOURCE_TAG_KEY`/`RESOURCE_TAG_VALUE` env와 config 필드를 추가함). env가 없으면 기본 `{ key: 'PhysicalAI', value: 'true' }`를 사용한다.
- 쓰기 동작(시작·중지) 없음. IAM 추가는 `tag:GetResources`(리소스 `*`) 하나.
- 응답 shape:
```ts
export type ResourceService = 'EC2' | 'FSx' | 'EKS' | 'SageMaker' | 'S3' | 'DynamoDB' | 'ECS' | 'ELB' | 'Lambda' | 'CodeBuild' | 'ECR' | 'Cognito' | 'Other';
export interface TaggedResource { arn: string; service: ResourceService; type: string; name: string; region: string; consoleUrl?: string; details?: Record<string, string | number | undefined> }
export interface ResourcesResponse { tag: { key: string; value: string }; fetchedAt: string; region: string; accountId: string; groups: { service: ResourceService; items: TaggedResource[]; error?: string }[] }
```
- UI 문자열은 i18n 네임스페이스 `resourcesPage`(ko/en 동일 키)에만 둔다. 사이드바 `groupCluster`에 `/resources` 추가.
- 명령: `cd dashboard/web && npm test -- <file> && npm run typecheck`; infra `cd dashboard/infra && npx tsc --noEmit -p . && node --require ts-node/register --test test/*.test.ts`.
- 커밋 형식 `feat|docs(dashboard): …`, 트레일러 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

### Task 1: `tagged-resources.ts` — 조회·분류·EC2 보강

**Files:**
- Modify: `dashboard/web/package.json` (`npm i @aws-sdk/client-resource-groups-tagging-api@^3.1133.0`)
- Modify: `dashboard/web/src/server/aws/clients.ts` (`tagging` 클라이언트 추가)
- Create: `dashboard/web/src/server/aws/tagged-resources.ts`
- Test: `dashboard/web/src/server/aws/tagged-resources.test.ts`

**Interfaces:**
- Produces: `parseArn(arn): { service: ResourceService; type: string; name: string; region: string }`, `listTaggedResources(now?: () => number): Promise<ResourcesResponse>`, `resetTaggedResourcesCache()`; `clients.ts`에 `export const tagging = memo(() => new ResourceGroupsTaggingAPIClient(region()));`.
- `parseArn` 매핑: `arn:aws:ec2:…:instance/i-…` → EC2/instance; `ec2:…:vpc|subnet|security-group|volume/…` → EC2/<type>; `fsx:…:file-system/fs-…` → FSx; `eks:…:cluster/<name>` → EKS; `sagemaker:…:cluster/<id>` → SageMaker/hyperpod-cluster, `sagemaker:…:pipeline|model-package-group|mlflow-tracking-server/<name>` → SageMaker/<type>; `s3:::<bucket>` → S3/bucket; `dynamodb:…:table/<name>` → DynamoDB; `ecs:…:cluster|service/…` → ECS; `elasticloadbalancing:…:loadbalancer/app/<name>/<id>` → ELB/name; `codebuild:…:project/<name>` → CodeBuild; `ecr:…:repository/<name>` → ECR; `cognito-idp:…:userpool/<id>` → Cognito; 그 외 → Other/`<service>`/`<마지막 경로 요소>`.
- 콘솔 링크는 `lib/console-links.ts`의 `consoleUrl()`을 재사용한다: EC2 instance → `ec2-instance`, FSx → `fsx-filesystem`, EKS → `eks-cluster`, SageMaker hyperpod-cluster → `hyperpod-cluster`, S3 → `s3-bucket`, DynamoDB → `dynamodb-table`, Cognito → `cognito-user-pool`. 나머지는 링크 없음(`undefined`).

- [ ] **Step 1: 의존성 설치**

Run: `cd dashboard/web && npm i @aws-sdk/client-resource-groups-tagging-api@^3.1133.0 && grep -n resource-groups-tagging package.json`
Expected: dependencies에 한 줄 추가, `package-lock.json` 갱신.

- [ ] **Step 2: 실패하는 테스트** — `tagged-resources.test.ts`

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
const sends = vi.hoisted(() => ({ tagging: vi.fn(), ec2: vi.fn() }));
vi.mock('./clients', () => ({ tagging: () => ({ send: sends.tagging }), ec2: () => ({ send: sends.ec2 }) }));
vi.mock('../config', () => ({ config: () => ({ region: 'us-east-1', accountId: '123456789012', resourceTag: { key: 'PhysicalAI', value: 'true' } }) }));
import { listTaggedResources, parseArn, resetTaggedResourcesCache } from './tagged-resources';

beforeEach(() => { sends.tagging.mockReset(); sends.ec2.mockReset(); resetTaggedResourcesCache(); });
const A = (s: string) => `arn:aws:${s}`;

describe('parseArn', () => {
  it('classifies the services the dashboard uses and falls back to Other', () => {
    expect(parseArn(A('ec2:us-east-1:123456789012:instance/i-0abc'))).toEqual({ service: 'EC2', type: 'instance', name: 'i-0abc', region: 'us-east-1' });
    expect(parseArn(A('fsx:us-east-1:123456789012:file-system/fs-01'))).toMatchObject({ service: 'FSx', name: 'fs-01' });
    expect(parseArn(A('eks:us-east-1:123456789012:cluster/hp'))).toMatchObject({ service: 'EKS', name: 'hp' });
    expect(parseArn(A('sagemaker:us-east-1:123456789012:cluster/abc123'))).toMatchObject({ service: 'SageMaker', type: 'hyperpod-cluster' });
    expect(parseArn(A('s3:::my-bucket'))).toEqual({ service: 'S3', type: 'bucket', name: 'my-bucket', region: 'us-east-1' });
    expect(parseArn(A('elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/pai/50dc6c'))).toMatchObject({ service: 'ELB', name: 'pai' });
    expect(parseArn(A('kinesis:us-east-1:123456789012:stream/x'))).toMatchObject({ service: 'Other', type: 'kinesis', name: 'x' });
  });
});
describe('listTaggedResources', () => {
  it('paginates GetResources, groups by service, enriches EC2 instances and caches for 60 s', async () => {
    sends.tagging
      .mockResolvedValueOnce({ PaginationToken: 'p2', ResourceTagMappingList: [{ ResourceARN: A('ec2:us-east-1:123456789012:instance/i-1') }, { ResourceARN: A('s3:::b1') }] })
      .mockResolvedValueOnce({ PaginationToken: '', ResourceTagMappingList: [{ ResourceARN: A('fsx:us-east-1:123456789012:file-system/fs-1') }] });
    sends.ec2.mockResolvedValueOnce({ Reservations: [{ Instances: [{ InstanceId: 'i-1', State: { Name: 'running' }, InstanceType: 'g5.4xlarge', PrivateIpAddress: '10.0.1.5', Placement: { AvailabilityZone: 'us-east-1a' }, LaunchTime: new Date('2026-09-01T00:00:00Z'), Tags: [{ Key: 'Name', Value: 'isaac-ws' }] }] }] });
    let now = 1_000;
    const first = await listTaggedResources(() => now);
    expect(sends.tagging).toHaveBeenCalledTimes(2);
    expect(sends.tagging.mock.calls[0][0].input).toMatchObject({ TagFilters: [{ Key: 'PhysicalAI', Values: ['true'] }], ResourcesPerPage: 100 });
    expect(sends.tagging.mock.calls[1][0].input.PaginationToken).toBe('p2');
    expect(first.groups.map(g => g.service)).toEqual(['EC2', 'FSx', 'S3']);
    const ec2 = first.groups[0].items[0];
    expect(ec2).toMatchObject({ name: 'isaac-ws', details: { instanceId: 'i-1', state: 'running', instanceType: 'g5.4xlarge', privateIp: '10.0.1.5', az: 'us-east-1a' } });
    expect(ec2.consoleUrl).toContain('InstanceDetails:instanceId=i-1');
    expect(sends.ec2.mock.calls[0][0].input.InstanceIds).toEqual(['i-1']);
    now += 59_000; await listTaggedResources(() => now);
    expect(sends.tagging).toHaveBeenCalledTimes(2);
    now += 2_000; sends.tagging.mockResolvedValueOnce({ ResourceTagMappingList: [] }); await listTaggedResources(() => now);
    expect(sends.tagging).toHaveBeenCalledTimes(3);
  });
  it('keeps the listing when EC2 enrichment fails and reports the error on the EC2 group', async () => {
    sends.tagging.mockResolvedValueOnce({ ResourceTagMappingList: [{ ResourceARN: A('ec2:us-east-1:123456789012:instance/i-1') }] });
    sends.ec2.mockRejectedValueOnce(new Error('AccessDenied'));
    const r = await listTaggedResources(() => 0);
    expect(r.groups[0]).toMatchObject({ service: 'EC2', error: 'AccessDenied' });
    expect(r.groups[0].items[0]).toMatchObject({ name: 'i-1', details: { instanceId: 'i-1' } });
  });
  it('rejects a pagination loop', async () => {
    sends.tagging.mockResolvedValue({ PaginationToken: 'same', ResourceTagMappingList: [] });
    await expect(listTaggedResources(() => 0)).rejects.toThrow(/pagination/);
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `cd dashboard/web && npm test -- src/server/aws/tagged-resources.test.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 4: 구현**

`clients.ts`:
```ts
import { ResourceGroupsTaggingAPIClient } from '@aws-sdk/client-resource-groups-tagging-api';
export const tagging = memo(() => new ResourceGroupsTaggingAPIClient(region()));
```
`tagged-resources.ts`:
```ts
import { GetResourcesCommand } from '@aws-sdk/client-resource-groups-tagging-api';
import { DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { config } from '../config';
import { ec2, tagging } from './clients';
import { consoleUrl, type ConsoleResource } from '@/lib/console-links';

export type ResourceService = 'EC2' | 'FSx' | 'EKS' | 'SageMaker' | 'S3' | 'DynamoDB' | 'ECS' | 'ELB' | 'Lambda' | 'CodeBuild' | 'ECR' | 'Cognito' | 'Other';
export interface TaggedResource { arn: string; service: ResourceService; type: string; name: string; region: string; consoleUrl?: string; details?: Record<string, string | number | undefined> }
export interface ResourcesResponse { tag: { key: string; value: string }; fetchedAt: string; region: string; accountId: string; groups: { service: ResourceService; items: TaggedResource[]; error?: string }[] }

const ORDER: ResourceService[] = ['EC2', 'EKS', 'SageMaker', 'FSx', 'S3', 'DynamoDB', 'ECS', 'ELB', 'CodeBuild', 'ECR', 'Cognito', 'Lambda', 'Other'];
const SERVICES: Record<string, ResourceService> = { ec2: 'EC2', fsx: 'FSx', eks: 'EKS', sagemaker: 'SageMaker', s3: 'S3', dynamodb: 'DynamoDB', ecs: 'ECS', elasticloadbalancing: 'ELB', lambda: 'Lambda', codebuild: 'CodeBuild', ecr: 'ECR', 'cognito-idp': 'Cognito' };

export function parseArn(arn: string): { service: ResourceService; type: string; name: string; region: string } {
  const [, , svc, region, , ...rest] = arn.split(':');
  const resource = rest.join(':');
  const service = SERVICES[svc] ?? 'Other';
  const home = region || config().region;
  if (svc === 's3') return { service, type: 'bucket', name: resource, region: home };
  const [type, ...pathParts] = resource.includes('/') ? resource.split('/') : resource.split(':');
  const path = pathParts.join('/');
  if (svc === 'elasticloadbalancing' && type === 'loadbalancer') return { service, type: pathParts[0] === 'app' ? 'application-load-balancer' : 'load-balancer', name: pathParts[1] ?? path, region: home };
  if (svc === 'sagemaker' && type === 'cluster') return { service, type: 'hyperpod-cluster', name: path, region: home };
  if (service === 'Other') return { service, type: svc, name: pathParts.at(-1) ?? resource, region: home };
  return { service, type, name: path || type, region: home };
}
function link(r: { service: ResourceService; type: string; name: string }): ConsoleResource | undefined {
  if (r.service === 'EC2' && r.type === 'instance') return { kind: 'ec2-instance', id: r.name };
  if (r.service === 'FSx') return { kind: 'fsx-filesystem', id: r.name };
  if (r.service === 'EKS') return { kind: 'eks-cluster', name: r.name };
  if (r.service === 'SageMaker' && r.type === 'hyperpod-cluster') return { kind: 'hyperpod-cluster', name: r.name };
  if (r.service === 'S3') return { kind: 's3-bucket', bucket: r.name };
  if (r.service === 'DynamoDB') return { kind: 'dynamodb-table', name: r.name };
  if (r.service === 'Cognito') return { kind: 'cognito-user-pool', id: r.name };
  return undefined;
}
const TTL_MS = 60_000;
let cache: { at: number; value: ResourcesResponse } | undefined;
export function resetTaggedResourcesCache(): void { cache = undefined; }

export async function listTaggedResources(now: () => number = Date.now): Promise<ResourcesResponse> {
  if (cache && now() - cache.at < TTL_MS) return cache.value;
  const c = config(), tag = c.resourceTag ?? { key: 'PhysicalAI', value: 'true' };
  const items: TaggedResource[] = [];
  const seen = new Set<string>(); let token: string | undefined;
  do {
    const out = await tagging().send(new GetResourcesCommand({ TagFilters: [{ Key: tag.key, Values: [tag.value] }], ResourcesPerPage: 100, PaginationToken: token }));
    for (const m of out.ResourceTagMappingList ?? []) {
      if (!m.ResourceARN) continue;
      const parsed = parseArn(m.ResourceARN);
      const nameTag = m.Tags?.find(t => t.Key === 'Name')?.Value;
      const resource: TaggedResource = { arn: m.ResourceARN, ...parsed, name: nameTag ?? parsed.name };
      const target = link(parsed);
      if (target) resource.consoleUrl = consoleUrl(target, parsed.region);
      items.push(resource);
    }
    token = out.PaginationToken || undefined;
    if (token && (seen.has(token) || seen.size >= 50)) throw new Error('Tagging API pagination is incomplete');
    if (token) seen.add(token);
  } while (token);
  const groups: ResourcesResponse['groups'] = ORDER.filter(s => items.some(i => i.service === s)).map(service => ({ service, items: items.filter(i => i.service === service).sort((a, b) => a.name.localeCompare(b.name)) }));
  const ec2Group = groups.find(g => g.service === 'EC2');
  const instances = ec2Group?.items.filter(i => i.type === 'instance') ?? [];
  if (ec2Group && instances.length) {
    for (const i of instances) i.details = { instanceId: parseArn(i.arn).name };
    try {
      const out = await ec2().send(new DescribeInstancesCommand({ InstanceIds: instances.map(i => parseArn(i.arn).name) }));
      for (const inst of (out.Reservations ?? []).flatMap(r => r.Instances ?? [])) {
        const item = instances.find(i => parseArn(i.arn).name === inst.InstanceId);
        if (!item) continue;
        item.name = inst.Tags?.find(t => t.Key === 'Name')?.Value ?? item.name;
        item.details = { instanceId: inst.InstanceId, state: inst.State?.Name, instanceType: inst.InstanceType, privateIp: inst.PrivateIpAddress, az: inst.Placement?.AvailabilityZone, launchedAt: inst.LaunchTime?.toISOString() };
      }
    } catch (error) { ec2Group.error = error instanceof Error ? error.message : String(error); }
  }
  const value: ResourcesResponse = { tag, fetchedAt: new Date(now()).toISOString(), region: c.region, accountId: c.accountId, groups };
  cache = { at: now(), value };
  return value;
}
```

- [ ] **Step 5: 통과 확인, 커밋**

Run: `cd dashboard/web && npm test -- src/server/aws/tagged-resources.test.ts && npm run typecheck`
Expected: PASS (4).
```bash
git add dashboard/web/package.json dashboard/web/package-lock.json dashboard/web/src/server/aws/clients.ts dashboard/web/src/server/aws/tagged-resources.ts dashboard/web/src/server/aws/tagged-resources.test.ts
git commit -m "feat(dashboard): list PhysicalAI-tagged AWS resources via the Tagging API with EC2 enrichment

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `GET /api/resources`와 IAM

**Files:**
- Create: `dashboard/web/src/app/api/resources/route.ts`
- Test: `dashboard/web/src/app/api/resources/route.test.ts`
- Modify: `dashboard/infra/lib/dashboard-stack.ts` (웹 태스크 역할에 `tag:GetResources`)
- Modify: `dashboard/infra/test/stack-modules.test.ts` (IAM 단언 1개 추가)

- [ ] **Step 1: 라우트 테스트**

```ts
import { describe, expect, it, vi } from 'vitest';
const list = vi.hoisted(() => vi.fn(async () => ({ tag: { key: 'PhysicalAI', value: 'true' }, fetchedAt: 't', region: 'us-east-1', accountId: '1', groups: [] })));
vi.mock('@/server/aws/tagged-resources', () => ({ listTaggedResources: list }));
vi.mock('@/server/api', () => ({ route: (_role: string, handler: (ctx: unknown) => Promise<unknown>) => async () => Response.json(await handler({})) }));
describe('GET /api/resources', () => {
  it('returns the tagged resource listing', async () => {
    const { GET } = await import('./route');
    const res = await GET(new Request('http://x/api/resources') as never, { params: Promise.resolve({}) } as never);
    expect(await res.json()).toMatchObject({ tag: { key: 'PhysicalAI' }, groups: [] });
    expect(list).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 라우트**

```ts
import { route } from '@/server/api';
import { listTaggedResources } from '@/server/aws/tagged-resources';
export const dynamic = 'force-dynamic';
/** Read-only inventory of AWS resources carrying the deployment's resource tag (cached 60 s server-side). */
export const GET = route('viewer', async () => listTaggedResources());
```

- [ ] **Step 3: IAM** — `dashboard-stack.ts`의 `role.addToPolicy(... sid: 'Ec2Describe' ...)` 바로 아래에:
```ts
role.addToPolicy(new iam.PolicyStatement({ sid: 'TaggedResourceInventory', actions: ['tag:GetResources'], resources: ['*'] }));
```
`stack-modules.test.ts`에 추가:
```ts
test('the web task role may list tagged resources', () => {
  const t = synthesize({ modules: modules({}) });
  assert.ok(JSON.stringify(t.toJSON()).includes('"tag:GetResources"'));
});
```

- [ ] **Step 4: 검증·커밋**

Run: `cd dashboard/web && npm test -- src/app/api/resources && npm run typecheck && cd ../infra && npx tsc --noEmit -p . && node --require ts-node/register --test test/stack-modules.test.ts test/logical-ids.test.ts`
Expected: PASS.
```bash
git add dashboard/web/src/app/api/resources dashboard/infra/lib/dashboard-stack.ts dashboard/infra/test/stack-modules.test.ts
git commit -m "feat(dashboard): /api/resources and tag:GetResources for the web task role

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: 리소스 화면, 사이드바, i18n

**Files:**
- Create: `dashboard/web/src/lib/i18n/messages/resourcesPage.ts`
- Modify: `dashboard/web/src/lib/i18n/messages/index.ts` (import + catalog 등록), `nav.ts` (`resources` 키 ko/en)
- Create: `dashboard/web/src/components/pages/ResourcesPage.tsx`, `dashboard/web/src/app/resources/page.tsx`
- Modify: `dashboard/web/src/components/layout/Sidebar.tsx` (`groupCluster`에 항목, `Server` 아이콘 import)
- Test: `dashboard/web/src/components/pages/ResourcesPage.test.ts` (그룹 정렬/필터 헬퍼 단위 테스트)

- [ ] **Step 1: i18n**

`resourcesPage.ts`:
```ts
import { defineMessages } from '../define';
export const resourcesPage = defineMessages({
  en: {
    title: 'AWS resources', description: 'Everything in this account carrying the deployment tag, read through the Resource Groups Tagging API. Read-only.',
    tag: 'Tag filter', fetchedAt: 'Fetched', refresh: 'Refresh', search: 'Search name, type or ARN…', empty: 'No resources carry this tag yet.',
    emptyHint: 'Deploy the dashboard, GrootFinetune, IsaacLab and HyperPodEks stacks with the PhysicalAI=true tag (see README).',
    colName: 'Name', colType: 'Type', colRegion: 'Region', colDetails: 'Details', colConsole: 'Console', open: 'Open',
    state: 'State', instanceType: 'Instance type', privateIp: 'Private IP', az: 'Availability zone', launchedAt: 'Launched',
    groupError: 'Details could not be loaded: {message}', count: '{n} resources', source: 'Resource Groups Tagging API GetResources · EC2 DescribeInstances',
  },
  ko: {
    title: 'AWS 리소스', description: '배포 태그가 붙은 이 계정의 모든 리소스를 Resource Groups Tagging API로 읽어 보여줍니다. 읽기 전용입니다.',
    tag: '태그 필터', fetchedAt: '조회 시각', refresh: '새로 고침', search: '이름·유형·ARN 검색…', empty: '이 태그가 붙은 리소스가 아직 없습니다.',
    emptyHint: '대시보드·GrootFinetune·IsaacLab·HyperPodEks 스택을 PhysicalAI=true 태그와 함께 배포하세요(README 참고).',
    colName: '이름', colType: '유형', colRegion: '리전', colDetails: '상세', colConsole: '콘솔', open: '열기',
    state: '상태', instanceType: '인스턴스 타입', privateIp: '프라이빗 IP', az: '가용 영역', launchedAt: '시작 시각',
    groupError: '상세 정보를 불러오지 못했습니다: {message}', count: '{n}개', source: 'Resource Groups Tagging API GetResources · EC2 DescribeInstances',
  },
});
```
`index.ts`: `import { resourcesPage } from './resourcesPage';` + catalog에 `resourcesPage,`. `nav.ts`: en `resources: 'AWS resources'`, ko `resources: 'AWS 리소스'`.

- [ ] **Step 2: 페이지 헬퍼 + 테스트** — `ResourcesPage.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { filterGroups } from './ResourcesPage';
const groups = [
  { service: 'EC2' as const, items: [{ arn: 'a1', service: 'EC2' as const, type: 'instance', name: 'isaac-ws', region: 'us-east-1', details: { state: 'running' } }] },
  { service: 'S3' as const, items: [{ arn: 'arn:aws:s3:::pai-artifacts', service: 'S3' as const, type: 'bucket', name: 'pai-artifacts', region: 'us-east-1' }] },
];
describe('filterGroups', () => {
  it('matches name, type or ARN case-insensitively and drops empty groups', () => {
    expect(filterGroups(groups, 'ISAAC').map(g => g.service)).toEqual(['EC2']);
    expect(filterGroups(groups, 'bucket').map(g => g.service)).toEqual(['S3']);
    expect(filterGroups(groups, 'arn:aws:s3').map(g => g.service)).toEqual(['S3']);
    expect(filterGroups(groups, '')).toHaveLength(2);
  });
});
```

- [ ] **Step 3: 페이지**

`app/resources/page.tsx`:
```tsx
import { ResourcesPage } from '@/components/pages/ResourcesPage';
export default async function Page() { return <ResourcesPage />; }
```
`components/pages/ResourcesPage.tsx`:
```tsx
'use client';
import * as React from 'react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge, Button, Card, Disclosure, EmptyState, ErrorBox, Input, Spinner, StatusPill, Table } from '@/components/ui';
import { useApi } from '@/lib/api-client';
import { useFormat, useT } from '@/lib/i18n';
import type { ResourcesResponse, TaggedResource } from '@/server/aws/tagged-resources';

type Group = ResourcesResponse['groups'][number];
export function filterGroups(groups: Group[], query: string): Group[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups;
  return groups.map(g => ({ ...g, items: g.items.filter(i => [i.name, i.type, i.arn].some(v => v.toLowerCase().includes(q))) })).filter(g => g.items.length);
}
function Details({ item, t }: { item: TaggedResource; t: ReturnType<typeof useT<'resourcesPage'>> }) {
  const d = item.details ?? {};
  const pairs: [string, string | number | undefined][] = [[t('state'), d.state], [t('instanceType'), d.instanceType], [t('privateIp'), d.privateIp], [t('az'), d.az]];
  return <span className="text-xs text-fg-muted">{pairs.filter(([, v]) => v !== undefined).map(([k, v]) => `${k} ${v}`).join(' · ')}</span>;
}
export function ResourcesPage() {
  const t = useT('resourcesPage');
  const tc = useT('common');
  const { ago } = useFormat();
  const [query, setQuery] = React.useState('');
  const { data, isLoading, error, refetch, isFetching } = useApi<ResourcesResponse>('/api/resources', { refetch: 60_000 });
  const groups = React.useMemo(() => filterGroups(data?.groups ?? [], query), [data, query]);
  const total = data?.groups.reduce((n, g) => n + g.items.length, 0) ?? 0;
  return <div>
    <PageHeader title={t('title')} description={t('description')} actions={<Button size="sm" variant="ghost" onClick={() => void refetch()} loading={isFetching}>{t('refresh')}</Button>}>
      {data && <p className="mt-1 text-xs text-fg-muted">{t('tag')}: <code>{data.tag.key}={data.tag.value}</code> · {t('fetchedAt')}: {ago(data.fetchedAt)} · {t('count', { n: total })}</p>}
    </PageHeader>
    <div className="mb-3"><Input aria-label={t('search')} placeholder={t('search')} value={query} onChange={e => setQuery(e.target.value)} /></div>
    {error && <ErrorBox error={error} />}
    {isLoading && !data && <Spinner label={tc('loading')} />}
    {data && !data.groups.length && <EmptyState title={t('empty')} hint={t('emptyHint')} />}
    <div className="space-y-3">
      {groups.map(group => <Card key={group.service} padded={false}>
        <Disclosure title={<span className="flex items-center gap-2">{group.service}<Badge tone="neutral">{t('count', { n: group.items.length })}</Badge></span>} defaultOpen={group.service === 'EC2'}>
          {group.error && <p role="alert" className="px-3 pb-2 text-xs text-warning">{t('groupError', { message: group.error })}</p>}
          <Table dense head={[t('colName'), t('colType'), t('colRegion'), t('colDetails'), t('colConsole')]}>
            {group.items.map(item => <tr key={item.arn}>
              <td className="font-medium" title={item.arn}>{item.name}</td>
              <td>{item.type}</td>
              <td>{item.region}</td>
              <td>{item.details?.state ? <span className="flex items-center gap-2"><StatusPill status={String(item.details.state)} /><Details item={item} t={t} /></span> : <Details item={item} t={t} />}</td>
              <td>{item.consoleUrl ? <a className="text-accent underline" href={item.consoleUrl} target="_blank" rel="noreferrer">{t('open')}</a> : null}</td>
            </tr>)}
          </Table>
        </Disclosure>
      </Card>)}
    </div>
    <p className="mt-4 text-xs text-fg-faint">{t('source')}</p>
  </div>;
}
```
`useT`의 파라미터 치환(`{n}`, `{message}`)이 기존 `t(key, params)` 시그니처와 맞는지 `lib/i18n`에서 확인하고, 다르면 그 시그니처로 맞춘다(`jobs.ts`의 `deleteConfirm: '… {name} …'`가 같은 방식이다). `useFormat().ago`가 없으면 `fmtDate`류 기존 함수를 쓴다.

- [ ] **Step 4: 사이드바**

`Sidebar.tsx`: lucide import에 `Server` 추가; `groupCluster` items에 `{ href: '/resources', key: 'resources', icon: Server }`를 `compute` 다음에 넣는다.

- [ ] **Step 5: 검증**

Run: `cd dashboard/web && npm run typecheck && npm test -- src/components/pages/ResourcesPage.test.ts src/lib src/app/route-slugs.test.ts`
Expected: PASS(`no-hardcoded-strings.test.ts` 포함). 로컬 확인: `npm run dev:local -- --offline` 후 `/resources`가 렌더되고 빈 상태 문구가 보이면 충분.

- [ ] **Step 6: 커밋**

```bash
git add dashboard/web/src/lib/i18n dashboard/web/src/components/pages/ResourcesPage.tsx dashboard/web/src/components/pages/ResourcesPage.test.ts dashboard/web/src/app/resources dashboard/web/src/components/layout/Sidebar.tsx
git commit -m "feat(dashboard): read-only AWS resources page grouped by service with console links

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: 문서

**Files:**
- Modify: `dashboard/README.md` (주요 화면 표에 행 추가)
- Modify: `dashboard/docs/dashboard-features-and-aws-architecture.md` (§10 컴퓨트 뒤에 "리소스" 절, §24 표에 Tagging API 행)

- [ ] **Step 1: README 표 행**

`| 리소스 | 배포 태그(기본 PhysicalAI=true)가 붙은 계정 내 AWS 리소스를 서비스별로 나열하고 EC2는 상태·타입·IP를 함께 표시. 읽기 전용, 60초 캐시 |`

- [ ] **Step 2: 기능 문서**

새 절:
```
## 10a. 리소스

- 화면: `/resources`. `GET /api/resources`(60초 폴링, 서버 60초 캐시)가 Resource Groups Tagging API `GetResources`(TagFilters `RESOURCE_TAG_KEY=RESOURCE_TAG_VALUE`, 기본 `PhysicalAI=true`)를 페이지네이션해 서비스별로 묶고, EC2 인스턴스는 `DescribeInstances`로 상태·타입·프라이빗 IP·AZ를 보강합니다. 콘솔 링크는 EC2·FSx·EKS·HyperPod·S3·DynamoDB·Cognito에만 제공합니다.
- 쓰기 동작은 없습니다. 태그는 대시보드·GrootFinetune·IsaacLab·HyperPodEks 스택이 각자 붙이며, 태그가 없는 리소스는 보이지 않습니다.
```
§24 표에 `| AWS Resource Groups Tagging API | `GetResources` | 리소스 |` 추가.

- [ ] **Step 3: 커밋**

```bash
git add dashboard/README.md dashboard/docs/dashboard-features-and-aws-architecture.md
git commit -m "docs(dashboard): resources page and Tagging API in the feature document

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
