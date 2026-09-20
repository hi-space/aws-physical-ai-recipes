/** Researcher recipes backed by baked source, explicit image contracts and real algorithms. */
import YAML from 'yaml';
import { getRepo } from '../store/repo';
import type { Template, TemplateParam } from '../store/types';
import { parseWorkflowYaml } from './template';
import { GR00T_EVAL_PY } from './gr00t-scripts';
import type { RecipeMetadata } from '@/lib/workflow/recipe-metadata';
import type { PortKind, RecipePorts } from '@/lib/workflow/ports';
type TaskDefinition = Record<string, unknown> & { name: string };
const P = (name: string, label: string, value: string, type: TemplateParam['type'] = 'string', help?: string): TemplateParam =>
  ({ name, label, type, default: value, ...(help ? { help } : {}) });
// Image params render as an approved-profile picker (components/workflows/ImagePicker.tsx). When the deployment
// variable is unset the default is `required://<ENV>`; the picker maps that back to the seeded `builtin-*` profile.
const image = (env: string, name = 'image'): TemplateParam => P(name, `${env} 실행 이미지 URI`, process.env[env] || `required://${env}`, 'image', "승인된 이미지 프로파일에서 선택하거나 레시피 실행 코드가 포함된 고정 이미지 URI를 직접 입력하세요.");
const seed = () => P('seed', "난수 seed", '42', 'number');
// A dataset input contributes two params: the registered dataset and its version. The task input consumes
// the version param via a template placeholder; the same param name feeds the ports metadata (versionParam)
// and a later dataset-picker task.
// The dataset param must name its versionParam: TemplateParamField only writes the DatasetPicker's chosen
// version back into that slot, and the wizard/composer hide the raw number field only for a declared slot.
// Without it the picker's version never reached `dataset_version`, which stayed at its default of 1.
const dataset = (name = 'dataset_name', value = 'leisaac-pick-orange', versionParam = 'dataset_version'): TemplateParam[] => [
  { ...P(name, "등록된 입력 데이터셋", value, 'dataset'), versionParam },
  P(versionParam, "데이터셋 버전", '1', 'number'),
];
const ports = (inputs: { param: string; kind: PortKind; label: string; versionParam?: string }[], outputs: { name: string; kind: PortKind; label: string }[]): RecipePorts => ({ inputs, outputs });
const views = (record: Record<string, ('tensorboard' | 'mlflow')[]>): Record<string, ('tensorboard' | 'mlflow')[]> => record;
const resume = () => P('resume', "재개할 체크포인트 (선택)", '', 'string', "이전 실행의 검증된 체크포인트를 사용합니다. 결과는 새 실행·시도 경로에 저장됩니다.");
const token = () => P('hf_token_param', "HF 토큰의 등록된 자격증명 참조", '/groot/hf-token');
const cpu = { cpu: 4, memory: '8Gi', gpu: 0, platform: 'ml.c5.4xlarge' };
const gpu = { cpu: 8, memory: '32Gi', gpu: 1, platform: 'ml.g5.8xlarge', shm_size: '8Gi' };
const isaacEnv = { ACCEPT_EULA: 'Y', PRIVACY_CONSENT: 'Y', OMNI_KIT_ACCEPT_EULA: 'YES', OMNI_KIT_ALLOW_ROOT: '1', PYTHONPATH: '/opt/workshop/src:/opt/recipes' };
const credentials = { huggingface: { HF_TOKEN: '{{ hf_token_param }}' } };
const published = (prefix: string, path = '{{output}}') => [{ dataset: { name: `${prefix}-{{workflow_id}}`, path } }];
const source = {
  workshop: 'https://github.com/hi-space/aws-physical-ai-recipes/tree/2a65a217c94da7dcb961076ffccdb38d82bef473/hyperpod-training',
  menagerie: 'https://github.com/google-deepmind/mujoco_menagerie/tree/ac6b2b09983786f3036cab1000221017fa2193b4/robotstudio_so101',
  isaac: 'https://github.com/isaac-sim/IsaacLab/tree/3c6e67bb5c7ada942a6d1884ab69338f57596f77',
  groot: 'https://github.com/NVIDIA/Isaac-GR00T/tree/5dc80c4afd726b34faad1d8f7e007a13b34e4c88',
  openpi: 'https://github.com/Physical-Intelligence/openpi/tree/215abfb217dbac7d5f1273282331b9b1866c0479',
  leisaac: 'https://github.com/LightwheelAI/leisaac/tree/24d3bcd3f1e4585740fc79921782c41617237812',
  cosmos: 'https://github.com/nvidia-cosmos/cosmos-transfer2.5/tree/0033b77a9e41e74f9d8d0b9cf80e0ecf94b3533b',
  cosmos3: 'https://github.com/NVIDIA/cosmos-framework/tree/c23e51f2f157ae3e51cfcd86ebfb5464850894f2',
  replicator: 'https://docs.isaacsim.omniverse.nvidia.com/5.1.0/replicator_tutorials/tutorial_replicator_getting_started.html',
  ros: 'https://docs.ros.org/en/humble/Tutorials/Advanced/Discovery-Server/Discovery-Server.html',
};
const imagePrereq = (env: string, parameter = 'image') => ({ kind: 'image', environment: env, parameter, reason: `실행 코드가 포함된 이미지를 준비하세요: dashboard/images/${env === 'GROOT_RUNTIME_IMAGE_URI' ? 'groot' : env.replace('_IMAGE_URI', '').toLowerCase()}/Dockerfile. URI는 해당 레시피 어댑터가 포함된 이미지를 가리켜야 합니다.` });
const gpuPrereq = { kind: 'hardware', reason: "할당 가능한 NVIDIA GPU, 호환 드라이버와 공유 메모리가 필요합니다. CPU 테스트로 GPU 실행까지 검증한 것은 아닙니다." };
const modelPrereq = { kind: 'model-access', reason: "사용 권한이 있는 모델 가중치를 준비하고 데이터셋의 embodiment·카메라·action 형식을 확인하세요. 자격증명은 비밀값 대신 참조를 사용합니다." };
const isaacPrereqs = [imagePrereq('ISAACLAB_IMAGE_URI'), gpuPrereq, { kind: 'license-assets', reason: "NVIDIA Isaac Sim 이용 약관을 확인하고 필요한 USD 자산에 접근할 수 있도록 준비하세요." }];

function recipe(options: {
  id: string; title: string; description: string; category: Template['category']; params: TemplateParam[];
  tasks?: TaskDefinition[]; groups?: Record<string, unknown>[]; resources?: Record<string, unknown>;
  metadata: Omit<RecipeMetadata, 'revision'>; mlflow?: boolean;
}): Template {
  const metadata: RecipeMetadata = { revision: '2026-09-16.1', ...options.metadata };
  const yaml = YAML.stringify({
    workflow: { name: options.id, description: options.description, mlflow: options.mlflow ?? false,
      timeout: { exec_timeout: '12h', queue_timeout: '2h', start_timeout: '20m' },
      resources: options.resources ?? { cpu, gpu }, tasks: options.tasks ?? [],
      ...(options.groups ? { groups: options.groups } : {}) },
    'default-values': Object.fromEntries(options.params.map(p => [p.name, p.default ?? ''])),
    ui: { recipe: metadata },
  }, { lineWidth: 0 });
  const needsGpu = metadata.prerequisites.some(p => p.kind === 'hardware');
  return { id: options.id, title: options.title,
    description: `${metadata.readiness === 'cpu-validated' ? '' : '준비 사항을 확인하세요. '}${options.description}`,
    category: options.category, builtin: true, yaml, params: options.params,
    requires: ['fsx', ...(needsGpu ? ['gpu' as const] : []), ...(options.mlflow ? ['mlflow' as const] : [])],
    createdAt: '2026-09-16T00:00:00Z' };
}
const cpuMetadata = (artifacts: string[], evaluationType?: RecipeMetadata['evaluationType']): Omit<RecipeMetadata, 'revision'> => ({
  readiness: process.env.MUJOCO_IMAGE_URI ? 'cpu-validated' : 'image-required', verification: 'local-docker',
  prerequisites: [imagePrereq('MUJOCO_IMAGE_URI')], sources: [source.workshop, source.menagerie], artifacts,
  imageContract: 'dashboard/images/mujoco/Dockerfile (repository root context)', evaluationType,
});
const gpuMetadata = (contract: string, sources: string[], artifacts: string[], prerequisites: RecipeMetadata['prerequisites'] = isaacPrereqs): Omit<RecipeMetadata, 'revision'> => ({
  readiness: 'prerequisites-required', verification: 'source-verified-gpu-unverified', prerequisites, sources, artifacts,
  imageContract: `dashboard/images/${contract}/Dockerfile (repository root context)`,
});
const mujocoParams = () => [image('MUJOCO_IMAGE_URI'), seed(), P('total_steps', "추가 PPO 학습 step 수", '200000', 'number'),
  P('num_envs', "병렬 환경 수", '4', 'number'), P('checkpoint_every', "체크포인트 저장 주기 (steps)", '10000', 'number'), resume()];
const mujocoTrain = (): TaskDefinition => ({ name: 'train', resource: 'cpu', image: '{{ image }}', live: true, command: ['python', '/opt/recipes/mujoco/train.py'],
  args: ['--output-dir', '{{output}}', '--seed', '{{ seed }}', '--total-steps', '{{ total_steps }}', '--num-envs', '{{ num_envs }}',
    '--checkpoint-every', '{{ checkpoint_every }}', '--resume', '{{ resume }}'],
  environment: { MUJOCO_GL: 'osmesa', MUJOCO_MENAGERIE_DIR: '/opt/mujoco_menagerie', OMP_NUM_THREADS: '1' },
  checkpoint: [{ path: '{{output}}', url: 'auto', frequency: '30s', regex: '^(final|checkpoints/step-[0-9]+)/(model\\.zip|vecnormalize\\.pkl|manifest\\.json)$' }],
  retry: { max_retries: 1 },
  exitActions: { COMPLETE: 0, RESCHEDULE: 75 }, outputs: published('mujoco-checkpoints') });
const mujocoEval = (pipeline = false): TaskDefinition => ({ name: 'evaluate', resource: 'cpu', image: '{{ image }}', live: true,
  command: ['python', '/opt/recipes/mujoco/evaluate.py'],
  args: ['--checkpoint', pipeline ? '{{input:0}}/final' : '{{input:0}}/{{ checkpoint_bundle }}', '--output-dir', '{{output}}',
    '--seed', '{{ eval_seed }}', '--episodes', '{{ episodes }}'],
  inputs: pipeline ? [{ task: 'train' }] : [{ dataset: { name: '{{ dataset_name }}', version: '{{ dataset_version }}' } }],
  environment: { MUJOCO_GL: 'osmesa' }, outputs: published('mujoco-evaluation') });
const evalParams = () => [P('episodes', "평가 에피소드 수", '5', 'number'), P('eval_seed', "독립 평가 seed", '2042', 'number')];
const isaacParams = () => [image('ISAACLAB_IMAGE_URI'), seed(), P('num_envs', "병렬 환경 수", '2048', 'number'),
  P('iterations', "추가 PPO 학습 반복 횟수", '300', 'number'), P('checkpoint_every', "체크포인트 저장 주기 (반복 횟수)", '50', 'number'), resume(),
  { ...P('live_view', "실시간 보기 프레임 게시", 'on', 'select', "훈련 중 실시간 MJPEG 스트림을 활성화합니다. 배포 시 PAI_LIVE_DIR이 필요합니다."), options: ['on', 'off'] }];
const isaacTrain = (task: string): TaskDefinition => ({ name: 'train', resource: 'gpu', image: '{{ image }}', live: true,
  command: ['/isaac-sim/python.sh', '/opt/recipes/isaaclab/train.py'],
  args: ['--task', task, '--output-dir', '{{output}}', '--seed', '{{ seed }}', '--num-envs', '{{ num_envs }}',
    '--iterations', '{{ iterations }}', '--checkpoint-every', '{{ checkpoint_every }}', '--resume', '{{ resume }}',
    '--live-view', '{{ live_view }}', '--headless'],
  environment: isaacEnv, outputs: published('isaaclab-checkpoints') });
const sdgTask = (imageParam = 'image'): TaskDefinition => ({ name: 'generate', resource: 'gpu', image: `{{ ${imageParam} }}`,
  command: ['/isaac-sim/python.sh', '/opt/recipes/sdg/generate.py'],
  args: ['--scene', '{{ scene }}', '--output-dir', '{{output}}', '--frames', '{{ frames }}', '--seed', '{{ seed }}'],
  environment: isaacEnv, outputs: published('replicator-sdg') });
/** Cosmos 3 adapter task; the runner (cosmos-framework inference CLI) is fixed inside the image, every knob is argv. */
const cosmos3Platform = () => P('cosmos_platform', "GPU 인스턴스 타입 고정 (선택)", '', 'string',
  "비워 두면 프로젝트 큐가 제공하는 아무 GPU 노드에서 실행됩니다. 큐는 GPU 개수만 보고 VRAM은 보지 않으므로, 48 GB가 필요한 Nano는 ml.g6e.4xlarge처럼 맞는 타입을 적어 24 GB 노드 배치를 막는 편이 안전합니다.");
const cosmos3Guardrails = () => P('guardrails', "콘텍츠 가드레일 (on/off)", 'on', 'string',
  "cosmos-framework 기본값(on)은 게이트된 nvidia/Cosmos-Guardrail1 체크포인트를 내려받으므로 HF 토큰 계정이 그 저장소 약관을 한 번 수락해야 합니다. off는 업스트림 --no-guardrails로 실행합니다.");
const cosmos3Resource = { cpu: 8, memory: '64Gi', gpu: 1, shm_size: '16Gi' };
const cosmos3Task = (mode: 'image2video' | 'transfer', model: string, extra: string[], outputPrefix: string): TaskDefinition => ({
  // Task-level platform accepts '' (resource-level does not): empty = any GPU node the queue offers, non-empty = pin.
  // No HF_HOME here: the adapter caches checkpoints under the project's FSx root (outside the published output),
  // not in the container layer on the node's 100 GB root disk.
  name: mode, resource: 'cosmos3', platform: '{{ cosmos_platform }}', image: '{{ cosmos_image }}', command: ['python', '/opt/recipes/cosmos3/generate.py'],
  args: ['--mode', mode, '--model', model, '--input-dir', '{{input:0}}', '--output-dir', '{{output}}', '--seed', '{{ seed }}',
    '--prompt', '{{ prompt }}', '--resolution', '{{ resolution }}', '--guardrails', '{{ guardrails }}', ...extra],
  inputs: [{ task: 'generate' }], credentials, outputs: published(outputPrefix) });
const sceneParams = () => [P('scene', "이미지 안의 USD 장면 경로", '/opt/workshop/src/workshop/robots/usd/so_arm101.usd'),
  P('frames', "모달리티별 프레임 수", '32', 'number'), seed()];
/** SO-101 key mapping the pinned so101_modality.py expects at <dataset>/meta/modality.json (from e2e-workshop/groot/training/data/configs). */
const SO101_MODALITY_JSON = JSON.stringify({
  state: { single_arm: { start: 0, end: 5 }, gripper: { start: 5, end: 6 } },
  action: { single_arm: { start: 0, end: 5 }, gripper: { start: 5, end: 6 } },
  video: { front: { original_key: 'observation.images.front' }, wrist: { original_key: 'observation.images.wrist' } },
  annotation: { 'human.task_description': { original_key: 'task_index' } },
}, null, 2) + '\n';
const grootPrereqs = [imagePrereq('GROOT_RUNTIME_IMAGE_URI'), gpuPrereq, modelPrereq,
  { kind: 'mlflow', reason: "MLflow를 사용하려면 추적 서버·접근 역할과 학습 Python 환경의 sagemaker-mlflow 플러그인이 필요합니다." }];

/** CPU collective/training proof. The compiler injects this file before the runtime barrier. */
const torchGlooTraining = String.raw`import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import socket
import time
from datetime import timedelta

parser = argparse.ArgumentParser()
parser.add_argument("--steps", type=int, default=8)
parser.add_argument("--seed", type=int, default=42)
parser.add_argument("--observe-seconds", type=int, default=0)
args = parser.parse_args()
if not 1 <= args.steps <= 64 or not 0 <= args.seed <= 4294967295 or not 0 <= args.observe_seconds <= 30:
    raise SystemExit("steps must be 1..64, seed uint32, and observation hold 0..30 seconds")

# Use the documented runtime precedence; do not guess a rank or start a local second worker.
indices = [(name, os.environ[name]) for name in
           ("OSMO_TASK_REPLICA_INDEX", "JOB_COMPLETION_INDEX", "PAI_REPLICA_INDEX")
           if os.environ.get(name)]
if not indices or "PAI_REPLICA_INDEX" not in os.environ or any(not re.fullmatch("[01]", value) for _, value in indices):
    raise SystemExit("two trusted Indexed-Job replica indices are required")
rank = int(indices[0][1])
if any(int(value) != rank for _, value in indices):
    raise SystemExit("runtime replica environment values disagree")
world_size = int(os.environ["WORLD_SIZE"])
if world_size != 2 or os.environ["PAI_TASK_REPLICAS"] != "2":
    raise SystemExit("this recipe requires exactly two replicas of one task")
identity = {
    "runId": os.environ["PAI_WORKFLOW_ID"], "taskName": os.environ["PAI_TASK_NAME"],
    "attempt": int(os.environ["PAI_ATTEMPT"]), "epoch": os.environ["PAI_ATTEMPT_EPOCH"],
}
if not identity["runId"] or not identity["taskName"] or identity["attempt"] < 1 or not identity["epoch"]:
    raise SystemExit("runtime run/task/attempt identity is required")
output = Path(os.environ["PAI_OUTPUT_DIR"])
if not output.is_absolute() or not output.is_dir() or output.is_symlink():
    raise SystemExit("compiler-prepared output directory is required")
master = os.environ["MASTER_ADDR"]
port = int(os.environ["MASTER_PORT"])
if not master or not 1 <= port <= 65535:
    raise SystemExit("rank-zero rendezvous address is required")

import torch
import torch.distributed as dist
from torch.nn.parallel import DistributedDataParallel

torch.set_num_threads(1)
torch.manual_seed(args.seed)
if not dist.is_available() or not dist.is_gloo_available():
    raise SystemExit("the configured CPU image does not provide Torch/Gloo")
dist.init_process_group("gloo", init_method=f"tcp://{master}:{port}", rank=rank,
                        world_size=world_size, timeout=timedelta(seconds=60))
try:
    identities = [None, None]
    dist.all_gather_object(identities, {**identity, "rank": rank, "podHostname": socket.gethostname()})
    if [entry["rank"] for entry in identities] != [0, 1] or any(
        any(entry[key] != value for key, value in identity.items()) for entry in identities
    ):
        raise RuntimeError("collective peers do not belong to the same run/task/attempt")
    contribution = torch.tensor([rank + 1.0], dtype=torch.float64, device="cpu")
    dist.all_reduce(contribution, op=dist.ReduceOp.SUM)
    if contribution.item() != 3.0:
        raise RuntimeError("two-rank all_reduce did not return 1 + 2")

    # Rank 0 owns x=1,y=2; rank 1 owns x=2,y=4. DDP averages their real gradients.
    model = torch.nn.Linear(1, 1, bias=False, dtype=torch.float64, device="cpu")
    with torch.no_grad():
        model.weight.zero_()
    parallel = DistributedDataParallel(model, broadcast_buffers=False)
    optimizer = torch.optim.SGD(parallel.parameters(), lr=0.1)
    x = torch.tensor([[rank + 1.0]], dtype=torch.float64, device="cpu")
    y = 2.0 * x

    def global_loss():
        with torch.no_grad():
            loss = torch.mean((model(x) - y) ** 2)
        dist.all_reduce(loss, op=dist.ReduceOp.SUM)
        return float(loss.item() / world_size)

    initial_loss = global_loss()
    first_gradient = None
    for step in range(args.steps):
        optimizer.zero_grad(set_to_none=True)
        loss = torch.mean((parallel(x) - y) ** 2)
        loss.backward()
        if step == 0:
            first_gradient = float(model.weight.grad.item())
        optimizer.step()
    final_loss = global_loss()
    final_weight = float(model.weight.detach().item())
    weights = [torch.zeros(1, dtype=torch.float64, device="cpu") for _ in range(world_size)]
    dist.all_gather(weights, model.weight.detach().reshape(1))
    gathered_weights = [float(weight.item()) for weight in weights]
    expected_weight = 2.0 * (1.0 - 0.5 ** args.steps)
    if (not math.isclose(first_gradient, -10.0, abs_tol=1e-12) or
        not math.isclose(final_weight, expected_weight, abs_tol=1e-12) or
        not final_loss < initial_loss or
        any(not math.isclose(weight, final_weight, abs_tol=1e-12) for weight in gathered_weights)):
        raise RuntimeError("distributed SGD did not produce the expected shared learned weights")

    # Every rank owns separate files under the runtime output, with no shared checkpoint overwrite.
    rank_output = output / f"rank-{rank}"
    rank_output.mkdir(exist_ok=False)
    def json_bytes(value):
        return (json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n").encode()
    def atomic_write(name, writer):
        destination = rank_output / name
        temporary = rank_output / ("." + name + ".tmp")
        with temporary.open("xb") as stream:
            writer(stream)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(destination)
        return hashlib.sha256(destination.read_bytes()).hexdigest()

    model_sha = atomic_write("model.pt", lambda stream: torch.save({"weight": model.weight.detach().cpu().clone()}, stream))
    model_state = {"architecture": "Linear(1,1,bias=False)", "dtype": "float64", "device": "cpu",
                   "state_dict": {"weight": model.weight.detach().cpu().tolist()}}
    weights_sha = atomic_write("weights.json", lambda stream: stream.write(json_bytes(model_state)))
    proof = {
        "schemaVersion": 1, "recipe": "torch-gloo-2rank", **identity,
        "rank": rank, "replicaIndex": int(os.environ["PAI_REPLICA_INDEX"]),
        "worldSize": dist.get_world_size(), "backend": str(dist.get_backend()), "device": "cpu",
        "torchVersion": torch.__version__, "podHostname": socket.gethostname(),
        "observedRanks": [entry["rank"] for entry in identities], "peers": identities,
        "localContribution": rank + 1, "allReduceSum": float(contribution.item()),
        "steps": args.steps, "seed": args.seed, "learningRate": 0.1,
        "initialLoss": initial_loss, "finalLoss": final_loss,
        "firstAveragedGradient": first_gradient, "finalWeight": final_weight,
        "gatheredWeights": gathered_weights, "modelSha256": model_sha, "weightsSha256": weights_sha,
    }
    atomic_write("proof.json", lambda stream: stream.write(json_bytes(proof)))
    dist.barrier()
    print("CPU_GLOO_TRAINED " + json.dumps({"rank": rank, "allReduceSum": proof["allReduceSum"],
                                          "finalWeight": final_weight, "finalLoss": final_loss}), flush=True)
    # Optional bounded hold is for the live placement observer, not additional training.
    if args.observe_seconds:
        time.sleep(args.observe_seconds)
    dist.barrier()
finally:
    dist.destroy_process_group()
`;

function distributedCpuRecipe(): Template {
  return recipe({
    id: 'torch-gloo-2rank', title: 'Torch DDP / Gloo 2-rank 학습 (CPU)', category: 'training',
    description: "CPU rank 2개가 DDP 기울기 집계와 all_reduce로 같은 선형 모델을 학습합니다. rank당 CPU 8개를 요청하며 노드 배치와 READY 결과를 확인해야 합니다.",
    params: [image('MUJOCO_IMAGE_URI'), seed(), P('steps', "분산 SGD step 수 (1–64)", '8', 'number'),
      P('gloo_interface', "Gloo 통신용 Pod 네트워크 인터페이스", 'eth0'),
      P('observe_seconds', "노드 배치 확인 대기 시간 (0–30초)", '0', 'number', "배포 환경 테스트에서 Pod 배치를 확인할 수 있도록 학습 후 잠시 대기하는 선택 설정입니다.")],
    resources: { distributed_cpu: { cpu: 8, memory: '2Gi', gpu: 0, platform: 'ml.c5.4xlarge' } },
    groups: [{
      name: 'gloo', barrier: true, ignoreNonleadStatus: false,
      timeout: { queue: '8m', start: '5m', exec: '3m' }, retry: { max_retries: 0 },
      tasks: [{
        name: 'train', lead: true, parallelism: 2, resource: 'distributed_cpu', image: '{{ image }}',
        command: ['python', '/tmp/torch_gloo_train.py'],
        args: ['--steps', '{{ steps }}', '--seed', '{{ seed }}', '--observe-seconds', '{{ observe_seconds }}'],
        environment: { MASTER_ADDR: '{{host:train:0}}', MASTER_PORT: '29500', WORLD_SIZE: '2',
          GLOO_SOCKET_IFNAME: '{{ gloo_interface }}', OMP_NUM_THREADS: '1', PYTHONDONTWRITEBYTECODE: '1' },
        ports: [{ name: 'gloo-store', containerPort: 29500, protocol: 'TCP' }],
        files: [{ path: '/tmp/torch_gloo_train.py', contents: torchGlooTraining, mode: 0o444 }],
        outputs: published('torch-gloo'), exitActions: { COMPLETE: 0 }, retry: { max_retries: 0 },
      }],
    }],
    metadata: {
      readiness: 'prerequisites-required', verification: 'source-verified-network-unverified', evaluationType: 'training_only',
      imageContract: 'Existing dashboard/images/mujoco/Dockerfile image with CPU Torch and Gloo; no image change is required.',
      sources: ['https://docs.pytorch.org/docs/stable/distributed.html',
        'https://docs.pytorch.org/docs/stable/generated/torch.nn.parallel.DistributedDataParallel.html',
        'dashboard/runtime/README.md', 'dashboard/web/src/server/workflow/groups.ts'],
      artifacts: ['rank-0/{proof.json,weights.json,model.pt}', 'rank-1/{proof.json,weights.json,model.pt}'],
      prerequisites: [
        imagePrereq('MUJOCO_IMAGE_URI'),
        { kind: 'cpu-capacity', reason: "할당 가능한 ml.c5.4xlarge 노드 2대와 큐의 CPU 16개 할당량이 필요합니다. 노드당 가용 CPU 15.89개인 환경에서는 8-CPU Pod 2개가 서로 다른 노드에 배치되어야 합니다." },
        { kind: 'runtime', environment: 'TASK_RUNTIME_IMAGE', reason: "JobSet·Kueue 연동과 런타임 barrier가 train:0/train:1을 함께 시작해야 합니다. PAI_REPLICA_INDEX는 Indexed Job 완료 인덱스에서 가져오며 두 replica는 같은 leader task에 속합니다." },
        { kind: 'network', parameter: 'gloo_interface', reason: "JobSet DNS와 rank 0의 호스트 참조가 해석되어야 합니다. Pod 사이의 TCP 29500 및 Gloo 피어 통신을 허용하고 네트워크 인터페이스(기본 eth0)를 확인하세요." },
        { kind: 'storage', reason: "공유 FSx의 실행·시도별 출력 경로에서 각 rank가 별도 하위 폴더에 저장합니다. 최종 결과 검증이 끝나야 READY 데이터셋으로 게시됩니다." },
      ],
      ports: ports([], [{ name: 'torch-gloo', kind: 'artifacts', label: 'Distributed training proof' }]),
    },
  });
}

export const BUILTIN_TEMPLATES: Template[] = [
  recipe({ id: 'custom', title: "사용자 워크플로", category: 'custom',
    description: "직접 편집할 수 있는 최소 CPU 워크플로입니다. 실행별 JSON 결과를 저장해 기본 동작을 확인합니다.",
    params: [image('MUJOCO_IMAGE_URI'), P('who', "실행 라벨", 'physical-ai-dashboard')],
    tasks: [{ name: 'hello', resource: 'cpu', image: '{{ image }}', command: ['python', '-c'],
      args: ['import json,pathlib,sys; p=pathlib.Path(sys.argv[1]); p.mkdir(parents=True,exist_ok=True); (p/"done.json").write_text(json.dumps({"label":sys.argv[2]}))', '{{output}}', '{{ who }}'],
      outputs: published('custom-artifacts') }], metadata: { ...cpuMetadata(['done.json']), ports: ports([], [{ name: 'custom-artifacts', kind: 'artifacts', label: 'Run artifacts' }]) } }),
  recipe({ id: 'mujoco-train', title: "MuJoCo SO-101 PPO 학습 (CPU)", category: 'training',
    description: "SO-101 도달 과제를 SB3 PPO로 학습합니다. seed 고정, 정규화 통계와 짝이 맞는 체크포인트, 학습 재개를 지원합니다.",
    params: mujocoParams(), tasks: [mujocoTrain()], metadata: { ...cpuMetadata(['checkpoints/*/{model.zip,vecnormalize.pkl,manifest.json}', 'final/', 'model_best.zip', 'model_final.zip', 'best_checkpoint.json', 'tb/'], 'training_only'), ports: ports([], [{ name: 'mujoco-checkpoints', kind: 'checkpoint', label: 'Training checkpoint' }]), views: views({ train: ['tensorboard'] }) } }),
  recipe({ id: 'mujoco-render', title: "MuJoCo 폐루프 평가 (CPU)", category: 'evaluation',
    description: "고정 seed로 체크포인트를 평가하고 성공률·지연시간·JSON 보고서·MP4를 저장합니다. 모델과 정규화 통계가 짝을 이루는 묶음이 필요합니다.",
    params: [image('MUJOCO_IMAGE_URI'), ...dataset('dataset_name', 'mujoco-checkpoints-run-id'), P('checkpoint_bundle', "데이터셋 안의 체크포인트 묶음 경로", 'final'), ...evalParams()],
    tasks: [mujocoEval()], metadata: { ...cpuMetadata(['evaluation.json', 'videos/*.mp4'], 'closed_loop'), ports: ports([{ param: 'dataset_name', kind: 'checkpoint', label: 'Checkpoint dataset', versionParam: 'dataset_version' }], [{ name: 'mujoco-evaluation', kind: 'artifacts', label: 'Evaluation results' }]) } }),
  recipe({ id: 'mujoco-pipeline', title: "MuJoCo 학습 → 평가 (CPU)", category: 'training',
    description: "한 실행에서 SO-101 정책을 CPU로 학습하고, 그 실행에서 만든 체크포인트로 평가까지 진행합니다.",
    params: [...mujocoParams(), ...evalParams()], tasks: [mujocoTrain(), mujocoEval(true)],
    metadata: { ...cpuMetadata(['train/checkpoints/', 'evaluate/evaluation.json', 'evaluate/videos/'], 'closed_loop'), ports: ports([], [{ name: 'mujoco-checkpoints', kind: 'checkpoint', label: 'Training checkpoint' }, { name: 'mujoco-evaluation', kind: 'artifacts', label: 'Evaluation results' }]), views: views({ train: ['tensorboard'] }) } }),
  recipe({ id: 'isaaclab-train', title: "Isaac Lab SO-101 Reach/Lift PPO 학습", category: 'training',
    description: "SO-101 Reach/Lift를 RSL-RL PPO로 학습합니다. seed, 주기적 체크포인트, 재개 및 TensorBoard 지표의 MLflow 기록을 지원합니다.", mlflow: true,
    params: [...isaacParams(), { ...P('task', "워크숍 task 선택", 'Workshop-SO101-Reach-v0', 'select'), options: ['Workshop-SO101-Reach-v0', 'Workshop-SO101-Lift-v0'] }],
    tasks: [isaacTrain('{{ task }}')], metadata: { ...gpuMetadata('isaaclab', [source.workshop, source.isaac], ['model_final.pt', 'checkpoints/', 'environment.yaml', 'agent.yaml']), evaluationType: 'training_only', ports: ports([], [{ name: 'isaaclab-checkpoints', kind: 'checkpoint', label: 'Training checkpoint' }]), views: views({ train: ['tensorboard', 'mlflow'] }) } }),
  recipe({ id: 'isaaclab-h1', title: "Isaac Lab Unitree H1 보행 PPO 학습", category: 'training',
    description: "공식 H1 평지·험지 속도 과제를 RSL-RL PPO로 학습합니다. Unitree USD 자산 접근 권한과 검증된 GPU 환경이 필요합니다.", mlflow: true,
    params: [...isaacParams(), { ...P('task', "H1 task 선택", 'Isaac-Velocity-Flat-H1-v0', 'select'), options: ['Isaac-Velocity-Flat-H1-v0', 'Isaac-Velocity-Rough-H1-v0'] }],
    tasks: [isaacTrain('{{ task }}')], metadata: { ...gpuMetadata('isaaclab', [source.isaac], ['model_final.pt', 'checkpoints/', 'training.json']), ports: ports([], [{ name: 'isaaclab-checkpoints', kind: 'checkpoint', label: 'Training checkpoint' }]), views: views({ train: ['tensorboard', 'mlflow'] }) } }),
  recipe({ id: 'isaaclab-video', title: "Isaac Lab 체크포인트 재생 영상", category: 'evaluation',
    description: "저장된 정책을 재생해 영상을 만듭니다. 영상 확인용이며 성공률을 측정하는 평가는 아닙니다.",
    params: [image('ISAACLAB_IMAGE_URI'), P('task', "task 선택", 'Workshop-SO101-Reach-v0'), ...dataset('dataset_name', 'isaaclab-checkpoints-run-id'),
      P('checkpoint_file', "데이터셋 안의 체크포인트 파일", 'model_final.pt'), P('video_length', "영상 길이 (steps)", '300', 'number')],
    tasks: [{ name: 'video', resource: 'gpu', image: '{{ image }}', command: ['/isaac-sim/python.sh', '/opt/recipes/isaaclab/play.py'],
      args: ['--task', '{{ task }}', '--checkpoint', '{{input:0}}/{{ checkpoint_file }}', '--num_envs', '1', '--video', '--video_length', '{{ video_length }}', '--video_dir', '{{output}}/videos', '--headless', '--enable_cameras'],
      inputs: [{ dataset: { name: '{{ dataset_name }}', version: '{{ dataset_version }}' } }], environment: isaacEnv, outputs: published('isaaclab-video') }],
    metadata: { ...gpuMetadata('isaaclab', [source.workshop], ['videos/*.mp4']), ports: ports([{ param: 'dataset_name', kind: 'checkpoint', label: 'Checkpoint dataset', versionParam: 'dataset_version' }], [{ name: 'isaaclab-video', kind: 'video', label: 'Video playback' }]) } }),
  recipe({ id: 'hf-dataset-import', title: "Hugging Face 데이터셋 가져오기·검증", category: 'data',
    description: "지정한 HF revision의 데이터를 내려받아 LeRobot v3→v2.1로 변환하고 에피소드·영상 누락을 확인합니다.",
    params: [image('MUJOCO_IMAGE_URI'), P('hf_dataset_id', "HF 데이터셋 ID", 'LightwheelAI/leisaac-pick-orange'), P('revision', "HF 데이터 revision", 'main'), token()],
    tasks: [{ name: 'import', resource: 'cpu', image: '{{ image }}', command: ['python', '/opt/recipes/data/hf_import.py'],
      args: ['--repo-id', '{{ hf_dataset_id }}', '--revision', '{{ revision }}', '--output-dir', '{{output}}'], credentials,
      outputs: [...published('hf-import', '{{output}}/dataset'), { logs: '{{output}}/dataset-manifest.json' }] }],
    metadata: { ...cpuMetadata(['dataset/', 'dataset-manifest.json']), prerequisites: [imagePrereq('MUJOCO_IMAGE_URI'), { kind: 'dataset-access', reason: "Hugging Face 데이터 revision의 읽기 권한과 등록된 HF 토큰 참조가 필요합니다." }], ports: ports([], [{ name: 'hf-import', kind: 'lerobot-dataset', label: 'Imported dataset' }]) } }),
  recipe({ id: 'gr00t-finetune', title: "GR00T N1.6 파인튜닝", category: 'training', mlflow: true,
    description: "고정된 N1.6.1 코드로 파인튜닝하며 Trainer 재개와 MLflow loss 기록을 지원합니다. 기본 빠른 설정은 100 steps, 배치 4, 50 steps마다 저장입니다.",
    params: [image('GROOT_RUNTIME_IMAGE_URI'), ...dataset(), token(), seed(), resume(),
      P('base_model', "사용 권한이 있는 기본 모델", 'nvidia/GR00T-N1.6-3B'), P('max_steps', "목표 학습 step 수", '100', 'number'),
      P('save_steps', "체크포인트 저장 주기 (steps)", '50', 'number'), P('batch_size', "전체 배치 크기", '4', 'number'),
      P('diffusion_flag', "diffusion head 학습 플래그", '--no-tune-diffusion-model', 'string', "24 GB GPU(A10G/L4)는 --no-tune-diffusion-model, 48 GB 이상은 --tune-diffusion-model. 기본값(diffusion head 학습)은 ml.g5에서 CUDA OOM이 납니다.")],
    // GR00T's dataset factory writes meta/stats.json next to the dataset, but dataset inputs are mounted read-only,
    // so the run trains on a local copy of the LeRobot dataset on the node's ephemeral disk (same approach as gr00t-e2e).
    tasks: [{ name: 'finetune', resource: 'gpu', image: '{{ image }}', command: ['bash', '-c',
        'set -euo pipefail; cp -r "$1" /tmp/dataset; shift; exec python /opt/recipes/groot/train.py "$@"', 'pai-finetune'],
      args: ['{{input:0}}', '--output-dir', '{{output}}', '--seed', '{{ seed }}', '--resume', '{{ resume }}', '--base-model-path', '{{ base_model }}',
        '--dataset-path', '/tmp/dataset', '--embodiment-tag', 'NEW_EMBODIMENT', '--modality-config-path', '/opt/recipes/groot/so101_modality.py',
        '--max-steps', '{{ max_steps }}', '--save-steps', '{{ save_steps }}', '--save-total-limit', '1', '--global-batch-size', '{{ batch_size }}', '--num-gpus', '1', '{{ diffusion_flag }}'],
      inputs: [{ dataset: { name: '{{ dataset_name }}', version: '{{ dataset_version }}' } }], credentials,
      environment: { HF_HOME: '/tmp/hf' }, outputs: published('groot-checkpoints') }],
    metadata: { ...gpuMetadata('groot', [source.groot, source.workshop], ['checkpoint-*/', 'training.json'], grootPrereqs), ports: ports([{ param: 'dataset_name', kind: 'lerobot-dataset', label: 'Training dataset', versionParam: 'dataset_version' }], [{ name: 'groot-checkpoints', kind: 'checkpoint', label: 'Fine-tuned checkpoint' }]), views: views({ finetune: ['tensorboard', 'mlflow'] }) } }),
  recipe({ id: 'openpi-train', title: "OpenPI π0 LIBERO 파인튜닝", category: 'training',
    description: "공식 OpenPI JAX 학습기로 LIBERO LeRobot 데이터를 학습합니다. 정규화 계산·seed·재개를 지원하는 LoRA 설정이며 SO-101 호환성은 별도 확인이 필요합니다.",
    params: [image('OPENPI_IMAGE_URI'), ...dataset('dataset_name', 'libero'), seed(), resume(), token(),
      P('repo_id', "LeRobot 저장소 ID", 'physical-intelligence/libero'), P('steps', "목표 학습 step 수", '1000', 'number'), P('batch_size', "배치 크기", '4', 'number'), P('save_interval', "체크포인트 저장 간격", '100', 'number')],
    tasks: [{ name: 'train', resource: 'gpu', image: '{{ image }}', command: ['python', '/opt/recipes/openpi/train.py'],
      args: ['--dataset-root', '{{input:0}}', '--repo-id', '{{ repo_id }}', '--output-dir', '{{output}}', '--seed', '{{ seed }}', '--steps', '{{ steps }}',
        '--batch-size', '{{ batch_size }}', '--save-interval', '{{ save_interval }}', '--resume', '{{ resume }}'],
      credentials, inputs: [{ dataset: { name: '{{ dataset_name }}', version: '{{ dataset_version }}' } }], outputs: published('openpi-checkpoints') }],
    metadata: { ...gpuMetadata('openpi', [source.openpi], ['checkpoints/', 'assets/', 'training.json'], [imagePrereq('OPENPI_IMAGE_URI'), gpuPrereq, modelPrereq,
      { kind: 'model-access', reason: "gs://openpi-assets/checkpoints/pi0_base 읽기 권한이 필요합니다. 선택한 GPU에서 LoRA 메모리 요구량을 확인하세요." }]), ports: ports([{ param: 'dataset_name', kind: 'lerobot-dataset', label: 'Training dataset', versionParam: 'dataset_version' }], [{ name: 'openpi-checkpoints', kind: 'checkpoint', label: 'Fine-tuned checkpoint' }]), views: views({ train: ['tensorboard'] }) } }),
  recipe({ id: 'replicator-sdg', title: "Replicator RGB·depth·segmentation 생성", category: 'data',
    description: "USD 장면을 화면 없이 렌더링하고 seed 기반 카메라 무작위화와 모달리티별 프레임 manifest를 저장합니다.",
    params: [image('ISAACLAB_IMAGE_URI'), ...sceneParams()], tasks: [sdgTask()], metadata: { ...gpuMetadata('isaaclab', [source.replicator, source.workshop], ['frames/', 'dataset-manifest.json']), ports: ports([], [{ name: 'replicator-sdg', kind: 'sdg-frames', label: 'Synthetic frames' }]) } }),
  recipe({ id: 'mimic-pipeline', title: "Isaac Lab Mimic 시연 데이터 생성", category: 'data',
    description: "공식 annotation → Mimic 생성 → HDF5 action 검증을 진행합니다. Franka 블록 쌓기 시연 데이터가 필요하며 생성 횟수가 성공 횟수를 뜻하지는 않습니다.",
    params: [image('ISAACLAB_IMAGE_URI'), ...dataset('dataset_name', 'franka-stack-demonstrations'), P('input_file', "입력 데이터 안의 HDF5 파일 경로", 'dataset.hdf5'), P('trials', "데이터 생성 시도 횟수", '10', 'number'), P('num_envs', "환경 수", '1', 'number')],
    tasks: [{ name: 'mimic', resource: 'gpu', image: '{{ image }}', command: ['/isaac-sim/python.sh', '/opt/recipes/mimic/generate.py'],
      args: ['--input-file', '{{input:0}}/{{ input_file }}', '--output-dir', '{{output}}', '--trials', '{{ trials }}', '--num-envs', '{{ num_envs }}'],
      inputs: [{ dataset: { name: '{{ dataset_name }}', version: '{{ dataset_version }}' } }], environment: isaacEnv, outputs: published('mimic-demonstrations') }],
    metadata: { ...gpuMetadata('isaaclab', [source.isaac], ['annotated.hdf5', 'generated.hdf5', 'dataset-manifest.json'], [...isaacPrereqs,
      { kind: 'input-schema', reason: "Isaac-Stack-Cube-Franka-IK-Rel-Mimic-v0의 HDF5 시연 기록이 필요합니다. 일반 LeRobot 데이터로 대체할 수 없습니다." }]), ports: ports([{ param: 'dataset_name', kind: 'hdf5-demos', label: 'HDF5 demonstrations', versionParam: 'dataset_version' }], [{ name: 'mimic-demonstrations', kind: 'hdf5-demos', label: 'Generated demonstrations' }]) } }),
  recipe({ id: 'cosmos-pipeline', title: "Replicator → Cosmos 영상 증강", category: 'data',
    description: "RGB·depth·segmentation을 렌더링하고 제어 영상을 만든 뒤 공식 Cosmos-Transfer2.5를 실행합니다. 결과는 증강 영상입니다.",
    params: [image('ISAACLAB_IMAGE_URI', 'sim_image'), image('COSMOS_IMAGE_URI', 'cosmos_image'),
      ...sceneParams().map(p => p.name === 'frames' ? { ...p, default: '93' } : p), token(),
      P('cosmos_platform', "준비된 80 GB GPU 인스턴스 프로필", 'ml.p5.48xlarge'), P('prompt', "영상 생성 프롬프트", 'A robot arm reaching on a well-lit table.')],
    resources: { gpu, cosmos: { cpu: 16, memory: '128Gi', gpu: 1, platform: '{{ cosmos_platform }}', shm_size: '16Gi' } },
    tasks: [sdgTask('sim_image'), { name: 'transfer', resource: 'cosmos', image: '{{ cosmos_image }}', command: ['python', '/opt/recipes/cosmos/transfer.py'],
      args: ['--input-dir', '{{input:0}}', '--output-dir', '{{output}}', '--seed', '{{ seed }}', '--prompt', '{{ prompt }}'],
      inputs: [{ task: 'generate' }], credentials, outputs: published('cosmos-videos') }],
    metadata: { ...gpuMetadata('cosmos', [source.cosmos, source.replicator], ['generated/*.mp4', 'controls/', 'dataset-manifest.json'],
      [imagePrereq('ISAACLAB_IMAGE_URI', 'sim_image'), imagePrereq('COSMOS_IMAGE_URI', 'cosmos_image'), gpuPrereq, modelPrereq,
        { kind: 'hardware', reason: "Transfer2-2B 추론에는 문서상 VRAM 65.4 GB가 필요합니다. 호환되는 80 GB GPU를 준비하세요. 기존 A10G 용량으로는 부족합니다." }]), ports: ports([], [{ name: 'cosmos-videos', kind: 'video', label: 'Enhanced videos' }]) } }),
  // Cosmos 3 (cosmos-framework): one image, two recipes. Cosmos3-Edge rejects transfer hints upstream, so it only
  // animates the first SDG frame; Cosmos3-Nano keeps the frame-aligned depth-control path of the Transfer2.5 recipe.
  recipe({ id: 'cosmos3-edge-pipeline', title: "Replicator → Cosmos 3 Edge image-to-video", category: 'data',
    description: "RGB 프레임 한 장을 렌더링한 뒤 Cosmos3-Edge(4B)로 프롬프트에 맞는 영상을 생성합니다. 결과는 첫 프레임에서 시작하는 생성 영상이며 SDG 프레임과 정렬되지 않습니다.",
    params: [image('ISAACLAB_IMAGE_URI', 'sim_image'), image('COSMOS3_IMAGE_URI', 'cosmos_image'),
      ...sceneParams().map(p => p.name === 'frames' ? { ...p, default: '1' } : p), token(),
      P('prompt', "영상 생성 프롬프트", 'A robot arm reaching on a well-lit table.'),
      cosmos3Platform(), cosmos3Guardrails(), P('resolution', "출력 해상도 단계 (256/480/720)", '480'), P('num_frames', "생성 프레임 수 (Edge 최대 150)", '93', 'number')],
    resources: { gpu, cosmos3: cosmos3Resource },
    tasks: [sdgTask('sim_image'), cosmos3Task('image2video', 'Cosmos3-Edge', ['--num-frames', '{{ num_frames }}'], 'cosmos3-edge-videos')],
    metadata: { ...gpuMetadata('cosmos3', [source.cosmos3, source.replicator], ['generated/*/vision.mp4', 'controls/', 'dataset-manifest.json'],
      [imagePrereq('ISAACLAB_IMAGE_URI', 'sim_image'), imagePrereq('COSMOS3_IMAGE_URI', 'cosmos_image'), gpuPrereq, modelPrereq,
        { kind: 'hardware', reason: "Cosmos3-Edge(4B)는 업스트림이 Jetson·H100에서 검증했고 24 GB GPU(ml.g5 A10G, ml.g6 L4)에서의 실행은 미검증입니다. 가중치 약 10 GB는 프로젝트 FSx 캐시(cache/hf)에 내려받습니다. 가드레일 on이면 HF 계정이 nvidia/Cosmos-Guardrail1 약관을 수락해야 합니다." }]),
      ports: ports([], [{ name: 'cosmos3-edge-videos', kind: 'video', label: 'Generated videos' }]) } }),
  recipe({ id: 'cosmos3-nano-pipeline', title: "Replicator → Cosmos 3 Nano depth transfer", category: 'data',
    description: "RGB·depth·segmentation을 렌더링하고 제어 영상을 만든 뒤 Cosmos3-Nano(16B)로 depth 제어 transfer를 실행합니다. 결과는 SDG 프레임과 1:1로 정렬된 증강 영상입니다.",
    params: [image('ISAACLAB_IMAGE_URI', 'sim_image'), image('COSMOS3_IMAGE_URI', 'cosmos_image'),
      ...sceneParams().map(p => p.name === 'frames' ? { ...p, default: '93' } : p), token(),
      cosmos3Platform(), cosmos3Guardrails(), P('prompt', "영상 생성 프롬프트", 'A robot arm reaching on a well-lit table.'),
      P('resolution', "출력 해상도 단계 (480/720)", '480', 'string', "480p는 ml.g6e.4xlarge(L40S 48 GB)에서 검증된 기본값입니다(2026-09-20, 93프레임, 샘플링 약 2.5분). 720p는 업스트림 기준 피크 약 46 GiB라 80 GB급 GPU가 필요합니다."),
      P('control_guidance', "depth 제어 강도", '1.5', 'number', "업스트림 depth cookbook 기본값 1.5. 높이면 기하를 더 엄격히 따르고 낮추면 프롬프트 자유도가 커집니다.")],
    resources: { gpu, cosmos3: cosmos3Resource },
    tasks: [sdgTask('sim_image'), cosmos3Task('transfer', 'Cosmos3-Nano', ['--control-guidance', '{{ control_guidance }}'], 'cosmos3-nano-videos')],
    metadata: { ...gpuMetadata('cosmos3', [source.cosmos3, source.replicator], ['generated/*/vision.mp4', 'controls/', 'dataset-manifest.json'],
      [imagePrereq('ISAACLAB_IMAGE_URI', 'sim_image'), imagePrereq('COSMOS3_IMAGE_URI', 'cosmos_image'), gpuPrereq, modelPrereq,
        { kind: 'hardware', reason: "Cosmos3-Nano(16B) transfer는 480p·93프레임 기준 ml.g6e.4xlarge(L40S 48 GB)에서 검증됐습니다(모델 적재 약 33 GB VRAM, 가중치 29 GB는 프로젝트 FSx 캐시로 약 4분). 720p는 업스트림 기준 피크 약 46 GiB라 80 GB급 GPU가 필요하고, A10G 24 GB로는 부족합니다. 가드레일 on이면 HF 계정이 nvidia/Cosmos-Guardrail1 약관을 수락해야 합니다." }]),
      ports: ports([], [{ name: 'cosmos3-nano-videos', kind: 'video', label: 'Enhanced videos' }]) } }),
  recipe({ id: 'ros2-transfer', title: "ROS 2 discovery·publisher·subscriber 통신 검증", category: 'simulation',
    description: "세 작업을 동시에 실행합니다. subscriber가 실행 식별자가 붙은 서로 다른 메시지를 받아야 완료되며 discovery와 데이터 전송을 함께 확인합니다.",
    params: [image('ROS2_IMAGE_URI'), P('messages', "수신해야 할 서로 다른 메시지 수", '20', 'number')],
    resources: { cpu }, groups: [{ name: 'ros', barrier: true, ignoreNonleadStatus: false, tasks: [
      { name: 'discovery', resource: 'cpu', image: '{{ image }}', command: ['bash', '-ec'],
        args: ['source /opt/ros/humble/setup.bash\nexec fastdds discovery --server-id 0 -p 11811'], exitActions: { COMPLETE: 0 } },
      ...(['publisher', 'subscriber'] as const).map(role => ({ name: role, lead: role === 'subscriber', resource: 'cpu', image: '{{ image }}',
        command: ['bash', '-ec'], args: [`source /opt/ros/humble/setup.bash\nexec python3 /opt/recipes/ros2/transfer.py --role ${role} --output-dir '{{output}}' --run-id '{{workflow_id}}' --messages '{{ messages }}'`],
        environment: { ROS_DISCOVERY_SERVER: '{{host:discovery}}:11811', RMW_IMPLEMENTATION: 'rmw_fastrtps_cpp', ROS_DOMAIN_ID: '42' },
        ...(role === 'subscriber' ? { outputs: published('ros2-transfer') } : {}), exitActions: { COMPLETE: 0 } })),
    ] }], metadata: { readiness: 'prerequisites-required', verification: 'source-verified-network-unverified', sources: [source.ros], artifacts: ['ros2-transfer.json'],
      imageContract: 'dashboard/images/ros2/Dockerfile', evaluationType: 'communication', prerequisites: [imagePrereq('ROS2_IMAGE_URI'),
        { kind: 'network', reason: "같은 그룹·시도의 discovery 호스트를 사용합니다. Pod 사이의 DDS discovery와 직접 UDP 데이터 전송을 모두 허용하세요." }],
      ports: ports([], [{ name: 'ros2-transfer', kind: 'artifacts', label: 'Communication proof' }]) } }),
  recipe({ id: 'leisaac-evaluate', title: "LeIsaac + GR00T 폐루프 평가", category: 'evaluation',
    description: "GR00T policy server와 LeIsaac 시뮬레이터를 함께 실행합니다. 회차별 성공·시간 초과, 측정 지연시간, 체크포인트 digest와 영상을 저장합니다.",
    params: [image('GROOT_RUNTIME_IMAGE_URI', 'policy_image'), image('LEISAAC_IMAGE_URI', 'sim_image'), ...dataset('dataset_name', 'groot-checkpoints-run-id'),
      P('checkpoint_bundle', "데이터셋 안의 체크포인트 폴더 또는 tar.gz", 'model/model.tar.gz'),
      ...evalParams(), token()],
    groups: [{ name: 'evaluation', barrier: true, ignoreNonleadStatus: false, tasks: [
      { name: 'policy', resource: 'gpu', image: '{{ policy_image }}', command: ['python', '/opt/recipes/groot/serve.py'],
        args: ['--model-path', '{{input:0}}/{{ checkpoint_bundle }}', '--embodiment-tag', 'NEW_EMBODIMENT', '--host', '0.0.0.0', '--port', '5555'],
        credentials, inputs: [{ dataset: { name: '{{ dataset_name }}', version: '{{ dataset_version }}' } }], exitActions: { COMPLETE: 0 } },
      { name: 'evaluate', lead: true, resource: 'gpu', image: '{{ sim_image }}', command: ['/isaac-sim/python.sh', '/opt/recipes/leisaac/evaluate.py'],
        args: ['--checkpoint', '{{input:0}}/{{ checkpoint_bundle }}', '--policy-host', '{{host:policy}}', '--output-dir', '{{output}}',
          '--seed', '{{ eval_seed }}', '--episodes', '{{ episodes }}', '--headless', '--enable_cameras'], environment: isaacEnv,
        inputs: [{ dataset: { name: '{{ dataset_name }}', version: '{{ dataset_version }}' } }], outputs: published('leisaac-evaluation'), exitActions: { COMPLETE: 0 } },
    ] }], metadata: { ...gpuMetadata('leisaac', [source.leisaac, source.groot], ['evaluation.json', 'videos/*.mp4'], [
      imagePrereq('GROOT_RUNTIME_IMAGE_URI', 'policy_image'), imagePrereq('LEISAAC_IMAGE_URI', 'sim_image'), gpuPrereq, modelPrereq,
      { kind: 'hardware', reason: "policy server와 RTX 지원 시뮬레이터에 각각 GPU를 동시에 할당할 수 있어야 합니다." },
      { kind: 'scene-assets', reason: "버전이 고정된 LeIsaac 주방·SO-101 자산을 준비하고 이미지에 LEISAAC_SCENE_REVISION을 기록하세요. 체크포인트 모달리티 호환성도 확인해야 합니다." },
      { kind: 'network', reason: "같은 그룹·시도의 policy task DNS를 사용합니다. TCP 5555로 연결할 수 있어야 합니다." },
      { kind: 'hardware', reason: "tar.gz 모델을 사용할 때 policy 컨테이너의 로컬 임시 디스크에 압축 해제된 모델 전체가 들어갈 공간이 필요합니다." },
    ]), evaluationType: 'closed_loop', ports: ports([{ param: 'dataset_name', kind: 'checkpoint', label: 'Checkpoint dataset', versionParam: 'dataset_version' }], [{ name: 'leisaac-evaluation', kind: 'artifacts', label: 'Evaluation results' }]) } }),
  recipe({ id: 'gr00t-e2e', title: "GR00T VLA 파이프라인: 데이터 → 파인튜닝 → 평가 (GPU DAG)", category: 'training', mlflow: true,
    description: "워크숍 가이드 순서를 EKS DAG로 실행합니다. HF 데이터 가져오기·v2.1 변환·SO-101 modality 배치(CPU) → GR00T N1.6.1 파인튜닝(1 GPU, MLflow loss) → 스모크·open-loop MSE 평가와 플롯(GPU). 각 단계 결과는 데이터셋으로 게시되어 Artifacts 탭에서 바로 볼 수 있고, 모델 등록은 모델·평가 화면에서 진행합니다.",
    params: [image('MUJOCO_IMAGE_URI', 'data_image'), image('GROOT_RUNTIME_IMAGE_URI'),
      P('hf_dataset_id', "HF 데이터셋 ID", 'LightwheelAI/leisaac-pick-orange'), P('revision', "HF 데이터 revision", 'main'),
      P('base_model', "사용 권한이 있는 기본 모델", 'nvidia/GR00T-N1.6-3B'), seed(),
      P('max_steps', "목표 학습 step 수", '300', 'number'), P('save_steps', "체크포인트 저장 주기 (steps)", '300', 'number'),
      P('batch_size', "전체 배치 크기", '16', 'number'), P('grad_accum', "gradient accumulation 단계 수", '2', 'number'),
      P('diffusion_flag', "diffusion head 학습 플래그", '--no-tune-diffusion-model', 'string', "24 GB GPU는 --no-tune-diffusion-model, 48 GB 이상은 --tune-diffusion-model. 단일 argv 단어로 전달됩니다."),
      P('eval_trajectories', "open-loop 평가 trajectory 수", '3', 'number'), P('eval_steps', "trajectory당 평가 step 수", '150', 'number'),
      P('max_mse', "평가 게이트 MSE 상한 (0 = 기록만)", '0', 'number'), P('language', "평가용 언어 지시", 'pick the orange')],
    resources: { cpu, gpu: { cpu: 12, memory: '96Gi', gpu: 1, platform: 'ml.g5.8xlarge', shm_size: '16Gi' } },
    tasks: [
      // Shell scripts below are fixed text; every template parameter arrives as an argv word ("$1", "$@"),
      // so overrides are never parsed by the shell.
      { name: 'import', resource: 'cpu', image: '{{ data_image }}', command: ['bash', '-c',
          'set -euo pipefail; python /opt/recipes/data/hf_import.py --repo-id "$1" --revision "$2" --output-dir "$3" && cp /tmp/gr00t/so101_modality.json "$3/dataset/meta/modality.json" && echo "modality.json staged for NEW_EMBODIMENT (SO-101)"', 'pai-import'],
        args: ['{{ hf_dataset_id }}', '{{ revision }}', '{{output}}'],
        files: [{ path: '/tmp/gr00t/so101_modality.json', contents: SO101_MODALITY_JSON, mode: 0o644 }],
        outputs: [...published('gr00t-e2e-dataset', '{{output}}/dataset'), { logs: '{{output}}/dataset-manifest.json' }] },
      // GR00T writes meta/stats.json next to the dataset while task inputs are mounted read-only, so both GPU
      // steps work on a local copy of the (~1 GB) LeRobot dataset on the node's ephemeral disk.
      { name: 'finetune', resource: 'gpu', image: '{{ image }}', command: ['bash', '-c',
          'set -euo pipefail; cp -r "$1" /tmp/dataset; out="$2"; shift 2; python /opt/recipes/groot/train.py "$@"; cp /tmp/dataset/meta/stats.json "$out/dataset_stats.json"', 'pai-finetune'],
        args: ['{{input:0}}/dataset', '{{output}}', '--output-dir', '{{output}}', '--seed', '{{ seed }}', '--resume', '', '--base-model-path', '{{ base_model }}',
          '--dataset-path', '/tmp/dataset', '--embodiment-tag', 'NEW_EMBODIMENT', '--modality-config-path', '/opt/recipes/groot/so101_modality.py',
          '--max-steps', '{{ max_steps }}', '--save-steps', '{{ save_steps }}', '--save-total-limit', '1', '--global-batch-size', '{{ batch_size }}',
          '--gradient-accumulation-steps', '{{ grad_accum }}', '--dataloader-num-workers', '4', '--num-gpus', '1', '{{ diffusion_flag }}'],
        inputs: [{ task: 'import' }], environment: { HF_HOME: '/tmp/hf', MLFLOW_ENABLE_SYSTEM_METRICS_LOGGING: 'true' },
        outputs: published('gr00t-e2e-checkpoints') },
      { name: 'evaluate', resource: 'gpu', image: '{{ image }}', command: ['bash', '-c',
          'set -euo pipefail; cp -r "$1" /tmp/dataset; if [ -f "$2/dataset_stats.json" ]; then cp "$2/dataset_stats.json" /tmp/dataset/meta/stats.json; fi; shift 2; exec python /tmp/gr00t/eval_gr00t.py "$@"', 'pai-evaluate'],
        args: ['{{input:1}}/dataset', '{{input:0}}', '--model-root', '{{input:0}}', '--dataset', '/tmp/dataset', '--output', '{{output}}', '--embodiment-tag', 'NEW_EMBODIMENT',
          '--modality-config', '/opt/recipes/groot/so101_modality.py', '--trajectories', '{{ eval_trajectories }}', '--steps', '{{ eval_steps }}',
          '--max-mse', '{{ max_mse }}', '--language', '{{ language }}'],
        files: [{ path: '/tmp/gr00t/eval_gr00t.py', contents: GR00T_EVAL_PY, mode: 0o755 }],
        inputs: [{ task: 'finetune' }, { task: 'import' }], environment: { HF_HOME: '/tmp/hf' },
        outputs: published('gr00t-e2e-evaluation') },
    ],
    metadata: { ...gpuMetadata('groot', [source.groot, source.workshop], ['dataset/', 'checkpoint-*/', 'training.json', 'evaluation.json', 'plots/*.jpeg'],
      [imagePrereq('MUJOCO_IMAGE_URI', 'data_image'), ...grootPrereqs,
        { kind: 'dataset-access', reason: "공개 HF 데이터셋과 공개 기본 모델을 기본값으로 사용합니다. 비공개 자원은 자격증명 참조를 추가하세요." }]),
      ports: ports([], [{ name: 'gr00t-e2e-dataset', kind: 'lerobot-dataset', label: 'Imported dataset' }, { name: 'gr00t-e2e-checkpoints', kind: 'checkpoint', label: 'Fine-tuned checkpoint' }, { name: 'gr00t-e2e-evaluation', kind: 'artifacts', label: 'Evaluation results' }]), views: views({ finetune: ['tensorboard', 'mlflow'] }) } }),
  distributedCpuRecipe(),
];

/** Parent migration can delete these stale rows; seeding only updates current templates. */
export const RETIRED_BUILTIN_TEMPLATE_IDS = ['workshop-setup', 'mujoco-setup', 'isaaclab-play', 'gr00t-pipeline'] as const;

/** Until the parent schema/finalizer supports runtime output names, call this at submission with the real run ID.
 * Commands and output paths keep their runtime placeholders. Only dataset publication names are materialized.
 */
export function materializeBuiltinTemplate(template: Template, runId: string): string {
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(runId) || runId.length > 80) throw new Error('runId must be a DNS-safe run identifier');
  const doc = YAML.parse(template.yaml);
  const tasks = [...(doc.workflow.tasks ?? []), ...(doc.workflow.groups ?? []).flatMap((g: { tasks: unknown[] }) => g.tasks)];
  for (const task of tasks) for (const output of task.outputs ?? []) if (output.dataset) {
    output.dataset.name = output.dataset.name.replace(/\{\{\s*workflow_id\s*\}\}/g, runId);
  }
  return YAML.stringify(doc, { lineWidth: 0 });
}

export function getRecipeMetadata(template: Template): RecipeMetadata {
  return YAML.parse(template.yaml).ui.recipe;
}

/** Parent preflight can use these actionable reasons without adding fields to the store schema. */
export function recipeConfigurationErrors(template: Template, overrides: Record<string, string> = {}): string[] {
  const values = { ...Object.fromEntries(template.params.map(p => [p.name, p.default ?? ''])), ...overrides };
  return getRecipeMetadata(template).prerequisites.flatMap(p => p.parameter && (!values[p.parameter] || values[p.parameter].startsWith('required')) ? [p.reason] : []);
}

export function validateBuiltins(): string[] {
  return BUILTIN_TEMPLATES.flatMap(t => {
    try { parseWorkflowYaml(materializeBuiltinTemplate(t, 'validation-run')); return []; }
    catch (e) { return [`${t.id}: ${(e as Error).message}`]; }
  });
}

export async function seedBuiltinTemplates(): Promise<void> {
  const repo = getRepo();
  for (const template of BUILTIN_TEMPLATES) await repo.putTemplate(template);
  for (const id of RETIRED_BUILTIN_TEMPLATE_IDS) {
    if ((await repo.getTemplate(id))?.builtin) await repo.deleteTemplate(id);
  }
}
