#!/bin/bash
# HyperPod EKS 노드 lifecycle 스크립트 (OnCreate).
#
# EKS 오케스트레이션에서는 kubelet 조인, GPU device plugin, health-monitoring agent가
# HyperPod와 HyperPodHelmChart(infra/eks) 쪽에서 처리되고, FSx는 FSx CSI 드라이버가 파드에
# 직접 마운트한다. 그래서 Slurm 경로의 on_create.sh(FSx 마운트·Slurm·DCV·드라이버 설치)와 달리
# 여기서는 진단 로그만 남긴다.
#
# Isaac Sim RTX 렌더러가 AMI 기본 드라이버에서 죽는 경우 setup_nvidia_driver.sh 호출을 이 자리에
# 추가한다(Slurm 경로 on_create.sh 참고). 헤드리스 RL 학습(모듈 9)은 렌더러를 쓰지 않는다.
set -u

LOG=/var/log/provision/provisioning.log
mkdir -p "$(dirname "$LOG")"
{
  echo "[on_create_eks] $(date -u +%FT%TZ) start on $(hostname)"
  if command -v nvidia-smi >/dev/null 2>&1; then
    nvidia-smi --query-gpu=name,driver_version --format=csv,noheader || true
  else
    echo "[on_create_eks] no NVIDIA GPU on this node"
  fi
  echo "[on_create_eks] done"
} >> "$LOG" 2>&1

exit 0
