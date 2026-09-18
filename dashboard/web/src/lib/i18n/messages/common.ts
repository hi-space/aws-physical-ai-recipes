import { defineMessages } from '../define';

/** Shared vocabulary: actions, table heads, states and generic feedback. Page modules add page-specific text. */
export const common = defineMessages({
  en: {
    // actions
    save: 'Save', saved: 'Saved', cancel: 'Cancel', close: 'Close', delete: 'Delete', remove: 'Remove', edit: 'Edit', create: 'Create', add: 'Add',
    retry: 'Retry', refresh: 'Refresh', copy: 'Copy', copied: 'Copied', download: 'Download', upload: 'Upload', search: 'Search',
    open: 'Open', view: 'View', details: 'Details', back: 'Back', next: 'Next', previous: 'Previous', apply: 'Apply', confirm: 'Confirm',
    run: 'Run', stop: 'Stop', start: 'Start', clone: 'Clone', export: 'Export', reset: 'Reset', select: 'Select', clear: 'Clear',
    showMore: 'Show more', showLess: 'Show less', expand: 'Expand', collapse: 'Collapse', learnMore: 'Learn more', filter: 'Filter',
    selectPublishedOutput: 'Select published output', publishedOutputHelp: 'Only READY versions published by completed runs can be selected.',
    // table heads / fields
    name: 'Name', status: 'Status', state: 'State', owner: 'Owner', namespace: 'Namespace', project: 'Project', created: 'Created',
    updated: 'Updated', started: 'Started', finished: 'Finished', duration: 'Duration', age: 'Age', size: 'Size', type: 'Type',
    version: 'Version', description: 'Description', tags: 'Tags', actions: 'Actions', id: 'ID', path: 'Path', image: 'Image',
    node: 'Node', queue: 'Queue', priority: 'Priority', progress: 'Progress', message: 'Message', reason: 'Reason', region: 'Region',
    account: 'Account', role: 'Role', user: 'User', email: 'Email', count: 'Count', total: 'Total', value: 'Value', key: 'Key',
    template: 'Template', task: 'Task', tasks: 'Tasks', workflow: 'Workflow', dataset: 'Dataset', model: 'Model', cluster: 'Cluster',
    // generic feedback
    loading: 'Loading…', loadingData: 'Loading data…', saving: 'Saving…', working: 'Working…', none: 'None', unknown: 'Unknown',
    notAvailable: 'N/A', empty: 'Nothing to show yet.', noResults: 'No results match the current filter.', yes: 'Yes', no: 'No',
    all: 'All', on: 'On', off: 'Off', enabled: 'Enabled', disabled: 'Disabled', readOnly: 'Read-only', optional: 'Optional',
    required: 'Required', more: 'more', items: '{count} items', selected: '{count} selected', page: 'Page {page}', perPage: 'up to {count} per page',
    justNow: 'just now', never: 'Never',
    // errors
    errorTitle: 'Something went wrong', errorGeneric: 'The request failed. Try again in a moment.', errorLoad: 'Could not load this data.',
    errorStale: 'The latest refresh failed; showing the previous result.', notConfiguredHint: 'Deploy the corresponding stack and redeploy the dashboard to enable this feature.',
    forbidden: 'You do not have permission for this action.', notConfigured: 'Not configured in this deployment', adminOnly: 'Admin only',
    confirmDelete: 'Delete "{name}"? This cannot be undone.', confirmGeneric: 'Are you sure?',
    // roles
    roleAdmin: 'Admin', roleResearcher: 'Researcher', roleViewer: 'Viewer', roleProjectAdmin: 'Project admin',
    // statuses (English shows the raw state name)
    stSucceeded: 'Succeeded', stRunning: 'Running', stPending: 'Pending', stQueued: 'Queued', stWaiting: 'Waiting', stFailed: 'Failed',
    stCancelled: 'Cancelled', stCancelling: 'Cancelling', stFinalizing: 'Finalizing', stSkipped: 'Skipped', stReady: 'Ready', stActive: 'Active',
    stCompleted: 'Completed', stStopped: 'Stopped', stStopping: 'Stopping', stStarting: 'Starting', stCreating: 'Creating', stUpdating: 'Updating',
    stDeleting: 'Deleting', stExecuting: 'Executing', stInProgress: 'In progress', stInService: 'In service', stError: 'Error', stDegraded: 'Degraded',
    stUnschedulable: 'Unschedulable', stSchedulable: 'Schedulable', stEvicted: 'Evicted', stMissing: 'Missing', stAvailable: 'Available',
    stAdmitted: 'Admitted', stSuspended: 'Suspended', stFinished: 'Finished', stEnabled: 'Enabled', stUnready: 'Not ready', stUnknown: 'Unknown',
    // language switch
    language: 'Language', logout: 'Sign out', signedInAs: 'Signed in as',
  },
  ko: {
    save: '저장', saved: '저장했습니다', cancel: '취소', close: '닫기', delete: '삭제', remove: '제거', edit: '수정', create: '만들기', add: '추가',
    retry: '재시도', refresh: '새로 고침', copy: '복사', copied: '복사됨', download: '다운로드', upload: '업로드', search: '검색',
    open: '열기', view: '보기', details: '상세', back: '뒤로', next: '다음', previous: '이전', apply: '적용', confirm: '확인',
    run: '실행', stop: '중지', start: '시작', clone: '복제', export: '내보내기', reset: '초기화', select: '선택', clear: '지우기',
    showMore: '더 보기', showLess: '접기', expand: '펼치기', collapse: '접기', learnMore: '자세히', filter: '필터',
    selectPublishedOutput: '게시된 출력 선택', publishedOutputHelp: '완료된 작업이 게시한 READY 버전만 선택할 수 있습니다.',
    name: '이름', status: '상태', state: '상태', owner: '소유자', namespace: '네임스페이스', project: '프로젝트', created: '생성',
    updated: '수정', started: '시작', finished: '종료', duration: '소요 시간', age: '경과', size: '크기', type: '유형',
    version: '버전', description: '설명', tags: '태그', actions: '작업', id: 'ID', path: '경로', image: '이미지',
    node: '노드', queue: '대기열', priority: '우선순위', progress: '진행', message: '메시지', reason: '사유', region: '리전',
    account: '계정', role: '역할', user: '사용자', email: '이메일', count: '개수', total: '전체', value: '값', key: '키',
    template: '레시피', task: '작업', tasks: '작업', workflow: '워크플로', dataset: '데이터셋', model: '모델', cluster: '클러스터',
    loading: '불러오는 중…', loadingData: '데이터를 불러오는 중…', saving: '저장 중…', working: '처리 중…', none: '없음', unknown: '알 수 없음',
    notAvailable: '해당 없음', empty: '아직 표시할 항목이 없습니다.', noResults: '조건에 맞는 항목이 없습니다.', yes: '예', no: '아니요',
    all: '전체', on: '켬', off: '끔', enabled: '사용', disabled: '사용 안 함', readOnly: '읽기 전용', optional: '선택',
    required: '필수', more: '더', items: '{count}개', selected: '{count}개 선택', page: '{page}페이지', perPage: '페이지당 최대 {count}개',
    justNow: '방금', never: '없음',
    errorTitle: '문제가 발생했습니다', errorGeneric: '요청에 실패했습니다. 잠시 후 다시 시도하세요.', errorLoad: '데이터를 불러오지 못했습니다.',
    errorStale: '최신 조회에 실패해 이전 결과를 표시합니다.', notConfiguredHint: '해당 스택을 배포한 뒤 대시보드를 다시 배포하면 이 기능이 켜집니다.',
    forbidden: '이 작업을 수행할 권한이 없습니다.', notConfigured: '이 배포에서는 구성되지 않았습니다', adminOnly: '관리자 전용',
    confirmDelete: '"{name}"을(를) 삭제할까요? 되돌릴 수 없습니다.', confirmGeneric: '계속할까요?',
    roleAdmin: '관리자', roleResearcher: '연구원', roleViewer: '뷰어', roleProjectAdmin: '프로젝트 관리자',
    stSucceeded: '성공', stRunning: '실행 중', stPending: '대기', stQueued: '대기열', stWaiting: '대기 중', stFailed: '실패',
    stCancelled: '취소됨', stCancelling: '취소 중', stFinalizing: '결과 저장 중', stSkipped: '건너뜀', stReady: '준비됨', stActive: '활성',
    stCompleted: '완료', stStopped: '중지됨', stStopping: '중지 중', stStarting: '시작 중', stCreating: '생성 중', stUpdating: '업데이트 중',
    stDeleting: '삭제 중', stExecuting: '실행 중', stInProgress: '진행 중', stInService: '서비스 중', stError: '오류', stDegraded: '성능 저하',
    stUnschedulable: '배치 불가', stSchedulable: '배치 가능', stEvicted: '퇴출됨', stMissing: '없음', stAvailable: '사용 가능',
    stAdmitted: '승인됨', stSuspended: '일시 중지', stFinished: '종료', stEnabled: '사용', stUnready: '준비 안 됨', stUnknown: '알 수 없음',
    language: '언어', logout: '로그아웃', signedInAs: '로그인 계정',
  },
});
