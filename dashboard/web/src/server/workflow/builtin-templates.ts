/**
 * Built-in workflow templates. Each one reproduces a workshop step from
 * hyperpod-training/k8s-templates as a declarative workflow so researchers
 * never type kubectl. `default-values` become the form in the UI (`params`).
 */
import { getRepo } from '../store/repo';
import type { Template, TemplateParam } from '../store/types';
import { parseWorkflowYaml } from './template';

const RECIPES = '/fsx/scratch/aws-physical-ai-recipes';
const HP = `${RECIPES}/hyperpod-training`;

const P = (name: string, label: string, type: TemplateParam['type'], def: string, extra: Partial<TemplateParam> = {}): TemplateParam => ({ name, label, type, default: def, ...extra });

const workshopSetup = `
workflow:
  name: workshop-setup
  description: Clone the recipes repo into FSx and stage the Isaac Lab workshop package (run once per FSx file system)
  timeout: { exec_timeout: 30m, queue_timeout: 1h }
  resources:
    cpu_small: { cpu: 1, memory: 1Gi, platform: ml.c5.4xlarge }
  tasks:
    - name: setup
      resource: cpu_small
      image: public.ecr.aws/docker/library/python:3.11
      command: [bash, -ceu]
      args:
        - |
          REPO=${RECIPES}
          mkdir -p /fsx/scratch /fsx/checkpoints/rl /fsx/scratch/logs /fsx/datasets
          chmod 777 /fsx/scratch /fsx/checkpoints/rl /fsx/scratch/logs /fsx/datasets
          if [ -d "$REPO/.git" ]; then
            echo "[setup] recipes already present - pulling {{ recipes_ref }}"
            git -C "$REPO" fetch --depth 1 origin "{{ recipes_ref }}" && git -C "$REPO" reset -q --hard FETCH_HEAD
          else
            echo "[setup] cloning recipes ({{ recipes_ref }})"
            git clone --depth 1 -b "{{ recipes_ref }}" https://github.com/hi-space/aws-physical-ai-recipes.git "$REPO"
          fi
          mkdir -p /fsx/scratch/isaaclab-workshop
          rm -rf /fsx/scratch/isaaclab-workshop/src
          cp -r "$REPO/hyperpod-training/isaac-lab-workshop/src" /fsx/scratch/isaaclab-workshop/src
          ls "$REPO/hyperpod-training" /fsx/scratch/isaaclab-workshop/src
          df -h /fsx
          echo "[setup] done"
default-values:
  recipes_ref: feat/e2e-workshop
`;

const mujocoSetup = `
workflow:
  name: mujoco-setup
  description: Create the MuJoCo Python venv on FSx (/fsx/envs/mujoco) and fetch the SO-101 Menagerie model
  timeout: { exec_timeout: 40m, queue_timeout: 1h }
  resources:
    cpu_small: { cpu: 2, memory: 4Gi, platform: ml.c5.4xlarge }
  tasks:
    - name: setup
      resource: cpu_small
      image: public.ecr.aws/docker/library/python:3.11
      command: [bash, -ceu]
      args: ["bash ${HP}/scripts/setup_mujoco_env.sh"]
default-values: {}
`;

const mujocoTrain = `
workflow:
  name: mujoco-train
  description: SB3 PPO on the SO-101 reach task in MuJoCo (CPU node). Publishes the checkpoint directory as a dataset version.
  timeout: { exec_timeout: 2h, queue_timeout: 1h }
  resources:
    cpu_train: { cpu: 12, memory: 16Gi, platform: ml.c5.4xlarge }
  tasks:
    - name: train
      resource: cpu_train
      image: public.ecr.aws/docker/library/python:3.11
      command: [/fsx/envs/mujoco/bin/python]
      args:
        - ${HP}/examples/rl/train_mujoco.py
        - --task
        - "{{ task }}"
        - --num_envs
        - "{{ num_envs }}"
        - --total_steps
        - "{{ total_steps }}"
        - --log_dir
        - "{{ log_dir }}"
      environment:
        MUJOCO_MENAGERIE_DIR: /fsx/scratch/mujoco_menagerie
        OMP_NUM_THREADS: "1"
      outputs:
        - dataset: { name: "{{ output_dataset }}", path: "{{ log_dir }}", note: "MuJoCo PPO checkpoints, TensorBoard events under tb/" }
default-values:
  task: Workshop-SO101-Reach-MuJoCo-v0
  num_envs: "12"
  total_steps: "1000000"
  log_dir: /fsx/checkpoints/rl/reach-mujoco
  output_dataset: so101-reach-mujoco-ckpt
`;

const mujocoRender = `
workflow:
  name: mujoco-render
  description: Roll out a MuJoCo checkpoint deterministically and render mp4/gif videos (CPU, OSMesa)
  timeout: { exec_timeout: 1h, queue_timeout: 1h }
  resources:
    cpu_small: { cpu: 2, memory: 4Gi, platform: ml.c5.4xlarge }
  tasks:
    - name: render
      resource: cpu_small
      image: public.ecr.aws/docker/library/python:3.11
      command: [bash, -ceu]
      args:
        - |
          export DEBIAN_FRONTEND=noninteractive
          apt-get update -qq && apt-get install -y -qq libosmesa6 >/dev/null
          if [ "{{ checkpoint }}" = "untrained" ]; then
            MODEL_ARGS="--untrained --video_dir {{ video_dir }}"
          else
            [ -f "{{ checkpoint }}" ] || { echo "ERROR: checkpoint not found: {{ checkpoint }}"; ls "$(dirname '{{ checkpoint }}')" || true; exit 1; }
            MODEL_ARGS="--checkpoint {{ checkpoint }}"
          fi
          exec /fsx/envs/mujoco/bin/python ${HP}/examples/rl/play_mujoco.py --task "{{ task }}" --episodes "{{ episodes }}" $MODEL_ARGS
      environment:
        MUJOCO_GL: osmesa
        MUJOCO_MENAGERIE_DIR: /fsx/scratch/mujoco_menagerie
default-values:
  task: Workshop-SO101-Reach-MuJoCo-v0
  checkpoint: /fsx/checkpoints/rl/reach-mujoco/SO101_Reach/model_best.zip
  episodes: "5"
  video_dir: /fsx/checkpoints/rl/reach-mujoco/SO101_Reach/videos
`;

const mujocoPipeline = `
workflow:
  name: mujoco-pipeline
  description: "Full CPU pipeline in one submit: recipes setup -> MuJoCo venv -> PPO training -> video validation"
  timeout: { exec_timeout: 3h, queue_timeout: 1h }
  resources:
    cpu_small: { cpu: 2, memory: 4Gi, platform: ml.c5.4xlarge }
    cpu_train: { cpu: 12, memory: 16Gi, platform: ml.c5.4xlarge }
  tasks:
    - name: setup
      resource: cpu_small
      image: public.ecr.aws/docker/library/python:3.11
      command: [bash, -ceu]
      args:
        - |
          REPO=${RECIPES}
          mkdir -p /fsx/scratch /fsx/checkpoints/rl /fsx/scratch/logs /fsx/datasets
          if [ -d "$REPO/.git" ]; then git -C "$REPO" fetch --depth 1 origin "{{ recipes_ref }}" && git -C "$REPO" reset -q --hard FETCH_HEAD;
          else git clone --depth 1 -b "{{ recipes_ref }}" https://github.com/hi-space/aws-physical-ai-recipes.git "$REPO"; fi
          mkdir -p /fsx/scratch/isaaclab-workshop && rm -rf /fsx/scratch/isaaclab-workshop/src
          cp -r "$REPO/hyperpod-training/isaac-lab-workshop/src" /fsx/scratch/isaaclab-workshop/src
          if [ -x /fsx/envs/mujoco/bin/python ] && /fsx/envs/mujoco/bin/python -c "import mujoco, mujoco_workshop" 2>/dev/null; then
            echo "[setup] MuJoCo venv already present"
          else
            bash $REPO/hyperpod-training/scripts/setup_mujoco_env.sh
          fi
    - name: train
      resource: cpu_train
      image: public.ecr.aws/docker/library/python:3.11
      inputs: [{ task: setup }]
      command: [/fsx/envs/mujoco/bin/python]
      args:
        - ${HP}/examples/rl/train_mujoco.py
        - --task
        - "{{ task }}"
        - --num_envs
        - "12"
        - --total_steps
        - "{{ total_steps }}"
        - --log_dir
        - "{{output}}"
      environment:
        MUJOCO_MENAGERIE_DIR: /fsx/scratch/mujoco_menagerie
        OMP_NUM_THREADS: "1"
      outputs:
        - dataset: { name: "{{ output_dataset }}", path: "{{output}}", note: "PPO checkpoints + tb/ from mujoco-pipeline" }
    - name: render
      resource: cpu_small
      image: public.ecr.aws/docker/library/python:3.11
      inputs: [{ task: train }]
      command: [bash, -ceu]
      args:
        - |
          export DEBIAN_FRONTEND=noninteractive
          apt-get update -qq && apt-get install -y -qq libosmesa6 >/dev/null
          CKPT=$(find {{input:0}} -name model_best.zip | head -1)
          [ -n "$CKPT" ] || { echo "no model_best.zip under {{input:0}}"; find {{input:0}} -maxdepth 3 | head -30; exit 1; }
          echo "rendering $CKPT"
          exec /fsx/envs/mujoco/bin/python ${HP}/examples/rl/play_mujoco.py --task "{{ task }}" --episodes "{{ episodes }}" --checkpoint "$CKPT"
      environment:
        MUJOCO_GL: osmesa
        MUJOCO_MENAGERIE_DIR: /fsx/scratch/mujoco_menagerie
default-values:
  recipes_ref: feat/e2e-workshop
  task: Workshop-SO101-Reach-MuJoCo-v0
  total_steps: "200000"
  episodes: "3"
  output_dataset: so101-reach-mujoco-ckpt
`;

const isaaclabTrain = `
workflow:
  name: isaaclab-train
  description: RSL-RL PPO on the SO-101 reach/lift task in Isaac Lab 2.3 (1 GPU, ml.g5.8xlarge). Scale the gpu-g5-8x group first.
  timeout: { exec_timeout: 4h, queue_timeout: 2h }
  resources:
    gpu1: { cpu: 12, memory: 48Gi, gpu: 1, platform: ml.g5.8xlarge, shm_size: 8Gi }
  tasks:
    - name: train
      resource: gpu1
      image: nvcr.io/nvidia/isaac-lab:2.3.0
      command: [/isaac-sim/python.sh]
      args:
        - ${HP}/examples/rl/train_isaaclab.py
        - --task
        - "{{ task }}"
        - --num_envs
        - "{{ num_envs }}"
        - --max_iterations
        - "{{ max_iterations }}"
        - --log_dir
        - "{{ log_dir }}"
        - --headless
      environment:
        ACCEPT_EULA: "Y"
        PRIVACY_CONSENT: "Y"
        OMNI_KIT_ACCEPT_EULA: "YES"
        OMNI_KIT_ALLOW_ROOT: "1"
        PYTHONPATH: /fsx/scratch/isaaclab-workshop/src
        GIT_PYTHON_REFRESH: quiet
      outputs:
        - dataset: { name: "{{ output_dataset }}", path: "{{ log_dir }}", note: "RSL-RL checkpoints (model_*.pt, model_best.pt)" }
default-values:
  task: Workshop-SO101-Reach-v0
  num_envs: "2048"
  max_iterations: "300"
  log_dir: /fsx/checkpoints/rl
  output_dataset: so101-reach-isaaclab-ckpt
`;

const isaaclabVideo = `
workflow:
  name: isaaclab-video
  description: Replay an Isaac Lab checkpoint headlessly and record an mp4 (1 GPU)
  timeout: { exec_timeout: 1h, queue_timeout: 2h }
  resources:
    gpu1: { cpu: 8, memory: 32Gi, gpu: 1, platform: ml.g5.8xlarge, shm_size: 8Gi }
  tasks:
    - name: video
      resource: gpu1
      image: nvcr.io/nvidia/isaac-lab:2.3.0
      command: [/isaac-sim/python.sh]
      args:
        - ${HP}/examples/rl/play_isaaclab.py
        - --task
        - "{{ task }}"
        - --checkpoint
        - "{{ checkpoint }}"
        - --num_envs
        - "{{ num_envs }}"
        - --headless
        - --video
        - --video_length
        - "{{ video_length }}"
        - --enable_cameras
      environment:
        ACCEPT_EULA: "Y"
        PRIVACY_CONSENT: "Y"
        OMNI_KIT_ACCEPT_EULA: "YES"
        OMNI_KIT_ALLOW_ROOT: "1"
        PYTHONPATH: /fsx/scratch/isaaclab-workshop/src
default-values:
  task: Workshop-SO101-Reach-v0
  checkpoint: /fsx/checkpoints/rl/reach/SO101_Reach/model_best.pt
  num_envs: "4"
  video_length: "300"
`;

const isaaclabPlay = `
workflow:
  name: isaaclab-play
  description: Interactive Isaac Sim replay on a GPU node's DCV desktop (X11). Open the node's DCV session first (Sessions page) and run xhost +si:localuser:root there.
  timeout: { exec_timeout: 1h, queue_timeout: 1h }
  resources:
    gpu1: { cpu: 8, memory: 32Gi, gpu: 1, platform: ml.g5.8xlarge, shm_size: 8Gi }
  tasks:
    - name: play
      resource: gpu1
      image: nvcr.io/nvidia/isaac-lab:2.3.0
      command: [bash, -ceu]
      args:
        - |
          SOCK=$(ls /tmp/.X11-unix/X* 2>/dev/null | sort -V | tail -1 || true)
          [ -n "$SOCK" ] || { echo "no X display on this node - start a DCV session first"; exit 1; }
          export DISPLAY=":\${SOCK##*/X}"
          echo "using DISPLAY=$DISPLAY"
          exec /isaac-sim/python.sh ${HP}/examples/rl/play_isaaclab.py --task "{{ task }}" --checkpoint "{{ checkpoint }}" --num_envs "{{ num_envs }}"
      environment:
        ACCEPT_EULA: "Y"
        PRIVACY_CONSENT: "Y"
        OMNI_KIT_ACCEPT_EULA: "YES"
        OMNI_KIT_ALLOW_ROOT: "1"
        PYTHONPATH: /fsx/scratch/isaaclab-workshop/src
      volumes: ["/tmp/.X11-unix:/tmp/.X11-unix"]
default-values:
  task: Workshop-SO101-Reach-v0
  checkpoint: /fsx/checkpoints/rl/reach/SO101_Reach/model_best.pt
  num_envs: "4"
`;

const hfImport = `
workflow:
  name: hf-dataset-import
  description: Download a Hugging Face dataset (LeRobot v3 auto-converted to v2.1) into FSx and register it as a dataset version
  timeout: { exec_timeout: 2h, queue_timeout: 1h }
  resources:
    cpu_small: { cpu: 4, memory: 8Gi, platform: ml.c5.4xlarge }
  tasks:
    - name: import
      resource: cpu_small
      image: public.ecr.aws/docker/library/python:3.11
      command: [bash, -ceu]
      args:
        - |
          export HF_HOME=/tmp/hf-home HUGGING_FACE_HUB_TOKEN="\${HF_TOKEN:-}"
          apt-get update -qq && apt-get install -y -qq git git-lfs ffmpeg >/dev/null
          pip install -q "huggingface_hub>=0.24" "pyarrow>=15" numpy
          python - "{{ hf_dataset_id }}" "{{output}}" <<'PY'
          import sys
          from huggingface_hub import snapshot_download
          rid, out = sys.argv[1], sys.argv[2]
          snapshot_download(repo_id=rid, repo_type="dataset", local_dir=out)
          print("downloaded", rid, "->", out)
          PY
          if [ -f ${RECIPES}/e2e-workshop/groot/training/data/convert_v3_to_v2.py ] && grep -q '"codebase_version": "v3' {{output}}/meta/info.json 2>/dev/null; then
            echo "converting LeRobot v3 -> v2.1"
            python ${RECIPES}/e2e-workshop/groot/training/data/convert_v3_to_v2.py "{{output}}" "{{output}}.v21" && rm -rf "{{output}}" && mv "{{output}}.v21" "{{output}}"
          fi
          find "{{output}}" -maxdepth 2 | head -50
      credentials:
        huggingface: { HF_TOKEN: "{{ hf_token_param }}" }
      outputs:
        - dataset: { name: "{{ dataset_name }}", path: "{{output}}", note: "Imported from Hugging Face {{ hf_dataset_id }}" }
default-values:
  hf_dataset_id: LightwheelAI/leisaac-pick-orange
  dataset_name: leisaac-pick-orange
  hf_token_param: /groot/hf-token
`;

const grootFinetune = `
workflow:
  name: gr00t-finetune
  description: Fine-tune GR00T N1.6 on a LeRobot dataset with the gr00t-train image from ECR (1 GPU). Requires the image built with hyperpod-training/container.
  mlflow: true
  timeout: { exec_timeout: 12h, queue_timeout: 2h }
  resources:
    gpu1: { cpu: 12, memory: 48Gi, gpu: 1, platform: ml.g5.8xlarge, shm_size: 16Gi }
  tasks:
    - name: finetune
      resource: gpu1
      image: "{{ image }}"
      command: [bash, -ceu]
      args:
        - |
          cd /workspace/gr00t
          source .venv/bin/activate 2>/dev/null || true
          export HF_HOME=/fsx/scratch/hf-home
          python -m gr00t.experiment.launch_finetune \\
            --base-model-path "{{ base_model }}" \\
            --dataset-path "{{input:0}}" \\
            --embodiment-tag "{{ embodiment_tag }}" \\
            --modality-config-path "{{ modality_config }}" \\
            --output-dir "{{output}}" \\
            --max-steps "{{ max_steps }}" --save-steps "{{ save_steps }}" \\
            --global-batch-size "{{ global_batch_size }}" --num-gpus 1
      inputs:
        - dataset: { name: "{{ dataset_name }}", version: latest, path: /data }
      credentials:
        huggingface: { HF_TOKEN: /groot/hf-token }
      outputs:
        - dataset: { name: "{{ output_dataset }}", path: "{{output}}", note: "GR00T N1.6 fine-tuned checkpoint" }
default-values:
  image: "913524902871.dkr.ecr.us-east-1.amazonaws.com/gr00t-train:latest"
  dataset_name: leisaac-pick-orange
  base_model: nvidia/GR00T-N1.6-3B
  embodiment_tag: new_embodiment
  modality_config: ${HP}/configs/so101_modality.py
  max_steps: "1000"
  save_steps: "500"
  global_batch_size: "32"
  output_dataset: gr00t-n16-so101-ckpt
`;

const custom = `
workflow:
  name: my-workflow
  description: Describe what this does
  timeout: { exec_timeout: 1h, queue_timeout: 1h }
  resources:
    cpu_small: { cpu: 1, memory: 1Gi, platform: ml.c5.4xlarge }
  tasks:
    - name: hello
      resource: cpu_small
      image: public.ecr.aws/docker/library/python:3.11
      command: [bash, -ceu]
      args:
        - |
          echo "hello from {{ who }}"
          nproc; free -g; df -h /fsx
          echo "artifacts go to {{output}}"
          date > {{output}}/done.txt
default-values:
  who: physical-ai-dashboard
`;

export const BUILTIN_TEMPLATES: Template[] = [
  {
    id: 'workshop-setup',
    title: 'Workshop setup (recipes → FSx)',
    description: 'Clones the recipes repository into /fsx/scratch and stages the Isaac Lab workshop package. Run once per cluster.',
    category: 'setup',
    builtin: true,
    yaml: workshopSetup,
    params: [P('recipes_ref', 'Git ref', 'string', 'feat/e2e-workshop')],
    requires: ['fsx'],
    createdAt: '2026-09-16T00:00:00Z',
  },
  {
    id: 'mujoco-setup',
    title: 'MuJoCo environment setup',
    description: 'Builds the MuJoCo venv at /fsx/envs/mujoco and downloads the SO-101 Menagerie model.',
    category: 'setup',
    builtin: true,
    yaml: mujocoSetup,
    params: [],
    requires: ['fsx'],
    createdAt: '2026-09-16T00:00:00Z',
  },
  {
    id: 'mujoco-train',
    title: 'MuJoCo RL training (CPU)',
    description: 'SB3 PPO on Workshop-SO101-Reach-MuJoCo-v0. ~5 min for 1M steps on ml.c5.4xlarge.',
    category: 'training',
    builtin: true,
    yaml: mujocoTrain,
    params: [
      P('task', 'Gymnasium task', 'string', 'Workshop-SO101-Reach-MuJoCo-v0'),
      P('num_envs', 'Parallel envs', 'number', '12'),
      P('total_steps', 'Total steps', 'number', '1000000'),
      P('log_dir', 'Log / checkpoint dir', 'string', '/fsx/checkpoints/rl/reach-mujoco'),
      P('output_dataset', 'Publish checkpoints as dataset', 'string', 'so101-reach-mujoco-ckpt'),
    ],
    requires: ['fsx'],
    createdAt: '2026-09-16T00:00:00Z',
  },
  {
    id: 'mujoco-render',
    title: 'MuJoCo validation video (CPU)',
    description: 'Rolls out a checkpoint deterministically and writes mp4/gif under videos/. Use checkpoint=untrained for a baseline.',
    category: 'evaluation',
    builtin: true,
    yaml: mujocoRender,
    params: [
      P('task', 'Gymnasium task', 'string', 'Workshop-SO101-Reach-MuJoCo-v0'),
      P('checkpoint', 'Checkpoint (.zip) or "untrained"', 'string', '/fsx/checkpoints/rl/reach-mujoco/SO101_Reach/model_best.zip'),
      P('episodes', 'Episodes', 'number', '5'),
      P('video_dir', 'Video dir (untrained only)', 'string', '/fsx/checkpoints/rl/reach-mujoco/SO101_Reach/videos'),
    ],
    requires: ['fsx'],
    createdAt: '2026-09-16T00:00:00Z',
  },
  {
    id: 'mujoco-pipeline',
    title: 'MuJoCo end-to-end pipeline (CPU DAG)',
    description: 'setup → train → render in one workflow. Good first run: needs only the always-on CPU node.',
    category: 'training',
    builtin: true,
    yaml: mujocoPipeline,
    params: [
      P('recipes_ref', 'Git ref', 'string', 'feat/e2e-workshop'),
      P('task', 'Gymnasium task', 'string', 'Workshop-SO101-Reach-MuJoCo-v0'),
      P('total_steps', 'Total steps', 'number', '200000'),
      P('episodes', 'Render episodes', 'number', '3'),
      P('output_dataset', 'Publish checkpoints as dataset', 'string', 'so101-reach-mujoco-ckpt'),
    ],
    requires: ['fsx'],
    createdAt: '2026-09-16T00:00:00Z',
  },
  {
    id: 'isaaclab-train',
    title: 'Isaac Lab RL training (GPU)',
    description: 'RSL-RL PPO on SO-101 Reach/Lift with Isaac Lab 2.3. Needs a schedulable ml.g5.8xlarge node.',
    category: 'training',
    builtin: true,
    yaml: isaaclabTrain,
    params: [
      P('task', 'Task', 'select', 'Workshop-SO101-Reach-v0', { options: ['Workshop-SO101-Reach-v0', 'Workshop-SO101-Lift-v0'] }),
      P('num_envs', 'Parallel envs', 'number', '2048'),
      P('max_iterations', 'Max iterations', 'number', '300'),
      P('log_dir', 'Log dir', 'string', '/fsx/checkpoints/rl'),
      P('output_dataset', 'Publish checkpoints as dataset', 'string', 'so101-reach-isaaclab-ckpt'),
    ],
    requires: ['fsx', 'gpu'],
    createdAt: '2026-09-16T00:00:00Z',
  },
  {
    id: 'isaaclab-video',
    title: 'Isaac Lab replay video (GPU)',
    description: 'Headless replay of a checkpoint with camera recording.',
    category: 'evaluation',
    builtin: true,
    yaml: isaaclabVideo,
    params: [
      P('task', 'Task', 'string', 'Workshop-SO101-Reach-v0'),
      P('checkpoint', 'Checkpoint (.pt)', 'string', '/fsx/checkpoints/rl/reach/SO101_Reach/model_best.pt'),
      P('num_envs', 'Envs', 'number', '4'),
      P('video_length', 'Video length (steps)', 'number', '300'),
    ],
    requires: ['fsx', 'gpu'],
    createdAt: '2026-09-16T00:00:00Z',
  },
  {
    id: 'isaaclab-play',
    title: 'Isaac Sim interactive replay on node DCV (GPU)',
    description: 'Runs play_isaaclab.py against the GPU node X display. Open the node DCV session first (Sessions page).',
    category: 'simulation',
    builtin: true,
    yaml: isaaclabPlay,
    params: [
      P('task', 'Task', 'string', 'Workshop-SO101-Reach-v0'),
      P('checkpoint', 'Checkpoint (.pt)', 'string', '/fsx/checkpoints/rl/reach/SO101_Reach/model_best.pt'),
      P('num_envs', 'Envs', 'number', '4'),
    ],
    requires: ['fsx', 'gpu'],
    createdAt: '2026-09-16T00:00:00Z',
  },
  {
    id: 'hf-dataset-import',
    title: 'Import dataset from Hugging Face',
    description: 'snapshot_download into FSx, LeRobot v3→v2.1 conversion when needed, registers a dataset version.',
    category: 'data',
    builtin: true,
    yaml: hfImport,
    params: [
      P('hf_dataset_id', 'HF dataset id', 'string', 'LightwheelAI/leisaac-pick-orange'),
      P('dataset_name', 'Dataset name', 'string', 'leisaac-pick-orange'),
      P('hf_token_param', 'SSM parameter holding HF token', 'string', '/groot/hf-token', { help: 'SecureString path; create with aws ssm put-parameter' }),
    ],
    requires: ['fsx'],
    createdAt: '2026-09-16T00:00:00Z',
  },
  {
    id: 'gr00t-finetune',
    title: 'GR00T N1.6 fine-tune (GPU, EKS)',
    description: 'launch_finetune from the gr00t-train ECR image against a registered LeRobot dataset. Logs to MLflow.',
    category: 'training',
    builtin: true,
    yaml: grootFinetune,
    params: [
      P('image', 'Training image', 'string', '913524902871.dkr.ecr.us-east-1.amazonaws.com/gr00t-train:latest'),
      P('dataset_name', 'Registered dataset', 'string', 'leisaac-pick-orange'),
      P('base_model', 'Base model', 'select', 'nvidia/GR00T-N1.6-3B', { options: ['nvidia/GR00T-N1.6-3B', 'nvidia/GR00T-N1.7-3B'] }),
      P('embodiment_tag', 'Embodiment tag', 'string', 'new_embodiment'),
      P('max_steps', 'Max steps', 'number', '1000'),
      P('save_steps', 'Save steps', 'number', '500'),
      P('global_batch_size', 'Global batch size', 'number', '32'),
      P('output_dataset', 'Publish checkpoint as dataset', 'string', 'gr00t-n16-so101-ckpt'),
    ],
    requires: ['fsx', 'gpu', 'mlflow'],
    createdAt: '2026-09-16T00:00:00Z',
  },
  {
    id: 'custom',
    title: 'Custom workflow (blank)',
    description: 'Start from a minimal one-task workflow and edit the YAML.',
    category: 'custom',
    builtin: true,
    yaml: custom,
    params: [P('who', 'Who', 'string', 'physical-ai-dashboard')],
    createdAt: '2026-09-16T00:00:00Z',
  },
];

/** Validate every built-in template at module load in tests / seed. */
export function validateBuiltins(): string[] {
  const errors: string[] = [];
  for (const t of BUILTIN_TEMPLATES) {
    try {
      parseWorkflowYaml(t.yaml);
    } catch (e) {
      errors.push(`${t.id}: ${(e as Error).message}`);
    }
  }
  return errors;
}

export async function seedBuiltinTemplates(): Promise<void> {
  const repo = getRepo();
  for (const t of BUILTIN_TEMPLATES) await repo.putTemplate(t);
}
