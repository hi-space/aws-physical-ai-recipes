# IsaacLab 셋업 가이드 (Ubuntu 22.04 + AWS)

## 환경 정보

| 항목 | 값 |
|------|-----|
| OS | Ubuntu 22.04.5 LTS |
| Kernel | 6.8.0-1029-aws |
| Python | 3.11.15 (deadsnakes PPA, venv: `~/venv311`) |
| GPU | NVIDIA L4 x 4 |
| Driver | 570.133.20 |
| isaacsim | 5.1.0 |
| 작업 디렉토리 | `~/environment/IsaacLab` |
| 브랜치 | `feature/newton` |

## 빠른 시작

```bash
cd ~/docs
bash setup_newton.sh
source ~/.bashrc
cd ~/environment/IsaacLab
python scripts/reinforcement_learning/skrl/train.py --task=Isaac-Ant-v0
```

`~/docs/setup_newton.sh`가 아래를 자동으로 수행한다:
1. `requirements_newton.txt`를 `~/environment/IsaacLab/`으로 복사
2. Python 3.11 설치 (deadsnakes PPA)
3. venv 생성 (`~/venv311`)
4. `~/.bashrc` 환경변수 설정 (EULA, venv 활성화, `LAUNCH_OV_APP=1`)
5. `requirements_newton.txt` 기반 의존성 설치
6. IsaacLab 패키지 설치 (`./isaaclab.sh --install` + 수동 `--no-deps` 패키지)
7. 설치 검증

### 수동 설치 (참고용)

<details>
<summary>스크립트 없이 수동으로 진행하는 경우</summary>

```bash
# 1. Python 3.11 설치
sudo add-apt-repository ppa:deadsnakes/ppa -y
sudo apt-get update
sudo apt-get install -y python3.11 python3.11-venv python3.11-dev
sudo ln -sf /usr/bin/python3 /usr/bin/python

# 2. venv 생성 및 활성화
python3.11 -m venv ~/venv311
source ~/venv311/bin/activate

# 3. 환경변수 설정 (~/.bashrc에 추가)
cat >> ~/.bashrc << 'EOF'
export ACCEPT_EULA=Y
export OMNI_KIT_ACCEPT_EULA=YES
export LAUNCH_OV_APP=1
source ~/venv311/bin/activate
EOF

# 4. 의존성 설치 (requirements_newton.txt 사용)
cd ~/environment/IsaacLab
pip install -r requirements_newton.txt --extra-index-url https://pypi.nvidia.com

# 5. IsaacLab 패키지 설치
./isaaclab.sh --install
pip install --no-deps -e source/isaaclab
pip install --no-deps -e source/isaaclab_experimental
pip install --no-deps -e source/isaaclab_newton

# 6. 실행 테스트
source ~/.bashrc
python scripts/reinforcement_learning/skrl/train.py --task=Isaac-Ant-v0
```

</details>

---

## 상세 설명

### 1. Python 3.11이 필요한 이유

`feature/newton` 브랜치는 Python 3.11을 전제로 만들어졌다:

- **isaacsim 5.1.0**: `Requires-Python ==3.11.*`
- **isaaclab_tasks, isaaclab_assets**: `python_requires >= 3.11`
- **isaacsim 버전별 Python 요구사항**:

| isaacsim | Python |
|----------|--------|
| 4.5.0 | 3.10 |
| 5.0.0 ~ 5.1.0 | 3.11 |
| 6.0.0 | 3.12 |

Python 3.10에서 억지로 맞추면 setup.py 수정(`python_requires` 변경), `--no-deps` 우회, numpy 버전 충돌 등 핵이 많아지므로 3.11로 시작하는 것이 정답.

### 2. `./isaaclab.sh --install`이 완전하지 않은 이유

install 스크립트가 `source/` 하위 패키지를 editable 모드로 설치하지만, **`isaaclab` 핵심 패키지는 설치에 실패**한다:

| 원인 | 설명 |
|------|------|
| `warp-lang==1.11.0.dev20251205` | NVIDIA dev index에서만 제공되는 버전. 기본 PyPI에 없음 |
| `omniverseclient` | isaaclab의 의존성이지만 pip에 존재하지 않는 패키지 (isaacsim 런타임 내장) |

따라서 `requirements_newton.txt`로 의존성을 먼저 설치한 뒤, `--no-deps`로 핵심 패키지를 설치해야 한다.

### 3. Newton 물리 엔진 의존성

`feature/newton` 브랜치의 핵심인 Newton 관련 패키지들은 특정 버전을 사용해야 한다:

| 패키지 | 올바른 소스 | 주의사항 |
|--------|------------|----------|
| `newton` | `git+...@beta-0.2.1` (v0.2.0) | PyPI의 `newton==1.0.0`은 warp 1.12+ 요구하여 호환 안 됨 |
| `mujoco_warp` | GitHub 특정 커밋 | `isaaclab_newton/setup.py`에 명시된 커밋 해시 사용 |
| `warp-lang` | `1.11.0.dev20251205` | NVIDIA index 필요. newton이 warp을 업그레이드할 수 있으므로 순서 주의 |

**설치 순서가 중요하다**: warp-lang → newton → mujoco_warp 순서대로 설치하되, newton이 warp을 자동 업그레이드하면 다시 warp-lang을 재설치해야 한다. `requirements_newton.txt`를 사용하면 pip이 순서를 자동으로 해결한다.

### 4. skrl 버전

- `skrl>=2.0.0`은 Newton 환경에서 `LazyLinear` 초기화 시 에러 발생
- `skrl>=1.4.2,<2.0`으로 고정 필요

### 5. 실행 시 `LAUNCH_OV_APP=1` 필요한 이유

`feature/newton` 브랜치의 AppLauncher는 기본적으로 **Standalone 모드**(SimulationApp 없이)로 진입한다. 하지만 `isaaclab.envs` 등의 코드가 `pxr` (USD) 모듈을 무조건 import하므로, SimulationApp이 초기화되지 않으면 `No module named 'pxr'` 에러가 발생한다.

`LAUNCH_OV_APP=1` 환경변수로 SimulationApp 모드를 강제 활성화하면 해결된다.

```bash
# ~/.bashrc에 추가하면 매번 안 붙여도 됨
export LAUNCH_OV_APP=1
```

### 6. `requirements_newton.txt`

프로젝트 루트(`~/environment/IsaacLab/requirements_newton.txt`)에 모든 의존성을 정리해두었다. 새 환경에서 동일하게 셋업할 때 사용.

### 최종 설치 패키지 목록

| 패키지 | 버전 | 소스 |
|--------|------|------|
| isaacsim | 5.1.0 | pip (NVIDIA index) |
| isaaclab | 0.42.25 | editable (`--no-deps`) |
| isaaclab_assets | 0.2.2 | `./isaaclab.sh --install` |
| isaaclab_experimental | 0.0.1 | editable (`--no-deps`) |
| isaaclab_newton | 0.0.1 | editable (`--no-deps`) |
| isaaclab_rl | 0.2.3 | `./isaaclab.sh --install` |
| isaaclab_tasks | 0.10.41 | `./isaaclab.sh --install` |
| isaaclab_tasks_experimental | 0.0.1 | `./isaaclab.sh --install` |
| newton | 0.2.0 | GitHub `beta-0.2.1` |
| mujoco_warp | 0.0.1 | GitHub 특정 커밋 |
| warp-lang | 1.11.0.dev20251205 | NVIDIA dev index |
| skrl | 1.4.3 | pip (`<2.0`) |
| torch | 2.7.0+cu128 | pip |

## Troubleshooting 로그

| 날짜 | 문제 | 해결 |
|------|------|------|
| 2026-04-11 | isaacsim 5.1.0이 Python 3.10에서 설치 불가 | Python 3.11 venv로 전환 |
| 2026-04-11 | `python` command not found | `sudo ln -sf /usr/bin/python3 /usr/bin/python` |
| 2026-04-11 | NVIDIA EULA 미동의 (isaacsim 5.1.0) | `ACCEPT_EULA=Y` + `OMNI_KIT_ACCEPT_EULA=YES` 둘 다 필요 |
| 2026-04-11 | `xterm-ghostty` unknown terminal type | `TERM=xterm-256color` fallback |
| 2026-04-11 | `isaaclab` 핵심 패키지 설치 실패 | warp-lang dev를 NVIDIA index에서 설치, `--no-deps`로 omniverseclient 우회 |
| 2026-04-11 | `No module named 'pxr'` | `LAUNCH_OV_APP=1`로 SimulationApp 모드 강제 |
| 2026-04-11 | PyPI `newton==1.0.0`이 warp 1.12+ 요구 | GitHub `beta-0.2.1` 태그로 설치 |
| 2026-04-11 | `No module named 'mujoco_warp'` | GitHub 특정 커밋에서 설치 |
| 2026-04-11 | skrl 2.0.0 `LazyLinear` 에러 | `skrl<2.0`으로 다운그레이드 |
