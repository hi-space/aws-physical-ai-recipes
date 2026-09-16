# Isaac Sim Livestream

> 이 문서는 [README.md](README.md)(영문)의 한국어 번역본입니다.

livestreaming이 활성화된 인터랙티브 NVIDIA Isaac Sim 세션. 이 워크플로우는 GPU 노드에서
Isaac Sim을 headless 모드로 실행하고 워크로드 pod에서 WebRTC 스트림을 서비스합니다.

## 이 예제의 범위

두 가지를 다룹니다.

1. OSMO가 확보한 GPU 노드 위에 Isaac Sim 스트리밍 서버를 띄우고 확인하는 것.
   `g6`/L4에서 런타임 검증했습니다 — [validation.md](validation.md) 참고.
2. 그 스트림을 **클러스터 VPC 내부 클라이언트에서** 보는 것. 영상이 실제로 도착하는
   구성은 이것뿐입니다.

VPC 외부 클라이언트에서 보는 것은 다루지 않습니다. `osmo workflow port-forward`는 WebRTC
미디어를 실어 보낼 수 없고, 포트를 어떻게 매핑해도 달라지지 않습니다. 실측 내용과 이유는
아래 "스트림 보기"에 있습니다. 누군가에게 스트림을 약속하기 전에 VPC로 들어가는 VPN이나
VPC 내부 GUI 데스크톱 인스턴스를 먼저 준비하십시오.

여섯 가지 워크플로우 파일을 제공합니다:

| 파일 | Isaac Sim | 플랫폼 | 메모리 | 비고 |
| --- | --- | --- | --- | --- |
| `workflow.yaml` | 4.5.0 (stable) | `g7e-rtx-pro-6000` | 16Gi | e2e-workshop stable 프로필과 동일 |
| `workflow-5.1.yaml` | 5.1.0 (latest) | `g7e-rtx-pro-6000` | 32Gi | 더 큰 메모리 할당 (5.1 기본 요구량 증가) |
| `workflow-g6e.yaml` | 5.1.0 | `g6e-l40s` | 32Gi | G7e capacity 부족 시 폴백 (L40S 48GB) |
| `workflow-g6.yaml` | 4.5.0 | `g6-l4` | 16Gi | G7e·G6e 모두 부족할 때의 최후 폴백 (L4 24GB) |
| `workflow-g6-5.1-pubep.yaml` | 5.1.0 | `g6-l4` | 32Gi | 5.1 전용 `publicEndpointAddress`/`fixedHostPort` 지정 |
| `workflow-g6-5.1-scene.yaml` | 5.1.0 | `g6-l4` | 32Gi | 1920x1080 물리 씬, 주기적 재낙하로 계속 움직임 |

사람이 스트림을 볼 예정이라면 `workflow-g6-5.1-scene.yaml`을 제출하십시오. 나머지 파일은
빈 스테이지 상태로 스트리밍 서버를 띄웁니다. 서버 확인에는 충분하지만, 보는 사람 입장에서는
스트림이 깨진 것과 구분되지 않습니다.

`platform`은 워크플로 파일에 고정되어 있고 템플릿 변수가 아니라서 `--set`으로 바꿀 수
없습니다. G6e에서 실행할 때는 `workflow-g6e.yaml`을 제출하십시오. 이 경로는
`DEPLOY_G6E_NODEPOOL=true`로 만든 `aws-osmo-g6e` NodePool과
`OSMO_CONFIGURE_G6E_PLATFORM=true`로 등록한 `g6e-l40s` 플랫폼이 둘 다 있어야 동작합니다.
하나만 있으면 실패합니다. G6도 같은 구조입니다 — `DEPLOY_G6_NODEPOOL=true`와
`OSMO_CONFIGURE_G6_PLATFORM=true`가 둘 다 필요합니다. 자세한 내용은
[docs/gpu-capacity.ko.md](../../docs/gpu-capacity.ko.md)를 참고하십시오.

`workflow-g6.yaml`은 stable 프로필을 그대로 내려받은 것이라 4.5.0을 씁니다. VRAM 때문은
아닙니다. 2026-09-15 L4(23034MiB)에서 실측한 유휴 GPU 메모리는 4.5.0이 577MiB, 5.1.0이
2032MiB로 둘 다 여유가 충분했습니다. L4에서 5.1을 쓰려면
[workflow-g6-5.1-pubep.yaml](workflow-g6-5.1-pubep.yaml)을 제출하십시오.

Isaac Sim 5.0.0은 별도 워크플로우를 두지 않습니다. 5.0은 5.1로 빠르게 대체된
과도기 릴리스라, e2e-workshop과 동일하게 stable(4.5)/latest(5.1) 두 프로필만
유지합니다. 5.0에서 실행해야 한다면 `isaac_sim_image`를
`nvcr.io/nvidia/isaac-sim:5.0.0`으로 오버라이드하면 되지만(포트/`runheadless.sh`
경로는 5.1과 동일), 검증 대상은 아닙니다.

```bash
GPU_PREWARM_INSTANCE_TYPE=g7e.2xlarge scripts/prewarm-gpu-node.sh

# stable (Isaac Sim 4.5.0)
osmo workflow submit examples/isaacsim-livestream/workflow.yaml

# latest (Isaac Sim 5.1.0)
osmo workflow submit examples/isaacsim-livestream/workflow-5.1.yaml
```

G7e가 `InsufficientInstanceCapacity`로 잡히지 않을 때는 G6e로 넘어갑니다.
`prewarm-gpu-node.sh`는 요청한 크기에 착륙하지 못하면 실패하므로, 크기를 고정하지 않는
probe로 노드를 확보하는 쪽이 확률이 높습니다
([docs/gpu-capacity.ko.md](../../docs/gpu-capacity.ko.md)의 "요청한 크기가 품절일 때
(ICE)" 절).

```bash
osmo workflow submit examples/isaacsim-livestream/workflow-g6e.yaml
```

G6e도 안 잡히면 G6(L4)까지 내려갑니다. 2026-09-15 `us-east-1`에서는 g7e 전 크기와
g6e 전 크기가 닿을 수 있는 두 AZ에서 모두 품절인 상황에서 `g6.2xlarge`가 첫 시도에
떴습니다. L4는 24GB이므로 스트리밍·평가용이고 학습용은 아닙니다.

```bash
osmo workflow submit examples/isaacsim-livestream/workflow-g6.yaml
```

## 서버가 떴는지 확인하기

이건 어디서든 되고, 서버 문제와 접속 경로 문제를 갈라 주므로 첫 단계로 적합합니다.
시그널링 포트에 대한 TCP 포트 전달은 투명하게 동작합니다.

```bash
osmo workflow port-forward <workflow-id> stream --port 49100 --connect-timeout 300
```

`localhost:49100`에 평범한 `GET`을 보내 HTTP 501이 오면 스트리밍 서버가 올라온 것입니다.
L4에서 4.5.0은 그 상태까지 약 8분 30초, 5.1.0은 약 63초 걸립니다.

`--udp`는 주지 마십시오. CLI 6.3.1에서 깨져 있고(Python 3.11의 `asyncio.wait`가 코루틴을
직접 받지 않음), 동작한다 해도 도움이 되지 않습니다. 아래를 참고하십시오.

## 스트림 보기

클라이언트는 클러스터 VPC 내부에 있어야 합니다. pod IP에 직접 도달해야 하기 때문입니다.
주소는 이렇게 확인합니다.

```bash
scripts/get-workflow-pod-ip.sh <workflow-id>
```

워크플로우 ID를 pod IP로 변환하며, 워크로드 네임스페이스에 대한 `get pods` 권한만
필요하므로 조회용 데스크톱에 클러스터 전체 `kubectl` 권한을 줄 필요가 없습니다. 그
데스크톱에서 `OSMO_WORKLOAD_NAMESPACE`를 지정하면 Terraform state 조회도 건너뜁니다.
내부적으로는 다음을 호출합니다.

```bash
kubectl -n osmo-workflows get pod <pod> -o jsonpath='{.status.podIP}'
```

그다음 노드 보안 그룹에서 클라이언트 출처에 대해 TCP `49100`과 UDP `47995-48012`,
`49000-49007`을 허용하고, Isaac Sim Streaming Client에서 그 pod IP를 지정합니다.
5.1.0에서는 `--/app/livestream/fixedHostPort=47998`로 미디어 포트를 고정할 수 있어
UDP는 그 한 포트만 열면 됩니다. 클라이언트를 VPC 내부에 두는 방법은 두 가지입니다.

- VPC 내부의 GUI 데스크톱 인스턴스. 계정 안에서 완결되고 지연이 가장 적으며, 여러 사용자에게
  같은 절차를 주기 쉽습니다. `scripts/deploy-viewer-desktop.sh`가 이 데스크톱을 만듭니다 —
  Amazon DCV와 Isaac Sim WebRTC Streaming Client가 설치된 Ubuntu 24.04 DLAMI
  `g6.2xlarge`이며, pod에 도달하기 위한 노드 보안 그룹 규칙까지 함께 넣습니다.

  ```bash
  DCV_ALLOWED_CIDR="$(curl -s https://checkip.amazonaws.com)/32" \
  DCV_DESKTOP_PASSWORD='<암호 지정>' \
    scripts/deploy-viewer-desktop.sh
  ```

  `https://<public-ip>:8443`으로 접속해 그 안에서 스트리밍 클라이언트를 실행합니다. 이
  데스크톱은 종료할 때까지 과금되는 GPU 인스턴스입니다 —
  `scripts/deploy-viewer-desktop.sh --destroy`로 정리하십시오.
- VPC로 들어가는 VPN 또는 서브넷 라우터. 노트북을 클라이언트로 유지할 수 있지만 사용자마다
  설정이 필요합니다.

### 뷰포트에 무언가를 띄우기

스트리밍 앱만 띄우면 빈 스테이지가 보이는데, 이는 스트림이 깨진 상태와 구분되지 않습니다.
별도 Python 진입점을 만들지 말고 같은 런처에 씬을 실어 보내십시오.

```bash
./runheadless.sh \
  --/app/livestream/enabled=true \
  --/app/livestream/port=49100 \
  --/app/livestream/fixedHostPort=47998 \
  --exec /tmp/scene.py
```

`runheadless.sh`는 인식하지 못한 인자를 kit으로 넘기므로, `--exec`는 이미 동작이 확인된
스트리밍 앱 안에서 씬을 실행합니다.

`SimulationApp({"headless": True, "livestream": 2})`로 씬을 만들지 마십시오. 5.1.0에서는
`isaacsim.exp.full.streaming`이 아니라 `isaacsim.exp.base`가 로드되어 포트 49100이 아예
열리지 않고 클라이언트가 연결조차 못 합니다(2026-09-16 실측). `livestream` 인자는 4.5
시절의 패턴입니다.

강체를 떨어뜨리기만 하는 씬은 몇 초 안에 안정되어 그 뒤로는 정지 화면처럼 보입니다. 앱
업데이트 스트림을 구독해 주기적으로 변환을 되돌리면, 나중에 접속한 사람도 움직임을 봅니다.

```python
def on_update(event):
    state["frames"] += 1
    if state["frames"] % 420:
        return
    timeline.stop()
    for op, start, velocity, angular in spawns:
        op.Set(start)
        velocity.Set(ZERO)
        angular.Set(ZERO)
    timeline.play()

sub = omni.kit.app.get_app().get_update_event_stream().create_subscription_to_pop(
    on_update, name="redrop"
)
```

### 해상도

기본 1280x720 렌더는 클라이언트 창이 그보다 크면 흐려 보입니다. 클라이언트가 업스케일하기
때문입니다. 서버에서 렌더 크기를 지정하고 클라이언트에서 같은 해상도를 고르십시오.

```bash
--/app/window/width=1920 --/app/window/height=1080 \
--/app/renderer/resolution/width=1920 --/app/renderer/resolution/height=1080
```

클라이언트의 `Resolution` 드롭다운도 같은 값으로 맞춰야 합니다. 클라이언트는 데이터 채널로
자기 크기를 요청하는데, 값이 다르면 다시 렌더하지 않고 크기만 조정합니다.

### 조회용 데스크톱 조작하기

DCV 데스크톱에서 시간을 잡아먹은 세 가지이며, 모두 Isaac Sim 문제가 아닙니다.

클라이언트 창이 검게 보이면 대개 데스크톱이 잠긴 것입니다. GNOME 화면 잠금이 콘솔 세션을
가리고, 스트리밍 클라이언트는 그 뒤에서 계속 돌아갑니다. 데스크톱마다 한 번 비활성화하십시오.

```bash
gsettings set org.gnome.desktop.screensaver lock-enabled false
gsettings set org.gnome.desktop.screensaver idle-activation-enabled false
gsettings set org.gnome.desktop.session idle-delay 0
```

SSM으로 클라이언트를 띄울 때는 세션 환경변수가 필요합니다. `su ubuntu -c ...`는 이를 하나도
물려받지 못해, Electron 창이 만들어지기는 하지만 매핑되지 않습니다(`xwininfo`가
`IsUnMapped`로 보고). 네 개를 모두 지정하십시오.

```bash
export DISPLAY=:1
export XDG_RUNTIME_DIR=/run/user/1000
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
export XAUTHORITY=/run/user/1000/gdm/Xauthority
```

모든 창이 `IsUnMapped`로 보고되면 앱이 아니라 셸을 재시작하십시오. 클라이언트를 재설치하거나
설정 디렉터리를 지워도 해결되지 않습니다. `kill <gnome-shell pid>`로 systemd가 다시 띄우게
하면 이후 창이 정상 매핑됩니다.

스트리밍 세션은 한 번에 하나만 존재할 수 있습니다. 클라이언트를 두 개 띄우면 먼저 붙은 쪽이
`N of 6 connection attempts have failed`를 반복하고 서버 로그에는
`nvstPushStreamData timeout for eye 0`이 남습니다. 다시 띄우기 전에
`pkill -f isaacsim-webrtc`를 실행하십시오. 로그에 `Isaac Sim Full Streaming App is loaded.`가
나오기 전에 연결하면 `Stream stopped - status=error`가 됩니다.

### 안 되는 것, 그리고 다시 시도하지 않아야 하는 이유

셋 다 2026-09-15에 `g6.2xlarge`의 Isaac Sim 4.5.0과 5.1.0을 대상으로, WebRTC Streaming
Client 1.0.6과 1.1.5로 실측했습니다. 전체 기록은 [validation.md](validation.md),
설명은 [docs/osmo-compatibility.md](../../docs/osmo-compatibility.md)에 있습니다.

미디어 포트를 포트 전달하는 것. Isaac Sim은 자기 인터페이스에서만 ICE 후보를 수집하므로
SDP에 pod의 VPC 주소를 실어 보냅니다. 포트 전달은 그 포트를 클라이언트의 `localhost`에
매핑하는데, `localhost`는 SDP 어디에도 없으므로 검사할 유효한 후보 쌍이 없습니다. 시그널링은
연결되고 STUN 바인딩 요청은 터널을 왕복하지만, 연결 상태가 `checking`에서 `disconnected`로
넘어가고 디코딩된 프레임은 0입니다. 포트가 아니라 주소의 문제라서 포트를 더 열어도 달라지지
않습니다.

광고 주소를 바꾸는 것. 5.1.0은 `--/app/livestream/publicEndpointAddress`를 받고,
`127.0.0.1`로 지정하면 SDP에 실제로 `127.0.0.1:47998`이 실립니다(확인했습니다). 그래도
ICE는 실패합니다. ICE는 요청이 떠난 것과 정확히 같은 5-tuple로 돌아온 STUN 응답만 인정하는데,
UDP를 WebSocket으로 감싸 중계하면 출처 주소와 포트가 보존되지 않기 때문입니다.

TURN 중계 서버를 세우는 것. 불가능합니다. Isaac Sim에는 ICE 서버 설정 자체가 없습니다.
이미지에 들어 있는 `libcarb.livestream-rtc.plugin.so`의 `/app/livestream/*` 키를 전수
확인한 결과 5.1.0은 20개, 4.5.0은 10개이고 어느 쪽에도 `iceServer`, `stunServer`,
`turnServer`가 없습니다. Isaac Sim이 relay 후보를 수집하지 않으므로 VPC에 TURN 서버를
세워도 쓰이지 않습니다.

정리(Cleanup):

```bash
scripts/wait-gpu-node-cleanup.sh
```

참고 사항:

- 워크플로우 실행 타임아웃은 2시간입니다. 시뮬레이션은 타임아웃되거나 수동으로 취소(`osmo workflow cancel <workflow-id>`)할 때까지 유지됩니다.
- 포트 범위: `47995-48012` (앱 스트리밍), `49000-49007` (비디오), `49100` (제어).
  5.1.0은 `fixedHostPort`로 미디어 측을 한 포트로 줄일 수 있습니다.
- 2026-09-15 L4(23034MiB) 실측 유휴 GPU 메모리: 4.5.0은 577MiB, 5.1.0은 2032MiB.
  대형 에셋이 포함된 씬은 이보다 훨씬 많이 쓰므로, 유휴 사용량이 아니라 씬 기준으로
  인스턴스를 고르십시오.
