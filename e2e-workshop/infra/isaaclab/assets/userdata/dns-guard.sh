#!/bin/bash
# =============================================================================
# dns-guard.sh - DNS 붕괴 감지 및 복구 게이트
# =============================================================================
# ubuntu-desktop(GNOME) 설치가 network-manager를 끌어오면서 systemd-networkd/
# systemd-resolved가 재시작되고 DNS 해석이 재부팅 전까지 죽는 현상이 실측됨
# (2026-09-02 서울 배포 2회 재현: docker pull/apt/cfn-bootstrap 전멸 →
# cfn-signal 미전송 → 스택 행. networkd/resolved 재시작만으로는 복구 안 됨).
#
# 복구 전략 (2단):
#  1) systemd-networkd/resolved 재시작 후 최대 60초 대기
#  2) 그래도 안 되면 /etc/resolv.conf(stub 심링크)를 링크-로컬
#     AmazonProvidedDNS(169.254.169.253)를 가리키는 정적 파일로 교체.
#     이 주소는 모든 VPC에서 동작하며 systemd-resolved를 완전히 우회한다.
#     (resolved는 심링크가 아닌 /etc/resolv.conf를 덮어쓰지 않으므로 유지됨)
# =============================================================================
_dns_ok() { getent hosts sts.amazonaws.com >/dev/null 2>&1; }

if ! _dns_ok; then
  echo "[WARN] [$(date)] dns-guard: DNS broken - restarting systemd-networkd/systemd-resolved..."
  systemctl restart systemd-networkd systemd-resolved 2>/dev/null || true
  for _dns_i in $(seq 1 12); do
    _dns_ok && { echo "[$(date)] dns-guard: DNS recovered after restart (attempt ${_dns_i})"; break; }
    sleep 5
  done
fi

if ! _dns_ok; then
  echo "[WARN] [$(date)] dns-guard: restart did not recover DNS - switching /etc/resolv.conf to AmazonProvidedDNS (169.254.169.253)"
  rm -f /etc/resolv.conf
  printf 'nameserver 169.254.169.253\noptions timeout:2 attempts:3\n' > /etc/resolv.conf
  sleep 3
  if _dns_ok; then
    echo "[$(date)] dns-guard: DNS recovered via static resolv.conf"
  else
    echo "[WARN] [$(date)] dns-guard: DNS still broken - continuing anyway"
  fi
fi
