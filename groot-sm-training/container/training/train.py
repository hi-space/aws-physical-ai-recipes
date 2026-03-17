#!/usr/bin/env python3
"""GR00T-N1.6 SageMaker 학습 엔트리포인트.

SageMaker 환경변수를 파싱하여 Isaac-GR00T의 launch_finetune.py를 호출하고,
학습 완료 후 SM_MODEL_DIR에 모델 아티팩트와 추론 메타데이터를 저장합니다.

환경변수 (SageMaker가 자동 설정):
    SM_CHANNEL_MODEL:    베이스 모델 경로 (S3에서 다운로드)
    SM_CHANNEL_DATASET:  데이터셋 경로 (S3에서 다운로드)
    SM_MODEL_DIR:        학습 완료 후 모델 저장 위치
    SM_HP_*:             하이퍼파라미터 (SageMaker가 SM_HP_ 접두사 추가)
"""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


# -------------------------------------------------------------------------------
# 환경변수 파싱
# -------------------------------------------------------------------------------

def _get_hyperparameter(key: str, default: str = "") -> str:
    """SageMaker 하이퍼파라미터를 환경변수에서 읽습니다.

    SageMaker는 하이퍼파라미터를 SM_HP_ 접두사로 설정하지만,
    키의 대소문자 변환이 버전마다 다를 수 있으므로 여러 형식을 시도합니다.
    또한 /opt/ml/input/config/hyperparameters.json 파일도 확인합니다.
    """
    # 1. 환경변수에서 시도 (대문자, 원본)
    for env_key in [f"SM_HP_{key.upper()}", f"SM_HP_{key}"]:
        val = os.environ.get(env_key)
        if val is not None:
            return val

    # 2. SageMaker hyperparameters.json 파일에서 시도
    hp_path = Path("/opt/ml/input/config/hyperparameters.json")
    if hp_path.exists():
        try:
            hp = json.loads(hp_path.read_text(encoding="utf-8"))
            if key in hp:
                return str(hp[key])
        except (json.JSONDecodeError, OSError):
            pass

    return default


def _detect_gpu_count() -> str:
    """사용 가능한 GPU 수를 자동 감지합니다."""
    try:
        import torch
        count = torch.cuda.device_count()
        if count > 0:
            return str(count)
    except Exception:
        pass
    return "1"


def parse_sagemaker_env() -> dict:
    """SageMaker 환경변수를 파싱하여 설정 딕셔너리로 반환합니다."""
    # num_gpus: 하이퍼파라미터 → 자동 감지 순서로 결정
    num_gpus = _get_hyperparameter("num_gpus")
    if not num_gpus:
        num_gpus = _detect_gpu_count()
        print(f"num_gpus 하이퍼파라미터 미설정 → 자동 감지: {num_gpus}개 GPU")

    return {
        "model_dir": os.environ.get("SM_CHANNEL_MODEL", "/opt/ml/input/data/model"),
        "dataset_dir": os.environ.get("SM_CHANNEL_DATASET", "/opt/ml/input/data/dataset"),
        "output_dir": os.environ.get("SM_MODEL_DIR", "/opt/ml/model"),
        "embodiment_tag": _get_hyperparameter("embodiment_tag", "NEW_EMBODIMENT"),
        "max_steps": _get_hyperparameter("max_steps", "10000"),
        "global_batch_size": _get_hyperparameter("global_batch_size", "32"),
        "save_steps": _get_hyperparameter("save_steps", "2000"),
        "num_gpus": num_gpus,
        "video_key": _get_hyperparameter("video_key", "video.webcam"),
        "state_key": _get_hyperparameter("state_key", "state.single_arm"),
        "action_dim": _get_hyperparameter("action_dim", "7"),
        "wandb_api_key": _get_hyperparameter("wandb_api_key", ""),
    }


# -------------------------------------------------------------------------------
# wandb 설정
# -------------------------------------------------------------------------------

def setup_wandb(env: dict) -> None:
    """wandb API 키를 환경변수에 설정합니다. SSM에서 읽거나 직접 설정."""
    api_key = env.get("wandb_api_key", "")

    # SSM에서 키를 읽으려고 시도 (SM_HP_WANDB_API_KEY가 "ssm:/groot/wandb-key" 형식인 경우)
    if api_key.startswith("ssm:"):
        try:
            import boto3
            ssm = boto3.client("ssm")
            param_name = api_key[4:]  # "ssm:" 제거
            response = ssm.get_parameter(Name=param_name, WithDecryption=True)
            api_key = response["Parameter"]["Value"]
            print(f"SSM에서 wandb API 키 로드 완료: {param_name}")
        except Exception as e:
            print(f"경고: SSM에서 wandb 키 로드 실패: {e}. wandb 없이 진행합니다.")
            api_key = ""

    if api_key:
        os.environ["WANDB_API_KEY"] = api_key
        print("wandb 활성화됨.")
    else:
        os.environ["WANDB_DISABLED"] = "true"
        print("wandb 비활성화됨 (키 없음).")


# -------------------------------------------------------------------------------
# GR00T 학습 실행
# -------------------------------------------------------------------------------

def ensure_tasks_jsonl(dataset_dir: str) -> None:
    """GR00T가 요구하는 meta/tasks.jsonl이 없으면 기본 파일을 생성합니다."""
    meta_dir = Path(dataset_dir) / "meta"
    tasks_path = meta_dir / "tasks.jsonl"
    if tasks_path.exists():
        return

    print(f"tasks.jsonl 누락 → 기본 파일 생성: {tasks_path}")
    meta_dir.mkdir(parents=True, exist_ok=True)

    # episodes.jsonl에서 task 정보 추출 시도
    task_descriptions = set()
    episodes_path = meta_dir / "episodes.jsonl"
    if episodes_path.exists():
        with open(episodes_path, "r", encoding="utf-8") as f:
            for line in f:
                ep = json.loads(line)
                for t in ep.get("tasks", []):
                    task_descriptions.add(t)

    with open(tasks_path, "w", encoding="utf-8") as f:
        if task_descriptions:
            for i, desc in enumerate(sorted(task_descriptions)):
                f.write(json.dumps({"task_index": i, "task": desc}) + "\n")
        else:
            f.write(json.dumps({"task_index": 0, "task": "default task"}) + "\n")

    print(f"  tasks.jsonl 생성 완료 ({max(len(task_descriptions), 1)}개 태스크)")


def run_gr00t_training(env: dict) -> None:
    """Isaac-GR00T의 launch_finetune.py를 subprocess로 호출합니다.

    num_gpus > 1인 경우 torchrun(DDP + DeepSpeed)으로 실행하고,
    단일 GPU인 경우 CUDA_VISIBLE_DEVICES를 제한하여 실행합니다.
    이렇게 해야 multi-GPU 머신에서도 DataParallel이 아닌 올바른
    병렬화 전략을 사용합니다.
    """
    ensure_tasks_jsonl(env["dataset_dir"])
    training_output_dir = os.path.join(env["output_dir"], "checkpoint")

    num_gpus = int(env["num_gpus"])

    finetune_args = [
        "gr00t/experiment/launch_finetune.py",
        "--base_model_path", env["model_dir"],
        "--dataset_path", env["dataset_dir"],
        "--embodiment_tag", env["embodiment_tag"],
        "--num_gpus", str(num_gpus),
        "--output_dir", training_output_dir,
        "--max_steps", env["max_steps"],
        "--global_batch_size", env["global_batch_size"],
        "--save_steps", env["save_steps"],
    ]

    # 데이터셋 안에 modality_config.py가 있으면 자동으로 전달
    modality_config_path = os.path.join(env["dataset_dir"], "modality_config.py")
    if os.path.isfile(modality_config_path):
        finetune_args.extend(["--modality_config_path", modality_config_path])
        print(f"Modality config 감지: {modality_config_path}")

    if env.get("wandb_api_key") and not os.environ.get("WANDB_DISABLED"):
        finetune_args.append("--use_wandb")

    # subprocess에 전달할 환경변수 (현재 환경 복사)
    run_env = os.environ.copy()

    if num_gpus > 1:
        # Multi-GPU: torchrun(DDP + DeepSpeed)
        cmd = [
            sys.executable, "-m", "torch.distributed.run",
            "--standalone",
            "--nproc_per_node", str(num_gpus),
        ] + finetune_args
        print(f"[Multi-GPU] torchrun으로 {num_gpus}개 GPU DDP 학습 시작")
    else:
        # Single-GPU: CUDA_VISIBLE_DEVICES를 GPU 0번으로 제한하여
        # HF Trainer가 다른 GPU를 감지하지 못하게 함 (DataParallel 방지)
        cmd = [sys.executable] + finetune_args
        run_env["CUDA_VISIBLE_DEVICES"] = "0"
        print(f"[Single-GPU] python으로 단일 GPU 학습 시작 (CUDA_VISIBLE_DEVICES=0)")

    print(f"학습 명령어: {' '.join(cmd)}")

    result = subprocess.run(cmd, cwd="/opt/gr00t", env=run_env, check=False)

    if result.returncode != 0:
        print(f"오류: 학습 실패 (코드 {result.returncode})", file=sys.stderr)
        sys.exit(result.returncode)

    print("학습 완료.")
    env["checkpoint_dir"] = training_output_dir


# -------------------------------------------------------------------------------
# 추론 메타데이터 저장
# -------------------------------------------------------------------------------

def save_inference_metadata(env: dict) -> None:
    """추론 컨테이너가 사용할 메타데이터를 inference_metadata.json으로 저장합니다.

    FastAPI 추론 서버가 모델 로드 시 이 파일을 읽어 올바른 관측 키와
    embodiment tag를 사용합니다.
    """
    metadata = {
        "embodiment_tag": env["embodiment_tag"],
        "video_key": env["video_key"],
        "state_key": env["state_key"],
        "action_dim": int(env["action_dim"]),
    }

    output_path = os.path.join(env["output_dir"], "inference_metadata.json")
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2, ensure_ascii=False)

    print(f"추론 메타데이터 저장 완료: {output_path}")
    print(f"  embodiment_tag: {metadata['embodiment_tag']}")
    print(f"  video_key:      {metadata['video_key']}")
    print(f"  state_key:      {metadata['state_key']}")
    print(f"  action_dim:     {metadata['action_dim']}")


# -------------------------------------------------------------------------------
# 모델 아티팩트 복사
# -------------------------------------------------------------------------------

def copy_artifacts(env: dict) -> None:
    """학습 체크포인트를 SM_MODEL_DIR 최상위로 복사합니다.

    SageMaker는 SM_MODEL_DIR의 내용을 model.tar.gz로 패키징하여 S3에 업로드합니다.
    """
    checkpoint_dir = env.get("checkpoint_dir", "")
    output_dir = env["output_dir"]

    if not checkpoint_dir or not os.path.isdir(checkpoint_dir):
        print(f"경고: 체크포인트 디렉토리를 찾을 수 없음: {checkpoint_dir}")
        return

    print(f"아티팩트 복사 중: {checkpoint_dir} → {output_dir}")

    for item in os.listdir(checkpoint_dir):
        src = os.path.join(checkpoint_dir, item)
        dst = os.path.join(output_dir, item)
        if os.path.isdir(src):
            shutil.copytree(src, dst, dirs_exist_ok=True)
        else:
            shutil.copy2(src, dst)

    # 프로세서 파일을 루트로 복사 (Gr00tPolicy가 model_dir 루트에서 로드)
    for subdir in ["processor", "checkpoint-1", "checkpoint"]:
        proc_cfg = os.path.join(output_dir, subdir, "processor_config.json")
        if os.path.isfile(proc_cfg) and not os.path.isfile(os.path.join(output_dir, "processor_config.json")):
            print(f"프로세서 파일을 {subdir}/에서 루트로 복사합니다.")
            for f in os.listdir(os.path.join(output_dir, subdir)):
                src_f = os.path.join(output_dir, subdir, f)
                dst_f = os.path.join(output_dir, f)
                if os.path.isfile(src_f) and not os.path.exists(dst_f):
                    shutil.copy2(src_f, dst_f)
            break

    print("아티팩트 복사 완료.")


# -------------------------------------------------------------------------------
# Main
# -------------------------------------------------------------------------------

def main() -> None:
    print("=" * 60)
    print("GR00T-N1.6 SageMaker 학습 시작")
    print("=" * 60)

    env = parse_sagemaker_env()

    print(f"설정:")
    print(f"  모델 경로:       {env['model_dir']}")
    print(f"  데이터셋 경로:   {env['dataset_dir']}")
    print(f"  출력 경로:       {env['output_dir']}")
    print(f"  embodiment tag: {env['embodiment_tag']}")
    print(f"  최대 스텝:       {env['max_steps']}")
    print(f"  배치 크기:       {env['global_batch_size']}")
    print(f"  GPU 수:         {env['num_gpus']}")

    setup_wandb(env)
    run_gr00t_training(env)
    save_inference_metadata(env)
    copy_artifacts(env)

    print("=" * 60)
    print("학습 완료!")
    print("=" * 60)


if __name__ == "__main__":
    main()
