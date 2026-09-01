#!/bin/bash
# post_provision_watcher.sh — on_create.sh 가 백그라운드로 띄우는 마무리 watcher.
#
# 왜 필요한가 (실측 기반):
#  - HyperPod(Managed Slurm)는 lifecycle 스크립트(on_create.sh)를 먼저 실행하고
#    그 *뒤에* Slurm 을 설치/구성한다 (실측: on_create 21:17 → Slurm 설치 21:21+).
#    on_create 안에서 바로 systemctl start 를 하면 바이너리가 아직 없어 조용히
#    건너뛰고, 이후 아무도 데몬을 시작하지 않아 클러스터는 InService 인데
#    sinfo 가 "Unable to contact slurm controller" 로 실패한다.
#  - FSx Lustre 도 노드 기동 시점에 아직 CREATING 이면 첫 mount 가 실패한 채
#    남는다 (setup_fsx.sh 의 mount 실패는 non-fatal).
#
# 동작: (1) /fsx 가 마운트될 때까지 setup_fsx.sh 를 재시도, (2) Slurm 설치가
# 끝나면 setup_slurm.sh 를 다시 실행해 노드별 구성(gres, conf-server)을 채우고
# 데몬(head=slurmctld, 그 외=slurmd)을 enable+start 한다. 각 단계 최대 30분.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# head/compute 판별. SAGEMAKER_INSTANCE_GROUP_NAME 은 watcher 시점에 비어
# 있을 수 있다(실측: compute 노드에서 group=unknown). 그 경우 HyperPod 가
# 노드마다 심어주는 /opt/ml/config/resource_config.json 의 Slurm controller
# IP 를 로컬 IP 들과 비교해 판별한다.
GROUP_NAME="${SAGEMAKER_INSTANCE_GROUP_NAME:-}"
IS_HEAD=false
if [ "$GROUP_NAME" = "head" ]; then
  IS_HEAD=true
elif [ -z "$GROUP_NAME" ] && [ -f /opt/ml/config/resource_config.json ]; then
  CTRL_IP=$(python3 -c "import json;print((json.load(open('/opt/ml/config/resource_config.json')).get('ClusterConfig') or {}).get('SlurmConfig',{}).get('PrimaryControllerIp') or '')" 2>/dev/null || true)
  if [ -n "$CTRL_IP" ] && hostname -I | tr ' ' '\n' | grep -qx "$CTRL_IP"; then
    IS_HEAD=true
  fi
fi
if [ "$IS_HEAD" = true ]; then
  SLURM_DAEMON=slurmctld
else
  SLURM_DAEMON=slurmd
fi

echo "[watcher] start: group=${GROUP_NAME:-unknown} head=${IS_HEAD} daemon=${SLURM_DAEMON}"

# --- 1) FSx 마운트 재시도 (최대 30분) ---------------------------------------
# mount|grep 은 오탐할 수 있으므로(실측) mountpoint 로 확인한다.
_fsx_ok() { mountpoint -q /fsx; }
for i in $(seq 1 60); do
  if _fsx_ok; then
    echo "[watcher] /fsx mounted."
    break
  fi
  bash "${SCRIPT_DIR}/setup_fsx.sh" || true
  _fsx_ok && { echo "[watcher] /fsx mounted (attempt $i)."; break; }
  sleep 30
done
_fsx_ok || echo "[watcher] WARNING: /fsx still not mounted after retries."

# --- 2) Slurm 데몬 기동 (설치 완료 대기, 최대 30분) --------------------------
for i in $(seq 1 180); do
  if [ -f "/opt/slurm/sbin/${SLURM_DAEMON}" ] && [ -f /opt/slurm/etc/slurm.conf ]; then
    # 설치가 끝난 뒤에야 의미가 있는 노드별 구성(gres.conf, conf-server)을 재적용
    bash "${SCRIPT_DIR}/setup_slurm.sh" || true
    systemctl enable "${SLURM_DAEMON}" 2>/dev/null || true
    systemctl is-active --quiet "${SLURM_DAEMON}" || systemctl start "${SLURM_DAEMON}" 2>/dev/null || true
    sleep 10
    if systemctl is-active --quiet "${SLURM_DAEMON}"; then
      echo "[watcher] ${SLURM_DAEMON} active."
      exit 0
    fi
  fi
  sleep 10
done

echo "[watcher] WARNING: ${SLURM_DAEMON} did not become active within 30 min."
exit 0
