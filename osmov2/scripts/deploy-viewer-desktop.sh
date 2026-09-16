#!/usr/bin/env bash
set -euo pipefail

# Provision a GPU desktop inside the cluster VPC for viewing an Isaac Sim WebRTC stream.
#
# WebRTC media cannot be carried over `osmo workflow port-forward` (the SDP advertises the
# pod's VPC address, which a forwarder never maps), so the client has to sit somewhere that
# routes to pod IPs. This builds that somewhere: an Ubuntu 24.04 DLAMI instance with Amazon
# DCV plus the Isaac Sim WebRTC Streaming Client, in a public subnet of the cluster VPC.
#
# Usage: DCV_ALLOWED_CIDR=<your.ip>/32 scripts/deploy-viewer-desktop.sh
#
# Idempotent: re-running reuses the security group, role, and instance it finds by tag.
# Deleting is not automatic — see `--destroy`.

# shellcheck source=./scripts/common.sh
# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

require_cmds aws jq

NAME="${DCV_DESKTOP_NAME:-aws-osmo-viewer-desktop}"
INSTANCE_TYPE="${DCV_INSTANCE_TYPE:-g6.2xlarge}"
VOLUME_SIZE="${DCV_VOLUME_SIZE:-200}"
DESKTOP_USER="${DCV_DESKTOP_USER:-ubuntu}"
# Pinned because NVIDIA publishes no "latest" alias for this .deb; a 404 must fail loudly
# rather than leave a desktop with no client on it.
ISAAC_CLIENT_VERSION="${ISAAC_CLIENT_VERSION:-2.0.0}"

if [[ "${1:-}" == "--destroy" ]]; then
  DESTROY=1
else
  DESTROY=0
fi

AWS_REGION="${AWS_REGION:-$(terraform_output aws_region)}"
VPC_ID="${DCV_VPC_ID:-$(terraform_output vpc_id)}"
NODE_SG_ID="${DCV_NODE_SG_ID:-$(terraform_output node_security_group_id)}"
export AWS_REGION

aws_ec2() { aws ec2 --region "${AWS_REGION}" "$@"; }

find_instance() {
  aws_ec2 describe-instances \
    --filters "Name=tag:Name,Values=${NAME}" \
      "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'Reservations[].Instances[0].InstanceId' --output text 2>/dev/null | tr -d '\n'
}

find_sg() {
  aws_ec2 describe-security-groups \
    --filters "Name=group-name,Values=${NAME}" "Name=vpc-id,Values=${VPC_ID}" \
    --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null | tr -d '\n'
}

if [[ "${DESTROY}" -eq 1 ]]; then
  INSTANCE_ID="$(find_instance)"
  [[ "${INSTANCE_ID}" == "None" || -z "${INSTANCE_ID}" ]] && die "no instance tagged ${NAME} to destroy"
  log "terminating ${INSTANCE_ID}"
  aws_ec2 terminate-instances --instance-ids "${INSTANCE_ID}" >/dev/null
  aws_ec2 wait instance-terminated --instance-ids "${INSTANCE_ID}"
  SG_ID="$(find_sg)"
  if [[ -n "${SG_ID}" && "${SG_ID}" != "None" ]]; then
    log "revoking node security group rules that reference ${SG_ID}"
    for spec in "tcp 49100 49100" "udp 47995 48012" "udp 49000 49007"; do
      read -r proto from to <<<"${spec}"
      aws_ec2 revoke-security-group-ingress --group-id "${NODE_SG_ID}" \
        --ip-permissions "IpProtocol=${proto},FromPort=${from},ToPort=${to},UserIdGroupPairs=[{GroupId=${SG_ID}}]" \
        >/dev/null 2>&1 || true
    done
    log "deleting security group ${SG_ID}"
    aws_ec2 delete-security-group --group-id "${SG_ID}" >/dev/null
  fi
  log "destroyed. The IAM role ${NAME} is left in place for reuse."
  exit 0
fi

ALLOWED_CIDR="${DCV_ALLOWED_CIDR:-}"
[[ -n "${ALLOWED_CIDR}" ]] || die "set DCV_ALLOWED_CIDR to the CIDR allowed to reach DCV on 8443, e.g. DCV_ALLOWED_CIDR=\$(curl -s https://checkip.amazonaws.com)/32"
[[ "${ALLOWED_CIDR}" != "0.0.0.0/0" ]] || die "refusing to open DCV to 0.0.0.0/0; DCV authenticates with the desktop user's OS password"

DESKTOP_PASSWORD="${DCV_DESKTOP_PASSWORD:-}"
[[ -n "${DESKTOP_PASSWORD}" ]] || die "set DCV_DESKTOP_PASSWORD; DCV authenticates against the ${DESKTOP_USER} account's OS password, so the account needs one"

EXISTING="$(find_instance)"
if [[ -n "${EXISTING}" && "${EXISTING}" != "None" ]]; then
  log "instance already exists: ${EXISTING}"
  aws_ec2 describe-instances --instance-ids "${EXISTING}" \
    --query 'Reservations[].Instances[].{State:State.Name,PublicIp:PublicIpAddress,PrivateIp:PrivateIpAddress}' \
    --output table
  die "refusing to create a second desktop; run with --destroy first, or set DCV_DESKTOP_NAME"
fi

# A public subnet is needed for the public IP. The VPC's public subnets do not auto-assign
# one, so the network interface asks for it explicitly. Every public subnet is a launch
# candidate: InsufficientInstanceCapacity is per-AZ, so pinning one AZ turns a transient
# shortage into a hard failure.
if [[ -n "${DCV_SUBNET_ID:-}" ]]; then
  SUBNETS=("${DCV_SUBNET_ID}")
else
  mapfile -t SUBNETS < <(aws_ec2 describe-subnets \
    --filters "Name=vpc-id,Values=${VPC_ID}" "Name=tag:Name,Values=*public*" \
    --query 'sort_by(Subnets,&AvailabilityZone)[].SubnetId' --output text | tr '\t' '\n')
  [[ "${#SUBNETS[@]}" -gt 0 ]] || die "no subnet tagged *public* in ${VPC_ID}; set DCV_SUBNET_ID"
fi
log "launch candidates: ${SUBNETS[*]}"

AMI_ID="${DCV_AMI_ID:-}"
if [[ -z "${AMI_ID}" ]]; then
  AMI_ID="$(aws_ec2 describe-images --owners amazon \
    --filters "Name=name,Values=Deep Learning OSS Nvidia Driver AMI GPU PyTorch*(Ubuntu 24.04)*" \
      "Name=state,Values=available" \
    --query 'reverse(sort_by(Images,&CreationDate))[0].ImageId' --output text)"
  [[ -n "${AMI_ID}" && "${AMI_ID}" != "None" ]] || die "no Ubuntu 24.04 DLAMI found in ${AWS_REGION}; set DCV_AMI_ID"
fi
log "AMI ${AMI_ID}"

SG_ID="$(find_sg)"
if [[ -z "${SG_ID}" || "${SG_ID}" == "None" ]]; then
  log "creating security group ${NAME}"
  SG_ID="$(aws_ec2 create-security-group --group-name "${NAME}" --vpc-id "${VPC_ID}" \
    --description "Amazon DCV desktop for viewing Isaac Sim WebRTC streams" \
    --query 'GroupId' --output text)"
fi
log "security group ${SG_ID}"

# DCV serves both TCP and QUIC/UDP on 8443; without the UDP rule it silently falls back
# to WebSocket, which is noticeably worse for an interactive 3D session.
for proto in tcp udp; do
  aws_ec2 authorize-security-group-ingress --group-id "${SG_ID}" \
    --ip-permissions "IpProtocol=${proto},FromPort=8443,ToPort=8443,IpRanges=[{CidrIp=${ALLOWED_CIDR},Description=DCV client}]" \
    >/dev/null 2>&1 || log "ingress ${proto}/8443 from ${ALLOWED_CIDR} already present"
done

# The desktop must reach the workload pod, so the node security group has to admit it.
# 49100 is signalling; the UDP ranges are Isaac Sim's media ports. 5.1.0 can be narrowed
# to a single port with fixedHostPort, but the ranges cover 4.5.0 too.
log "allowing ${SG_ID} into node security group ${NODE_SG_ID}"
for spec in "tcp 49100 49100 isaac-sim-signalling" "udp 47995 48012 isaac-sim-app-streaming" "udp 49000 49007 isaac-sim-video"; do
  read -r proto from to desc <<<"${spec}"
  aws_ec2 authorize-security-group-ingress --group-id "${NODE_SG_ID}" \
    --ip-permissions "IpProtocol=${proto},FromPort=${from},ToPort=${to},UserIdGroupPairs=[{GroupId=${SG_ID},Description=${desc}}]" \
    >/dev/null 2>&1 || log "node ingress ${proto}/${from}-${to} already present"
done

# On EC2, DCV needs no license server but does validate against a regional S3 bucket.
if ! aws iam get-role --role-name "${NAME}" >/dev/null 2>&1; then
  log "creating IAM role ${NAME}"
  aws iam create-role --role-name "${NAME}" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
    >/dev/null
  aws iam attach-role-policy --role-name "${NAME}" \
    --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore >/dev/null
  aws iam put-role-policy --role-name "${NAME}" --policy-name dcv-license \
    --policy-document "$(jq -nc --arg arn "arn:aws:s3:::dcv-license.${AWS_REGION}/*" \
      '{Version:"2012-10-17",Statement:[{Effect:"Allow",Action:"s3:GetObject",Resource:$arn}]}')" \
    >/dev/null
fi
if ! aws iam get-instance-profile --instance-profile-name "${NAME}" >/dev/null 2>&1; then
  aws iam create-instance-profile --instance-profile-name "${NAME}" >/dev/null
  aws iam add-role-to-instance-profile --instance-profile-name "${NAME}" --role-name "${NAME}" >/dev/null
  log "waiting for instance profile to propagate"
  sleep 15
fi

USER_DATA="$(mktemp)"
trap 'rm -f "${USER_DATA}"' EXIT
chmod 600 "${USER_DATA}"

cat >"${USER_DATA}" <<USERDATA
#!/usr/bin/env bash
set -euxo pipefail
exec > >(tee -a /var/log/viewer-desktop-setup.log) 2>&1

DESKTOP_USER='${DESKTOP_USER}'
DESKTOP_PASSWORD='${DESKTOP_PASSWORD}'
ISAAC_CLIENT_VERSION='${ISAAC_CLIENT_VERSION}'

export DEBIAN_FRONTEND=noninteractive

# The DLAMI runs its own apt work at boot (unattended-upgrades, apt-daily), and user-data
# starts while that still holds the dpkg locks. Without this wait the first apt-get exits
# non-zero and \`set -e\` kills the whole provisioning run.
apt_wait() {
  for _ in \$(seq 1 60); do
    fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock >/dev/null 2>&1 || return 0
    sleep 10
  done
  echo "apt locks still held after 10 minutes" >&2
  return 1
}
apt_get() { apt_wait; apt-get "\$@"; }

apt_get update
apt_get install -y ubuntu-desktop gdm3 pulseaudio curl gnupg

# DCV does not support Wayland.
mkdir -p /etc/gdm3
if grep -q '^\s*#\?WaylandEnable' /etc/gdm3/custom.conf 2>/dev/null; then
  sed -i 's/^\s*#\?WaylandEnable.*/WaylandEnable=false/' /etc/gdm3/custom.conf
else
  printf '[daemon]\nWaylandEnable=false\n' >>/etc/gdm3/custom.conf
fi

# The DLAMI ships the NVIDIA driver, so the GPU X path is used rather than an Xdummy
# device. Without an xorg.conf the X server does not claim the GPU.
rm -f /etc/X11/XF86Config /etc/X11/XF86Config-4
nvidia-xconfig --preserve-busid --enable-all-gpus
systemctl set-default graphical.target

# This alias always points at the newest DCV release, so there is no version to pin.
cd /tmp
curl -fsSL -O https://d1uj6qtbmh3dt5.cloudfront.net/NICE-GPG-KEY
gpg --import NICE-GPG-KEY
curl -fsSL -O https://d1uj6qtbmh3dt5.cloudfront.net/nice-dcv-ubuntu2404-x86_64.tgz
tar -xzf nice-dcv-ubuntu2404-x86_64.tgz
cd nice-dcv-*-ubuntu2404-x86_64
apt_get install -y ./nice-dcv-server_*.deb ./nice-dcv-web-viewer_*.deb ./nice-xdcv_*.deb ./nice-dcv-gl_*.deb
usermod -aG video dcv

printf '%s:%s\n' "\${DESKTOP_USER}" "\${DESKTOP_PASSWORD}" | chpasswd

# DCV authenticates against the OS account, and only console sessions can be auto-created;
# there is no supported flag for auto-creating a virtual session.
mkdir -p /etc/dcv
cat >/etc/dcv/dcv.conf <<CONF
[session-management]
create-session = true
[session-management/automatic-console-session]
owner="\${DESKTOP_USER}"
[connectivity]
enable-quic-frontend=true
CONF

# Fetch the Isaac Sim client before declaring success, so a 404 surfaces here.
CLIENT_DEB="isaacsim-webrtc-streaming-client-\${ISAAC_CLIENT_VERSION}-linux-x86_64.deb"
curl -fsSL -o "/tmp/\${CLIENT_DEB}" \
  "https://downloads.isaacsim.nvidia.com/\${CLIENT_DEB}"
apt_get install -y "/tmp/\${CLIENT_DEB}"

# Ubuntu 24.04 restricts unprivileged user namespaces, which the client's Electron
# sandbox needs.
cat >/etc/sysctl.d/99-electron-sandbox.conf <<SYSCTL
kernel.apparmor_restrict_unprivileged_userns=0
SYSCTL
sysctl --system

# The screen lock blanks the console session while the streaming client keeps running behind
# it, which looks exactly like a dead stream. Applied via dconf rather than gsettings so it
# lands before the user session exists.
mkdir -p /etc/dconf/profile /etc/dconf/db/local.d
printf 'user-db:user\nsystem-db:local\n' >/etc/dconf/profile/user
cat >/etc/dconf/db/local.d/00-no-screen-lock <<DCONF
[org/gnome/desktop/screensaver]
lock-enabled=false
idle-activation-enabled=false

[org/gnome/desktop/session]
idle-delay=uint32 0
DCONF
dconf update

systemctl enable --now dcvserver
systemctl restart gdm3

touch /var/log/viewer-desktop-setup.done
USERDATA

INSTANCE_ID=""
for SUBNET_ID in "${SUBNETS[@]}"; do
  log "launching ${INSTANCE_TYPE} in ${SUBNET_ID}"
  if INSTANCE_ID="$(aws_ec2 run-instances \
    --image-id "${AMI_ID}" \
    --instance-type "${INSTANCE_TYPE}" \
    --iam-instance-profile "Name=${NAME}" \
    --network-interfaces "AssociatePublicIpAddress=true,DeviceIndex=0,SubnetId=${SUBNET_ID},Groups=${SG_ID}" \
    --block-device-mappings "DeviceName=/dev/sda1,Ebs={VolumeSize=${VOLUME_SIZE},VolumeType=gp3,DeleteOnTermination=true,Encrypted=true}" \
    --metadata-options "HttpTokens=required" \
    --user-data "fileb://${USER_DATA}" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=${NAME}},{Key=app.kubernetes.io/part-of,Value=aws-osmo-reference}]" \
    --query 'Instances[0].InstanceId' --output text 2>/dev/null)"; then
    break
  fi
  INSTANCE_ID=""
  log "no ${INSTANCE_TYPE} capacity in ${SUBNET_ID}; trying the next subnet"
done

[[ -n "${INSTANCE_ID}" ]] || die "no ${INSTANCE_TYPE} capacity in any public subnet of ${VPC_ID}. Try another size with DCV_INSTANCE_TYPE (a viewing desktop does not need a large GPU) or retry later — InsufficientInstanceCapacity is transient."
log "instance ${INSTANCE_ID}"

aws_ec2 wait instance-running --instance-ids "${INSTANCE_ID}"
PUBLIC_IP="$(aws_ec2 describe-instances --instance-ids "${INSTANCE_ID}" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)"

log "running at ${PUBLIC_IP}"
cat >&2 <<SUMMARY

The desktop is up but still installing. Setup writes
/var/log/viewer-desktop-setup.log and touches /var/log/viewer-desktop-setup.done when
finished; it pulls a desktop environment and two GPU packages, so allow 10-15 minutes.

  Follow along:  aws ssm start-session --region ${AWS_REGION} --target ${INSTANCE_ID}
                 sudo tail -f /var/log/viewer-desktop-setup.log

  Then connect:  https://${PUBLIC_IP}:8443
                 user ${DESKTOP_USER}, the password passed in DCV_DESKTOP_PASSWORD
                 (the certificate is self-signed, so the browser will warn)

Inside the desktop, resolve the workflow to a pod IP and point the client at it:

  scripts/get-workflow-pod-ip.sh <workflow-id>

Billing does not stop when the stream does. Terminate with:

  ${0##*/} --destroy

SUMMARY
