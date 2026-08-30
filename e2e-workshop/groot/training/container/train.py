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
    """SageMaker 환경변수를 파싱하여 설정 딕셔너리로 반환합니다.

    base_model_path 결정 우선순위:
        1. SM_HP_BASE_MODEL_PATH (사용자가 hyperparameter로 명시)
        2. SM_CHANNEL_MODEL (사용자가 S3 채널로 베이스 모델 제공)
        3. BASE_MODEL_PATH 환경변수 (Dockerfile ARG에서 build 시 결정)
        4. GROOT_VERSION 환경변수에서 유추 (n1.6 → nvidia/GR00T-N1.6-3B)
    """
    num_gpus = _get_hyperparameter("num_gpus")
    # 미지정/0 이면 인스턴스가 가진 모든 GPU 를 사용. SageMaker pipeline 의
    # ParameterInteger 는 None 을 허용하지 않아 NumGpus=0 을 sentinel 로 쓴다.
    if not num_gpus or num_gpus == "0":
        num_gpus = _detect_gpu_count()
        print(f"num_gpus 미설정/0 → 자동 감지: {num_gpus}개 GPU")

    groot_version = (
        _get_hyperparameter("groot_version")
        or os.environ.get("GROOT_VERSION", "n1.6")
    ).lower()

    # base_model_path 결정
    hp_base_model = _get_hyperparameter("base_model_path")
    if hp_base_model:
        base_model_path = hp_base_model
    elif os.environ.get("SM_CHANNEL_MODEL"):
        base_model_path = os.environ["SM_CHANNEL_MODEL"]
    elif os.environ.get("BASE_MODEL_PATH"):
        base_model_path = os.environ["BASE_MODEL_PATH"]
    else:
        # GROOT_VERSION에서 유추
        version_map = {
            "n1.6": "nvidia/GR00T-N1.6-3B",
            "n1.7": "nvidia/GR00T-N1.7-3B",
        }
        base_model_path = version_map.get(groot_version, "nvidia/GR00T-N1.6-3B")

    return {
        "model_dir": base_model_path,
        "dataset_dir": os.environ.get("SM_CHANNEL_DATASET", "/opt/ml/input/data/dataset"),
        "output_dir": os.environ.get("SM_MODEL_DIR", "/opt/ml/model"),
        "groot_version": groot_version,
        "embodiment_tag": _get_hyperparameter("embodiment_tag", "NEW_EMBODIMENT"),
        "max_steps": _get_hyperparameter("max_steps", "10000"),
        "global_batch_size": _get_hyperparameter("global_batch_size", "32"),
        "save_steps": _get_hyperparameter("save_steps", "2000"),
        "dataloader_num_workers": _get_hyperparameter("dataloader_num_workers", "4"),
        # FSx용 export: 설정 시 학습 종료 후 SM_MODEL_DIR(비압축 슬림 체크포인트)을
        # 이 S3 prefix로 그대로 sync. IsaacSim이 FSx Lustre로 마운트해 tar 해제 없이 로드.
        "export_s3_uri": _get_hyperparameter("export_s3_uri", ""),
        "num_gpus": num_gpus,
        "video_key": _get_hyperparameter("video_key", "video.webcam"),
        "state_key": _get_hyperparameter("state_key", "state.single_arm"),
        "action_dim": _get_hyperparameter("action_dim", "7"),
        "wandb_api_key": _get_hyperparameter("wandb_api_key", ""),
        "hf_token": _get_hyperparameter("hf_token", ""),
        "hf_dataset_id": _get_hyperparameter("hf_dataset_id", ""),
    }


# -------------------------------------------------------------------------------
# wandb 설정
# -------------------------------------------------------------------------------

def _resolve_aws_region() -> str:
    """SageMaker 학습 컨테이너에서 boto3 클라이언트에 쓸 region을 결정합니다.

    SageMaker는 AWS_REGION을 자동 주입하지 않을 수 있으므로
    SM_TRAINING_ENV에서 region을 추출하거나 IMDS도 시도합니다.
    """
    for key in ("AWS_REGION", "AWS_DEFAULT_REGION"):
        value = os.environ.get(key)
        if value:
            return value
    # IMDSv2로 인스턴스 region 조회
    try:
        import urllib.request
        token_req = urllib.request.Request(
            "http://169.254.169.254/latest/api/token",
            method="PUT",
            headers={"X-aws-ec2-metadata-token-ttl-seconds": "60"},
        )
        token = urllib.request.urlopen(token_req, timeout=2).read().decode()
        region_req = urllib.request.Request(
            "http://169.254.169.254/latest/meta-data/placement/region",
            headers={"X-aws-ec2-metadata-token": token},
        )
        return urllib.request.urlopen(region_req, timeout=2).read().decode()
    except Exception:
        return "us-east-1"


def setup_wandb(env: dict) -> None:
    """wandb API 키를 환경변수에 설정합니다. SSM에서 읽거나 직접 설정."""
    api_key = env.get("wandb_api_key", "")

    # SSM에서 키를 읽으려고 시도 (SM_HP_WANDB_API_KEY가 "ssm:/groot/wandb-key" 형식인 경우)
    if api_key.startswith("ssm:"):
        try:
            import boto3
            ssm = boto3.client("ssm", region_name=_resolve_aws_region())
            param_name = api_key[4:]  # "ssm:" 제거
            response = ssm.get_parameter(Name=param_name, WithDecryption=True)
            api_key = response["Parameter"]["Value"]
            print(f"SSM에서 wandb API 키 로드 완료: {param_name}")
        except Exception as e:
            print(f"경고: SSM에서 wandb 키 로드 실패: {e}. wandb 없이 진행합니다.")
            api_key = ""

    # CFN이 만든 SSM 파라미터에 PLACEHOLDER 값이 그대로 남아 있으면 비활성화 처리.
    # (wandb 활성화 후 401 PERMISSION_ERROR 로 학습 자체가 죽는 것을 방지)
    if api_key and "PLACEHOLDER" not in api_key.upper():
        os.environ["WANDB_API_KEY"] = api_key
        print("wandb 활성화됨.")
    else:
        os.environ["WANDB_DISABLED"] = "true"
        if api_key:
            print("wandb 비활성화됨 (SSM 값이 PLACEHOLDER).")
        else:
            print("wandb 비활성화됨 (키 없음).")


def setup_huggingface(env: dict) -> None:
    """HF 토큰을 환경변수로 설정합니다 (필요 시 SSM에서 읽음)."""
    token = env.get("hf_token", "")
    if token.startswith("ssm:"):
        try:
            import boto3
            ssm = boto3.client("ssm", region_name=_resolve_aws_region())
            param_name = token[4:]
            response = ssm.get_parameter(Name=param_name, WithDecryption=True)
            token = response["Parameter"]["Value"]
            print(f"SSM에서 HF 토큰 로드 완료: {param_name}")
        except Exception as e:
            print(f"경고: SSM에서 HF 토큰 로드 실패: {e}.")
            token = ""
    if token:
        os.environ["HF_TOKEN"] = token
        os.environ["HUGGING_FACE_HUB_TOKEN"] = token


def ensure_modality_files(env: dict) -> None:
    """NEW_EMBODIMENT 학습 시 dataset에 modality_config.py / meta/modality.json이
    없으면 source_dir에 번들된 SO-101 디폴트로 자동 배치합니다.

    GR00T의 launch_finetune.py는 NEW_EMBODIMENT를 default config dict에 등록하지
    않은 상태로 호출되면 KeyError('new_embodiment')로 실패합니다. modality_config.py
    가 dataset root에 있어야 train.py가 --modality_config_path로 전달하고,
    이 파일의 register_modality_config(...) 호출이 dict에 등록합니다.
    """
    if env["embodiment_tag"].upper() != "NEW_EMBODIMENT":
        return  # 빌트인 embodiment는 GR00T가 자체 config 보유

    dataset_dir = Path(env["dataset_dir"])
    if not dataset_dir.is_dir():
        return  # dataset 자체가 없으면 호출자(GR00T)가 더 명확한 에러로 실패

    # source_dir에 번들된 디폴트 modality 파일
    bundled_dir = Path(__file__).parent / "configs"
    bundled_config_py = bundled_dir / "so101_modality_config.py"
    bundled_modality_json = bundled_dir / "so101_modality.json"

    target_config_py = dataset_dir / "modality_config.py"
    target_modality_json = dataset_dir / "meta" / "modality.json"

    if not target_config_py.exists() and bundled_config_py.exists():
        print(f"NEW_EMBODIMENT modality_config.py 누락 → 번들 SO-101 디폴트 배치: {target_config_py}")
        shutil.copy2(bundled_config_py, target_config_py)

    if not target_modality_json.exists() and bundled_modality_json.exists():
        print(f"NEW_EMBODIMENT meta/modality.json 누락 → 번들 SO-101 디폴트 배치: {target_modality_json}")
        target_modality_json.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(bundled_modality_json, target_modality_json)


def maybe_download_hf_dataset(env: dict) -> None:
    """SM_CHANNEL_DATASET이 비어 있고 HF_DATASET_ID가 주어지면 HF에서 다운로드합니다."""
    dataset_dir = env["dataset_dir"]
    hf_id = env.get("hf_dataset_id", "")
    if os.path.isdir(dataset_dir) and os.listdir(dataset_dir):
        return  # 이미 채널로 받음
    if not hf_id:
        return  # 채널도 HF id도 없음 → 호출자 검증에 맡김

    print(f"SM_CHANNEL_DATASET 비어있음 → HF에서 다운로드: {hf_id}")
    from huggingface_hub import snapshot_download

    os.makedirs(dataset_dir, exist_ok=True)
    kwargs = {
        "repo_id": hf_id,
        "repo_type": "dataset",
        "local_dir": dataset_dir,
    }
    if os.environ.get("HF_TOKEN"):
        kwargs["token"] = os.environ["HF_TOKEN"]
    snapshot_download(**kwargs)
    print(f"HF 데이터셋 다운로드 완료: {dataset_dir}")


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
    # 학습 중간 체크포인트는 /opt/ml/checkpoints 에 저장한다.
    # SageMaker CheckpointConfig 가 이 경로를 S3 와 실시간 sync 하므로
    # (1) 중간 step 가중치를 S3 에서 바로 확인할 수 있고
    # (2) Spot 중단 시 재시작에서 이어서 학습할 수 있다.
    # /opt/ml/model 아래에 두면 학습 종료 후 tar.gz 업로드 시점까지 S3 에 안 올라간다.
    training_output_dir = "/opt/ml/checkpoints"
    os.makedirs(training_output_dir, exist_ok=True)

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
        "--dataloader_num_workers", env["dataloader_num_workers"],
    ]

    # 데이터셋 안에 modality_config.py가 있으면 자동으로 전달
    # 그 다음 우선순위로 source_dir 번들의 SO-101 디폴트(NEW_EMBODIMENT)를 사용
    modality_config_path = os.path.join(env["dataset_dir"], "modality_config.py")
    if not os.path.isfile(modality_config_path):
        bundled_modality = (
            Path(__file__).parent / "configs" / "so101_modality_config.py"
        )
        if bundled_modality.is_file():
            modality_config_path = str(bundled_modality)
            print(f"dataset에 modality_config.py 없음 → 번들 디폴트 사용: {modality_config_path}")
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

    SageMaker는 SM_MODEL_DIR 내용을 model.tar.gz 로 패키징하여 S3 에 업로드합니다.
    추론에는 사용되지 않는 옵티마이저/스케줄러/RNG state/trainer state 는 제외해
    tarball 크기를 크게 줄입니다 (100GB+ → ~6-12GB).
    제외 패턴은 HF Trainer 가 만드는 표준 파일명 기준.
    """
    checkpoint_dir = env.get("checkpoint_dir", "")
    output_dir = env["output_dir"]

    if not checkpoint_dir or not os.path.isdir(checkpoint_dir):
        print(f"경고: 체크포인트 디렉토리를 찾을 수 없음: {checkpoint_dir}")
        return

    # 추론 시 불필요해 tarball 에서 제외할 파일 패턴 (basename 기준)
    INFERENCE_EXCLUDE = {
        "optimizer.pt",
        "optimizer.bin",
        "scheduler.pt",
        "rng_state.pth",
        "trainer_state.json",
        "training_args.bin",
        "scaler.pt",
    }

    def _should_skip(name: str) -> bool:
        if name in INFERENCE_EXCLUDE:
            return True
        # rank-별 RNG state (rng_state_0.pth ...) 와 DeepSpeed shard 도 제거.
        if name.startswith("rng_state_") and name.endswith(".pth"):
            return True
        if name.startswith("global_step") or name == "latest":
            return True
        return False

    def _copytree_filtered(src: str, dst: str) -> None:
        os.makedirs(dst, exist_ok=True)
        for entry in os.listdir(src):
            if _should_skip(entry):
                print(f"  skip (inference 불필요): {os.path.relpath(os.path.join(src, entry), checkpoint_dir)}")
                continue
            s = os.path.join(src, entry)
            d = os.path.join(dst, entry)
            if os.path.isdir(s):
                _copytree_filtered(s, d)
            else:
                shutil.copy2(s, d)

    # checkpoint-N 디렉토리들 중 가장 최신(가장 큰 N)만 보존하고 나머지는 skip.
    # 추론은 최신 가중치만 필요하고, intermediate checkpoint 가 누적되면 tarball 폭증.
    checkpoint_subdirs = sorted(
        (d for d in os.listdir(checkpoint_dir)
         if d.startswith("checkpoint-") and d.split("-", 1)[1].isdigit()),
        key=lambda d: int(d.split("-", 1)[1]),
    )
    keep_checkpoint = checkpoint_subdirs[-1] if checkpoint_subdirs else None
    drop_checkpoints = set(checkpoint_subdirs[:-1])
    if drop_checkpoints:
        print(f"중간 체크포인트 skip (최신 {keep_checkpoint}만 보존): {sorted(drop_checkpoints)}")

    print(f"아티팩트 복사 중 (추론용만): {checkpoint_dir} → {output_dir}")
    for item in os.listdir(checkpoint_dir):
        if _should_skip(item):
            print(f"  skip (inference 불필요): {item}")
            continue
        if item in drop_checkpoints:
            continue
        src = os.path.join(checkpoint_dir, item)
        dst = os.path.join(output_dir, item)
        if os.path.isdir(src):
            _copytree_filtered(src, dst)
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
# FSx용 비압축 export
# -------------------------------------------------------------------------------

def export_uncompressed_to_s3(env: dict) -> None:
    """SM_MODEL_DIR(비압축 슬림 체크포인트)을 export_s3_uri prefix로 그대로 업로드합니다.

    SageMaker가 SM_MODEL_DIR을 model.tar.gz로 압축해 output_path에 올리는 것과 별개로,
    이 함수는 동일 내용을 **압축하지 않고** 지정 S3 prefix에 sync한다. 파일이 이미 컨테이너
    로컬 디스크에 있으므로 재다운로드/재압축 없이 업로드만 수행한다(별도 ProcessingStep 불필요).
    이 prefix를 FSx for Lustre DRA(import 소스)로 걸면 IsaacSim EC2가 tar 해제 없이 바로 로드한다.
    """
    export_uri = (env.get("export_s3_uri") or "").strip()
    if not export_uri:
        print("export_s3_uri 미설정 → 비압축 export 건너뜀 (model.tar.gz만 생성).")
        return
    if not export_uri.startswith("s3://"):
        print(f"경고: export_s3_uri 형식이 s3:// 가 아님 → 건너뜀: {export_uri}")
        return

    import boto3
    output_dir = env["output_dir"]
    without_scheme = export_uri[len("s3://"):]
    bucket, _, key_prefix = without_scheme.partition("/")
    key_prefix = key_prefix.rstrip("/")

    region = _resolve_aws_region()
    s3 = boto3.client("s3", region_name=region)

    n = 0
    for root, _dirs, files in os.walk(output_dir):
        for fname in files:
            local_path = os.path.join(root, fname)
            rel = os.path.relpath(local_path, output_dir)
            key = f"{key_prefix}/{rel}" if key_prefix else rel
            s3.upload_file(local_path, bucket, key)
            n += 1
    print(f"비압축 export 완료: {n}개 파일 → {export_uri}/ (FSx import 소스)")


# -------------------------------------------------------------------------------
# Main
# -------------------------------------------------------------------------------

def main() -> None:
    print("=" * 60)
    print("GR00T SageMaker 학습 시작")
    print("=" * 60)

    env = parse_sagemaker_env()

    print(f"설정:")
    print(f"  GR00T 버전:      {env['groot_version']}")
    print(f"  베이스 모델:     {env['model_dir']}")
    print(f"  데이터셋 경로:   {env['dataset_dir']}")
    print(f"  출력 경로:       {env['output_dir']}")
    print(f"  embodiment tag: {env['embodiment_tag']}")
    print(f"  최대 스텝:       {env['max_steps']}")
    print(f"  배치 크기:       {env['global_batch_size']}")
    print(f"  GPU 수:         {env['num_gpus']}")

    setup_wandb(env)
    setup_huggingface(env)
    maybe_download_hf_dataset(env)
    ensure_modality_files(env)
    run_gr00t_training(env)
    save_inference_metadata(env)
    copy_artifacts(env)
    export_uncompressed_to_s3(env)

    print("=" * 60)
    print("학습 완료!")
    print("=" * 60)


if __name__ == "__main__":
    main()
