# IsaacLab EC2 인스턴스 SSH 접속 가이드

## 인스턴스 정보

관리자에게 아래 정보를 전달받으세요.

| 항목 | 값 |
|------|-----|
| Instance ID | `<INSTANCE_ID>` |
| Region | `<REGION>` |
| Public IP | `<PUBLIC_IP>` |
| OS | Ubuntu 22.04 |
| Instance Type | g6.12xlarge |
| 접속 유저 | `ubuntu` |

---

## 사전 준비

### SSH 키 생성 (키가 없는 경우)

```bash
# [로컬]
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""
```

---

## SSH Config 설정

로컬 PC의 `~/.ssh/config` 파일에 아래 내용을 추가합니다. `<PUBLIC_IP>`를 전달받은 IP로 교체하세요.

```
# [로컬] ~/.ssh/config 에 추가
Host isaaclab
    HostName <PUBLIC_IP>
    User ubuntu
    IdentityFile ~/.ssh/id_ed25519
```

---

## 최초 접속 (공개키 등록)

### Step 1

로컬 공개키 내용을 확인합니다.

```bash
# [로컬]
cat ~/.ssh/id_ed25519.pub
```

### Step 2

AWS 콘솔에서 EC2 Instance Connect로 인스턴스에 접속한 뒤, 출력된 공개키를 등록합니다.

1. AWS 콘솔 > EC2 > 인스턴스 선택 > **연결** > **EC2 Instance Connect** 탭 > **연결**
2. 브라우저 터미널이 열리면 아래 명령 실행:

```bash
# [EC2 인스턴스] — 브라우저 터미널에서 실행
echo "전달받은_공개키_내용" >> /home/ubuntu/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
```

---

## 이후 접속

공개키가 영구 등록된 후에는 아래 명령으로 바로 접속할 수 있습니다:

```bash
# [로컬]
ssh isaaclab
```

---

## 트러블슈팅

| 증상 | 원인 및 해결 |
|------|-------------|
| `Permission denied (publickey)` | 인스턴스에 공개키가 등록되지 않음. "최초 접속" 섹션을 따라 키 등록 필요 |
| `Connection timed out` | 보안 그룹에서 22번 포트가 열려 있는지 확인. 인스턴스가 실행 중인지 확인 |
| `send-ssh-public-key` 실패 (방법 A) | IAM 권한에 `ec2-instance-connect:SendSSHPublicKey` 액션이 허용되어 있는지 확인 |
| ProxyCommand 관련 오류 (SSM 방식) | Session Manager Plugin 설치 여부 확인: `session-manager-plugin --version` |
