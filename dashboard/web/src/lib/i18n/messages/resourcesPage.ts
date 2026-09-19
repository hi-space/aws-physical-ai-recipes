import { defineMessages } from '../define';

/** The `/resources` page: every AWS resource carrying the deployment tag, grouped by service. Read-only. */
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
