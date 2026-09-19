import { defineMessages } from '../define';

export const logs = defineMessages({
  en: {
    task: 'Task', target: 'Pod', targetLatest: 'Latest attempt · first member',
    attempt: 'Attempt', member: 'Member', container: 'Container',
    follow: 'Follow', live: 'Live', ended: 'Ended', podGone: 'Pod removed', notStarted: 'Not started',
    filterLabel: 'Filter logs', filterPlaceholder: 'Search logs…', reopen: 'Reopen', downloadShown: 'Download shown logs',
    logRegion: 'Task log', noLogsYet: 'No log lines yet.',
    podGoneInfo: 'Logs are read from the Pod through the Kubernetes API and are available only while the Pod exists. Nothing is stored by the dashboard.',
    redactionUnavailable: 'Secret redaction could not be verified for this Pod; values injected as credentials may appear in plain text.',
    limitInfo: 'Shows up to 5,000 lines per request; the view keeps the last 10,000 lines.',
    truncatedWarning: 'Earlier lines were trimmed from the view.',
    connectionLost: 'Connection lost. Reconnecting from the last timestamp…',
    permissionExpired: 'Log permission expired. Reopen the log.', loadFailed: 'Log lookup failed',
  },
  ko: {
    task: '작업', target: 'Pod', targetLatest: '최근 시도 · 첫 번째 멤버',
    attempt: '시도', member: '멤버', container: '컨테이너',
    follow: '계속 보기', live: '실시간', ended: '종료', podGone: 'Pod 삭제됨', notStarted: '시작 전',
    filterLabel: '로그 필터', filterPlaceholder: '로그 검색…', reopen: '다시 열기', downloadShown: '표시 로그 다운로드',
    logRegion: '작업 로그', noLogsYet: '아직 로그 줄이 없습니다.',
    podGoneInfo: '로그는 Kubernetes API로 Pod에서 직접 읽으며 Pod가 있는 동안만 볼 수 있습니다. 대시보드는 로그를 저장하지 않습니다.',
    redactionUnavailable: '이 Pod의 비밀값 필터를 검증할 수 없어 자격증명으로 주입된 값이 그대로 보일 수 있습니다.',
    limitInfo: '요청당 최대 5,000줄을 읽고 화면은 최근 10,000줄을 유지합니다.',
    truncatedWarning: '이전 화면 내용이 잘렸습니다.',
    connectionLost: '연결이 끊어졌습니다. 마지막 시각부터 다시 연결합니다.',
    permissionExpired: '로그 권한이 만료되었습니다. 다시 열어 주세요.', loadFailed: '로그 조회 실패',
  },
});
