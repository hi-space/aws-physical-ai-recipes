# SSH Access Guide for the IsaacLab EC2 Instance

> 한국어 문서: [README.ko.md](README.ko.md)

## Instance Information

Ask your administrator for the values below.

| Item | Value |
|------|-----|
| Instance ID | `<INSTANCE_ID>` |
| Region | `<REGION>` |
| Public IP | `<PUBLIC_IP>` |
| OS | Ubuntu 22.04 |
| Instance Type | g6.12xlarge |
| Login user | `ubuntu` |

---

## Automatic Setup (Script)

The script below handles everything from SSH key generation to registering the host in `~/.ssh/config`. Afterwards, all you need to do is run the public-key registration command it prints in the EC2 Instance Connect browser terminal.

```bash
# [Local] macOS / Linux
bash setup-ssh-client.sh <PUBLIC_IP>
```

```powershell
# [Local] Windows PowerShell
.\setup-ssh-client.ps1 <PUBLIC_IP>
```

To configure this manually instead of using the script, follow the steps below.

---

## Prerequisites (Manual Setup)

### Generate an SSH key (if you don't have one)

```bash
# [Local]
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""
```

---

## SSH Config Setup

Add the following to `~/.ssh/config` on your local PC. Replace `<PUBLIC_IP>` with the IP you were given.

```
# [Local] add to ~/.ssh/config
Host isaaclab
    HostName <PUBLIC_IP>
    User ubuntu
    IdentityFile ~/.ssh/id_ed25519
```

---

## First Connection (Public Key Registration)

### Step 1

Print your local public key.

```bash
# [Local]
cat ~/.ssh/id_ed25519.pub
```

### Step 2

Connect to the instance with EC2 Instance Connect from the AWS console, then register the public key you just printed.

1. AWS console > EC2 > select the instance > **Connect** > **EC2 Instance Connect** tab > **Connect**
2. When the browser terminal opens, run:

```bash
# [EC2 instance] — run in the browser terminal
echo "your_public_key_contents" >> /home/ubuntu/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
```

---

## Subsequent Connections

Once the public key is permanently registered, connect with:

```bash
# [Local]
ssh isaaclab
```

---

## Troubleshooting

| Symptom | Cause and fix |
|------|-------------|
| `Permission denied (publickey)` | The public key is not registered on the instance. Follow the "First Connection" section to register it |
| `Connection timed out` | Check that port 22 is open in the security group, and that the instance is running |
| `send-ssh-public-key` fails (method A) | Check that your IAM permissions allow the `ec2-instance-connect:SendSSHPublicKey` action |
| ProxyCommand errors (SSM method) | Check whether the Session Manager Plugin is installed: `session-manager-plugin --version` |
