# 대시보드 학습 템플릿 HyperPod 실행 검증 (2026-09-19)

배포된 대시보드(physical-ai.hi-yoo.com, 프로젝트 `workshop`, 네임스페이스 `hyperpod-ns-team-a`)의 학습 계열 템플릿을 실제로 제출해 HyperPod EKS 클러스터(c5.4xlarge×2, g5.8xlarge×1 A10G 24 GB)에서 끝까지 도는지 확인했다. 배포된 템플릿 YAML은 소스(`builtin-templates.ts`)에서 생성한 YAML과 SHA-256이 모두 일치했다.

## 결과 요약

| 템플릿 | 실행 ID | 결과 | 근거 |
|---|---|---|---|
| mujoco-train (50k steps) | `0b434edd9d2afc20` | SUCCEEDED, 4분 | best_checkpoint mean return 38.6→51.6, 체크포인트 6개 게시 |
| mujoco-pipeline (기본값) | `13c6dc12a12f4562` | SUCCEEDED, 17분 | ep_rew_mean 63.8, 폐루프 평가 성공률 5/5, MP4 5개 게시 |
| torch-gloo-2rank | `dc9bf187660804da` | SUCCEEDED, 44초 | rank 2개 DDP 학습 완료, torch-gloo 데이터셋 게시 |
| isaaclab-train | `8ec5b8d256263983` (당일 앞선 실행) | SUCCEEDED | MLflow mean_reward −0.08→3.59 (300 iter) |
| isaaclab-h1 | `67016718e61ab7a8` | 학습 성공, 대시보드 상태 **FAILED** | MLflow mean_reward −0.13→27.83 (300 iter); 컨트롤러 버그로 완료 직후 `start timeout` 처리 (아래 B2) |
| gr00t-finetune | `64ad0af83966379e` (수정 템플릿) | 학습 성공, 게시 중 취소 | MLflow loss 10 포인트(1.07…0.98…1.08, 100 step), checkpoint-50/100/최종 FSx·S3 저장; 38 GB 게시가 컨트롤러를 멈춰 취소 (B3) |
| openpi-train (300 step, LIBERO 100 에피소드) | `cca7667efce73942` (수정 어댑터 주입) | SUCCEEDED, 학습 11분 + 게시 15분 | loss 0.214→0.131→0.102 (1.9→3.3 s/it, A10G), orbax 체크포인트 100/200/300, 9.3 GB 데이터셋 `openpi-checkpoints-cca7667efce73942` 게시 |
| gr00t-e2e | `9c22ae7744a2e9c7` (9/17) | SUCCEEDED (재실행 안 함) | MLflow loss 1.06→0.095 (300 step) |

수정 전 템플릿으로는 gr00t-finetune이 두 가지 이유로 즉시 실패했고(A1, A2), openpi-train은 실행 경로 자체가 없었다(A3, A4).

## A. 템플릿·레시피 결함 (소스 수정 완료, 커밋 `79df01b`, `2ef8097`)

- **A1 gr00t-finetune 읽기 전용 입력**: GR00T가 `<dataset>/meta/stats.json`을 쓰는데 데이터셋 입력은 읽기 전용 마운트 → `OSError: [Errno 30] Read-only file system`. gr00t-e2e처럼 `/tmp/dataset`으로 복사 후 학습하도록 변경.
- **A2 gr00t-finetune CUDA OOM**: 기본값이 diffusion head까지 학습해 첫 optimizer step에서 22 GB 초과. `diffusion_flag` 파라미터(기본 `--no-tune-diffusion-model`) 추가, `--save-total-limit 1` 추가(전체 상태 체크포인트 1개 ≈ 14 GB).
- **A3 openpi-train 어댑터 PicklingError**: `compute_norm_stats`를 `spec_from_file_location`으로 로드해 spawn된 DataLoader 워커가 `RemoveStrings`를 unpickle 못 함. `sys.path` + `importlib.import_module`로 변경. **이미지 재빌드 + 이미지 프로필 재승인 필요** (검증은 `files:`로 패치 파일을 주입해 수행).
- **A4 hf-dataset-import v2.0 거부**: `physical-intelligence/libero`는 LeRobot v2.0(이미지 내장, 영상 없음)인데 import가 v2.1만 허용 → `Expected LeRobot v2.1 after conversion`. v2.0도 허용. 또한 전체 데이터셋은 parquet 1693개로 런타임 입력 하이드레이션 한도(1024 파일)를 넘으므로, 검증에는 100 에피소드 서브셋을 커스텀 워크플로로 게시해 사용(`libero-subset-926a642f504158e3`, 3.5 GB).
- **A5 자격증명 참조**: gr00t-finetune/openpi-train 기본값 `/groot/hf-token`이 프로젝트에 등록돼 있지 않아 제출이 거부됨. SSM SecureString `/groot/hf-token`을 만들고 `POST /api/credentials/legacy`로 프로젝트에 등록해 해결(운영 절차로 문서화 필요).

## B. 인프라·컨트롤러 문제 (소스 수정 1건, 나머지는 후속 과제)

- **B1 GPU 노드 디스크 100 GB**: GR00T 이미지(29 GB 압축) pull 도중 kubelet ephemeral-storage 임계치(10.7 GB)에 걸려 Pod가 두 번 evict됐다(`The node was low on resource: ephemeral-storage`). 완료된 Pod의 쓰기 레이어(모델 캐시 ~7 GB/개)가 남아 있고 대시보드가 완료 Job/Pod를 지우지 않는 것이 원인 중 하나. 오래된 완료 Pod 12개(rl 네임스페이스 4개 포함)와 미사용 이미지를 `ctr images rm --sync`로 정리해 진행했다. 권장: `gpu-g5-8x` 인스턴스 그룹에 `InstanceStorageConfigs` EBS(예: 500 GB, `/opt/sagemaker`) 추가 후 노드 교체, 컨트롤러에서 완료 Job에 `ttlSecondsAfterFinished` 적용.
- **B2 완료 직후 start_timeout 오판 (수정 완료)**: Pod가 Succeeded인데 Job의 Complete 조건이 아직 없는 몇 초 동안 `deriveTaskPhase`가 PENDING을 반환 → INITIALIZING으로 회귀 → 시작 후 20분이 지난 작업은 완료 순간 `start timeout initializing workload`로 FAILED. H1 실행이 이 경로로 실패했다(exitCode 0, MLflow FINISHED). `status.ts`에서 Succeeded Pod를 RUNNING으로 보고하도록 수정하고 테스트 추가.
- **B3 대용량 게시가 컨트롤러를 멈춤**: 38 GB(51 파일) GR00T 출력 게시 중 컨트롤러 ECS 태스크가 `/health` 실패로 17:57, 18:12 두 번 교체됐고(in-flight tick 10분 초과), 재시작마다 SHA-256 재검증을 처음부터 반복해 45/51 파일에서 진전이 없었다. 그 사이 새로 제출한 openpi-train은 6분간 Job이 생성되지 않았다. 실행 취소로 즉시 풀림. 9.3 GB(50 파일) OpenPI 출력은 15분 만에 정상 게시됐다. 후속: 게시를 reconcile tick 밖으로 분리, 이미 복사된 객체 재해시 생략, 게시 크기 상한 안내.
- **B4 MLflow 지표 업로드 속도**: `tracking.py`가 TensorBoard 스칼라를 `log_metric` 호출 하나씩 올려 H1은 학습 5분 뒤 업로드에 ~20분 소요. `log_batch`로 묶을 것.
- **B5 API 오류 코드**: 존재하지 않는 데이터셋 `GET /api/v1/datasets/<name>`이 404 대신 401 `Invalid, expired, or unauthorized API token`을 반환한다.

## 검증 방법

Playwright로 Cognito 로그인 → `POST /api/tokens`(브라우저 전용)으로 프로젝트 API 토큰 발급 → `dashboard/cli/pai.py`와 동일한 `/api/v1/workflows` API로 제출(`acknowledgePreflight: true` 필요). 템플릿 YAML은 소스에서 `tsx`로 생성. Pod 로그는 대시보드가 보관하지 않으므로 `kubectl logs -f`로 파일에 수집했다. MLflow 지표는 SageMaker MLflow 추적 서버(`groot-mlflow-913524902871`)에서 직접 조회했다.
