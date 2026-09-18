import { defineMessages } from '../define';

export const pipelines = defineMessages({
  en: {
    // PipelinesPage
    title: 'Pipelines', description: '{projectName} ({projectId}) · SageMaker managed pipeline',
    resourceSource: 'SageMaker DescribePipeline · ListPipelineExecutions · DescribePipelineExecution · ListPipelineExecutionSteps · DescribeTrainingJob / CloudWatch Logs GetLogEvents',
    selectProject: 'Select research project.',
    noProjectTracking: 'Current pipeline definition has no project experiment tags. Apply new definition to use project MLflow comparison. Existing unscoped experiments are admin-only.',
    startExecution: 'Start execution', discardDraft: 'Discard unsaved draft', discardDraftNote: 'Discard saved draft to create new draft in currently selected project.',
    // pipeline description
    pipelineDesc: 'Runs as SageMaker managed Processing / Training Job. Start HyperPod workflow execution separately on workflows page.',
    pipelineArn: 'Pipeline ARN', executionRole: 'Current definition execution role', versionName: 'Current definition version name',
    versionDesc: 'Current definition version description', lastModified: 'Current definition modified',
    status: 'Status', created: 'Created',
    parametersSection: 'Parameters', defaultValue: 'default: {value}',
    // execution list
    executionList: 'Execution list', executionCount: '{count}', noExecutions: 'No execution history.',
    // steps explanation
    stepsTitle: 'Pipeline steps',
    step1: 'TransformDataset — input data preprocessing', step2: 'GR00TFinetune — GR00T fine-tuning',
    step3: 'SmokeEval — model load · inference operation check', step4: 'SmokeGate — smoke results check',
    step5: 'RegisterModel — model artifact registration',
    // dialog
    dialogTitle: 'Start pipeline execution', dialogProject: '{projectName} ({projectId})',
    dialogOwnerMismatch: 'Log in with account that created this draft, then verify same request.',
    dialogUnsupportedParameters: 'This definition has parameters browser storage does not allow. Verify parameter configuration.',
    dialogPipelineChanged: 'Pipeline target changed. Discard unsaved draft and verify current target.',
    dialogLocked: 'Execution response confirmation required. Project · parameters · request key pinned to prevent duplicate execution. Closing or refreshing will retry with same request.',
    dialogInvalidNumbers: 'Check numeric parameters: {params}. Empty values cannot be submitted.',
    dialogQuickValidation: 'Quick validation performs short training and model load · inference check. Robot motion quality evaluation is separate.',
    dialogQuickButton: 'Quick validation setup', dialogDisplayName: 'Execution name (optional)', dialogDisplayNameAriaLabel: 'Execution name', dialogDisplayNamePlaceholder: 'e.g. training-v1',
    dialogCancelButton: 'Cancel', dialogSubmitButton: 'Run', dialogRetryButton: 'Retry same request',
    // messages
    loadingPipelines: 'Loading pipelines…', loadingProject: 'Loading…', loadingExecution: 'Loading execution…',
    toastSubmitted: 'Execution request submitted.', executionArnInvalid: 'Did not receive execution ARN. Verify with same request.',
    executionArnNotReceived: 'Did not receive execution ARN. Check execution list.',
    executionDraftRejected: 'Execution request not submitted. Edit values and send new request.',
    // PipelineExecutionPage - archive panel
    archiveTitle: 'Project model archive', archiveDesc: 'Pin actual file · version · checksum from completed SageMaker output to project archive. Does not re-run training.',
    archiveWarning: 'Only successfully completed executions can be archived. OOM · capacity exhaustion · cancellation are not treated as successful GR00T training.',
    archiveTrainingStep: 'Training step that created model', archiveReports: 'Reports to archive together',
    archiveButton: 'Validate · archive completed output', archiveNote: 'Reports imported from completed steps using this model as input only. Does not create quality approval from smoke pass or existing Registry Approved status.',
    archiveLoading: 'Checking archive status…', noArchives: 'No archived project model outputs.',
    archiveStatusReady: 'READY', archiveStatusFailed: 'FAILED', archiveStatusPending: 'PENDING', archiveStatusArchiving: 'ARCHIVING',
    archiveDataset: '{name} · v{version}', archiveManifest: 'Manifest SHA-256: {hash}', archiveDirectory: '{count} model files bundle digest and tar.gz full file digest pinned separately.',
    archiveReportsList: 'Archive reports: {reports}', archiveModelInput: 'Model name', archiveModelButton: 'Register model from archive output',
    archiveRetry: 'Retry archive', archiveCancel: 'Cancel archive', archiveLink: 'Open registered model · evaluation history',
    archiveDefaultModelName: '{executionName} model',
    // execution header
    executionPageTitle: '{name}', executionPageDescription: '{projectName} ({projectId}) · SageMaker managed execution',
    executionNote: 'SageMaker managed Processing / Training Job execution path. HyperPod workflow has separate execution path.',
    executionPipelineArn: '{arn}', executionExecutionArn: '{arn}', executionVersionId: 'Execution definition version: {version}',
    executionStatus: 'Status', executionCreatedTime: 'Created', executionLastModified: 'Last modified', executionFailureReason: 'Failure reason',
    // execution parameters
    executionParameters: 'Parameters',
    // execution steps
    executionStepsTitle: 'Pipeline steps', executionStepName: '{index}. {name}', executionStepDuration: '{duration}',
    executionStepStarted: 'Started: {time}', executionStepEnded: 'Ended: {time}', executionStepFailure: 'Failure: {reason}',
    // training job selection
    trainingJobSelectionTitle: 'Training Job selection', trainingJobSelectionLabel: 'Training Job step',
    trainingJobSelectionEmpty: 'Select step', trainingJobSelectionNote: '{name} Training Job ARN not yet available.',
    trainingJobSelectionFineTune: ' · fine-tuning', trainingJobSelectionSmoke: ' · model load · inference check',
    // training job detail
    trainingJobTitle: 'Training Job · {step}', trainingJobName: '{name}',
    trainingJobStatus: 'Status', trainingJobSecondaryStatus: 'Secondary Status',
    trainingJobInstanceType: 'Instance Type', trainingJobInstanceCount: 'Instance Count', trainingJobBillableTime: 'Billable Time',
    trainingJobModelArtifacts: 'Model Artifacts', trainingJobHyperparameters: 'Hyperparameters',
    trainingJobHyperparametersExpanded: '{expanded ? ▼ : ▶} Hyperparameters', trainingJobLogs: 'Logs (last 300 lines)',
    // training job stop
    stopPipelineButton: 'Stop execution', stopPipelineConfirm: 'Stop this pipeline execution and running steps?',
    stopPipelineAccepted: 'Stop requested',
    // mlflow link
    openMlflowButton: 'Open in MLflow',
    // draft storage errors
    draftRestoreError: 'Could not restore saved execution request. Check execution history before creating a new request.',
    draftSaveError: 'Could not save execution request to this tab. Try again when storage is available.',
    draftClearError: 'Received execution response but could not clear request history in this tab. Verify with the same request.',
  },
  ko: {
    // PipelinesPage
    title: '파이프라인', description: '{projectName} ({projectId}) · SageMaker 관리형 파이프라인',
    resourceSource: 'SageMaker DescribePipeline · ListPipelineExecutions · DescribePipelineExecution · ListPipelineExecutionSteps · DescribeTrainingJob / CloudWatch Logs GetLogEvents',
    selectProject: '연구 프로젝트를 선택하세요.',
    noProjectTracking: '현재 파이프라인 정의에는 프로젝트 실험 태그가 없습니다. 프로젝트 MLflow 비교를 사용하려면 새 정의를 적용해야 합니다. 기존 unscoped 실험은 관리자 전용입니다.',
    startExecution: '실행 시작', discardDraft: '미제출 초안 버리기', discardDraftNote: '저장된 초안을 버리면 현재 선택한 프로젝트에서 새 초안을 작성할 수 있습니다.',
    // pipeline description
    pipelineDesc: 'SageMaker 관리형 Processing / Training Job으로 실행합니다. HyperPod 워크플로 실행은 워크플로 페이지에서 별도로 시작합니다.',
    pipelineArn: '파이프라인 ARN', executionRole: '현재 정의의 실행 역할', versionName: '현재 정의 버전 이름',
    versionDesc: '현재 정의 버전 설명', lastModified: '현재 정의 변경 시각',
    status: '상태', created: '생성 시각',
    parametersSection: '파라미터', defaultValue: 'default: {value}',
    // execution list
    executionList: '실행 목록', executionCount: '{count}개', noExecutions: '실행 이력이 없습니다.',
    // steps explanation
    stepsTitle: '파이프라인 단계',
    step1: 'TransformDataset — 입력 데이터 전처리', step2: 'GR00TFinetune — GR00T 파인튜닝',
    step3: 'SmokeEval — 모델 로드·추론 동작 확인', step4: 'SmokeGate — smoke 결과 확인',
    step5: 'RegisterModel — 모델 아티팩트 등록',
    // dialog
    dialogTitle: '파이프라인 실행', dialogProject: '{projectName} ({projectId})',
    dialogOwnerMismatch: '이 초안을 만든 계정으로 로그인한 뒤 동일 요청을 확인하세요.',
    dialogUnsupportedParameters: '이 정의에는 브라우저 저장을 허용하지 않은 파라미터가 있습니다. 파라미터 구성을 확인하세요.',
    dialogPipelineChanged: '파이프라인 대상이 변경되었습니다. 미제출 초안을 버리고 현재 대상을 확인하세요.',
    dialogLocked: '실행 응답 확인이 필요합니다. 중복 실행을 막기 위해 프로젝트·파라미터·요청 키를 고정했습니다. 창을 닫거나 새로 고침해도 동일 요청으로 재시도합니다.',
    dialogInvalidNumbers: '숫자 파라미터를 확인하세요: {params}. 빈 값은 제출할 수 없습니다.',
    dialogQuickValidation: 'Quick 검증은 짧은 학습과 모델 로드·추론 확인을 수행합니다. 로봇 동작 품질 평가는 별도입니다.',
    dialogQuickButton: 'Quick 검증 설정', dialogDisplayName: '실행 이름 (선택)', dialogDisplayNameAriaLabel: '실행 이름', dialogDisplayNamePlaceholder: '예: training-v1',
    dialogCancelButton: '취소', dialogSubmitButton: '실행', dialogRetryButton: '동일 요청 재시도',
    // messages
    loadingPipelines: '파이프라인을 불러오는 중…', loadingProject: '불러오는 중…', loadingExecution: '실행을 불러오는 중…',
    toastSubmitted: '실행 요청을 접수했습니다.', executionArnInvalid: '실행 ARN을 받지 못했습니다. 동일 요청으로 다시 확인하세요.',
    executionArnNotReceived: '실행 ARN을 받지 못했습니다. 실행 목록을 확인하세요.',
    executionDraftRejected: '실행 요청이 접수되지 않았습니다. 값을 수정한 뒤 새 요청을 보낼 수 있습니다.',
    // PipelineExecutionPage - archive panel
    archiveTitle: '프로젝트 모델 보관', archiveDesc: '완료된 SageMaker 출력의 실제 파일·버전·체크섬을 프로젝트 보관소에 고정합니다. 학습을 다시 실행하지 않습니다.',
    archiveWarning: '성공적으로 완료된 실행만 보관할 수 있습니다. OOM·용량 부족·중단 결과는 성공한 GR00T 학습으로 취급하지 않습니다.',
    archiveTrainingStep: '모델을 생성한 학습 단계', archiveReports: '함께 보관할 평가 보고서',
    archiveButton: '완료 출력 검증·보관', archiveNote: '보고서는 이 모델을 입력으로 사용한 완료 단계에서만 가져옵니다. Smoke 통과나 기존 Registry Approved 상태로 품질 승인을 만들지 않습니다.',
    archiveLoading: '보관 상태 확인 중…', noArchives: '보관된 프로젝트 모델 출력이 없습니다.',
    archiveStatusReady: 'READY', archiveStatusFailed: 'FAILED', archiveStatusPending: 'PENDING', archiveStatusArchiving: 'ARCHIVING',
    archiveDataset: '{name} · v{version}', archiveManifest: 'Manifest SHA-256: {hash}', archiveDirectory: '{count}개 모델 파일의 묶음 digest와 tar.gz 전체 파일 digest를 따로 고정했습니다.',
    archiveReportsList: '보관 보고서: {reports}', archiveModelInput: '등록할 모델 이름', archiveModelButton: '보관 출력에서 모델 등록',
    archiveRetry: '보관 재시도', archiveCancel: '보관 취소', archiveLink: '등록 모델·평가 이력 열기',
    archiveDefaultModelName: '{executionName} 모델',
    // execution header
    executionPageTitle: '{name}', executionPageDescription: '{projectName} ({projectId}) · SageMaker 관리형 실행',
    executionNote: 'SageMaker 관리형 Processing / Training Job 실행 경로입니다. HyperPod 워크플로는 별도 실행 경로입니다.',
    executionPipelineArn: '{arn}', executionExecutionArn: '{arn}', executionVersionId: '실행 정의 버전: {version}',
    executionStatus: '상태', executionCreatedTime: '생성 시각', executionLastModified: '최근 변경', executionFailureReason: '실패 사유',
    // execution parameters
    executionParameters: '파라미터',
    // execution steps
    executionStepsTitle: '파이프라인 단계', executionStepName: '{index}. {name}', executionStepDuration: '{duration}',
    executionStepStarted: 'Started: {time}', executionStepEnded: 'Ended: {time}', executionStepFailure: 'Failure: {reason}',
    // training job selection
    trainingJobSelectionTitle: 'Training Job 선택', trainingJobSelectionLabel: 'Training Job 단계',
    trainingJobSelectionEmpty: '단계를 선택하세요', trainingJobSelectionNote: '{name}의 Training Job ARN이 아직 없습니다.',
    trainingJobSelectionFineTune: ' · 파인튜닝', trainingJobSelectionSmoke: ' · 모델 로드·추론 확인',
    // training job detail
    trainingJobTitle: 'Training Job · {step}', trainingJobName: '{name}',
    trainingJobStatus: 'Status', trainingJobSecondaryStatus: 'Secondary Status',
    trainingJobInstanceType: 'Instance Type', trainingJobInstanceCount: 'Instance Count', trainingJobBillableTime: 'Billable Time',
    trainingJobModelArtifacts: 'Model Artifacts', trainingJobHyperparameters: 'Hyperparameters',
    trainingJobHyperparametersExpanded: '{expanded ? ▼ : ▶} Hyperparameters', trainingJobLogs: 'Logs (last 300 lines)',
    // training job stop
    stopPipelineButton: '실행 중단', stopPipelineConfirm: '이 파이프라인 실행과 실행 중인 단계를 중단할까요?',
    stopPipelineAccepted: '중단 요청 접수됨',
    // mlflow link
    openMlflowButton: 'MLflow에서 열기',
    // draft storage errors
    draftRestoreError: '저장된 실행 요청을 복원하지 못했습니다. 새 요청을 만들기 전에 기존 실행 기록을 확인하세요.',
    draftSaveError: '이 탭에 실행 요청을 저장하지 못했습니다. 저장소를 사용할 수 있을 때 다시 시도하세요.',
    draftClearError: '실행 응답은 받았지만 이 탭의 요청 기록을 정리하지 못했습니다. 동일 요청으로 다시 확인하세요.',
  },
});
