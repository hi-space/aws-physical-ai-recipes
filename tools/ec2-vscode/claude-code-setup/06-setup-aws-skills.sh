#!/bin/bash
###############################################################################
# Claude Code - AWS Skills 설치 스크립트
#
# aws-skills-for-claude-code 리포지토리에서 36개 AWS 스킬을
# ~/.claude/skills/ 에 설치합니다.
# macOS / Linux 공용
###############################################################################

set -euo pipefail

# ANSI 색상 코드
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[ OK ]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
fail()  { echo -e "${RED}[FAIL]${NC} $*"; exit 1; }

REPO_URL="https://github.com/whchoi98/aws-skills-for-claude-code.git"
CLONE_DIR="${HOME}/.claude/aws-skills-for-claude-code"
SKILLS_TARGET="${HOME}/.claude/skills"

###############################################################################
# 1. 사전 요구사항 확인
###############################################################################
info "=== AWS Skills 설치 ==="

# git 확인
if command -v git >/dev/null 2>&1; then
    ok "git: $(git --version)"
else
    fail "git이 설치되어 있지 않습니다."
fi

# claude CLI 확인
if command -v claude >/dev/null 2>&1; then
    ok "claude CLI: $(claude --version 2>&1 | head -1)"
else
    warn "claude CLI가 설치되어 있지 않습니다. 스킬 설치는 진행하지만 사용하려면 Claude Code가 필요합니다."
fi

echo ""

###############################################################################
# 2. 리포지토리 클론 또는 업데이트
###############################################################################
info "=== 리포지토리 준비 ==="

if [ -d "${CLONE_DIR}/.git" ]; then
    info "기존 리포지토리 업데이트 중..."
    git -C "${CLONE_DIR}" pull --ff-only 2>&1 && ok "리포지토리 업데이트 완료" || warn "업데이트 실패, 기존 버전으로 진행"
else
    if [ -d "${CLONE_DIR}" ]; then
        info "기존 디렉토리 제거 후 재클론..."
        rm -rf "${CLONE_DIR}"
    fi
    info "리포지토리 클론 중..."
    git clone "${REPO_URL}" "${CLONE_DIR}" 2>&1 && ok "클론 완료" || fail "리포지토리 클론 실패"
fi

echo ""

###############################################################################
# 3. 스킬 설치
###############################################################################
info "=== 스킬 설치 ==="

KIRO_SKILLS_DIR="${CLONE_DIR}/.kiro/skills"

if [ ! -d "${KIRO_SKILLS_DIR}" ]; then
    fail "스킬 소스 디렉토리를 찾을 수 없습니다: ${KIRO_SKILLS_DIR}"
fi

mkdir -p "${SKILLS_TARGET}"

installed=0
skipped=0

for skill_dir in "${KIRO_SKILLS_DIR}"/*/; do
    skill_name="$(basename "${skill_dir}")"
    skill_file="${skill_dir}SKILL.md"

    if [ ! -f "${skill_file}" ]; then
        warn "${skill_name} (SKILL.md 없음)"
        skipped=$((skipped + 1))
        continue
    fi

    target_dir="${SKILLS_TARGET}/${skill_name}"
    mkdir -p "${target_dir}"
    cp "${skill_file}" "${target_dir}/SKILL.md"
    ok "${skill_name}"
    installed=$((installed + 1))
done

echo ""

###############################################################################
# 4. 결과 요약
###############################################################################
info "=== 설치 결과 ==="
echo ""
echo "  설치 완료: ${installed}개 스킬"
echo "  건너뜀:    ${skipped}개"
echo "  설치 경로: ${SKILLS_TARGET}"
echo ""
echo "  사용법:"
echo "    /aws-cloudwatch     — 수동으로 스킬 호출"
echo "    /stripe             — Stripe 결제 연동"
echo "    /terraform          — Terraform IaC"
echo "    키워드 언급 시 자동 활성화됩니다."
echo ""
ok "AWS Skills 설치가 완료되었습니다!"
