#Requires -Version 5.1
<#
IsaacLab EC2 SSH 클라이언트 설정 스크립트 (Windows PowerShell)
- SSH 키 생성 (없으면)
- ~/.ssh/config 에 isaaclab 호스트 추가
- 공개키 출력 (EC2 인스턴스에 등록용)
#>

param(
    [Parameter(Position = 0)]
    [string]$PublicIP
)

$ErrorActionPreference = "Stop"

$SSH_DIR = Join-Path $env:USERPROFILE ".ssh"
$KEY_FILE = Join-Path $SSH_DIR "id_ed25519"
$CONFIG_FILE = Join-Path $SSH_DIR "config"
$HOST_ALIAS = "isaaclab"

# --- 1. PUBLIC_IP 입력 받기 ---
if (-not $PublicIP) {
    $PublicIP = Read-Host "EC2 인스턴스 Public IP를 입력하세요"
}

if (-not $PublicIP) {
    Write-Error "ERROR: Public IP가 필요합니다."
    exit 1
}

# --- 2. ~/.ssh 디렉토리 확인 ---
if (-not (Test-Path $SSH_DIR)) {
    New-Item -ItemType Directory -Path $SSH_DIR -Force | Out-Null
    Write-Host "[OK] $SSH_DIR 디렉토리 생성"
}

# --- 3. SSH 키 생성 (없는 경우만) ---
if (Test-Path $KEY_FILE) {
    Write-Host "[SKIP] SSH 키가 이미 존재합니다: $KEY_FILE"
} else {
    ssh-keygen -t ed25519 -f $KEY_FILE -N '""'
    Write-Host "[OK] SSH 키 생성 완료: $KEY_FILE"
}

# --- 4. ~/.ssh/config 에 호스트 추가 ---
$hostEntry = @"

Host $HOST_ALIAS
    HostName $PublicIP
    User ubuntu
    IdentityFile $KEY_FILE
"@

if (Test-Path $CONFIG_FILE) {
    $content = Get-Content $CONFIG_FILE -Raw
    if ($content -match "(?m)^Host $HOST_ALIAS\s*$") {
        $content = $content -replace "(?m)(Host $HOST_ALIAS\s*\r?\n\s*HostName\s+)\S+", "`${1}$PublicIP"
        Set-Content -Path $CONFIG_FILE -Value $content -NoNewline
        Write-Host "[UPDATE] ~/.ssh/config 의 ${HOST_ALIAS} HostName을 ${PublicIP}로 업데이트"
    } else {
        Add-Content -Path $CONFIG_FILE -Value $hostEntry
        Write-Host "[OK] ~/.ssh/config 에 ${HOST_ALIAS} 호스트 추가 완료"
    }
} else {
    Set-Content -Path $CONFIG_FILE -Value $hostEntry.TrimStart()
    Write-Host "[OK] ~/.ssh/config 에 ${HOST_ALIAS} 호스트 추가 완료"
}

# --- 5. 공개키 출력 ---
$pubKey = Get-Content "$KEY_FILE.pub"

Write-Host ""
Write-Host "============================================"
Write-Host "  설정 완료! 아래 공개키를 EC2에 등록하세요"
Write-Host "============================================"
Write-Host ""
Write-Host $pubKey
Write-Host ""
Write-Host "--------------------------------------------"
Write-Host "EC2 Instance Connect 브라우저 터미널에서 실행:"
Write-Host ""
Write-Host "  echo `"$pubKey`" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
Write-Host ""
Write-Host "등록 후 접속:"
Write-Host "  ssh ${HOST_ALIAS}"
Write-Host "--------------------------------------------"
