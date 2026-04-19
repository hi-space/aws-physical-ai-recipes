#!/bin/bash
# =============================================================================
# distributed_run.bash - 분산 학습 실행 스크립트
# =============================================================================
# AWS Batch에서 Isaac Lab 분산 강화학습을 실행하기 위한 스크립트.
# 사용자가 직접 수정하여 학습 파라미터를 조정할 수 있다.
#
# 사용법:
#   ./distributed_run.bash [학습 스크립트 경로] [추가 인자...]
# =============================================================================

echo "===== [$(date)] START: distributed_run.bash ====="

# EFS 마운트 확인
if [ ! -d "/home/ubuntu/environment/efs" ]; then
  echo "경고: EFS 마운트 디렉토리가 존재하지 않습니다."
fi

# 학습 스크립트 실행
if [ -n "$1" ]; then
  echo "학습 스크립트 실행: $@"
  exec "$@"
else
  echo "사용법: ./distributed_run.bash [학습 스크립트 경로] [추가 인자...]"
  exit 1
fi

echo "===== [$(date)] END: distributed_run.bash ====="
