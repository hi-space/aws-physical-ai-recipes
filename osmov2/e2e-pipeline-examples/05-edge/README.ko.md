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
| `run-closeloop-eval.sh` | 모델 변경 후 | 배포된 엣지 정책 서버 대상으로 LeIsaac SO-101 closed-loop 시뮬을 실행해 새 모델을 검증. |

이 스크립트들은 단일 파일 워크샵 설치기
(`e2e-workshop/edge/scripts/setup-greengrass-workshop-N16.sh`)를 성격별로 분리한
것입니다: 이미지 빌드, 1회성 디바이스 프로비저닝, 반복적인 컴포넌트 등록/배포.

## 디바이스에 모델 올리기

Stage 3(`03-vla-finetune`)이 체크포인트를 OSMO 데이터셋
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
#    (편집 대신 아래 register-components.sh 에 --model-s3-uri / --ecr-image 를
#     넘겨도 됩니다 — "모델 변경 후 재배포" 참고.)

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

## 모델 변경 후 재배포

Stage 5가 파이프라인에서 하는 핵심 역할입니다. Stage 3를 다시 돌려 새 체크포인트가
나오면, recipe를 고치거나 컴포넌트 버전을 올리지 않고도 새 위치를 배포 시점
override로 넘겨 디바이스에 새 모델을 롤아웃할 수 있습니다:

```bash
# 새 체크포인트를 새 S3 prefix 로 내보낸 뒤:
bash register-components.sh \
  --region <region> \
  --deploy --thing-group groot-edge-01-group \
  --model-s3-uri s3://<your-bucket>/models/<new-prefix>
```

`--model-s3-uri`는 `com.aws.groot.setup`의 `configurationUpdate.merge`로 주입되어
setup 컴포넌트가 재실행되고, HARD 의존인 inference 컴포넌트가 재시작하며 새 모델을
로드합니다. 관련 override:

| Override | 적용 대상 | 효과 |
| --- | --- | --- |
| `--model-s3-uri <URI>` | setup `modelS3Uri` | 다음 배포에서 디바이스가 이 모델을 받음 |
| `--model-name <NAME>` | setup `modelName` + inference `modelPath` | 디바이스 내 다른 디렉토리에 모델 배치(두 컴포넌트 경로를 함께 맞춤) |
| `--ecr-image <IMAGE>` | inference `ecrImage` | 새 서버 이미지 롤아웃(예: `build-inference-image.sh` 후) |

이 흐름이 안정적으로 동작하는 두 가지 이유:

- **setup 컴포넌트가 항상 mirror-sync** 한다(`aws s3 sync --delete`). `modelS3Uri`가
  바뀌면(또는 같은 URI에 새 체크포인트가 올라오면) 디바이스의 기존 모델을 완전히
  **교체**합니다. 바뀌지 않은 파일은 재다운로드하지 않아 재배포가 가볍고, 비어 있거나
  placeholder인 URI에서는 sync를 거부해 정상 모델 디렉토리를 지우지 않습니다.
  (이전의 "모델이 이미 있으면 스킵" 로직은 `modelS3Uri`를 바꿔도 조용히 무시되게
  만들었는데 — 이 부분을 수정했습니다.)
- **override는 버전 범프가 필요 없다.** recipe의 `modelS3Uri`만 고치고
  `ComponentVersion`을 올리지 않으면 (이미 존재하는 버전이라) 조용히 무시되므로,
  모델 교체에는 override 플래그를 쓰세요. recipe/스크립트 *로직*을 바꿀 때만
  `ComponentVersion`을 올립니다.

## 바뀐 모델을 시뮬레이션으로 검증

새 모델을 재배포한 뒤, LeIsaac SO-101 pick-orange closed-loop 시뮬레이션으로
새 정책을 확인합니다 — 시뮬은 Stage 4와 동일하게 엣지 ZMQ 정책 서버에 붙습니다:

```bash
# 1) 새 모델 배포 (엣지 서버가 :5555에서 새 모델을 다시 로드)
bash register-components.sh --region <region> --deploy \
  --thing-group groot-edge-01-group \
  --model-s3-uri s3://<your-bucket>/models/<new-prefix>

# 2) 엣지 서버 대상으로 closed-loop 시뮬 실행 (GPU 호스트에서)
bash run-closeloop-eval.sh --eval-rounds 5
```

`run-closeloop-eval.sh`는 LeIsaac `policy_inference.py`를 클라이언트로 띄워
`--policy-host/--policy-port`(기본 `localhost:5555`, 엣지 서버가 host 네트워크
사용)에 접속합니다. `isaac-lab` 컨테이너 이미지를 재사용하며, headless RTX
rollout에 필요한 수정들을 내장합니다:

- `NVIDIA_DRIVER_CAPABILITIES=all` — RTX 카메라 렌더는 Vulkan *graphics* 능력이
  필요(`--gpus all`만으론 compute/utility만 부여 → `vkGetMemoryFdKHR`/공유 핸들
  에러로 카메라 렌더 실패).
- 클라이언트 패키지의 numpy를 `<2`로 — Isaac Sim은 numpy 1.x를 쓰는데
  `PYTHONPATH`의 numpy 2.x가 이를 가리면 Kit이 시작 시 ABI 세그폴트.
- LeIsaac을 평가 가능한 커밋으로 고정 + N1.6 동적 언어키/headless
  키보드·`wait_for_textures` 패치.
- 클라이언트 디렉토리에서 torch/CUDA 제거(Isaac Sim 번들 사용), `PYTHONUNBUFFERED=1`,
  전용 셰이더 캐시.

요구사항: 호스트에 NVIDIA GPU + NVIDIA Container Toolkit + Docker, 그리고 엣지
정책 서버 도달 가능(기본 동일 호스트 `:5555`). GR00T 서버 이미지 커밋과 모델의
`embodimentTag`가 task와 맞아야 합니다(SO-101 pick-orange는 base GR1이 아니라
`NEW_EMBODIMENT` 파인튜닝을 기대).

> closed-loop 평가의 정석/검증된 위치는 **Stage 4(04-closeloop)를 OSMO로 실행**하는
> 것이며, 그 환경이 이에 맞게 구성됩니다. `run-closeloop-eval.sh`는 *배포된 엣지
> 모델*을 엣지 호스트에서 smoke-test하게 해주지만, 임의의 박스에서 전체 Isaac Sim
> 씬을 돌리면 Isaac Sim/씬 에셋 환경 이슈에 걸릴 수 있습니다. 씬 생성 단계에서
> 멈추면 Stage 4(OSMO)를 사용하세요.




## 정책 서버와 통신

실행되면 디바이스는 Stage 4와 동일한 ZMQ REQ/REP 인터페이스를 노출합니다. 로봇
제어 루프가 관측값(카메라 프레임 + 고유수용성 + 지시문)을 보내면 미래 관절 명령의
horizon을 받습니다. GR00T 리포의 클라이언트 헬퍼(`gr00t/eval`)나 e2e 워크샵의
`batch-zmq` ping 클라이언트로 서버 응답을 확인하세요.

## 배포한 서버 검증하기

디바이스의 서버가 실제로 모델을 로드하고 추론을 서빙하는지, GR00T의 **자체**
클라이언트(`gr00t.policy.server_client.PolicyClient`)로 확인합니다. ZMQ msgpack
직렬화가 서버와 정확히 일치하도록 *실행 중인 inference 컨테이너 안에서* 돌리세요
(호스트에서 다른 `msgpack` 빌드로 돌리면 역직렬화가 실패할 수 있음 — 아래 참고):

```bash
CID=$(sudo docker ps -q --filter name=groot-edge-inference | head -1)
sudo docker exec "$CID" python - <<'PY'
import numpy as np
from gr00t.policy.server_client import PolicyClient

c = PolicyClient(host="localhost", port=5555)
print("ping:", c.ping())
print("modalities:", list(c.get_modality_config().keys()))

# 중첩 관측 ({video,state,language} dict) — 평탄화("video.front") 아님.
# 키/shape 는 get_modality_config() 참고 (SO-101: front/wrist 카메라,
# single_arm[5]+gripper[1] state). 이미지는 (B,T,H,W,3).
obs = {
    "video":    {"front": np.zeros((1, 1, 480, 640, 3), np.uint8),
                 "wrist": np.zeros((1, 1, 480, 640, 3), np.uint8)},
    "state":    {"single_arm": np.zeros((1, 1, 5), np.float32),
                 "gripper":    np.zeros((1, 1, 1), np.float32)},
    "language": {"annotation.human.task_description":
                 [["pick up the orange and place it on the plate"]]},
}
action, info = c.get_action(obs)
for k, v in action.items():
    print("action", k, v.shape)   # single_arm (1, 16, 5) ; gripper (1, 16, 1)
PY
```

정상 서버는 `ping: True`, 모델 modality config(`video/state/action/language`),
그리고 16-step 액션 호라이즌(`single_arm (1, 16, 5)`, `gripper (1, 16, 1)`)을
출력합니다. 이는 **배포 + 모델 로드 + 추론**을 Isaac Sim closed-loop 없이
엔드투엔드로 검증합니다.

> **직렬화 주의.** 서버와 클라이언트는 동일한 `msgpack` 인코딩을 써야 합니다.
> GR00T ZMQ 프로토콜은 numpy 배열을 `msgpack` + `use_bin_type=True`(모던
> `msgpack>=1.0`)로 패킹합니다. 클라이언트에 구버전 `msgpack-python` 0.5.6 이
> 있으면 배열을 raw 문자열로 패킹해서, 서버가 `'utf-8' codec can't decode byte
> 0x93`(=`.npy` 매직) 로 실패합니다. inference 컨테이너 안에서 검증하면 이 문제를
>피합니다. 다른 환경(예: Stage 4 스타일 LeIsaac 클라이언트)에서 서버를 구동한다면,
> 그 GR00T 서버 커밋과 `msgpack` 빌드가 이 이미지와 일치하는지 확인하세요.

## 참고

- inference 컴포넌트는 이미지를 **프라이빗 ECR**에서 pull 합니다. 디바이스(TES)
  role — `bootstrap-device.sh`가 ECR pull 권한을 부여함 — 로 docker 데몬에
  로그인한 뒤 `docker run` 전에 `docker pull` 하므로, 재배포 시 새로 푸시한 태그가
  반영됩니다. `build-inference-image.sh`로 디바이스 role이 접근 가능한 계정/리전의
  ECR 리포에 빌드·푸시하세요(비-ECR 이미지 URI면 로그인은 건너뜁니다).
- 워크샵의 TensorRT 경로(DiT action-head 가속)는 모델·스크립트에 특화되어
  있습니다. `buildTrt` 기본값이 `false`라 이 컴포넌트는 GR00T를 PyTorch 모드로
  실행합니다. TRT를 원하면 자신의 `export_onnx` / `build_tensorrt_engine`
  스크립트를 준비하세요.
- recipe는 `architecture: amd64`(x86_64 GPU 호스트, 예: G6e/L40S EC2)를
  대상으로 합니다. aarch64 디바이스(Jetson/Thor)는 이 플랫폼과 매칭되지 않습니다.
- 디바이스에는 NVIDIA GPU, NVIDIA container toolkit, 그리고 로봇 제어 프로세스가
  포트 5555로 접근할 수 있는 네트워크 도달성이 필요합니다.
