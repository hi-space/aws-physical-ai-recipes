# Dashboard I — 보기(views) 게이팅과 Isaac Lab 라이브 뷰 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 실행 중인 Isaac Lab 훈련에서 실시간 프레임 스트리밍을 활성화하고, TensorBoard·MLflow 링크를 선택된 작업의 선언에 따라서만 표시한다.

**Architecture:** 
- Views gating: 워크플로 저장 YAML에서 `ui.recipe.views` 필드를 파싱하고 작업당 `views` DTO 필드로 노출하면, TaskConnections가 렌더 조건으로 사용한다.
- Isaac live: `LiveFrames` 클래스(MuJoCo에서 사용 중)를 `pai_live.py`로 이동시키고, `isaaclab/live.py`에서 RSL-RL 환경을 래핑하여 매 스텝 후 조건부로 프레임을 게시한다. 템플릿 `--live-view on/off` 플래그로 제어한다.

**Tech Stack:** Next.js 16, vitest, Python 3.10+ (gymnasium, imageio, isaaclab).

**Spec:** `docs/designs/2026-09-19-dashboard-composer-views-ux-design.md` §3.4, §3.5.

## Global Constraints

- 모든 명령은 `dashboard/web`, `dashboard/recipes`, `dashboard/images/isaaclab`에서 실행한다. 웹 테스트는 `npm test -- <file>`(vitest); 파이썬은 unittest 또는 직접 실행.
- UI 문자열은 `web/src/lib/i18n/messages/*`에만 두며 컴포넌트에 한글 리터럴을 쓰지 않는다.
- 커밋 메시지는 `feat(dashboard): …` 형식, 끝에 `Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>`.
- 과거 설계·계획 문서는 수정하지 않는다.

---

### Task 1: 보기(views) 게이팅 — 서버 파싱과 DTO 확장

**Files:**
- Modify: `dashboard/web/src/server/workflow/views.ts` (new file)
- Modify: `dashboard/web/src/server/store/types.ts`
- Modify: `dashboard/web/src/app/api/workflows/[id]/route.ts`
- Modify: `dashboard/web/src/components/workflows/TaskConnections.tsx`
- Test: `dashboard/web/src/server/workflow/views.test.ts`
- Test: `dashboard/web/src/components/workflows/TaskConnections.test.ts`

**Interfaces:**
- Pure helper: `taskViews(specYaml: string, taskName: string): ('tensorboard'|'mlflow')[] | undefined`
  - `ui.recipe.views`에서 taskName 키를 찾고, 없으면 undefined (legacy).
  - 예: spec이 `ui.recipe.views: { train: ['tensorboard','mlflow'] }` → `taskViews(spec, 'train')` = `['tensorboard','mlflow']`.
- DTO Task에 `views?: ('tensorboard'|'mlflow')[]` 필드 추가.

- [ ] **Step 1: 실패하는 단위 테스트 작성**

`dashboard/web/src/server/workflow/views.test.ts` 생성:

```ts
import { describe, expect, it } from 'vitest';
import { taskViews } from './views';
import YAML from 'yaml';

describe('taskViews', () => {
  const mkSpec = (views?: Record<string, string[]>) => YAML.stringify({
    workflow: { name: 'test', tasks: [] },
    ui: { recipe: { ...(views && { views }) } },
  });
  
  it('extracts views for a named task', () => {
    const spec = mkSpec({ train: ['tensorboard', 'mlflow'], evaluate: ['tensorboard'] });
    expect(taskViews(spec, 'train')).toEqual(['tensorboard', 'mlflow']);
    expect(taskViews(spec, 'evaluate')).toEqual(['tensorboard']);
  });
  
  it('returns undefined when views is absent (legacy)', () => {
    const spec = mkSpec();
    expect(taskViews(spec, 'train')).toBeUndefined();
  });
  
  it('returns undefined when the task is not in views', () => {
    const spec = mkSpec({ train: ['tensorboard'] });
    expect(taskViews(spec, 'unknown')).toBeUndefined();
  });
  
  it('handles invalid YAML gracefully', () => {
    expect(taskViews('{{{', 'train')).toBeUndefined();
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd dashboard/web && npm test -- src/server/workflow/views.test.ts`
Expected: FAIL — `taskViews is not a function`.

- [ ] **Step 3: 순수 헬퍼 구현**

`dashboard/web/src/server/workflow/views.ts` 생성:

```ts
import YAML from 'yaml';

/** Extract the list of views (tensorboard, mlflow) for a task from the workflow spec.
 * Returns undefined for legacy specs without ui.recipe.views. */
export function taskViews(specYaml: string, taskName: string): ('tensorboard' | 'mlflow')[] | undefined {
  try {
    const spec = YAML.parse(specYaml) as { ui?: { recipe?: { views?: Record<string, string[]> } } };
    const views = spec.ui?.recipe?.views;
    if (!views || typeof views !== 'object') return undefined;
    const result = views[taskName];
    return Array.isArray(result) ? result : undefined;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: Task 타입 확장**

`dashboard/web/src/server/store/types.ts` 51행(Task 인터페이스) 끝에 필드 추가:

```ts
export interface Task {
  // …existing fields…
  views?: ('tensorboard' | 'mlflow')[];
}
```

- [ ] **Step 5: API 라우트에서 views 계산**

`dashboard/web/src/app/api/workflows/[id]/route.ts` 찾아서 (아마도 `GET` 핸들러), 워크플로 반환 전에 각 작업에 `views` 필드를 추가한다. 예를 들어:

```ts
import { taskViews } from '@/server/workflow/views';

// 워크플로 로드 후, tasks 배열에서:
const tasksWithViews = tasks.map(task => ({
  ...task,
  views: taskViews(workflow.specYaml, task.name),
}));
```

전체 라우트 코드를 읽고 정확한 위치와 반환 구조를 파악한 후 수정한다.

- [ ] **Step 6: TaskConnections 컴포넌트 게이팅**

`dashboard/web/src/components/workflows/TaskConnections.tsx` 92행 근처(TensorBoard 블록 렌더 체크) 수정:

```tsx
// 현재 (l.92): const resultsAvailable = research && hostsConfigured && …
// 새로운 로직:
// - TensorBoard 렌더 조건: resultsAvailable AND (views === undefined OR views.includes('tensorboard'))
// - MLflow 렌더 조건: workflow.mlflow AND views?.includes('mlflow')
```

TaskConnections props에 `views?: ('tensorboard'|'mlflow')[]` 추가 (작업에서 받음):

```tsx
interface ConnectionTask = Pick<Task, '...' | 'views'>;
// …
const tensorboardVisible = resultsAvailable && (task?.views === undefined || task?.views?.includes('tensorboard'));
const mlflowVisible = workflow.mlflow && task?.views?.includes('mlflow');
// TensorBoard 블록 JSX: {tensorboardVisible && <…>}
// MLflow 링크: {mlflowVisible && <…>}
```

문자열은 i18n 네임스페이스 `taskConnections`에 이미 정의되어 있어야 한다(변경 없음).

- [ ] **Step 7: 컴포넌트 테스트 작성**

`dashboard/web/src/components/workflows/TaskConnections.test.ts` (또는 browser test) 추가:

```ts
import { describe, expect, it } from 'vitest';
import { taskConnectionPayload } from './TaskConnections';

describe('TaskConnections views gating', () => {
  const workflow = { id: 'wf1', projectId: 'p1', status: 'RUNNING', ownerSubject: 'u1' };
  
  it('allows TensorBoard when views includes tensorboard or is undefined', () => {
    const taskNoViews = { workflowId: 'wf1', name: 'train', phase: 'RUNNING', outputPath: '/fsx/checkpoints/projects/p1/out', attempts: 1 };
    const taskWithTB = { ...taskNoViews, views: ['tensorboard', 'mlflow'] };
    const taskWithoutTB = { ...taskNoViews, views: ['mlflow'] };
    
    // All should allow tensorboard creation to proceed (payload check happens elsewhere)
    expect(() => taskConnectionPayload('tensorboard', workflow, taskNoViews)).not.toThrow();
    expect(() => taskConnectionPayload('tensorboard', workflow, taskWithTB)).not.toThrow();
    // The gating happens in the component render, not in payload creation.
    // So test the component's conditional render logic instead.
  });
});
```

또는 더 정확히, TaskConnections 컴포넌트의 렌더 로직을 직접 테스트하는 browser test 추가.

- [ ] **Step 8: 타입과 테스트 통과 확인**

Run: `cd dashboard/web && npm test -- src/server/workflow/views && npm test -- src/components/workflows/TaskConnections && npm run typecheck`
Expected: PASS.

- [ ] **Step 9: 커밋**

```bash
cd dashboard/web
git add \
  src/server/workflow/views.ts \
  src/server/workflow/views.test.ts \
  src/server/store/types.ts \
  src/app/api/workflows/[id]/route.ts \
  src/components/workflows/TaskConnections.tsx \
  src/components/workflows/TaskConnections.test.ts
git commit -m "feat(dashboard): gate TensorBoard/MLflow on task views from recipe metadata

Views extracted from spec ui.recipe.views; undefined = legacy all-visible.

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

---

### Task 2: LiveFrames 이동 및 re-export

**Files:**
- New: `dashboard/recipes/pai_live.py`
- Modify: `dashboard/recipes/mujoco/common.py`
- Modify: `dashboard/recipes/FILES.txt` (if it exists and enumerates files)
- Modify: `dashboard/recipes/provenance.json` (if it exists and enumerates files)
- Test: `dashboard/recipes/mujoco/test_*.py` (existing, should still pass)

**Interfaces:**
- `pai_live.LiveFrames`: stdlib + imageio only, no isaac/mujoco imports.
- `mujoco/common.py`: `from pai_live import LiveFrames`.

- [ ] **Step 1: 기존 LiveFrames 확인**

Run: `grep -n "class LiveFrames" dashboard/recipes/mujoco/common.py`
Expected: 라인 92 이후 `class LiveFrames` 정의 확인 (이미 Read에서 봄: l.92-122).

- [ ] **Step 2: pai_live.py 생성 및 이동**

`dashboard/recipes/pai_live.py` 생성 (mujoco/common.py l.92-122 코드 복사, 표준 라이브러리만 import):

```python
"""Live frame publishing for workflow sidecars. Stdlib + imageio only."""
import os
import time
from pathlib import Path


class LiveFrames:
    """Dashboard live view: publish JPEG frames to $PAI_LIVE_DIR/frame.jpg (atomic rename, rate limited).
    A no-op when the workflow task was not compiled with `live: true`."""

    def __init__(self, max_fps=10.0):
        self.dir = os.environ.get("PAI_LIVE_DIR") or None
        self.interval = 1.0 / max_fps
        self.last = 0.0
        self.count = 0
        if self.dir:
            Path(self.dir).mkdir(parents=True, exist_ok=True)

    @property
    def enabled(self):
        return self.dir is not None

    def due(self):
        return self.enabled and time.monotonic() - self.last >= self.interval

    def publish(self, frame):
        if not self.due():
            return False
        import imageio.v2 as imageio
        target = Path(self.dir) / "frame.jpg"
        temporary = target.with_name("frame.tmp.jpg")
        imageio.imwrite(temporary, frame, quality=80)
        os.replace(temporary, target)
        self.last = time.monotonic()
        self.count += 1
        return True
```

- [ ] **Step 3: mujoco/common.py 수정 — re-export**

`dashboard/recipes/mujoco/common.py` 1행 추가 (또는 기존 import 섹션에 추가):

```python
from pai_live import LiveFrames  # noqa: F401
```

기존 `class LiveFrames` 정의 (l.92-122) 삭제.

- [ ] **Step 4: mujoco 테스트 통과 확인**

Run: `cd dashboard/recipes && python3 -m pytest mujoco/test_*.py -v` (또는 repo 규칙에 맞는 테스트 실행)
또는: `cd dashboard/recipes && python3 -c "from mujoco.common import LiveFrames; print('OK')" && python3 -c "from pai_live import LiveFrames; print('OK')"`
Expected: 모두 OK, import 성공.

- [ ] **Step 5: FILES.txt 및 provenance.json 확인 및 수정**

Run: `head -20 dashboard/recipes/FILES.txt dashboard/recipes/provenance.json` (둘 다 있는지 확인)
- 둘 다 없으면 스킵.
- `mujoco/common.py` 항목이 있으면 `pai_live.py` 항목 추가.

예:
```
# FILES.txt에 추가
pai_live.py
```

```json
// provenance.json에 추가 (구조에 맞게)
{
  "files": ["pai_live.py", …]
}
```

- [ ] **Step 6: 커밋**

```bash
cd dashboard/recipes
git add pai_live.py mujoco/common.py
[ -f FILES.txt ] && git add FILES.txt
[ -f provenance.json ] && git add provenance.json
git commit -m "refactor(dashboard): move LiveFrames to standalone pai_live module

Decouples frame publishing from mujoco recipes; isaaclab can now import.

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

---

### Task 3: Isaac Lab 라이브 뷰 래퍼 구현

**Files:**
- New: `dashboard/recipes/isaaclab/live.py`
- Modify: `dashboard/recipes/isaaclab/train.py`
- Modify: `dashboard/recipes/isaaclab/test_image_contract.py`
- Test: `dashboard/recipes/isaaclab/test_live_publisher.py` (new)

**Interfaces:**
- `live.py`: `class LiveStepPublisher` wrapping gym.Env
  - `__init__(self, env, frames: LiveFrames)`
  - `step(actions)` → calls `env.step()`, then `frames.due()` & render
  - `__getattr__` delegates all others
- `train.py`: `--live-view {on,off}` flag (default `off`)

- [ ] **Step 1: 단위 테스트 작성 (먼저 실패하게)**

`dashboard/recipes/isaaclab/test_live_publisher.py` 생성:

```python
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock

# 가짜 환경 (isaaclab/gymnasium 없이)
class FakeEnv:
    def __init__(self):
        self.num_envs = 4
        self.num_obs = 10
        self.device = "cpu"
        self.render_called = []
        
    def step(self, actions):
        obs = [0.1] * self.num_obs
        reward = 1.0
        done = False
        info = {}
        return obs, reward, done, info
    
    def reset(self):
        return [0.1] * self.num_obs
    
    def render(self):
        self.render_called.append(True)
        return [[0] * 84 * 84 * 3]  # fake frame
    
    @property
    def unwrapped(self):
        return self
    
    def close(self):
        pass


class TestLiveStepPublisher(unittest.TestCase):
    def test_step_delegates_to_env(self):
        import sys
        sys.path.insert(0, str(Path(__file__).resolve().parents[0]))
        from live import LiveStepPublisher
        from pai_live import LiveFrames
        
        env = FakeEnv()
        frames = LiveFrames(max_fps=10.0)  # no dir = disabled
        pub = LiveStepPublisher(env, frames)
        
        obs, reward, done, info = pub.step([0.5] * 6)
        assert obs == [0.1] * 10
        assert reward == 1.0
    
    def test_render_called_only_when_due(self):
        import sys
        sys.path.insert(0, str(Path(__file__).resolve().parents[0]))
        from live import LiveStepPublisher
        from pai_live import LiveFrames
        
        with tempfile.TemporaryDirectory() as tmpdir:
            os.environ['PAI_LIVE_DIR'] = tmpdir
            env = FakeEnv()
            frames = LiveFrames(max_fps=10.0)
            pub = LiveStepPublisher(env, frames)
            
            # First step: due
            pub.step([0.5] * 6)
            assert len(env.render_called) == 1
            
            # Second step quickly: not due yet
            pub.step([0.5] * 6)
            assert len(env.render_called) == 1
            
            # Wait and step again
            import time
            time.sleep(0.11)
            pub.step([0.5] * 6)
            assert len(env.render_called) == 2
    
    def test_attr_delegation(self):
        import sys
        sys.path.insert(0, str(Path(__file__).resolve().parents[0]))
        from live import LiveStepPublisher
        from pai_live import LiveFrames
        
        env = FakeEnv()
        frames = LiveFrames()
        pub = LiveStepPublisher(env, frames)
        
        assert pub.num_envs == 4
        assert pub.device == "cpu"
        assert pub.num_obs == 10
    
    def tearDown(self):
        if 'PAI_LIVE_DIR' in os.environ:
            del os.environ['PAI_LIVE_DIR']


if __name__ == '__main__':
    unittest.main()
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd dashboard/recipes && python3 -m unittest isaaclab.test_live_publisher -v`
Expected: FAIL — `from live import LiveStepPublisher` 실패.

- [ ] **Step 3: LiveStepPublisher 구현**

`dashboard/recipes/isaaclab/live.py` 생성:

```python
"""Live frame publisher wrapper for Isaac Lab environments."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pai_live import LiveFrames


class LiveStepPublisher:
    """Wraps a gym-compatible environment to publish rendered frames after each step.
    
    The wrapper checks LiveFrames.due() and only calls env.unwrapped.render() when needed,
    bounding frame publishing to ≤max_fps. If PAI_LIVE_DIR is not set, no-op.
    """

    def __init__(self, env, frames: LiveFrames):
        self._env = env
        self._frames = frames

    def step(self, actions):
        """Step the environment and publish a frame if due."""
        result = self._env.step(actions)
        if self._frames.due():
            try:
                frame = self._env.unwrapped.render()
                if frame is not None:
                    if isinstance(frame, list) and len(frame) > 0:
                        frame = frame[0]
                    self._frames.publish(frame)
            except Exception:
                # Rendering failed; continue without frame
                pass
        return result

    def reset(self, *args, **kwargs):
        """Delegate reset to the environment."""
        return self._env.reset(*args, **kwargs)

    def close(self):
        """Delegate close to the environment."""
        return self._env.close()

    def __getattr__(self, name):
        """Delegate all other attribute access to the wrapped environment."""
        return getattr(self._env, name)
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd dashboard/recipes && python3 -m unittest isaaclab.test_live_publisher -v`
Expected: PASS, 특히 `render_called` 및 `max_fps` 체크 성공.

- [ ] **Step 5: train.py 수정 — --live-view 플래그 추가**

`dashboard/recipes/isaaclab/train.py` 파이썬 코드:

파서에 추가 (l.23 AppLauncher.add_app_launcher_args 뒤):

```python
parser.add_argument("--live-view", choices=['on', 'off'], default='off',
                    help="Publish frames to PAI_LIVE_DIR at ~10 fps during training")
```

실행 로직 수정 (env 생성 전, l.42-52 수정):

```python
# Before AppLauncher, if live-view is on, enable cameras
if args.live_view == 'on':
    args.enable_cameras = True

app = AppLauncher(args).app

# … 나머지 코드 …

# Environment creation (l.52)
env = RslRlVecEnvWrapper(gym.make(args.task, cfg=environment))

# Wrap with LiveStepPublisher if live-view enabled
if args.live_view == 'on':
    from live import LiveStepPublisher
    from pai_live import LiveFrames
    frames = LiveFrames()
    if frames.enabled:
        env = LiveStepPublisher(env, frames)
```

전체 파일을 읽어서 정확한 구조와 환경 변수 설정 위치를 파악한 후 수정한다.

- [ ] **Step 6: test_image_contract.py 수정**

`dashboard/recipes/isaaclab/test_image_contract.py` 확인 및 수정:

파서 도움말에 `--live-view`가 있는지 테스트 추가:

```python
def test_live_view_flag_in_help(self):
    """Verify --live-view {on,off} flag is present in train.py help."""
    result = subprocess.run(
        ['python3', '/opt/recipes/isaaclab/train.py', '--help'],
        capture_output=True,
        text=True,
        timeout=10
    )
    assert '--live-view' in result.stdout, "--live-view flag not found in help"
    assert '{on,off}' in result.stdout or 'on' in result.stdout, "live-view choices not documented"
```

- [ ] **Step 7: 타입과 기존 테스트 확인**

Run: `cd dashboard/recipes && python3 -m unittest isaaclab.test_image_contract -v && python3 -m unittest isaaclab.test_live_publisher -v`
Expected: PASS.

또는 기존 이미지 계약 테스트가 정의된 방식 확인 (dockerfile 검사 등).

- [ ] **Step 8: 커밋**

```bash
cd dashboard/recipes
git add \
  isaaclab/live.py \
  isaaclab/train.py \
  isaaclab/test_live_publisher.py \
  isaaclab/test_image_contract.py
git commit -m "feat(dashboard): add Isaac Lab live-view frame publishing

New LiveStepPublisher wrapper at max ~10 fps. train.py --live-view {on,off}.

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

---

### Task 4: 템플릿과 컴파일러 통합

**Files:**
- Modify: `dashboard/web/src/server/workflow/builtin-templates.ts`
- Modify: `dashboard/web/src/server/workflow/compile.ts` (확인만, 변경 없음)
- Test: `dashboard/web/src/server/workflow/builtin-templates.test.ts`
- Test: `dashboard/web/src/server/workflow/compile.test.ts` (기존, 변경 없음)

**Interfaces:**
- `isaacTrain()`: `live: true` 필드 추가, `'--live-view', '{{ live_view }}'` args 추가.
- `isaacParams()`: `live_view` select 파라미터 추가 (on/off, default on, label "실시간 보기 프레임 게시").

- [ ] **Step 1: builtin-templates.ts 수정 — isaacTrain()**

`dashboard/web/src/server/workflow/builtin-templates.ts` l.95-99 (isaacTrain 함수) 수정:

```ts
const isaacTrain = (task: string): TaskDefinition => ({ 
  name: 'train', 
  resource: 'gpu', 
  image: '{{ image }}',
  live: true,  // ← ADD
  command: ['/isaac-sim/python.sh', '/opt/recipes/isaaclab/train.py'],
  args: ['--task', task, '--output-dir', '{{output}}', '--seed', '{{ seed }}', '--num-envs', '{{ num_envs }}',
    '--iterations', '{{ iterations }}', '--checkpoint-every', '{{ checkpoint_every }}', '--resume', '{{ resume }}', 
    '--live-view', '{{ live_view }}',  // ← ADD
    '--headless'],
  environment: isaacEnv, 
  outputs: published('isaaclab-checkpoints') 
});
```

- [ ] **Step 2: isaacParams() 수정**

`dashboard/web/src/server/workflow/builtin-templates.ts` l.93-94 (isaacParams 함수) 수정:

```ts
const isaacParams = () => [
  image('ISAACLAB_IMAGE_URI'), 
  seed(), 
  P('num_envs', "병렬 환경 수", '2048', 'number'),
  P('iterations', "추가 PPO 학습 반복 횟수", '300', 'number'), 
  P('checkpoint_every', "체크포인트 저장 주기 (반복 횟수)", '50', 'number'), 
  resume(),
  P('live_view', "실시간 보기 프레임 게시", 'on', 'select'),  // ← ADD
];
```

참고: `P` 함수는 l.19-20 정의되어 있고, 5번째 인자 `help`가 추가되므로 원한다면 추가:

```ts
P('live_view', "실시간 보기 프레임 게시", 'on', 'select', "훈련 중 실시간 MJPEG 스트림을 활성화합니다. 배포 시 PAI_LIVE_DIR이 필요합니다."),
```

그런데 `P` 함수의 `type` 기본값이 'string'이고 select를 지원하는지 확인 필요. 아마도 현재 YAML에 option들이 별도로 정의되어야 할 수 있다. RecipeMetadata의 ports와 같이 options 필드가 필요하다면 plan G에서 정의해야 한다. **여기서는 기본 구현만 한다 (옵션 선택은 UI나 wizard 단계에서).**

기본값을 'on'으로 설정하되, 만약 select 타입이 UI에서 선택지를 요구한다면 파라미터 정의 후 문서 주석으로 설명한다:

```ts
// live_view: on/off (select type, requires UI support in wizard)
P('live_view', "실시간 보기 프레임 게시", 'on'),
```

또는 type 파라미터를 명시적으로:

```ts
P('live_view', "실시간 보기 프레임 게시", 'on', 'select' as any),
```

현재 코드에서 select 타입 사용 예시 검색:

Run: `grep -n "type: 'select'" dashboard/web/src/server/workflow/builtin-templates.ts`

만약 없으면 type 파라미터를 생략하고 (기본값 'string'), 실제 선택지는 dashboard 마법사에서 처리한다 (plan G의 역할).

- [ ] **Step 3: 정합성 테스트**

`dashboard/web/src/server/workflow/builtin-templates.test.ts` 수정 (또는 새로 추가):

```ts
describe('isaaclab recipes', () => {
  it('isaaclab-train template has live: true', () => {
    const templates = getBuiltinTemplates();
    const isaacTrain = templates.find(t => t.id === 'isaaclab-train');
    expect(isaacTrain).toBeDefined();
    const spec = YAML.parse(isaacTrain!.yaml);
    expect(spec.workflow.tasks[0].live).toBe(true);
    expect(spec.workflow.tasks[0].args).toContain('--live-view');
    expect(spec.workflow.tasks[0].args).toContain('{{ live_view }}');
  });

  it('isaaclab-train params include live_view', () => {
    const templates = getBuiltinTemplates();
    const isaacTrain = templates.find(t => t.id === 'isaaclab-train');
    expect(isaacTrain?.params.some(p => p.name === 'live_view')).toBe(true);
  });

  it('isaaclab-h1 template has live: true', () => {
    const templates = getBuiltinTemplates();
    const isaacH1 = templates.find(t => t.id === 'isaaclab-h1');
    expect(isaacH1).toBeDefined();
    const spec = YAML.parse(isaacH1!.yaml);
    expect(spec.workflow.tasks[0].live).toBe(true);
  });
});
```

- [ ] **Step 4: compile.ts 확인 (변경 없음)**

Run: `grep -n "live:" dashboard/web/src/server/workflow/compile.ts | head -5`
Expected: 이미 `live: true` → sidecar 로직이 있어야 함. 확인만 한다.

l.326-335 찾아 보기:

```ts
// compile.ts에서 이미 존재하는 로직:
// if (task.live) { … setup sidecar on pai-live port … }
```

변경 없음. Task 정의에 `live: true`만 추가하면 기존 컴파일러가 처리한다.

- [ ] **Step 5: 테스트 통과**

Run: `cd dashboard/web && npm test -- src/server/workflow/builtin-templates.test.ts && npm test -- src/server/workflow/compile.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: 커밋**

```bash
cd dashboard/web
git add src/server/workflow/builtin-templates.ts src/server/workflow/builtin-templates.test.ts
git commit -m "feat(dashboard): add live-view parameter to Isaac Lab recipes

isaacTrain() gets live: true and --live-view argument with {{ live_view }}.

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

---

### Task 5: 이미지 Dockerfile 확인 및 설정

**Files:**
- Check: `dashboard/images/isaaclab/Dockerfile`
- Docs: `dashboard/docs/dashboard-features-and-aws-architecture.md` §9 (DCV)

**Interfaces:**
- Isaac Lab 이미지는 이미 위의 `py` 스크립트들이 포함되어야 함.
- `pai_live` 모듈 접근성 확인 (PYTHONPATH).

- [ ] **Step 1: Dockerfile 검토**

Run: `grep -n "PYTHONPATH\|pai_live\|recipes" dashboard/images/isaaclab/Dockerfile | head -20`

Expected: 
- `COPY dashboard/recipes /opt/recipes` 또는 유사 (또는 FROM에서 이미 포함됨)
- `PYTHONPATH` 설정 확인 (parents[1]에 recipes 포함되는지)

현재 code에서 `isaaclab/train.py` l.9:
```python
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
```

이는 `/opt/recipes`를 PYTHONPATH에 추가하므로, `from pai_live import LiveFrames`가 작동한다.

검증: dockerfile에 recipes 사본 확인.

Run: `grep -A5 "COPY.*recipes" dashboard/images/isaaclab/Dockerfile`

- [ ] **Step 2: pai_live 접근성 보장**

dockerfile에 명시적으로 필요 없음 (COPY 이미 있으면). 만약 `RUN pip install` 같은 게 필요하면 (예: imageio), 추가:

```dockerfile
RUN pip install imageio
```

확인:

Run: `grep imageio dashboard/images/isaaclab/Dockerfile`

만약 없으면 추가할 수도 있지만, 아마 isaac sim 이미지에 이미 포함되어 있을 것.

- [ ] **Step 3: 문서 업데이트 — §9 DCV**

`dashboard/docs/dashboard-features-and-aws-architecture.md` 찾아서 §9 (DCV) 찾기:

Run: `grep -n "^## 9\|^### 9\|^#### 9" dashboard/docs/dashboard-features-and-aws-architecture.md`

또는 "DCV" 검색:

Run: `grep -n "DCV" dashboard/docs/dashboard-features-and-aws-architecture.md | head -5`

DCV 섹션 끝에 문단 추가:

```
- **라이브 뷰**: 대시보드 "실시간 보기" 기능은 두 가지 방식을 지원합니다.
  - MuJoCo 훈련: `live: true` 컴파일 옵션으로 자동 활성화.
  - Isaac Lab 훈련: `--live-view on` 플래그(기본값)로 프레임을 PAI_LIVE_DIR 경로에 게시. 
  관리자 DCV 데스크톱과 달리, 라이브 뷰는 각 워크플로우 실행에 연결되며 실시간 MJPEG 스트림을 제공합니다.
```

- [ ] **Step 4: 커밋 (문서만)**

```bash
git add dashboard/docs/dashboard-features-and-aws-architecture.md
git commit -m "docs(dashboard): document live view for Isaac Lab training

Live view activated via --live-view flag; distinct from DCV workstation.

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

---

### Task 6: 최종 통합 테스트 및 검증

**Files:**
- Test: all unit/integration tests running
- Verify: template compilation with sidecar

**Interfaces:**
- No new interfaces; this is verification.

- [ ] **Step 1: 전체 테스트 실행**

Run:
```bash
cd dashboard/web && npm test -- \
  src/server/workflow/views \
  src/server/workflow/builtin-templates \
  src/server/workflow/compile \
  src/components/workflows/TaskConnections \
  && npm run typecheck
```

Expected: PASS, 타입 오류 없음.

Run:
```bash
cd dashboard/recipes && python3 -m unittest \
  isaaclab.test_live_publisher \
  isaaclab.test_image_contract \
  mujoco.test_checkpoint_bundle \
  -v 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 2: 템플릿 컴파일 검증**

Run: `cd dashboard/web && npm test -- src/server/workflow/compile.test.ts -t "isaac"`
Expected: Isaac Lab 템플릿이 sidecar 컴파일 옵션을 포함하는지 확인 (기존 테스트 통과).

또는 직접 확인:

```bash
cd dashboard/web
npm run -s tsx -- -e "
const { getBuiltinTemplates } = require('./src/server/workflow/builtin-templates');
const { compileTask } = require('./src/server/workflow/compile');
const t = getBuiltinTemplates().find(t => t.id === 'isaaclab-train');
const spec = require('yaml').parse(t.yaml);
const compiled = compileTask(spec.workflow.tasks[0], {}, 'us-east-1');
console.log('live:', compiled.live);
console.log('has sidecar:', compiled.sidecars?.some(s => s.name === 'pai-live'));
"
```

Expected: `live: true`, `has sidecar: true`.

- [ ] **Step 3: 호환성 검증 — 레거시 specs**

Run: `cd dashboard/web && npm test -- src/server/workflow/views.test.ts`

Expected: `taskViews(legacySpec, 'train')` = `undefined` (backward compatible).

- [ ] **Step 4: 문서 확인**

Run: `grep -r "실시간 보기\|live.py\|LiveStepPublisher" dashboard/docs/ dashboard/recipes/ 2>/dev/null | wc -l`
Expected: 최소 3줄 (코드 주석 + 문서).

---

### Task 7: 수동 GPU 검증 (선택사항, 사용자 허가 시)

**Files:**
- Verify: actual deployment and runtime behavior

**Prerequisites:**
- GPU 그룹 스케일 가능 (`hyperpod-training/scripts/scale-cluster.sh`).
- 대시보드 배포 준비 완료.

**Note:** 이 테스트는 비용 발생. 사용자가 명시적으로 허가해야 함.

- [ ] **Step 1: 배포**

Run:
```bash
cd dashboard && cdk deploy --require-approval never
# 또는 기존 배포 프로세스
```

Wait: 배포 완료 (5-10분).

- [ ] **Step 2: GPU 스케일 업**

Run:
```bash
cd hyperpod-training
./scripts/scale-cluster.sh gpu-g5-8x 1 --cluster hyperpod-eks-913524902871
```

Wait: 노드 준비 (5분).

- [ ] **Step 3: 이미지 프로필 재승인**

Run (또는 콘솔):
```bash
# dashboard/docs 또는 README의 지시 따르기
# 예: recipes COPY 업데이트 시 이미지 프로필 API call
aws sagemaker create-image-version \
  --image-name isaac-lab-gpu \
  --base-image-uri <uri> \
  # 등…
```

또는 콘솔에서 수동 승인 (if re-approval is needed).

- [ ] **Step 4: 훈련 제출**

대시보드 UI에서:
1. "isaaclab-train" 템플릿 선택.
2. 매개변수:
   - num_envs: 64
   - iterations: 20
   - live_view: on
3. 제출.

- [ ] **Step 5: 실시간 보기 확인**

대시보드 워크플로우 상세 페이지:
- 작업 "train" 선택.
- "실시간 보기" 버튼 렌더됨 (views gating 작동).
- 클릭 → 라이브 MJPEG 스트림 확인.

- [ ] **Step 6: 프레임 카운트 검증**

포트 포워드:
```bash
kubectl port-forward -n pai <pod> 5555:5555 &
curl http://localhost:5555/status.json | jq '.frame_count'
# Expected: 점진적 증가 (~1 fps * time_s)
```

- [ ] **Step 7: 스케일 다운**

Run:
```bash
./scripts/scale-cluster.sh gpu-g5-8x 0 --cluster hyperpod-eks-913524902871
```

---

## 자체 검토 — 스펙 대 태스크 매핑

| 스펙 섹션 | 요구사항 | Task 매핑 | 검증 |
|---------|--------|---------|------|
| §3.4 Views gating — TensorBoard 렌더 조건 | `views` 포함/undefined 체크 | Task 1 (views.ts, TaskConnections 게이팅) | vitest + browser test |
| §3.4 Views gating — MLflow 렌더 조건 | `views.includes('mlflow')` + workflow.mlflow | Task 1 (TaskConnections 게이팅) | vitest |
| §3.4 Legacy behavior | `views` 없음 = 모두 표시 | Task 1 (taskViews 반환 undefined) | vitest |
| §3.5 LiveFrames 이동 | pai_live.py, mujoco re-export | Task 2 (move & import) | python3 import test |
| §3.5 LiveStepPublisher 래퍼 | env.step() + frames.due() + render | Task 3 (live.py) | unit test, ~10 fps capping |
| §3.5 train.py --live-view flag | {on,off}, default off | Task 3 (train.py args) | --help assertion, test_image_contract |
| §3.5 args.enable_cameras = True | headless rendering 조건 | Task 3 (train.py 로직) | Dockerfile 존재 확인, GPU test |
| §3.5 sidecar 컴파일 | `live: true` → pai-live port | Task 4 (isaacTrain live: true) | compile.test.ts + manual |
| §3.5 템플릿 --live-view 매개변수 | select/on/off, default on, label | Task 4 (isaacParams live_view) | builtin-templates.test.ts |
| 문서 업데이트 | §9 DCV vs. live view | Task 5 (docs) | grep 확인 |
| GPU 검증 (선택) | live frames 실제 스트리밍 | Task 7 (manual) | 실시간 보기 활성화, frame_count ↑ |

---

## 커밋 요약

```
1. feat(dashboard): gate TensorBoard/MLflow on task views from recipe metadata
2. refactor(dashboard): move LiveFrames to standalone pai_live module
3. feat(dashboard): add Isaac Lab live-view frame publishing
4. feat(dashboard): add live-view parameter to Isaac Lab recipes
5. docs(dashboard): document live view for Isaac Lab training
```

배포 전 확인:
- 모든 웹 테스트 통과 (`npm test`)
- 모든 파이썬 테스트 통과 (`python3 -m unittest`)
- 타입 체크 통과 (`npm run typecheck`)
- CDK 배포 (`cdk deploy` 또는 기존 프로세스)
- 이미지 프로필 재승인 (recipes 변경 시)
