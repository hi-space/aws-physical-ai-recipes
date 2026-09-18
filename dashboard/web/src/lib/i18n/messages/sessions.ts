import { defineMessages } from '../define';

export const sessions = defineMessages({
  en: {
    // page header & description
    title: 'Simulation · development sessions', description: 'Open personal research workspace or connect to running tasks.',
    resourceSource: 'DynamoDB session records · Kubernetes API Deployment · Service · Ingress · Pod / EC2 DescribeInstances · StartInstances · StopInstances (workstation)',
    notConfigured: 'This deployment has no session host domain (GATEWAY_BASE_DOMAIN) configured. Cannot open apps, terminals, files, or DCV sessions. Configure domain then redeploy.',
    // intro
    intro: 'Open personal research workspace or connect to one of your running tasks. Workspaces use your project queue and close when time expires.',
    newSessionButton: 'New session',
    // main card
    cardTitle: 'Development sessions', cardDesc: '{liveCount} active · {totalCount} total',
    noSessions: 'No development sessions', noSessionsHint: 'Create JupyterLab, VS Code or TensorBoard, or attach terminal to running task.',
    // table headers
    // session table rows
    sessionKind: '{kind}', sessionId: '{id}', sessionOwner: '{owner}',
    sessionTaskInfo: '{taskName} · attempt {attempt} · replica {replicaIndex}', sessionLegacy: 'Legacy',
    sessionProjectName: '{projectName}', sessionQueue: '{queue}', sessionNamespace: '{namespace}',
    sessionStatus: '{status}', sessionMessage: '{message}',
    sessionExpired: 'Expired · cleanup pending', sessionExpiringIn: '{minutes} min remaining', sessionNoExpiry: 'No managed expiry',
    sessionClosed: 'Closed', sessionEndAndRecreate: 'End and recreate to launch', sessionExpiresAt: '{time}',
    // session actions
    sessionOpenButton: 'Open', sessionExtendButton: 'Extend', sessionEndButton: 'End',
    sessionConfirmEnd: 'End {name} session {id}?', sessionEndedToast: 'Session ended', sessionEndingToast: 'Access revoked; waiting for resources to terminate',
    sessionExtendedToast: 'Expiry extended. Open session again to refresh connection.', sessionReadyToast: 'Task session is ready to open',
    sessionQueuedToast: 'Session submitted to project queue',
    // create dialog
    dialogTitle: 'New development session', dialogCancel: 'Cancel', dialogCreate: 'Create session',
    dialogProjectLabel: 'Project', dialogProjectEmpty: 'Select your project', dialogProjectHint: 'Ask project administrator to add your Cognito subject as researcher.',
    dialogProjectQueue: 'Queue: {queue}', dialogApplicationLabel: 'Application',
    // applications
    appJupyterLab: 'JupyterLab', appVsCode: 'VS Code', appTensorBoard: 'TensorBoard', appTerminal: 'Task terminal', appPortForward: 'Task application',
    // tensorboard section
    dialogTensorboardLabel: 'Project log directory', dialogTensorboardPlaceholder: '/fsx/checkpoints/projects/{projectId}/runs/…',
    dialogTensorboardHint: 'Choose existing run directory in this project. Logs mounted read-only.',
    // workflow attachment section
    dialogWorkflowLabel: 'Your running workflow', dialogWorkflowEmpty: 'Select workflow', dialogWorkflowHint: 'No workflow you own is running in this project.',
    dialogTaskLabel: 'Running task', dialogTaskEmpty: 'Select task', dialogTaskHint: 'No ready pod for current attempt. Refresh after task starts.',
    dialogTaskAttempt: '{name} · attempt {attempts}',
    dialogReplicaLabel: 'Ready replica', dialogReplicaOption: 'Replica {index}',
    // port forward section
    dialogPortLabel: 'Registered application port', dialogPortEmpty: 'Select named port', dialogPortHint: 'Only named TCP ports declared on task container can be opened.',
    // time limit
    dialogTimeLabel: 'Time limit (minutes)',
    // extend dialog
    extendDialogTitle: 'Extend session', extendDialogCancel: 'Cancel', extendDialogSave: 'Save expiry',
    extendDialogLabel: 'Minutes from now', extendDialogNote: 'Sessions have 24-hour maximum lifetime. Reopen after extending to refresh authenticated connection.',
    // DCV admin section
    adminDcvTitle: 'Existing workstation / DCV administration', adminDcvDesc: 'Administrator access · managed DCV session integration is configured separately',
    adminDcvLoading: 'Loading workstation…', adminDcvError: '{error}', adminDcvInstanceId: '{instanceId} · {instanceType}',
    adminDcvStarted: 'Started {time}', adminDcvStart: 'Start workstation', adminDcvStop: 'Stop workstation',
    adminDcvStopConfirm: 'Stop workstation and disconnect active desktop users?', adminDcvOpenDcv: 'Open DCV', adminDcvOpenEditor: 'Open workstation editor',
    adminDcvCredentials: 'Reveal credentials', adminDcvCredentialsHint: 'Hidden automatically after 60 seconds', adminDcvHide: 'Hide',
    // HyperPod nodes section
    adminNodesTitle: 'Existing HyperPod node access', adminNodesOrchestrator: '{orchestrator}', adminNodesInstance: '{instanceId} · {instanceType}',
    adminNodesLogin: 'Login: {login}',
    // DCV browser specific
    dcvBrowserCardTitle: 'Isaac Sim desktop',
    dcvBrowserCardDesc: 'Existing workshop workstation · admin-only shared environment',
    dcvBrowserReady: 'Browser connection ready',
    dcvBrowserNotReady: 'Connection setup required',
    dcvBrowserViewHere: 'View here',
    dcvBrowserOpenNew: 'Open in new window',
    dcvBrowserSetup: 'Set up browser connection',
    dcvBrowserCloseConnection: 'Close my connection',
    dcvBrowserInfo: 'Open desktop with Cognito login. Access is valid for 1 hour; closing the connection keeps the shared workstation and existing tasks.',
    dcvBrowserTitle: 'Isaac Sim DCV desktop',
    dcvBrowserClient: 'DCV web client · runs from session host origin and disconnects when expired.',
    dcvBrowserClose: 'Close',
    colSession: 'Session', colProjectQueue: 'Project / queue', colReadiness: 'Readiness', colExpires: 'Expires', colActions: 'Actions',
  },
  ko: {
    // page header & description
    title: '시뮬레이션·개발 세션', description: '개인 연구 워크스페이스를 열거나 실행 중인 작업에 연결합니다.',
    resourceSource: 'DynamoDB session records · Kubernetes API Deployment · Service · Ingress · Pod / EC2 DescribeInstances · StartInstances · StopInstances (workstation)',
    notConfigured: '이 배포에는 세션 호스트 도메인(GATEWAY_BASE_DOMAIN)이 설정되지 않아 앱·터미널·파일·DCV 세션을 열 수 없습니다. 도메인을 구성한 뒤 다시 배포하세요.',
    // intro
    intro: '개인 연구 워크스페이스를 열거나 실행 중인 작업 중 하나에 연결합니다. 워크스페이스는 프로젝트 대기열을 사용하며 시간 만료 시 종료됩니다.',
    newSessionButton: '새 세션',
    // main card
    cardTitle: '개발 세션', cardDesc: '{liveCount}개 활성 · 전체 {totalCount}개',
    noSessions: '개발 세션 없음', noSessionsHint: 'JupyterLab, VS Code, TensorBoard를 만들거나 실행 중인 작업에 터미널을 연결하세요.',
    // table headers
    // session table rows
    sessionKind: '{kind}', sessionId: '{id}', sessionOwner: '{owner}',
    sessionTaskInfo: '{taskName} · 시도 {attempt} · replica {replicaIndex}', sessionLegacy: 'Legacy',
    sessionProjectName: '{projectName}', sessionQueue: '{queue}', sessionNamespace: '{namespace}',
    sessionStatus: '{status}', sessionMessage: '{message}',
    sessionExpired: '만료됨 · 정리 대기 중', sessionExpiringIn: '{minutes}분 남음', sessionNoExpiry: '관리형 만료 없음',
    sessionClosed: '종료됨', sessionEndAndRecreate: '종료 후 다시 만들기', sessionExpiresAt: '{time}',
    // session actions
    sessionOpenButton: '열기', sessionExtendButton: '연장', sessionEndButton: '종료',
    sessionConfirmEnd: '{name} 세션 {id}를 종료할까요?', sessionEndedToast: '세션 종료됨', sessionEndingToast: '액세스 취소됨; 리소스 종료 대기 중',
    sessionExtendedToast: '만료 연장됨. 세션을 다시 열어 연결 새로 고침.', sessionReadyToast: 'Task 세션을 열 준비됨',
    sessionQueuedToast: '세션이 프로젝트 대기열에 제출됨',
    // create dialog
    dialogTitle: '새 개발 세션', dialogCancel: '취소', dialogCreate: '세션 만들기',
    dialogProjectLabel: '프로젝트', dialogProjectEmpty: '프로젝트 선택', dialogProjectHint: '프로젝트 관리자에게 Cognito subject를 연구원으로 추가 요청',
    dialogProjectQueue: '대기열: {queue}', dialogApplicationLabel: '애플리케이션',
    // applications
    appJupyterLab: 'JupyterLab', appVsCode: 'VS Code', appTensorBoard: 'TensorBoard', appTerminal: 'Task terminal', appPortForward: 'Task application',
    // tensorboard section
    dialogTensorboardLabel: '프로젝트 로그 디렉터리', dialogTensorboardPlaceholder: '/fsx/checkpoints/projects/{projectId}/runs/…',
    dialogTensorboardHint: '이 프로젝트의 기존 실행 디렉터리 선택. 로그는 읽기 전용 마운트.',
    // workflow attachment section
    dialogWorkflowLabel: '실행 중인 워크플로', dialogWorkflowEmpty: '워크플로 선택', dialogWorkflowHint: '이 프로젝트에서 소유한 실행 중인 워크플로 없음.',
    dialogTaskLabel: '실행 중인 작업', dialogTaskEmpty: '작업 선택', dialogTaskHint: '현재 시도에 준비된 pod 없음. 작업 시작 후 새로 고침.',
    dialogTaskAttempt: '{name} · 시도 {attempts}',
    dialogReplicaLabel: '준비된 replica', dialogReplicaOption: 'Replica {index}',
    // port forward section
    dialogPortLabel: '등록된 애플리케이션 포트', dialogPortEmpty: '명명된 포트 선택', dialogPortHint: '작업 컨테이너에서 선언한 명명된 TCP 포트만 열 수 있음.',
    // time limit
    dialogTimeLabel: '시간 제한 (분)',
    // extend dialog
    extendDialogTitle: '세션 연장', extendDialogCancel: '취소', extendDialogSave: '만료 저장',
    extendDialogLabel: '지금부터의 분 수', extendDialogNote: '세션 최대 수명은 24시간. 연장 후 세션 다시 열어 인증 연결 새로 고침.',
    // DCV admin section
    adminDcvTitle: '기존 워크스테이션 / DCV 관리', adminDcvDesc: '관리자 액세스 · 관리형 DCV 세션 통합 별도 구성',
    adminDcvLoading: '워크스테이션 불러오는 중…', adminDcvError: '{error}', adminDcvInstanceId: '{instanceId} · {instanceType}',
    adminDcvStarted: '시작됨 {time}', adminDcvStart: '워크스테이션 시작', adminDcvStop: '워크스테이션 중지',
    adminDcvStopConfirm: '워크스테이션을 중지하고 활성 데스크톱 사용자 연결 해제?', adminDcvOpenDcv: 'DCV 열기', adminDcvOpenEditor: '워크스테이션 편집기 열기',
    adminDcvCredentials: '자격 증명 표시', adminDcvCredentialsHint: '60초 후 자동 숨김', adminDcvHide: '숨기기',
    // HyperPod nodes section
    adminNodesTitle: '기존 HyperPod 노드 액세스', adminNodesOrchestrator: '{orchestrator}', adminNodesInstance: '{instanceId} · {instanceType}',
    adminNodesLogin: '로그인: {login}',
    // DCV browser specific
    dcvBrowserCardTitle: 'Isaac Sim 데스크톱',
    dcvBrowserCardDesc: '기존 워크숍 워크스테이션 · 관리자 전용 공유 환경',
    dcvBrowserReady: '브라우저 연결 준비됨',
    dcvBrowserNotReady: '연결 준비 필요',
    dcvBrowserViewHere: '여기서 보기',
    dcvBrowserOpenNew: '새 창에서 열기',
    dcvBrowserSetup: '브라우저 연결 준비',
    dcvBrowserCloseConnection: '내 연결 종료',
    dcvBrowserInfo: 'Cognito 로그인으로 데스크톱을 엽니다. 접속은 1시간 동안 유효하며, 종료해도 공유 워크스테이션과 기존 작업은 유지됩니다.',
    dcvBrowserTitle: 'Isaac Sim DCV 데스크톱',
    dcvBrowserClient: 'DCV 웹 클라이언트 · 세션 호스트 origin에서 실행되며 만료 시 끊깁니다.',
    dcvBrowserClose: '닫기',
    colSession: '세션', colProjectQueue: '프로젝트 / 대기열', colReadiness: '준비 상태', colExpires: '만료', colActions: '작업',
  },
});
