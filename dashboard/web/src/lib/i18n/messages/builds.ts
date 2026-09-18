import { defineMessages } from '../define';

export const builds = defineMessages({
  en: {
    // page header
    title: 'Builds', description: 'Build project sources into immutable images, tracking source versions and result digests.',
    // sources section
    sourcesCard: 'Build sources', noTargets: 'No registered source build tasks.', noTargetsHint: 'A platform administrator needs to connect CodeBuild tasks and ECR repositories for this project.',
    noProjectHint: 'Source registration and build history belong to the selected project.',
    selectTarget: 'Select a registered build task', selectTargetOption: 'Select registered task', sourceName: 'Build source name', sourceNamePlaceholder: 'Example: Research code snapshot',
    registerSource: 'Register source', registeredSources: 'Registered build sources', sourceDisabled: 'Configuration changed',
    sourceDetails: 'Source configuration (read-only)', repoUrl: 'Repository URL', s3Snapshot: 'S3 snapshot · {versionId}', sourceHash: 'Registration hash', sourceSha256: 'Source SHA256',
    dockerfile: 'Dockerfile', context: 'Context', sourceSelect: 'Select source', previousSources: 'View previous sources', recentSources: 'View recent sources',
    // build execution
    buildCard: 'Start build', fullCommitSha: 'Full Git commit SHA', commitPlaceholder: '40-character commit SHA',
    startBuild: 'Start image build', buildNote: 'Image profiles need approval and runtime validation before running workflows. Build history preserves verified sources and resulting image digests.',
    // history section
    historyCard: 'Project build history', noBuildHistory: 'No source build history yet.',
    previousBuilds: 'View previous builds', recentBuilds: 'View recent builds',
    // detail section
    detailCard: 'Build status, source, and logs', cancelButton: 'Cancel build', cancelNote: 'Cancel request recorded. Final state reflects actual job completion.',
    diagnostics: 'Diagnostics: {code}', startUncertain: 'Start response unconfirmed. To prevent duplicate runs, new builds do not start automatically. Check the registered task execution history.',
    recoveryInput: 'CodeBuild run ID to recover', recoveryPlaceholder: '{project}:run-ID', recoveryButton: 'Confirm recovered execution',
    // provenance
    provenance: 'Build provenance', resolvedImage: 'Verified output image', sourceArchiveSha: 'Source archive SHA256',
    dockerfileSha: 'Dockerfile SHA256', environment: 'Execution environment', envNote: 'Model and workflow execution not verified. External dependency reproducibility not guaranteed.',
    connectImage: 'Review and approve image with source provenance',
    // logs
    logsLabel: 'Source build logs', logsLoading: 'Loading logs…', logsTruncated: 'Response size limited; showing partial logs.',
    // admin operations
    adminOps: 'Platform administrator tasks', adminNote: 'Operations tasks sync project execution permissions and network policies.',
    operationCard: 'Task to run', projectSelect: 'Build project', startOp: 'Start task',
    historyCardAdmin: 'Execution history', noHistoryAdmin: 'No execution history yet.',
    historyPhase: 'Phase', historySource: 'Source', registrationSuccess: 'Project build source registered.',
    buildSubmitted: 'Build request submitted.',
    cancelRequested: 'Cancellation requested. Watching for termination confirmation.',
    recoverySuccess: 'Matched execution linked to recovery request ID.',
  },
  ko: {
    title: '환경 빌드·동기화', description: '프로젝트 소스를 불변 이미지로 빌드하고 소스 버전과 결과 digest를 추적합니다.',
    sourcesCard: '빌드 출처', noTargets: '등록된 소스 빌드 작업이 없습니다.', noTargetsHint: '플랫폼 관리자가 이 프로젝트의 CodeBuild 작업과 ECR 저장소를 연결해야 합니다.',
    noProjectHint: '소스 등록과 빌드 이력은 선택한 프로젝트에 속합니다.',
    selectTarget: '등록할 소스 작업', selectTargetOption: '등록된 작업 선택', sourceName: '빌드 출처 이름', sourceNamePlaceholder: '예: 연구 코드 스냅샷',
    registerSource: '출처 등록', registeredSources: '등록된 빌드 출처', sourceDisabled: '구성 변경됨',
    sourceDetails: '소스 구성 (읽기 전용)', repoUrl: '저장소 URL', s3Snapshot: 'S3 스냅샷 · {versionId}', sourceHash: '등록 해시', sourceSha256: '소스 SHA256',
    dockerfile: 'Dockerfile', context: 'context', sourceSelect: '출처 선택', previousSources: '이전 출처 보기', recentSources: '최근 출처 보기',
    buildCard: '이미지 빌드 시작', fullCommitSha: '전체 Git commit SHA', commitPlaceholder: '40자리 commit SHA',
    startBuild: '이미지 빌드 시작', buildNote: '워크플로 실행 전 이미지 프로필 승인과 실행 환경 검증이 필요합니다. 빌드 이력에는 검사한 소스와 결과 이미지 digest를 보관합니다.',
    historyCard: '프로젝트 빌드 이력', noBuildHistory: '아직 소스 빌드 이력이 없습니다.',
    previousBuilds: '이전 빌드 보기', recentBuilds: '최근 빌드 보기',
    detailCard: '빌드 상태·출처·로그', cancelButton: '빌드 취소', cancelNote: '취소 요청 기록이 있습니다. 최종 상태는 실제 작업 종료 결과입니다.',
    diagnostics: '진단: {code}', startUncertain: '시작 응답을 확인하지 못했습니다. 중복 실행을 막기 위해 새 빌드를 자동으로 시작하지 않습니다. 등록된 작업의 실행 기록 확인이 필요합니다.',
    recoveryInput: '복구할 CodeBuild 실행 ID', recoveryPlaceholder: '{project}:실행-ID', recoveryButton: '동일 요청 실행 확인',
    provenance: '빌드 계보', resolvedImage: '검증한 결과 이미지', sourceArchiveSha: '소스 archive SHA256',
    dockerfileSha: 'Dockerfile SHA256', environment: '실행 환경', envNote: '모델·워크플로 실행은 검증하지 않았습니다. 외부 의존성의 동일한 재해석도 보장하지 않습니다.',
    connectImage: '소스 계보를 연결해 이미지 승인 검토',
    logsLabel: '소스 빌드 로그', logsLoading: '로그를 불러오는 중…', logsTruncated: '응답 크기 제한으로 로그 일부만 표시합니다.',
    adminOps: '플랫폼 관리자 작업', adminNote: 'Operations 작업은 프로젝트 실행 권한과 네트워크 정책을 동기화합니다.',
    operationCard: '실행할 작업', projectSelect: '빌드 프로젝트', startOp: '작업 시작',
    historyCardAdmin: '실행 이력', noHistoryAdmin: '아직 실행 이력이 없습니다.',
    historyPhase: '단계', historySource: '소스', registrationSuccess: '프로젝트 빌드 출처를 등록했습니다.',
    buildSubmitted: '빌드 요청을 저장했습니다.',
    cancelRequested: '취소를 요청했습니다. 종료 확인까지 실행 상태를 표시합니다.',
    recoverySuccess: '요청 식별자가 일치하는 실행을 연결했습니다.',
  },
});
