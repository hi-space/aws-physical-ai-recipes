# Project = HyperPod Team: ComputeQuota 채택 + Cognito 그룹 멤버십

날짜: 2026-09-20 · 상태: 구현 완료 (feat/hyperpod-dashboard, 배포 전) — 하단 "구현 결과"·"후속" 참조

## 배경

대시보드의 "프로젝트"는 DynamoDB에만 존재하는 논리 엔티티였다. HyperPod Task
Governance의 Team(= `ComputeQuota` → `hyperpod-ns-<team>` 네임스페이스 + Kueue
LocalQueue)과는 `namespace` 문자열 명명 규칙으로만 연결되었고, 참조가 없어 드리프트를
감지할 수 없었다. 멤버십은 `Project.members`(Cognito subject → 역할) 맵으로 DynamoDB에
따로 살았는데, 플랫폼 역할은 이미 Cognito 그룹(`admins`/`researchers`)으로 판정된다.

AWS 문서(HyperPod task governance › Policies)는 Team을 이렇게 정의한다:

> **Team name**: A corresponding **Namespace** will be created, of type `hyperpod-ns-team-name`.
> **Members**: … You will need to set up a Kubernetes RBAC for data scientist users …

즉 Team은 컴퓨트 정체성이고, 멤버십은 Task Governance 밖에서 관리해야 한다. 이 설계는
컴퓨트 축을 ComputeQuota에, 멤버십 축을 Cognito 그룹에 각각 네이티브로 붙인다.

## 결정 (사용자 확정)

| 결정 | 선택 |
|---|---|
| 범위 | 두 축 모두 — ComputeQuota 참조 + Cognito 그룹 멤버십 |
| 진실의 원천 | **명시적 채택(adopt)**: 관리자가 ComputeQuota를 골라 프로젝트로 채택. DynamoDB 레코드는 얇은 바인딩 |
| 역할 모델 | 프로젝트별 2그룹 `proj-<id>`(멤버), `proj-<id>-admin`(관리자) + 플랫폼 역할 합성 |
| 기존 데이터 | 깔끔 리셋. `workshop` 프로젝트/레코드 삭제, 산출물 이동 없음, 마이그레이션 코드 없음 |
| 플랫폼 viewer + `proj-x-admin` | `project-admin`으로 취급(멤버 관리 가능, 실행은 플랫폼 조건으로 계속 차단) |
| 클라이언트 응답 | `members` 맵 대신 `myRole`만 내려줌. 멤버 목록은 별도 API |

## 1. 데이터 모델

### Project (DynamoDB `PROJECT#<id>` / `META`, `gsi1pk=TYPE#PROJECT`)

```ts
interface Project {
  id: string;               // == ComputeQuota TeamName. ^[a-z][a-z0-9-]{0,39}$ — 숫자 시작 팀은 채택 거부
  name: string;             // 표시 이름. 기본값 TeamName, 관리자가 수정 가능
  computeQuotaId: string;   // SageMaker ComputeQuotaId — 바인딩의 실체
  clusterArn: string;       // 채택 당시 HyperPod 클러스터 ARN
  backendId?: string;       // 없으면 default (기존 규칙)
  backendConfigHash?: string;
  credentialRefs: string[]; // 유지 — AWS 대응물 없음
  description?: string;
  createdAt: string; updatedAt: string;
}
```

삭제되는 필드: `members`(Cognito 그룹으로). `namespace`/`queue`는 **저장하지 않지만 타입에는 남는다** —
`projectFromItem`이 읽는 시점에 `id`로부터 채워 반환하므로, `project.namespace`/`project.queue`를 읽는
약 30곳의 호출부는 바뀌지 않는다. 쓰기 시점(`projectItem`)에는 두 필드를 제거한다.

파생 함수 (`projects.ts`):

```ts
export const namespaceOf = (p: Pick<Project, 'id'>) => `hyperpod-ns-${p.id}`;
export const queueOf = (p: Pick<Project, 'id'>) => `${namespaceOf(p)}-localqueue`;
export const projectIdFromNamespace = (ns: string) => /^hyperpod-ns-([a-z][a-z0-9-]{0,39})$/.exec(ns)?.[1];
```

### 예약 아이템 (채택 트랜잭션, 모두 `condition: absent`)

- `PROJECT#<id>` / `META`
- `PROJECT_NAMESPACE#<backendId>#hyperpod-ns-<id>` / `OWNER` (기존; default 백엔드는 접두어 없는 키도 함께 — 기존 규칙 유지)
- `PROJECT_QUOTA#<computeQuotaId>` / `OWNER` `{ projectId }` — 같은 쿼터의 이중 채택 차단

### 불변

- 워크플로우/데이터셋/템플릿/세션/모델의 `projectId` 필드, GSI `PROJECT#<id>#WF`, 스토리지
  prefix `projects/<id>/`·`datasets/projects/<id>/`·`checkpoints/projects/<id>/`와
  `assertStorageScope` — 변경 없음. id의 의미만 "팀 이름"이 된다.

### 파생 상태 (저장 안 함)

`attachment: 'ATTACHED' | 'DETACHED' | 'UNKNOWN'` — 섹션 4.

### Cognito 그룹

- `proj-<id>` — 멤버. `proj-<id>-admin` — 프로젝트 관리자(단독으로도 멤버십 부여).
- `proj-` 접두어로 플랫폼 그룹(`admins`/`researchers`/`viewers`)과 분리. 채택 시 생성, 프로젝트 삭제 시 삭제.
- **`-admin`으로 끝나는 팀 이름은 채택 거부** — `proj-<x>-admin`이 "프로젝트 x의 관리자 그룹"인지 "프로젝트 x-admin의 멤버 그룹"인지
  구분할 수 없기 때문. `projectIdPattern`은 `^(?!.*-admin$)[a-z][a-z0-9-]{0,39}$`이고 `projectRoleFromGroups`도 방어적으로 같은 규칙을 적용한다.
- 한계: Cognito 사용자당 그룹 100개 → 사용자당 최대 ~50 프로젝트. 문서화만 한다.

## 2. 인증/세션

### `Session.groups: string[]`, 헤더 `x-pai-groups` (쉼표 구분)

`proxy.ts`의 네 경로 모두 채운다:

| 경로 | 출처 | 추가 호출 |
|---|---|---|
| ALB + Cognito | `readGroupsFromAccessToken()` 반환값 (이미 호출 중) | 없음 |
| 직접 Cognito 로그인 | `identity.groups` | 없음 |
| API 토큰 | `verifyApiToken()`이 `TokenSession.groups`를 반환 — 내부 `current()`가 이미 `currentUserAuthorization()`으로 그룹을 받아옴 | 없음 |
| 로컬 dev | `DEV_GROUPS` (기본 `admins`). `DEV_ROLE` 제거 | — |

`sessionFromHeaders`는 헤더가 없으면 `groups: []`. 플랫폼 `role`은 기존처럼 별도 헤더로 유지(파생 재계산하지 않음).

### 신선도 — 기존과 동일하게 이원화

- 브라우저: 액세스 토큰 클레임. 그룹 변경은 토큰 갱신 후 반영(플랫폼 역할과 동일한 지연).
- API 토큰·게이트웨이·로그 인증: `currentUserAuthorization()` 신선 조회 유지. KV `members` 읽기만 제거.

### `rbac.ts`

```ts
export type ProjectRole = 'viewer' | 'researcher' | 'project-admin';
export const PROJECT_ROLE_RANK: Record<ProjectRole, number> = { viewer: 0, researcher: 1, 'project-admin': 2 };
export const projectGroup = (id: string) => `proj-${id}`;
export const projectAdminGroup = (id: string) => `proj-${id}-admin`;
/** 플랫폼 그룹 × 프로젝트 그룹 합성. 비멤버는 undefined. */
export function projectRoleFromGroups(groups: readonly string[], projectId: string): ProjectRole | undefined {
  if (groups.includes(projectAdminGroup(projectId))) return 'project-admin';
  if (!groups.includes(projectGroup(projectId))) return undefined;
  return roleFromGroups(groups) === 'viewer' ? 'viewer' : 'researcher';
}
```

`ProjectRole` 타입은 `projects.ts`에서 `rbac.ts`로 이동(re-export 유지).

## 3. 권한 헬퍼와 호출부

### 단일 진입점 (`projects.ts`)

```ts
export function memberRole(session: Session, project: Pick<Project, 'id'>): ProjectRole | undefined {
  if (session.tokenProjectId && session.tokenProjectId !== project.id) return undefined;
  if (session.role === 'admin') return 'project-admin';
  return projectRoleFromGroups(session.groups, project.id);
}
export const isMember = (s: Session, p: Pick<Project, 'id'>) => memberRole(s, p) !== undefined;
export const canWriteIn = (s: Session, p: Pick<Project, 'id'>) => { const r = memberRole(s, p); return r !== undefined && r !== 'viewer'; };
export const isProjectAdmin = (s: Session, p: Pick<Project, 'id'>) => memberRole(s, p) === 'project-admin';
```

### 기존 헬퍼 — 시그니처 유지, 내부 교체

- `listProjects`: GSI 전체 → `filter(p => isMember(session, p))`.
- `resolveProject(session, id, repo, required)`: `memberRole` 랭크 비교. `workshop` 폴백 제거.
- `canReadResource` / `filterAccessible`: KV 읽기 제거, `memberRole`만. `filterAccessible`은 `listProjects` 호출도 제거.
- `assertNamespaceAccess(session, namespace, write, backend)`: `projectIdFromNamespace`로 역파생 → `memberRole`. 백엔드 매칭은 프로젝트 META 1회 읽기로 유지(`backendId` 대조).
- `requestProject`: `ensureDefaultProject` 호출 제거.
- `updateProjectMembers` → 삭제.
- 신규 `setProjectMembership(session, id, username, role: ProjectRole | null)` — `isProjectAdmin` 필요.
  `cognito.setProjectGroups(username, projectId, role)`가 해당 프로젝트의 두 그룹에 대해서만
  `AdminAddUserToGroup`/`AdminRemoveUserFromGroup` 호출(전체 교체인 `setGroups`는 쓰지 않음).
  `role === 'viewer' | 'researcher'` → `proj-<id>`만; `'project-admin'` → 둘 다; `null` → 둘 다 제거.
  viewer/researcher 구분은 플랫폼 그룹이 결정하므로 UI는 "멤버 / 프로젝트 관리자 / 제외" 3택.
- 신규 `listProjectMembers(session, id)` — `cognito.listUsers()`(그룹 포함) → `projectRoleFromGroups` ≠ undefined인 사용자만.

### 호출부 치환 규칙

| 기존 | 교체 |
|---|---|
| `Object.hasOwn(project.members, subject)` | `isMember(session, project)` |
| `['researcher','project-admin'].includes(project.members[subject])` | `canWriteIn(session, project)` |
| `project.members[subject] === 'project-admin'` | `isProjectAdmin(session, project)` |
| `session.role !== 'viewer' && …` 선행 조건 | 그대로 유지 |

세션이 없는 네 곳(`api-tokens.ts` `projectMembership`, `logs/auth.ts`, `gateway/auth.ts` `currentSession`,
`gateway/token-grants.ts`)은 `projectRoleFromGroups(user.groups, projectId)`를 직접 호출. KV
`members` 읽기 줄은 삭제하되 프로젝트 존재·`namespaceOf(project) === wf.namespace`·백엔드
해시 대조는 유지.

`gateway/auth.ts`의 `currentSession`은 현재 세션 소유자 그룹을 조회하지 않으므로
`currentUserAuthorization(s.owner)`를 추가 호출한다 — 세션 레코드의 `owner`가 이미 Cognito username이다.
반환된 `subject`가 `s.ownerSubject`와 다르면 거부. 토큰 바인딩 세션(`hasTokenBinding`)은 기존
`authorizeDerivedToken` 경로 그대로.

`/api/me`의 `project.role` → `memberRole`. `/api/projects` 응답에 `myRole` 포함.

## 4. 채택 흐름과 DETACHED

### `POST /api/projects` (admin) — body `{ computeQuotaId, backendId?, name?, description?, credentialRefs? }`

`runOnBackend(input, …)` 안에서:

1. `hp.describeComputeQuota(computeQuotaId)` (신규 래퍼) → `TeamName`, `ClusterArn`, `Status`.
2. `id = TeamName`; 규칙 불일치(숫자 시작 등) → 400 `팀 이름이 프로젝트 식별자 규칙에 맞지 않습니다`.
3. `ClusterArn`이 현재 백엔드의 `describeCluster(hyperPodClusterName).ClusterArn`과 다르면 400.
4. 비-default 백엔드는 `profile.namespaces.includes(namespaceOf)` 확인(기존 규칙).
5. `listLocalQueues()`에 `queueOf`가 존재해야 함(기존 확인 유지 — 쿼터 생성 후 K8s 리소스 반영 지연 방어).
6. Cognito 그룹 2개 생성(`CreateGroup`, `GroupExistsException`은 무시).
7. 트랜잭션 put(섹션 1). 실패 시 그룹은 남겨둠(멱등이므로 재시도 무해) — 400 `이미 채택된 팀 또는 쿼터`.

기존 `namespace` 기반 body는 제거. `ensureDefaultProject` 삭제.

### `GET /api/projects`, `GET /api/projects/[id]`

응답: `Project & { namespace, queue, myRole, attachment }`.

`attachment`는 백엔드별 `listComputeQuotas(clusterArn)` 결과를 **모듈 캐시 60초**로 재사용해 계산:
- 목록에 `ComputeQuotaId`가 있고 `TeamName === id` → `ATTACHED`
- 목록 조회 성공했으나 없음 → `DETACHED`
- 조회 실패 → `UNKNOWN`

`requestProject`/`resolveProject` 핫패스는 SageMaker를 호출하지 않는다.

### `PATCH /api/projects/[id]` (project-admin) — `{ name?, description?, credentialRefs? }`

메타만. 멤버는 아래 전용 API.

### 멤버 API

- `GET /api/projects/[id]/members` (project-admin) → `{ members: [{ username, subject, email, role }] }`
- `PUT /api/projects/[id]/members/[username]` (project-admin) — `{ role: 'member' | 'project-admin' | null }`.
  `member`는 `proj-<id>`만, `project-admin`은 둘 다, `null`은 제거. audit `project.members`.

### `DELETE /api/projects/[id]` (admin)

채택 레코드(META + OWNER 3종)와 Cognito 그룹 2개 삭제. ComputeQuota와 S3/FSx/워크플로우
데이터는 건드리지 않는다. 남은 `projectId` 자원은 플랫폼 admin에게만 보인다. audit `project.delete`.

### 폴백 제거

`resolveProject`의 `PROJECT#workshop` 폴백과 `ensureDefaultProject` 삭제. 프로젝트가 없을 때:
- 비-admin: 403 `참여 중인 프로젝트가 없습니다. 관리자에게 요청하세요.`
- admin: `/projects`에서 채택하라는 빈 상태.

## 5. UI

### ProjectsPage

- "새 프로젝트" 폼 → **"팀 채택"**: 백엔드 선택(기존) + `GET /api/quotas?backendId=`의 쿼터 중
  아직 채택되지 않은 것 드롭다운(`TeamName · 인스턴스 요약 · fair-share`). 이름 기본값 TeamName.
- 프로젝트 카드: `attachment` 배지(ATTACHED 초록 / DETACHED 경고 / UNKNOWN 회색), 네임스페이스·큐 표시.
- 구성원 패널: `GET …/members` 목록 + 사용자 검색(`/api/admin/users`는 admin 전용이므로
  project-admin은 목록에서만 역할 변경, 신규 추가는 username 입력) → `PUT …/members/[username]`.
  역할 3택: 멤버 / 프로젝트 관리자 / 제외. 안내문: "읽기·실행 권한은 플랫폼 역할(researchers 그룹)이 결정".
- 삭제 버튼(admin): 확인 다이얼로그 → `DELETE`.

### ProjectSwitcher

DETACHED 프로젝트에 경고 아이콘. 선택은 허용(과거 결과 열람).

### SessionsPage

`eligibleProjects` → `myRole !== 'viewer'` 기준.

### QueuesPage

ComputeQuota 표에 "프로젝트" 열: 채택된 쿼터는 프로젝트 링크, 아니면 "채택" 링크(`/projects?quota=<id>&backendId=`).

### i18n

`projects.ts`에 ko/en 동시 추가: adoptTeam, team, attachment 상태 3종, memberRoleMember,
memberRoleAdmin, memberRemove, platformRoleHint, deleteProject, deleteConfirm, noQuotas, quotaAdopted.

## 6. 인프라와 리셋

### CDK (`infra/lib/dashboard-stack.ts`)

web 태스크 롤에 `cognito-idp:CreateGroup`, `cognito-idp:DeleteGroup`, `cognito-idp:GetGroup` 추가.
`sagemaker:DescribeComputeQuota`/`ListComputeQuotas`/`DescribeCluster`는 `/api/quotas`가 이미 사용 — 확인만.

`proj-*` 그룹은 런타임 생성이므로 CDK 변경 없음.

### 로컬 dev

`DEV_ROLE` → `DEV_GROUPS` (예: `admins` 또는 `researchers,proj-team-a`). README 갱신.

### 배포 리셋 런북 (`docs/runbooks/2026-09-20-project-reset.md`, 스펙과 함께 작성)

1. 배포 전: 실행 중 워크플로우 없음 확인. **삭제는 배포 뒤에** — 옛 코드의 `ensureDefaultProject`가 admin 요청마다 `workshop`을 재생성한다.
2. 배포(`-c sourceBuildProjectId=team-a` 필수 — 소스빌드 CodeBuild/ECR 타깃이 채택 팀 이름을 따른다).
3. `infra/ops/legacy-project-reset.sh`로 `PROJECT#workshop` 파티션·관련 항목을 백업하고 설정 레코드(META, 네임스페이스 OWNER,
   이미지 프로필/리비전, 토큰, 웹훅, 소스 등록, 자격증명)만 삭제. 실행 이력(PIPELINE·EVALUATION·TRACKING, `projectId` 달린 WF/DS/TPL 등)은 남긴다.
   실제 환경에는 `PROJECT_NAMESPACE#default#…` 변형이 없었다(비접두 키 1건만 존재).
4. 관리자 로그인 → `/projects` → default 백엔드 → `team-a` 쿼터 채택.
5. 이미지 프로필은 프로젝트 단위이므로 `team-a`에서 builtin 프로필 seed → 승인(안 하면 모든 제출이 `image_preflight_blocked`).
6. 기존 사용자를 `proj-team-a` / `proj-team-a-admin`에 추가 → 재로그인(토큰 갱신).
7. `projects/workshop/` 등 S3/FSx 산출물은 그대로 둔다(admin만 열람 가능). 필요 시 수동 정리.

## 7. 테스트

- `rbac.test.ts`: `projectRoleFromGroups` 매트릭스(플랫폼 3역할 × 프로젝트 그룹 4조합).
- `projects.test.ts`(신규) / `project-boundaries.test.ts`(개정): `memberRole` 토큰 바인딩·admin 우회,
  `listProjects` 그룹 필터, `filterAccessible`가 KV를 읽지 않음(kv.get 스파이 0회), `assertNamespaceAccess`
  역파생, 채택 트랜잭션(describeComputeQuota·createGroup 목), 숫자 시작 TeamName 거부, ClusterArn
  불일치 거부, 쿼터 이중 채택 거부, `attachment` 3상태와 60초 캐시.
- `api-tokens.test.ts`, `logs/stream.test.ts`, `gateway/auth.test.ts`, `gateway/token-grants.test.ts`:
  픽스처를 `members` → `currentUser().groups`로 전환. `TokenSession.groups` 반환 확인.
- 픽스처(`token-fixtures.test-helpers.ts`, `pipeline-fixtures.ts`, `edge/fixtures.ts`): `members` 제거,
  세션에 `groups` 부여하는 헬퍼 `sessionFor(subject, ...groups)` 추가.
- `ProjectsPage.browser.test.ts`(신규): 채택 드롭다운이 미채택 쿼터만 표시, DETACHED 배지, 멤버 역할 변경 호출.
- 기존 `members`를 참조하는 30개 테스트 파일은 컴파일 오류로 누락이 드러나므로 `tsc --noEmit`을 게이트로.

## 범위 밖

- ComputeQuota 자체의 생성/수정 UI 변경(QueuesPage 기존 기능 유지).
- 멤버십을 EKS Access Entry/K8s RBAC까지 내리는 것 — 대시보드는 자체 서비스 계정으로 K8s에 접근하므로 불필요.
- 기존 `workshop` 데이터 마이그레이션.

## 구현 결과 (2026-09-20)

`feat/hyperpod-dashboard`에 `795d7c7..` 로 구현 완료(배포 전). 실행 중 확정된 추가 규칙:

- **`-admin`으로 끝나는 팀 이름 채택 거부**(§1 참조).
- **`sessions.ts refresh()`**: 붙어 있는 세션의 소유자를 Cognito에서 신선 조회해 그룹을 얻는다. `UserNotFoundException`/비활성/subject 불일치만 세션 종료 사유이고, 그 외 Cognito 오류는 503으로 표면화되어 세션을 닫지 않는다.
- **CAS 조건에서 `namespace` 제거**: `execution-profiles.ts`, `image-profiles.ts`의 낙관적 잠금은 `updatedAt`(+`backendId`)만 사용한다. 파생 필드는 CAS 토큰이 될 수 없다.
- `ComputeQuota`가 아닌 **팀 재바인딩**은 백엔드 변경으로만 표현된다(네임스페이스는 id의 함수).
- `attachmentsFor`는 인가 핫패스에서는 호출하지 않지만, 채택/수정 **응답 정형화**에는 사용한다(60초 캐시).

## 후속

- `deleteProject`에서 META 삭제 후 그룹 삭제가 실패하면 Cognito 그룹이 고아가 된다(재시도 시 `not found`). 그룹 정리 도구 또는 순서 재검토.
- 채택 트랜잭션 경합 시 먼저 만든 Cognito 그룹이 남는다(멱등이므로 재채택으로 해소).
- 프로젝트 삭제 다이얼로그의 브라우저 테스트 없음.
- 플랫폼 admin은 프로젝트 그룹 없이도 credentials/tokens 라우트에서 `canWrite/canShare`가 참이다(설계 의도: admin = 모든 프로젝트의 project-admin). 감사 관점에서 재검토 여지.
- `cognito-idp:GetGroup` IAM 권한은 현재 코드가 호출하지 않는다(§6 목록 유지).
- 사용자당 Cognito 그룹 100개 한도 → 1인당 최대 ~50 프로젝트.
- `src/server/workflow-adapters/artifact-inventory.test.ts`의 ctime 플레이크는 이 변경과 무관하게 샌드박스 FS에서 실패한다.
- 레거시 정리(2026-09-20): CDK 소스빌드 타깃의 `projectId: 'workshop'` 하드코딩을 context `sourceBuildProjectId`(필수)로 바꾸고, Pod Identity 기본 네임스페이스 목록에서 클러스터에 존재하지 않는 `rl`을 제외했다. 남은 코드 레거시는 `DEFAULT_NAMESPACE`(`config().defaultNamespace`, 기본 `rl`) — 프로젝트 없는 제출 경로(`submitBoundWorkflow` else 분기, 테스트·재시도)가 아직 쓰므로 유지. 데이터 정리 결과는 런북 §0 표 참조.
- 이 변경 전부터 떠 있던 `next dev`(Turbopack)는 `projects.ts`의 새 export를 반영하지 못해 `GET /api/projects`가 500(`memberRole is not a function`)을 냈다. 코드 결함이 아니라 HMR 모듈 그래프 stale 문제이며 dev 서버 재시작으로 해소된다. 재시작 직후 로그의 `Export createProject doesn't exist` 오류는 `.next/dev` 영속 캐시 재생이고 첫 컴파일 후 사라진다.
