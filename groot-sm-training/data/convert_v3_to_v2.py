#!/usr/bin/env python3
"""LeRobot v3.0 → v2.1 데이터셋 변환기.

GR00T 파인튜닝에 필요한 LeRobot v2.1 형식으로 변환합니다.
lerobot 라이브러리 의존성 없이 독립적으로 동작합니다.

변환 내용:
  - data/ : 통합 parquet → 에피소드별 parquet 분리
  - videos/ : 연결된 mp4 → 에피소드별 mp4 분리 (ffmpeg 필요)
  - meta/episodes/ (parquet) → meta/episodes.jsonl
  - meta/tasks.parquet → meta/tasks.jsonl
  - meta/info.json : codebase_version v3.0 → v2.1, 경로 템플릿 변경

사용법:
    from data.convert_v3_to_v2 import convert_v3_to_v2
    convert_v3_to_v2("/path/to/v3-dataset")
"""

import json
import math
import os
import shutil
import subprocess
from pathlib import Path

import pyarrow.parquet as pq


CHUNKS_SIZE_DEFAULT = 1000


def ensure_tasks_jsonl(dataset_path: str) -> bool:
    """meta/tasks.jsonl이 없으면 기본 파일을 생성합니다.

    GR00T의 LeRobotEpisodeLoader._load_metadata()는 tasks.jsonl을
    무조건 open()하므로, 파일이 없으면 FileNotFoundError가 발생합니다.

    Returns:
        True이면 새로 생성됨, False이면 이미 존재.
    """
    return _ensure_tasks_jsonl(Path(dataset_path))


def _ensure_tasks_jsonl(root: Path) -> bool:
    """내부 구현: meta/tasks.jsonl이 없으면 기본 파일을 생성합니다."""
    tasks_jsonl = root / "meta" / "tasks.jsonl"
    if tasks_jsonl.exists():
        return False

    # episodes.jsonl에서 task 정보 추출 시도
    task_descriptions = set()
    episodes_jsonl = root / "meta" / "episodes.jsonl"
    if episodes_jsonl.exists():
        with open(episodes_jsonl, "r", encoding="utf-8") as f:
            for line in f:
                ep = json.loads(line)
                for t in ep.get("tasks", []):
                    task_descriptions.add(t)

    tasks_jsonl.parent.mkdir(parents=True, exist_ok=True)
    with open(tasks_jsonl, "w", encoding="utf-8") as f:
        if task_descriptions:
            for i, desc in enumerate(sorted(task_descriptions)):
                f.write(json.dumps({"task_index": i, "task": desc}, ensure_ascii=False) + "\n")
        else:
            f.write(json.dumps({"task_index": 0, "task": "default task"}, ensure_ascii=False) + "\n")

    return True


def is_v3_dataset(dataset_path: str) -> bool:
    """데이터셋이 LeRobot v3.0 형식인지 확인합니다."""
    info_path = Path(dataset_path) / "meta" / "info.json"
    if not info_path.exists():
        return False
    info = json.loads(info_path.read_text(encoding="utf-8"))
    return info.get("codebase_version", "").startswith("v3")


def convert_v3_to_v2(dataset_path: str) -> None:
    """LeRobot v3.0 데이터셋을 v2.1로 인플레이스 변환합니다.

    Args:
        dataset_path: 변환할 데이터셋 경로.
    """
    root = Path(dataset_path)
    info = json.loads((root / "meta" / "info.json").read_text(encoding="utf-8"))

    if not info.get("codebase_version", "").startswith("v3"):
        print("이미 v2 형식이거나 알 수 없는 버전입니다. 변환을 건너뜁니다.")
        return

    print(f"LeRobot v3 → v2 변환 시작: {dataset_path}")

    chunks_size = info.get("chunks_size", CHUNKS_SIZE_DEFAULT)
    episodes = _load_episodes_parquet(root)
    video_keys = [k for k, v in info.get("features", {}).items() if v.get("dtype") == "video"]

    # 1. data/ 변환: 통합 parquet → 에피소드별 parquet
    _convert_data(root, episodes, chunks_size)

    # 2. videos/ 변환: 연결 mp4 → 에피소드별 mp4
    _convert_videos(root, episodes, video_keys, chunks_size)

    # 3. meta/ 변환
    _convert_episodes_to_jsonl(root, episodes)
    _convert_tasks_to_jsonl(root)

    # 4. info.json 업데이트
    _update_info_json(root, info, episodes, video_keys)

    print("v3 → v2 변환 완료!")


def _load_episodes_parquet(root: Path) -> list[dict]:
    """meta/episodes/ 디렉토리의 parquet 파일들을 읽어 에피소드 메타데이터를 반환합니다."""
    episodes_dir = root / "meta" / "episodes"
    pq_files = sorted(episodes_dir.glob("chunk-*/file-*.parquet"))
    if not pq_files:
        raise FileNotFoundError(f"에피소드 parquet 파일을 찾을 수 없습니다: {episodes_dir}")

    records = []
    for pq_file in pq_files:
        table = pq.read_table(pq_file)
        records.extend(table.to_pylist())

    records.sort(key=lambda r: int(r["episode_index"]))
    print(f"  에피소드 {len(records)}개 로드")
    return records


def _convert_data(root: Path, episodes: list[dict], chunks_size: int) -> None:
    """통합 parquet 파일을 에피소드별 parquet으로 분리합니다."""
    print("  data/ 변환 중...")

    # 파일별 에피소드 그룹핑
    grouped = {}
    for ep in episodes:
        key = (int(ep["data/chunk_index"]), int(ep["data/file_index"]))
        grouped.setdefault(key, []).append(ep)

    for (chunk_idx, file_idx), eps in grouped.items():
        src = root / f"data/chunk-{chunk_idx:03d}/file-{file_idx:03d}.parquet"
        if not src.exists():
            print(f"    경고: {src} 없음, 건너뜀")
            continue

        table = pq.read_table(src)
        eps = sorted(eps, key=lambda r: int(r["dataset_from_index"]))
        file_offset = int(eps[0]["dataset_from_index"])

        for ep in eps:
            ep_idx = int(ep["episode_index"])
            start = int(ep["dataset_from_index"]) - file_offset
            length = int(ep["dataset_to_index"]) - int(ep["dataset_from_index"])

            ep_table = table.slice(start, length)
            dest_chunk = ep_idx // chunks_size
            dest = root / f"data/chunk-{dest_chunk:03d}/episode_{ep_idx:06d}.parquet"
            dest.parent.mkdir(parents=True, exist_ok=True)
            pq.write_table(ep_table, dest)

        # 원본 통합 파일 삭제
        src.unlink()

    print(f"    에피소드별 parquet 분리 완료")


def _convert_videos(root: Path, episodes: list[dict], video_keys: list[str], chunks_size: int) -> None:
    """연결된 mp4를 에피소드별로 분리합니다 (ffmpeg 필요)."""
    if not video_keys:
        print("  비디오 없음, 건너뜀")
        return

    # ffmpeg 존재 확인
    if shutil.which("ffmpeg") is None:
        print("  경고: ffmpeg를 찾을 수 없어 비디오 변환을 건너뜁니다.")
        print("         sudo apt install ffmpeg 로 설치 후 재시도하세요.")
        return

    print(f"  videos/ 변환 중 ({len(video_keys)}개 비디오 키)...")

    for vk in video_keys:
        # v3 경로: videos/{video_key}/chunk-{chunk_index}/file-{file_index}.mp4
        chunk_col = f"videos/{vk}/chunk_index"
        file_col = f"videos/{vk}/file_index"
        from_ts_col = f"videos/{vk}/from_timestamp"
        to_ts_col = f"videos/{vk}/to_timestamp"

        # 파일별 그룹핑
        grouped = {}
        for ep in episodes:
            if chunk_col not in ep or ep[chunk_col] is None:
                continue
            key = (int(ep[chunk_col]), int(ep[file_col]))
            grouped.setdefault(key, []).append(ep)

        for (chunk_idx, file_idx), eps in grouped.items():
            src = root / f"videos/{vk}/chunk-{chunk_idx:03d}/file-{file_idx:03d}.mp4"
            if not src.exists():
                print(f"    경고: {src} 없음, 건너뜀")
                continue

            eps = sorted(eps, key=lambda r: float(r[from_ts_col]))

            for ep in eps:
                ep_idx = int(ep["episode_index"])
                start = float(ep[from_ts_col])
                end = float(ep[to_ts_col])
                duration = max(end - start, 1e-6)

                dest_chunk = ep_idx // chunks_size
                # v2 경로: videos/chunk-{chunk}/observation.images.top/episode_{idx}.mp4
                dest = root / f"videos/chunk-{dest_chunk:03d}/{vk}/episode_{ep_idx:06d}.mp4"
                dest.parent.mkdir(parents=True, exist_ok=True)

                cmd = [
                    "ffmpeg", "-hide_banner", "-loglevel", "error",
                    "-ss", f"{start:.6f}",
                    "-i", str(src),
                    "-t", f"{duration:.6f}",
                    "-c", "copy",
                    "-avoid_negative_ts", "1",
                    "-y", str(dest),
                ]
                subprocess.run(cmd, check=True, timeout=300, capture_output=True)

            # 원본 연결 파일 삭제
            src.unlink()

        # 빈 v3 비디오 디렉토리 정리
        v3_video_dir = root / f"videos/{vk}"
        if v3_video_dir.exists():
            shutil.rmtree(v3_video_dir, ignore_errors=True)

    print(f"    에피소드별 mp4 분리 완료")


def _to_serializable(value):
    """numpy/pyarrow 값을 JSON 직렬화 가능한 Python 타입으로 변환합니다."""
    import numpy as np
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, (list, tuple)):
        return [_to_serializable(v) for v in value]
    if isinstance(value, dict):
        return {k: _to_serializable(v) for k, v in value.items()}
    return value


def _convert_episodes_to_jsonl(root: Path, episodes: list[dict]) -> None:
    """meta/episodes/ (parquet) → meta/episodes.jsonl 변환."""
    print("  episodes.jsonl 생성 중...")

    episodes_path = root / "meta" / "episodes.jsonl"
    stats_path = root / "meta" / "episodes_stats.jsonl"

    with open(episodes_path, "w", encoding="utf-8") as ep_f, \
         open(stats_path, "w", encoding="utf-8") as stats_f:
        for ep in sorted(episodes, key=lambda r: int(r["episode_index"])):
            # episodes.jsonl: 기본 메타데이터만
            legacy = {}
            for k, v in ep.items():
                if k.startswith(("data/", "videos/", "stats/", "meta/")):
                    continue
                if k in ("dataset_from_index", "dataset_to_index"):
                    continue
                legacy[k] = _to_serializable(v)

            if "length" not in legacy:
                if "dataset_from_index" in ep and "dataset_to_index" in ep:
                    legacy["length"] = int(ep["dataset_to_index"]) - int(ep["dataset_from_index"])

            ep_f.write(json.dumps(legacy, ensure_ascii=False) + "\n")

            # episodes_stats.jsonl: 에피소드별 통계
            stats_flat = {k: _to_serializable(ep[k]) for k in ep if k.startswith("stats/")}
            if stats_flat:
                stats_nested = _unflatten_dict(stats_flat).get("stats", {})
                stats_f.write(json.dumps({
                    "episode_index": int(ep["episode_index"]),
                    "stats": stats_nested,
                }, ensure_ascii=False) + "\n")

    # v3 episodes 디렉토리 삭제
    episodes_dir = root / "meta" / "episodes"
    if episodes_dir.exists():
        shutil.rmtree(episodes_dir)

    print(f"    episodes.jsonl ({len(episodes)}개), episodes_stats.jsonl 생성 완료")


def _unflatten_dict(flat: dict) -> dict:
    """'stats/action/min' 같은 플랫 키를 중첩 딕셔너리로 변환합니다."""
    result = {}
    for key, value in flat.items():
        parts = key.split("/")
        d = result
        for part in parts[:-1]:
            d = d.setdefault(part, {})
        d[parts[-1]] = value
    return result


def _convert_tasks_to_jsonl(root: Path) -> None:
    """meta/tasks.parquet → meta/tasks.jsonl 변환.

    tasks.parquet이 없으면 기본 tasks.jsonl을 생성합니다.
    GR00T의 LeRobotEpisodeLoader는 tasks.jsonl을 무조건 요구합니다.
    """
    tasks_jsonl = root / "meta" / "tasks.jsonl"
    tasks_pq = root / "meta" / "tasks.parquet"

    if tasks_pq.exists():
        print("  tasks.parquet → tasks.jsonl 변환 중...")
        table = pq.read_table(tasks_pq)
        df = table.to_pandas()

        with open(tasks_jsonl, "w", encoding="utf-8") as f:
            for task_desc, row in df.iterrows():
                f.write(json.dumps({
                    "task_index": int(row["task_index"]),
                    "task": str(task_desc),
                }, ensure_ascii=False) + "\n")

        tasks_pq.unlink()
        print(f"    tasks.jsonl 변환 완료")
    elif not tasks_jsonl.exists():
        print("  tasks.parquet/tasks.jsonl 없음 → 기본 tasks.jsonl 생성...")
        _ensure_tasks_jsonl(root)
        print(f"    기본 tasks.jsonl 생성 완료")


def _update_info_json(root: Path, info: dict, episodes: list[dict], video_keys: list[str]) -> None:
    """info.json을 v2.1 스키마로 업데이트합니다."""
    print("  info.json 업데이트 중...")

    total_episodes = info.get("total_episodes", len(episodes))
    chunks_size = info.get("chunks_size", CHUNKS_SIZE_DEFAULT)

    info["codebase_version"] = "v2.1"
    info["data_path"] = "data/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.parquet"

    if video_keys:
        info["video_path"] = "videos/chunk-{episode_chunk:03d}/{video_key}/episode_{episode_index:06d}.mp4"
    else:
        info["video_path"] = None

    # v3 전용 필드 제거
    info.pop("data_files_size_in_mb", None)
    info.pop("video_files_size_in_mb", None)

    # video feature에서 중복 fps 제거
    for key, ft in info.get("features", {}).items():
        if ft.get("dtype") != "video":
            ft.pop("fps", None)

    info["total_chunks"] = math.ceil(total_episodes / chunks_size) if total_episodes > 0 else 0
    info["total_videos"] = total_episodes * len(video_keys)

    with open(root / "meta" / "info.json", "w", encoding="utf-8") as f:
        json.dump(info, f, indent=4, ensure_ascii=False)

    print(f"    codebase_version: v2.1")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="LeRobot v3 → v2 변환기")
    parser.add_argument("dataset_path", help="변환할 데이터셋 경로")
    args = parser.parse_args()

    convert_v3_to_v2(args.dataset_path)
