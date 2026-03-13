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

def parse_sagemaker_env() -> dict:
    """SageMaker 환경변수를 파싱하여 설정 딕셔너리로 반환합니다."""
    return {
        "model_dir": os.environ.get("SM_CHANNEL_MODEL", "/opt/ml/input/data/model"),
        "dataset_dir": os.environ.get("SM_CHANNEL_DATASET", "/opt/ml/input/data/dataset"),
        "output_dir": os.environ.get("SM_MODEL_DIR", "/opt/ml/model"),
        # 하이퍼파라미터 (SageMaker는 SM_HP_ 접두사를 붙임)
        "embodiment_tag": os.environ.get("SM_HP_EMBODIMENT_TAG", "new_embodiment"),
        "max_steps": os.environ.get("SM_HP_MAX_STEPS", "10000"),
        "global_batch_size": os.environ.get("SM_HP_GLOBAL_BATCH_SIZE", "32"),
        "save_steps": os.environ.get("SM_HP_SAVE_STEPS", "2000"),
        "num_gpus": os.environ.get("SM_HP_NUM_GPUS", "1"),
        "video_key": os.environ.get("SM_HP_VIDEO_KEY", "video.webcam"),
        "state_key": os.environ.get("SM_HP_STATE_KEY", "state.single_arm"),
        "action_dim": os.environ.get("SM_HP_ACTION_DIM", "7"),
        "wandb_api_key": os.environ.get("SM_HP_WANDB_API_KEY", ""),
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

def run_gr00t_training(env: dict) -> None:
    """Isaac-GR00T의 launch_finetune.py를 subprocess로 호출합니다."""
    training_output_dir = os.path.join(env["output_dir"], "checkpoint")

    cmd = [
        sys.executable,
        "gr00t/experiment/launch_finetune.py",
        "--base-model-path", env["model_dir"],
        "--dataset-path", env["dataset_dir"],
        "--embodiment-tag", env["embodiment_tag"],
        "--num-gpus", env["num_gpus"],
        "--output-dir", training_output_dir,
        "--max-steps", env["max_steps"],
        "--global-batch-size", env["global_batch_size"],
        "--save-steps", env["save_steps"],
    ]

    if env.get("wandb_api_key") and not os.environ.get("WANDB_DISABLED"):
        cmd.append("--use-wandb")

    print(f"학습 명령어: {' '.join(cmd)}")

    result = subprocess.run(cmd, cwd="/opt/gr00t", check=False)

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
