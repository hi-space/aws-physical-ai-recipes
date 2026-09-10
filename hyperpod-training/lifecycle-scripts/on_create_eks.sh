#!/bin/bash
# HyperPod EKS 노드 lifecycle 스크립트 (OnCreate).
#
# EKS 오케스트레이션에서는 kubelet 조인, GPU device plugin, health-monitoring agent가
# HyperPod와 HyperPodHelmChart(infra/eks) 쪽에서 처리되고, FSx는 FSx CSI 드라이버가 파드에
# 직접 마운트한다. 그래서 Slurm 경로의 on_create.sh(FSx 마운트·Slurm 설치)와 달리 CPU 노드에서는
# 진단 로그만 남긴다.
#
# GPU 노드(gpu-g5-8x)에서는 두 단계를 추가로 수행한다 (모듈 10 §10.7 방법 B: HyperPod GPU 노드의
# DCV 데스크톱에서 Isaac Sim 재생).
#   1. setup_nvidia_driver.sh — AMI 드라이버(595.x)에서는 Isaac Sim RTX 렌더러가 segfault 로 죽으므로
#      580.173.02 로 교체한다. 헤드리스 RL 학습(모듈 9)은 렌더러를 쓰지 않아 어느 드라이버에서도 돈다.
#   2. setup_dcv_al2023.sh — GNOME 데스크톱 + Amazon DCV 서버 + 'workspace' 가상 세션(ec2-user/hyperpod).
#      EKS 노드 AMI 는 Amazon Linux 2023 이므로 Slurm 경로의 setup_dcv.sh(Ubuntu) 대신 dnf 판을 쓴다.
#      Docker 는 설치하지 않는다(kubelet 의 containerd 를 건드리지 않음). 재생 컨테이너는
#      Pod(k8s-templates/rl/isaaclab-play-job.yaml)로 띄우고 노드의 X 소켓을 hostPath 로 넘긴다.
# 두 단계는 실패해도 non-fatal 이며(노드는 학습용으로는 정상), 합쳐서 약 8분이 걸린다(드라이버 6분 + 데스크톱·DCV 2분; 노드 기동 전체 약 13분).
# 건너뛰려면 인스턴스 그룹 lifecycle 환경에 EKS_GPU_DCV=0 을 둔다(기본 1).
set -u

LOG=/var/log/provision/provisioning.log
mkdir -p "$(dirname "$LOG")"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
{
  echo "[on_create_eks] $(date -u +%FT%TZ) start on $(hostname)"
  if command -v nvidia-smi >/dev/null 2>&1 || lspci 2>/dev/null | grep -qi nvidia; then
    nvidia-smi --query-gpu=name,driver_version --format=csv,noheader || true
    if [ "${EKS_GPU_DCV:-1}" = "1" ]; then
      echo "[on_create_eks] GPU node: NVIDIA driver for Isaac Sim rendering"
      bash "${SCRIPT_DIR}/setup_nvidia_driver.sh" || echo "[on_create_eks] NVIDIA driver setup skipped or failed (non-fatal)."
      echo "[on_create_eks] GPU node: DCV desktop"
      bash "${SCRIPT_DIR}/setup_dcv_al2023.sh" || echo "[on_create_eks] DCV setup skipped or failed (non-fatal)."
      nvidia-smi --query-gpu=name,driver_version --format=csv,noheader || true
      systemctl is-active dcvserver auto-dcv || true
    fi
  else
    echo "[on_create_eks] no NVIDIA GPU on this node"
  fi
  echo "[on_create_eks] $(date -u +%FT%TZ) done"
} >> "$LOG" 2>&1

exit 0
