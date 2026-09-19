# Physical AI Dashboard — 기능별 AWS 아키텍처 다이어그램

`physical-ai-dashboard-features.drawio` 한 파일에 9개 페이지가 있으며, 각 페이지는 같은 이름의 `NN-*.drawio.png`로 내보내져 있습니다(PNG에 draw.io XML이 내장되어 draw.io에서 바로 다시 열 수 있음). 본문 설명은 [../dashboard-features-and-aws-architecture.md](../dashboard-features-and-aws-architecture.md)를 참조하세요.

| 페이지 | 파일 | 다루는 화면 |
|---|---|---|
| 00 전체 아키텍처 | `00-전체-아키텍처.drawio.png` | 배포 전체(Route 53 · ALB · Cognito · ECS Fargate 3서비스 · HyperPod EKS · DynamoDB · S3 · SageMaker · AMP …) |
| 01 로그인·인증·권한 | `01-로그인-인증-권한.drawio.png` | 로그인, 사이드바 로그아웃, 자격증명·API 토큰, 플랫폼 설정(사용자/감사) |
| 02 실행(워크플로) | `02-실행-워크플로.drawio.png` | 실행 목록, 새 실행, 실행 상세 7개 탭, 실시간 보기, 웹훅/알림 |
| 03 데이터셋 | `03-데이터셋.drawio.png` | 데이터셋 목록·상세, 멀티파트 업로드, PENDING→READY, FSx DRA |
| 04 모델·SageMaker 학습·MLflow | `04-모델-SageMaker-학습-MLflow.drawio.png` | 모델·평가, SageMaker 학습(파이프라인 + 아카이브), 실험 비교 |
| 05 시뮬레이션·개발 세션 | `05-시뮬레이션-개발-세션.drawio.png` | 워크스페이스 세션(gateway), 실시간 보기, Isaac Sim DCV 임베드 |
| 06 컴퓨트·대기열·K8s 작업·메트릭 | `06-컴퓨트-대기열-K8s-작업-메트릭.drawio.png` | HyperPod API, Kubernetes/Kueue, 노드 수 변경·복구, AMP |
| 07 파일·사용량·비용 | `07-파일-사용량-비용.drawio.png` | S3 브라우저, FSx DRA 작업, CPU/GPU-hour 사용량 통계, Cost Explorer |
| 08 설정 | `08-설정-프로젝트-이미지-빌드-웹훅-엣지-백엔드.drawio.png` | 프로젝트·구성원, 이미지·실행 환경, 환경 빌드, 웹훅, 엣지, 백엔드 연결 |

## 범례

- 실선: 요청/데이터 경로. 점선: 비동기·보조·조회. 보라색: controller(Fargate) 워커 루프. 녹색: 브라우저가 S3에 직접 전송하는 presigned 요청.
- 흰 상자: 코드/규칙 요약(파일 경로는 `dashboard/web/src/` 기준).
- 아이콘은 draw.io 내장 AWS Architecture Icons(`mxgraph.aws4`)이며, 이 draw.io 빌드에서 렌더링되는지 테스트 시트로 확인한 이름만 사용했습니다. 확인된 이름: cognito, eks, ecs, fargate, dynamodb, s3, sqs, step_functions, eventbridge, sns, route_53, sagemaker, sagemaker_model, sagemaker_train, fsx_for_lustre, cloudwatch, ecr, codebuild, systems_manager, parameter_store, secrets_manager, ec2, iot_core, greengrass, cost_explorer, certificate_manager, cloud_map, identity_and_access_management, key_management_service, container_2, managed_service_for_prometheus, users, client, internet, command_line_interface, application_load_balancer(standalone). 렌더링되지 않은 이름: general_AWScloud, managed_grafana, prometheus, elastic_kubernetes_service, iot_thing, iot_greengrass, cloudwatch_logs 계열 일부.

## 재생성

```bash
cd dashboard/docs/diagrams
./export.sh          # gen_diagrams.py 실행 후 페이지별 PNG 내보내기 (draw.io desktop CLI + xvfb 필요)
```

`gen_diagrams.py`는 페이지·노드·그룹·엣지를 파이썬 데이터로 정의하고 mxGraphModel XML을 생성합니다. 컨테이너 안 노드 좌표는 부모 기준 상대 좌표이며, 엣지의 exit/entry 포인트는 상대 위치로 자동 계산되고 필요하면 `points=[(x, y), …]`(절대 좌표) 웨이포인트로 경로를 지정합니다.

## 주요 설계 결정(다이어그램에 반영)

1. 로그인은 앱 코드가 아니라 ALB `authenticate-cognito`이며 web은 `x-amzn-oidc-*` JWT만 검증합니다.
2. 세션 트래픽은 대시보드 origin과 분리된 `*.apps.<domain>` 호스트로 gateway가 처리하고, Kubernetes `exec/portforward` 또는 SSM 포트포워딩(DCV)으로 연결합니다.
3. 결과물은 FSx → S3 데이터 버킷(DRA export) → 아티팩트 버킷(SHA-256 검증 사본 + manifest) 순서로만 "게시"되며 UI는 고정 manifest·VersionId만 읽습니다.
4. 레시피 실행은 SageMaker Training Job이 아니라 HyperPod EKS의 Kueue Job/JobSet입니다. SageMaker API는 HyperPod 클러스터·할당량·Pipelines·Model Registry·MLflow에만 사용합니다.
