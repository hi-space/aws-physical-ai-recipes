# Stage 5 — 엣지 배포

파인튜닝한 GR00T 정책을 AWS IoT Greengrass로 물리 엣지 디바이스에 배포합니다.
이 스테이지는 OSMO 워크플로가 아닙니다 — OSMO는 클러스터에서 돌고, 로봇의 온보드
컴퓨터가 Greengrass 컴포넌트를 실행합니다. Stage 4의 클러스터 내 closed-loop
평가와 같은 GR00T ZMQ 정책 서버·같은 프로토콜을 쓰되, 실행 호스트만 다른
"온로봇" 짝입니다.

`e2e-workshop/edge/workshop-components/N1.6/`를 일반화했습니다. 워크샵 버전은
CloudFront 모델 tarball과 특정 ECR 이미지를 하드코딩했지만, 여기서는 모델을 S3
(Stage 3 체크포인트)에서 가져오고 이미지는 `build-inference-image.sh`로 직접
빌드해 자신의 ECR에 올립니다.

> 이 문서는 [README.md](README.md)(영문)의 한국어 번역본입니다. 상세 원문은 영문
> README를 기준으로 삼으세요.

## 컴포넌트

| 컴포넌트 | 역할 |
| --- | --- |
| `com.aws.groot.setup` | 파인튜닝한 모델을 S3에서 디바이스(`/opt/groot/models`)로 동기화. TensorRT 빌드는 선택. |
| `com.aws.groot.inference` | 컨테이너에서 `gr00t.eval.run_gr00t_server`를 실행해 포트 5555에 ZMQ 정책 서버를 노출. |

`com.aws.groot.inference`는 `com.aws.groot.setup`에 의존합니다(HARD dependency).

## 스크립트

| 스크립트 | 실행 시점 | 역할 |
| --- | --- | --- |
| `build-inference-image.sh` | 최초 1회(GR00T 버전 변경 시 재빌드) | GR00T 서버 Docker 이미지(PyTorch + TRT + Isaac-GR00T)를 빌드해 ECR에 푸시. `com.aws.groot.inference`가 pull하는 이미지. |
| `bootstrap-device.sh` | 디바이스당 1회 | Greengrass v2 nucleus 설치, IoT thing/group/cert 프로비저닝, 디바이스 role(TES)에 S3/ECR/logs 권한 부여. |
| `register-components.sh` | 모델·이미지가 바뀔 때마다 | 두 recipe를 컴포넌트 버전으로 등록하고, 선택적으로 배포까지 생성. |
| `fetch-demo-model.sh` | 선택, 사전 점검용 | 워크샵의 사전 학습 Pick-Orange 데모 체크포인트를 S3에 올려, Stage 3 없이도 엣지 배포를 smoke-check. |

이 스크립트들은 단일 파일 워크샵 설치기
(`e2e-workshop/edge/scripts/setup-greengrass-workshop-N16.sh`)를 성격별로 분리한
것입니다: 이미지 빌드, 1회성 디바이스 프로비저닝, 반복적인 컴포넌트 등록/배포.

## 디바이스에 모델 올리기

Stage 3(`03-training`)이 체크포인트를 OSMO 데이터셋
(`e2e-pipeline-groot-checkpoint`)에 기록합니다. 그 데이터셋을 S3로 내보낸 뒤 setup
컴포넌트가 그 위치를 가리키게 하세요:

```bash
# 예: OSMO 데이터셋을 로컬에 받은 뒤 S3로 푸시
osmo dataset download e2e-pipeline-groot-checkpoint ./ckpt
aws s3 sync ./ckpt s3://<your-bucket>/models/e2e-pipeline-groot-checkpoint
```

`com.aws.groot.setup/recipe.yaml`의 `modelS3Uri`를 그 S3 URI로 설정하세요.

아직 Stage 3를 돌리지 않았나요? 워크샵의 사전 학습 데모 체크포인트로 엣지 경로를
먼저 시험 삼아 돌려볼 수 있습니다:

```bash
bash fetch-demo-model.sh \
  --s3-uri s3://<your-bucket>/models/groot-demo-pick-orange \
  --region <region>
```

## 배포

```bash
# 1) GR00T 추론 이미지를 빌드해 ECR에 푸시 (1회).
bash build-inference-image.sh --repo groot-inference --region <region>

# 2) 1회성: 디바이스 프로비저닝 (디바이스에서 root로 실행).
#    IoT thing/group/cert 생성 및 디바이스 role에 S3/ECR 권한 부여.
sudo bash bootstrap-device.sh \
  --thing-name groot-edge-01 \
  --region <region> \
  --s3-bucket <your-bucket>

# 3) 두 recipe.yaml 편집: REPLACE_ME 모델 S3 URI (com.aws.groot.setup)와
#    ECR 이미지 (com.aws.groot.inference — build-inference-image.sh가 출력한
#    이미지 URI 사용)를 교체.

# 4) 컴포넌트 등록 + 배포 (AWS 자격증명만 있으면 어디서든 실행).
bash register-components.sh \
  --region <region> \
  --deploy --thing-group groot-edge-01-group
```

`register-components.sh`는 `com.aws.groot.inference`를 대상으로 배포하며,
Greengrass가 `com.aws.groot.setup` HARD 의존을 자동으로 해소합니다. 디바이스를
정리하려면 `sudo bash bootstrap-device.sh --thing-name groot-edge-01 --uninstall`을
실행하세요.

원본 `e2e-workshop/edge/scripts/setup-greengrass-workshop-N16.sh`는 이 모든 것을
(워크샵 전용 ECR 이미지 빌드까지) 한 파일에 담고 있습니다. 프로비저닝 단계가
요구하는 전체 IAM 권한 목록은 그 스크립트를 참고하세요.

## 정책 서버와 통신

실행되면 디바이스는 Stage 4와 동일한 ZMQ REQ/REP 인터페이스를 노출합니다. 로봇
제어 루프가 관측값(카메라 프레임 + 고유수용성 + 지시문)을 보내면 미래 관절 명령의
horizon을 받습니다. GR00T 리포의 클라이언트 헬퍼(`gr00t/eval`)나 e2e 워크샵의
`batch-zmq` ping 클라이언트로 서버 응답을 확인하세요.

## 참고

- 워크샵의 TensorRT 경로(DiT action-head 가속)는 모델·스크립트에 특화되어
  있습니다. `buildTrt` 기본값이 `false`라 이 컴포넌트는 GR00T를 PyTorch 모드로
  실행합니다. TRT를 원하면 자신의 `export_onnx` / `build_tensorrt_engine`
  스크립트를 준비하세요.
- 디바이스에는 NVIDIA GPU, NVIDIA container toolkit, 그리고 로봇 제어 프로세스가
  포트 5555로 접근할 수 있는 네트워크 도달성이 필요합니다.
