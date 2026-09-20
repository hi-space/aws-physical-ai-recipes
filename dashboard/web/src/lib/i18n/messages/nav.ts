import { defineMessages } from '../define';

/** Sidebar navigation. Plain words first; the AWS/Kubernetes noun only where users must recognise it. */
export const nav = defineMessages({
  en: {
    brand: 'Physical AI', brandSub: 'Dashboard',
    groupResearch: 'Research', groupCluster: 'Cluster', groupSettings: 'Settings',
    overview: 'Home',
    workflows: 'Runs', workflowsHint: 'Recipe runs and their results',
    datasets: 'Datasets', models: 'Models', experiments: 'Experiments (MLflow)', pipelines: 'SageMaker training', sessions: 'Simulation & dev sessions',
    compute: 'Compute', queues: 'Queues & quotas', jobs: 'Kubernetes jobs', metrics: 'Metrics', storage: 'Files', usage: 'Usage & cost',
    projects: 'Projects & members', access: 'Credentials & API tokens', imageProfiles: 'Images & runtimes', edge: 'Devices & deployment',
    webhooks: 'Automation & webhooks', builds: 'Environment builds', backends: 'Backend connections', admin: 'Platform settings',
    resources: 'AWS resources',
    project: 'Research project', allProjects: 'All projects / past runs', selectProject: 'Select a project', projectsLoadFailed: 'Could not load projects.',
    notConfigured: 'Not configured in this deployment', detached: 'binding lost',
  },
  ko: {
    brand: 'Physical AI', brandSub: 'Dashboard',
    groupResearch: '연구', groupCluster: '클러스터', groupSettings: '설정',
    overview: '홈',
    workflows: '실행', workflowsHint: '레시피 실행과 결과',
    datasets: '데이터셋', models: '모델', experiments: '실험 비교 (MLflow)', pipelines: 'SageMaker 학습', sessions: '시뮬레이션·개발 세션',
    compute: '컴퓨트', queues: '대기열·할당량', jobs: 'Kubernetes 작업', metrics: '메트릭', storage: '파일', usage: '사용량·비용',
    projects: '프로젝트·구성원', access: '자격증명·API 토큰', imageProfiles: '이미지·실행 환경', edge: '디바이스·배포',
    webhooks: '자동화·웹훅', builds: '환경 빌드', backends: '백엔드 연결', admin: '플랫폼 설정',
    resources: 'AWS 리소스',
    project: '연구 프로젝트', allProjects: '전체 프로젝트 / 이전 실행', selectProject: '프로젝트 선택', projectsLoadFailed: '프로젝트를 불러오지 못했습니다.',
    notConfigured: '이 배포에서는 구성되지 않았습니다', detached: '바인딩 끊김',
  },
});
