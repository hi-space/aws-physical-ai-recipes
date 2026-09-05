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

# head/compute 판별 (1차 추정). SAGEMAKER_INSTANCE_GROUP_NAME 은 watcher 시점에 비어
# 있을 수 있고(실측: head/compute 모두 group=unknown), resource_config.json 의
# SlurmConfig.PrimaryControllerIp 는 SageMaker 쪽 네트워크 주소(172.16.x.x)라 로컬 IP 와
# 일치하지 않으며 InstanceGroups[].Instances 도 null 이다. 그래서 여기서는 그룹 env 만 보고,
# 최종 판별은 아래 Slurm 루프에서 HyperPod 가 써 준 slurm.conf 의 SlurmctldHost 로 한다
# (_detect_daemon). 이 판별이 틀리면 head 에서 slurmd 만 기다리다 slurmctld 를 아무도
# 시작하지 않아 클러스터는 InService 인데 sinfo 가 "Unable to contact slurm controller" 가 된다.
GROUP_NAME="${SAGEMAKER_INSTANCE_GROUP_NAME:-}"
IS_HEAD=false
[ "$GROUP_NAME" = "head" ] && IS_HEAD=true
if [ "$IS_HEAD" = true ]; then
  SLURM_DAEMON=slurmctld
else
  SLURM_DAEMON=slurmd
fi

# slurm.conf 의 SlurmctldHost=<host>(<ip>) 가 이 노드의 호스트명/IP 와 같으면 head.
_detect_daemon() {
  local conf=/opt/slurm/etc/slurm.conf ctl_host ctl_ip
  [ -f "$conf" ] || return 1
  ctl_host=$(grep -oP '^SlurmctldHost=\K[^(\s]+' "$conf" 2>/dev/null | head -1 || true)
  ctl_ip=$(grep -oP '^SlurmctldHost=\S+\(\K[^)]+' "$conf" 2>/dev/null | head -1 || true)
  [ -n "$ctl_host$ctl_ip" ] || return 1
  if { [ -n "$ctl_ip" ] && hostname -I | tr ' ' '\n' | grep -qx "$ctl_ip"; } \
     || { [ -n "$ctl_host" ] && [ "$ctl_host" = "$(hostname -s)" ]; }; then
    SLURM_DAEMON=slurmctld
  else
    SLURM_DAEMON=slurmd
  fi
  return 0
}

echo "[watcher] start: group=${GROUP_NAME:-unknown} head=${IS_HEAD} daemon(initial)=${SLURM_DAEMON}"

# --- 1) FSx 마운트 재시도 (최대 30분) ---------------------------------------
# lifecycle 스크립트는 별도 마운트 네임스페이스에서 돌기 때문에 이 셸의
# mountpoint 는 호스트 상태가 아니다. 반드시 PID 1 의 네임스페이스에서 확인한다
# (setup_fsx.sh 도 같은 네임스페이스에 마운트한다).
_fsx_ok() {
  if [ "$(readlink /proc/1/ns/mnt 2>/dev/null)" != "$(readlink /proc/self/ns/mnt 2>/dev/null)" ] \
     && command -v nsenter >/dev/null 2>&1; then
    nsenter -t 1 -m -- mountpoint -q /fsx
  else
    mountpoint -q /fsx
  fi
}
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
  if [ -f /opt/slurm/etc/slurm.conf ] && _detect_daemon && [ -f "/opt/slurm/sbin/${SLURM_DAEMON}" ]; then
    echo "[watcher] slurm.conf present → daemon=${SLURM_DAEMON}"
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
