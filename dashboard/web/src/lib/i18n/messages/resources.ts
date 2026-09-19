import { defineMessages } from '../define';

/** Labels for the AWS resources behind a page (ResourceStrip) and the architecture map on the home page. */
export const resources = defineMessages({
  en: {
    stripTitle: 'AWS resources behind this page', source: 'Data source', openConsole: 'Open in AWS console', notConfigured: 'not configured',
    region: 'Region', account: 'Account',
    hyperPodCluster: 'HyperPod cluster', hyperPodSlurm: 'HyperPod cluster (Slurm)', eksCluster: 'EKS cluster', namespace: 'Kubernetes namespace', serviceAccount: 'Service account',
    dataBucket: 'Data bucket (S3)', artifactsBucket: 'Artifacts bucket (S3)', fsx: 'FSx for Lustre', fsxMount: 'FSx mount', amp: 'Prometheus workspace (AMP)',
    mlflow: 'MLflow tracking server', pipeline: 'SageMaker pipeline', pipelineRole: 'Pipeline execution role', modelGroup: 'Model package group', trainingLogGroup: 'Training job logs',
    trainingImage: 'Training image', clusterLogGroup: 'Cluster logs', dcvInstance: 'Workstation (EC2)', thingGroup: 'IoT thing group', component: 'Greengrass component',
    userPool: 'Cognito user pool', table: 'DynamoDB table', costExplorer: 'Cost Explorer',
  },
  ko: {
    stripTitle: '이 페이지가 읽는 AWS 자원', source: '데이터 출처', openConsole: 'AWS 콘솔에서 열기', notConfigured: '구성되지 않음',
    region: '리전', account: '계정',
    hyperPodCluster: 'HyperPod 클러스터', hyperPodSlurm: 'HyperPod 클러스터 (Slurm)', eksCluster: 'EKS 클러스터', namespace: 'Kubernetes 네임스페이스', serviceAccount: '서비스 계정',
    dataBucket: '데이터 버킷 (S3)', artifactsBucket: '아티팩트 버킷 (S3)', fsx: 'FSx for Lustre', fsxMount: 'FSx 마운트', amp: 'Prometheus 워크스페이스 (AMP)',
    mlflow: 'MLflow 추적 서버', pipeline: 'SageMaker 파이프라인', pipelineRole: '파이프라인 실행 역할', modelGroup: '모델 패키지 그룹', trainingLogGroup: '학습 작업 로그',
    trainingImage: '학습 이미지', clusterLogGroup: '클러스터 로그', dcvInstance: '워크스테이션 (EC2)', thingGroup: 'IoT 사물 그룹', component: 'Greengrass 컴포넌트',
    userPool: 'Cognito 사용자 풀', table: 'DynamoDB 테이블', costExplorer: 'Cost Explorer',
  },
});
