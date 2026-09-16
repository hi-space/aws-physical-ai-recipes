/**
 * Built-in workflow templates. Each one reproduces a workshop step from
 * hyperpod-training/k8s-templates as a declarative workflow so researchers
 * never type kubectl. `default-values` become the form in the UI (`params`).
 */
import { config } from '../config';
import { getRepo } from '../store/repo';
import type { Template, TemplateParam } from '../store/types';
import { GR00T_EVAL_PY, GR00T_REGISTER_PY } from './gr00t-scripts';
import { parseWorkflowYaml } from './template';

const RECIPES = '/fsx/scratch/aws-physical-ai-recipes';
const HP = `${RECIPES}/hyperpod-training`;
const GROOT_DIR = `${RECIPES}/e2e-workshop/groot`;
/** Defaults discovered from the GrootFinetune stack (empty in dev without env). */
const GROOT_IMAGE = config().groot?.trainingImageUri ?? `${config().accountId || '<account>'}.dkr.ecr.${config().region}.amazonaws.com/groot-sm-training:latest`;
const GROOT_BUCKET = config().groot?.artifactsBucket ?? config().eks?.dataBucket ?? '';

/** Indent a multi-line script for a YAML block scalar. */
const block = (text: string, spaces: number) => text.split('\n').map((l) => (l ? ' '.repeat(spaces) + l : l)).join('\n');

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
  description: Fine-tune GR00T N1.6 on a registered LeRobot dataset with the groot-sm-training image (1 GPU). Same launch_finetune call as the SageMaker container.
  mlflow: true
  timeout: { exec_timeout: 12h, queue_timeout: 2h }
  resources:
    gpu1: { cpu: 12, memory: 100Gi, gpu: 1, platform: ml.g5.8xlarge, shm_size: 16Gi }
  tasks:
    - name: finetune
      resource: gpu1
      image: "{{ image }}"
      command: [bash, -ceu]
      args:
        - |
          cd /opt/gr00t
          export HF_HOME=/fsx/scratch/hf-home
          mkdir -p /opt/ml/code && cp ${GROOT_DIR}/training/container/sitecustomize.py /opt/ml/code/sitecustomize.py 2>/dev/null || true
          nvidia-smi --query-gpu=name,memory.total --format=csv || { echo "no GPU visible"; exit 1; }
          DIFFUSION=--no-tune-diffusion-model; [ "{{ tune_diffusion_model }}" = "true" ] && DIFFUSION=--tune-diffusion-model
          [ -f /data/modality_config.py ] || cp ${GROOT_DIR}/training/data/configs/so101_modality_config.py /tmp/modality_config.py
          MODALITY=/data/modality_config.py; [ -f "$MODALITY" ] || MODALITY=/tmp/modality_config.py
          python gr00t/experiment/launch_finetune.py \\
            --base_model_path "{{ base_model }}" --dataset_path /data --embodiment_tag {{ embodiment_tag }} \\
            --modality_config_path "$MODALITY" --output_dir "{{output}}" \\
            --max_steps {{ max_steps }} --save_steps {{ save_steps }} --save_total_limit 2 \\
            --global_batch_size {{ global_batch_size }} --gradient_accumulation_steps {{ grad_accum }} \\
            --dataloader_num_workers 4 --num_gpus 1 $DIFFUSION
      environment:
        MLFLOW_ENABLE_SYSTEM_METRICS_LOGGING: "true"
      inputs:
        - dataset: { name: "{{ dataset_name }}", version: latest, path: /data }
      outputs:
        - dataset: { name: "{{ output_dataset }}", path: "{{output}}", note: "GR00T N1.6 fine-tuned checkpoint ({{ max_steps }} steps)" }
default-values:
  image: "${GROOT_IMAGE}"
  dataset_name: leisaac-pick-orange
  base_model: nvidia/GR00T-N1.6-3B
  embodiment_tag: NEW_EMBODIMENT
  max_steps: "1000"
  save_steps: "500"
  global_batch_size: "16"
  grad_accum: "2"
  tune_diffusion_model: "false"
  output_dataset: gr00t-n16-so101-ckpt
`;

const grootPipeline = `
workflow:
  name: gr00t-pipeline
  description: "GR00T N1.6 VLA pipeline (workshop guide on EKS): HF dataset -> LeRobot v2.1 staging + validation -> single-GPU fine-tune (MLflow) -> open-loop evaluation gate -> uncompressed S3 export + MLflow model registration"
  mlflow: true
  timeout: { exec_timeout: 8h, queue_timeout: 3h }
  resources:
    cpu_small: { cpu: 4, memory: 8Gi, platform: ml.c5.4xlarge }
    gpu1: { cpu: 12, memory: 100Gi, gpu: 1, platform: ml.g5.8xlarge, shm_size: 16Gi }
  tasks:
    - name: prepare-data
      resource: cpu_small
      image: public.ecr.aws/docker/library/python:3.11
      timeout: 2h
      command: [bash, -ceu]
      args:
        - |
          export DEBIAN_FRONTEND=noninteractive HF_HOME=/fsx/scratch/hf-home
          apt-get update -qq && apt-get install -y -qq git git-lfs ffmpeg >/dev/null
          pip install -q "huggingface_hub>=0.24" pyyaml boto3 pyarrow numpy
          REPO=${RECIPES}
          mkdir -p /fsx/scratch /fsx/datasets /fsx/checkpoints
          if [ -d "$REPO/.git" ]; then git -C "$REPO" fetch -q --depth 1 origin "{{ recipes_ref }}" && git -C "$REPO" reset -q --hard FETCH_HEAD;
          else git clone -q --depth 1 -b "{{ recipes_ref }}" https://github.com/hi-space/aws-physical-ai-recipes.git "$REPO"; fi
          cd ${GROOT_DIR}/training/data
          echo "[prepare-data] TransformDataset: download {{ hf_dataset_id }}, convert v3->v2.1 if needed, validate, stage with manifest"
          python transform_dataset.py --hf-dataset-id "{{ hf_dataset_id }}" --output-dir "{{output}}"
          echo "[prepare-data] modality files for {{ embodiment_tag }} ({{ modality_profile }})"
          [ -f "{{output}}/modality_config.py" ] || cp configs/{{ modality_profile }}_modality_config.py "{{output}}/modality_config.py"
          [ -f "{{output}}/meta/modality.json" ] || cp configs/{{ modality_profile }}_modality.json "{{output}}/meta/modality.json"
          python - "{{output}}" <<'PY'
          import json, sys, pathlib
          root = pathlib.Path(sys.argv[1]); info = json.loads((root / "meta" / "info.json").read_text())
          summary = {k: info.get(k) for k in ("codebase_version", "robot_type", "fps", "total_episodes", "total_frames", "total_videos")}
          summary["features"] = sorted(info.get("features", {}).keys()); summary["modality"] = json.loads((root / "meta" / "modality.json").read_text())
          (root / "dataset_summary.json").write_text(json.dumps(summary, indent=2)); print("DATASET SUMMARY:", json.dumps(summary))
          PY
      outputs:
        - dataset: { name: "{{ dataset_name }}", path: "{{output}}", note: "LeRobot v2.1 from Hugging Face {{ hf_dataset_id }} (validated, with {{ modality_profile }} modality config)" }
    - name: finetune
      resource: gpu1
      image: "{{ image }}"
      inputs: [{ task: prepare-data }]
      timeout: 5h
      command: [bash, -ceu]
      args:
        - |
          cd /opt/gr00t
          export HF_HOME=/fsx/scratch/hf-home
          mkdir -p /opt/ml/code && cp ${GROOT_DIR}/training/container/sitecustomize.py /opt/ml/code/sitecustomize.py
          pip install -q nvidia-ml-py 2>/dev/null || true
          nvidia-smi --query-gpu=name,memory.total --format=csv || { echo "no GPU visible on this node"; exit 1; }
          DIFFUSION=--no-tune-diffusion-model; [ "{{ tune_diffusion_model }}" = "true" ] && DIFFUSION=--tune-diffusion-model
          echo "[finetune] {{ base_model }} on {{input:0}} -> {{output}} ({{ max_steps }} steps, batch {{ global_batch_size }} x accum {{ grad_accum }}, $DIFFUSION)"
          python gr00t/experiment/launch_finetune.py \\
            --base_model_path "{{ base_model }}" --dataset_path "{{input:0}}" --embodiment_tag {{ embodiment_tag }} \\
            --modality_config_path "{{input:0}}/modality_config.py" --output_dir "{{output}}" \\
            --max_steps {{ max_steps }} --save_steps {{ save_steps }} --save_total_limit 2 \\
            --global_batch_size {{ global_batch_size }} --gradient_accumulation_steps {{ grad_accum }} \\
            --dataloader_num_workers 4 --num_gpus 1 $DIFFUSION
          python - "{{output}}" "{{ embodiment_tag }}" <<'PY'
          import glob, json, os, sys, pathlib
          out = pathlib.Path(sys.argv[1]); tag = sys.argv[2]
          states = sorted(glob.glob(str(out / "**" / "trainer_state.json"), recursive=True), key=os.path.getmtime)
          summary = {"embodiment_tag": tag, "output_dir": str(out)}
          if states:
              st = json.loads(pathlib.Path(states[-1]).read_text()); hist = [h for h in st.get("log_history", []) if "loss" in h]
              summary.update({"global_step": st.get("global_step"), "max_steps": st.get("max_steps"), "final_loss": hist[-1]["loss"] if hist else None, "first_loss": hist[0]["loss"] if hist else None, "epoch": st.get("epoch")})
          (out / "training_summary.json").write_text(json.dumps(summary, indent=2))
          meta = out / "inference_metadata.json"
          if not meta.exists(): meta.write_text(json.dumps({"embodiment_tag": tag}, indent=2))
          print("TRAINING SUMMARY:", json.dumps(summary))
          PY
      environment:
        MLFLOW_ENABLE_SYSTEM_METRICS_LOGGING: "true"
      outputs:
        - dataset: { name: "{{ output_dataset }}", path: "{{output}}", note: "GR00T N1.6 fine-tune output ({{ max_steps }} steps on {{ dataset_name }})" }
    - name: evaluate
      resource: gpu1
      image: "{{ image }}"
      inputs: [{ task: finetune }, { task: prepare-data }]
      timeout: 1h
      files:
        - path: /pai/eval_gr00t.py
          contents: |
${block(GR00T_EVAL_PY, 12)}
      command: [bash, -ceu]
      args:
        - |
          cd /opt/gr00t
          python -c "import matplotlib, pandas" 2>/dev/null || pip install -q matplotlib pandas
          echo "[evaluate] smoke + open-loop MSE on {{ eval_trajectories }} trajectories ({{ eval_steps }} steps each), gate max_mse={{ max_mse }}"
          python /pai/eval_gr00t.py --model-root "{{input:0}}" --dataset "{{input:1}}" --output "{{output}}" \\
            --embodiment-tag {{ embodiment_tag }} --trajectories {{ eval_trajectories }} --steps {{ eval_steps }} --max-mse {{ max_mse }}
      outputs:
        - dataset: { name: "{{ output_dataset }}-eval", path: "{{output}}", note: "evaluation.json + open-loop plots for {{ output_dataset }}" }
    - name: register
      resource: cpu_small
      image: public.ecr.aws/docker/library/python:3.11
      inputs: [{ task: finetune }, { task: evaluate }, { task: prepare-data }]
      timeout: 1h
      files:
        - path: /pai/register_gr00t.py
          contents: |
${block(GR00T_REGISTER_PY, 12)}
      command: [bash, -ceu]
      args:
        - |
          pip install -q boto3 "mlflow>=3,<4" sagemaker-mlflow
          echo "[register] export -> s3://{{ artifacts_bucket }}/{{ s3_prefix }}/wf-{{workflow_id}}/ and MLflow model {{ model_name }} (alias {{ alias }})"
          python /pai/register_gr00t.py --model-root "{{input:0}}" --eval-dir "{{input:1}}" --dataset-dir "{{input:2}}" --output "{{output}}" \\
            --bucket "{{ artifacts_bucket }}" --prefix "{{ s3_prefix }}/wf-{{workflow_id}}" --model-name "{{ model_name }}" --alias "{{ alias }}" \\
            --workflow-id "{{workflow_id}}" --base-model "{{ base_model }}" --dataset-name "{{ dataset_name }}" --hf-dataset-id "{{ hf_dataset_id }}" --embodiment-tag {{ embodiment_tag }}
      outputs:
        - dataset: { name: "{{ model_name }}", path: "{{output}}/model", note: "Inference-only GR00T export (gate passed); mirrored to s3://{{ artifacts_bucket }}/{{ s3_prefix }}/" }
default-values:
  recipes_ref: feat/e2e-workshop
  hf_dataset_id: LightwheelAI/leisaac-pick-orange
  dataset_name: leisaac-pick-orange
  modality_profile: so101
  image: "${GROOT_IMAGE}"
  base_model: nvidia/GR00T-N1.6-3B
  embodiment_tag: NEW_EMBODIMENT
  max_steps: "300"
  save_steps: "100"
  global_batch_size: "16"
  grad_accum: "2"
  tune_diffusion_model: "false"
  output_dataset: gr00t-n16-so101-ckpt
  eval_trajectories: "3"
  eval_steps: "150"
  max_mse: "0"
  artifacts_bucket: "${GROOT_BUCKET}"
  s3_prefix: models/groot-sm
  model_name: gr00t-n16-so101
  alias: candidate
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
    description: 'launch_finetune from the groot-sm-training ECR image against a registered LeRobot dataset. Logs to MLflow. Projector-only by default so it fits one 24 GB GPU.',
    category: 'training',
    builtin: true,
    yaml: grootFinetune,
    params: [
      P('image', 'Training image', 'string', GROOT_IMAGE),
      P('dataset_name', 'Registered dataset', 'string', 'leisaac-pick-orange'),
      P('base_model', 'Base model', 'select', 'nvidia/GR00T-N1.6-3B', { options: ['nvidia/GR00T-N1.6-3B', 'nvidia/GR00T-N1.7-3B'] }),
      P('embodiment_tag', 'Embodiment tag', 'string', 'NEW_EMBODIMENT'),
      P('max_steps', 'Max steps', 'number', '1000'),
      P('save_steps', 'Save steps', 'number', '500'),
      P('global_batch_size', 'Global batch size', 'number', '16'),
      P('grad_accum', 'Gradient accumulation steps', 'number', '2'),
      P('tune_diffusion_model', 'Tune diffusion head', 'select', 'false', { options: ['false', 'true'], help: 'true needs >24 GB GPU memory (ml.g5.12xlarge / g6e); false trains the projector only' }),
      P('output_dataset', 'Publish checkpoint as dataset', 'string', 'gr00t-n16-so101-ckpt'),
    ],
    requires: ['fsx', 'gpu', 'mlflow'],
    createdAt: '2026-09-16T00:00:00Z',
  },
  {
    id: 'gr00t-pipeline',
    title: 'GR00T VLA end-to-end pipeline (GPU DAG)',
    description: 'The workshop pipeline on EKS: prepare-data (HF download, v3→v2.1, validation) → finetune (1 GPU, MLflow) → evaluate (smoke + open-loop MSE gate) → register (uncompressed S3 export for IsaacSim, MLflow model version).',
    category: 'training',
    builtin: true,
    yaml: grootPipeline,
    params: [
      P('hf_dataset_id', 'HF dataset id', 'string', 'LightwheelAI/leisaac-pick-orange'),
      P('dataset_name', 'Dataset name', 'string', 'leisaac-pick-orange'),
      P('modality_profile', 'Modality config', 'select', 'so101', { options: ['so101', 'aloha'], help: 'copied next to the data when the dataset has no modality_config.py' }),
      P('base_model', 'Base model', 'select', 'nvidia/GR00T-N1.6-3B', { options: ['nvidia/GR00T-N1.6-3B', 'nvidia/GR00T-N1.7-3B'] }),
      P('max_steps', 'Training steps', 'number', '300'),
      P('save_steps', 'Save every N steps', 'number', '100'),
      P('global_batch_size', 'Global batch size', 'number', '16'),
      P('grad_accum', 'Gradient accumulation steps', 'number', '2'),
      P('tune_diffusion_model', 'Tune diffusion head', 'select', 'false', { options: ['false', 'true'], help: 'true needs >24 GB GPU memory; false = projector only (fits ml.g5.8xlarge)' }),
      P('eval_trajectories', 'Eval trajectories', 'number', '3'),
      P('eval_steps', 'Eval steps per trajectory', 'number', '150'),
      P('max_mse', 'Gate: max open-loop MSE (0 = record only)', 'number', '0'),
      P('model_name', 'MLflow registered model', 'string', 'gr00t-n16-so101'),
      P('alias', 'Model alias on pass', 'string', 'candidate'),
      P('artifacts_bucket', 'Export bucket', 'string', GROOT_BUCKET),
      P('s3_prefix', 'Export prefix', 'string', 'models/groot-sm', { help: 'the DCV workstation mounts this bucket at /mnt/s3/groot' }),
      P('output_dataset', 'Publish checkpoint as dataset', 'string', 'gr00t-n16-so101-ckpt'),
      P('image', 'Training image', 'string', GROOT_IMAGE),
      P('recipes_ref', 'Recipes git ref', 'string', 'feat/e2e-workshop'),
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
