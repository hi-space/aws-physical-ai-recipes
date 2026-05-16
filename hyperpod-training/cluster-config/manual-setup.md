# SageMaker HyperPod Manual Cluster Setup Guide

This guide provides step-by-step instructions for manually creating and managing a SageMaker HyperPod cluster using AWS CLI commands.

## Prerequisites

Before starting, ensure you have the following AWS resources in place:

### 1. VPC and Networking
- An AWS VPC with subnets in your desired region
- A security group with appropriate inbound/outbound rules for:
  - SLURM communication (port 6817-6819)
  - SSH access (port 22)
  - Container registry access (port 443)
- Network connectivity between all subnets where nodes will be placed

### 2. FSx for Lustre
- Create an FSx for Lustre file system:
  ```bash
  aws fsx create-file-system \
    --file-system-type LUSTRE \
    --storage-capacity 1200 \
    --import-path s3://your-bucket/import \
    --export-path s3://your-bucket/export \
    --region us-east-1
  ```
- Record the **DNS name** and **mount name** from the created file system
- Ensure FSx security group allows NFS/Lustre traffic (ports 988, 1021-1023)

### 3. S3 Bucket for Lifecycle Scripts
- Create an S3 bucket to store lifecycle scripts:
  ```bash
  aws s3 mb s3://your-hyperpod-lifecycle-bucket --region us-east-1
  ```
- The bucket should be accessible from your VPC (via S3 gateway endpoint or public access)

### 4. IAM Permissions
- Ensure your AWS credentials have permissions for:
  - `sagemaker:CreateCluster`
  - `sagemaker:DescribeCluster`
  - `sagemaker:DeleteCluster`
  - `sagemaker:ListClusters`
  - `ec2:DescribeSecurityGroups`
  - `ec2:DescribeSubnets`
  - `fsx:DescribeFileSystems`
  - `s3:ListBucket`
  - `s3:GetObject`

## Step 1: Upload Lifecycle Scripts to S3

Upload all lifecycle scripts from the `lifecycle-scripts/` directory to your S3 bucket:

```bash
# Set your bucket name
LIFECYCLE_BUCKET="your-hyperpod-lifecycle-bucket"
SCRIPTS_DIR="./lifecycle-scripts"

# Upload all scripts
aws s3 cp $SCRIPTS_DIR s3://$LIFECYCLE_BUCKET/lifecycle-scripts/ --recursive

# Verify upload
aws s3 ls s3://$LIFECYCLE_BUCKET/lifecycle-scripts/
```

Expected output:
```
2024-XX-XX XX:XX:XX      XXXX on_create.sh
2024-XX-XX XX:XX:XX      XXXX setup_fsx.sh
2024-XX-XX XX:XX:XX      XXXX setup_slurm.sh
```

## Step 2: Edit cluster-config.json

Edit `cluster-config.json` and replace the following placeholders:

### Replace Security Group ID
```bash
# List available security groups
aws ec2 describe-security-groups --region us-east-1 --query 'SecurityGroups[].{ID:GroupId,Name:GroupName}'

# Update the placeholder in cluster-config.json
sed -i 's/sg-REPLACE/sg-your-group-id/g' cluster-config.json
```

### Replace Subnet ID
```bash
# List available subnets
aws ec2 describe-subnets --region us-east-1 --query 'Subnets[].{ID:SubnetId,AZ:AvailabilityZone,CIDR:CidrBlock}'

# Update the placeholder in cluster-config.json
sed -i 's/subnet-REPLACE/subnet-your-subnet-id/g' cluster-config.json
```

### Replace S3 Bucket URI
```bash
# Update lifecycle bucket reference
sed -i "s|s3://LIFECYCLE_BUCKET|s3://$LIFECYCLE_BUCKET|g" cluster-config.json
```

### Verify the changes
```bash
cat cluster-config.json
```

## Step 3: Edit provisioning-params.json

Update the FSx configuration in `provisioning-params.json`:

```bash
# Get FSx file system details
aws fsx describe-file-systems --region us-east-1 --query 'FileSystems[].{DNS:DNSName,MountName:LustreConfiguration.MountName}'

# Example output:
# DNS: fs-0123456789abcdef.fsx.us-east-1.amazonaws.com
# MountName: fsx

# Update the placeholders
sed -i 's/FSX_DNS_REPLACE/fs-0123456789abcdef.fsx.us-east-1.amazonaws.com/g' provisioning-params.json
sed -i 's/FSX_MOUNT_REPLACE/fsx/g' provisioning-params.json
```

### Verify the changes
```bash
cat provisioning-params.json
```

## Step 4: Create the HyperPod Cluster

Use the AWS CLI to create the cluster with the updated configuration:

```bash
# Define cluster configuration
CLUSTER_CONFIG_FILE="cluster-config.json"

# Create the cluster
aws sagemaker create-cluster \
  --cluster-name hyperpod-robotics \
  --instance-groups file://$CLUSTER_CONFIG_FILE \
  --region us-east-1

# Output: ClusterArn: arn:aws:sagemaker:us-east-1:ACCOUNT:cluster/hyperpod-robotics
```

Note the **ClusterArn** for future reference.

## Step 5: Monitor Cluster Creation

Check the cluster status during provisioning:

```bash
# Check cluster status (runs every 10 seconds, press Ctrl+C to stop)
while true; do
  aws sagemaker describe-cluster \
    --cluster-name hyperpod-robotics \
    --region us-east-1 \
    --query 'ClusterStatus' \
    --output text
  
  echo "Last updated: $(date)"
  sleep 10
done
```

Expected status progression:
- `Creating` → Cluster is being provisioned (5-15 minutes)
- `Updating` → Configuration is being applied
- `InService` → Cluster is ready

### Detailed cluster information
```bash
aws sagemaker describe-cluster \
  --cluster-name hyperpod-robotics \
  --region us-east-1
```

This returns:
- Cluster ARN and creation time
- Instance group details and status
- SLURM head node information
- Last status update

## Step 6: Connect to Head Node

Once the cluster is in `InService` state, connect to the head node:

### Option A: Using AWS Systems Manager Session Manager

```bash
# Get the head node instance ID
HEAD_NODE_ID=$(aws sagemaker describe-cluster \
  --cluster-name hyperpod-robotics \
  --region us-east-1 \
  --query 'ClusterStatus.InstanceGroups[?InstanceGroupName==`head`].InstanceIds[0]' \
  --output text)

# Start a session
aws ssm start-session \
  --target $HEAD_NODE_ID \
  --region us-east-1
```

### Option B: Using SSH (if configured)

```bash
# Get head node public/private IP
aws ec2 describe-instances \
  --instance-ids $HEAD_NODE_ID \
  --region us-east-1 \
  --query 'Reservations[0].Instances[0].PrivateIpAddress'

# SSH into the node (requires key pair and security group SSH rule)
ssh -i your-key.pem ubuntu@<instance-ip>
```

### On the Head Node: Verify SLURM

```bash
# Check SLURM controller status
sudo systemctl status slurmctld

# View SLURM configuration
sinfo

# Check node status
sinfo -a

# View SLURM partitions
sinfo -e
```

Expected output:
```
PARTITION   AVAIL  TIMELIMIT  NODES  STATE NODELIST
sim            up   infinite     16   idle node-sim-[01-16]
train*         up   infinite      4   idle node-train-[01-04]
debug          up    4:00:00      1   idle node-debug-01
```

### Verify FSx Mount

```bash
# Check FSx mount on head node
mount | grep fsx

# List FSx directories
ls -la /fsx/

# Verify writable scratch directory
touch /fsx/scratch/test.txt && rm /fsx/scratch/test.txt && echo "FSx write test passed"
```

## Step 7: Run a Test Job

Submit a test job to verify SLURM functionality:

```bash
# On the head node, create a test script
cat > test_job.sh <<'EOF'
#!/bin/bash
echo "Running on $(hostname)"
nvidia-smi --list-gpus
ls -la /fsx/scratch
EOF

chmod +x test_job.sh

# Submit to the training partition
sbatch -p train --nodes=1 --gpus=1 test_job.sh

# Check job status
squeue

# View job output
tail -f slurm-*.out
```

## Step 8: Delete the Cluster

When you're done, delete the cluster to avoid unnecessary charges:

```bash
# Delete the cluster (this will terminate all instances)
aws sagemaker delete-cluster \
  --cluster-name hyperpod-robotics \
  --region us-east-1

# Verify deletion
aws sagemaker describe-cluster \
  --cluster-name hyperpod-robotics \
  --region us-east-1
# This will return an error after cluster is deleted
```

### Wait for Cluster Deletion

```bash
# Monitor deletion progress
while true; do
  STATUS=$(aws sagemaker describe-cluster \
    --cluster-name hyperpod-robotics \
    --region us-east-1 \
    --query 'ClusterStatus.ClusterStatus' \
    --output text 2>/dev/null)
  
  if [ -z "$STATUS" ]; then
    echo "Cluster deleted successfully"
    break
  fi
  
  echo "Current status: $STATUS"
  sleep 10
done
```

## Troubleshooting

### Cluster Stuck in "Creating" State

1. Check EC2 instances:
   ```bash
   aws ec2 describe-instances --filters "Name=tag:sagemaker:cluster-name,Values=hyperpod-robotics"
   ```

2. Review CloudWatch logs:
   ```bash
   aws logs describe-log-groups --query 'logGroups[?contains(logGroupName, `hyperpod`)]'
   ```

3. Check IAM permissions and resource quotas

### SLURM Issues

```bash
# View SLURM errors on head node
sudo tail -f /var/log/slurm/slurmd.log

# Check SLURM controller status
sudo systemctl status slurmctld
sudo systemctl restart slurmctld

# View all nodes
sinfo -a

# View pending jobs
squeue -S "-t"
```

### FSx Mount Failures

```bash
# Check FSx health
aws fsx describe-file-systems --query 'FileSystems[].{Status:Lifecycle,FailureDetails:FailureDetails}'

# Check mount on head node
mount | grep lustre

# Remount if needed
sudo umount /fsx
sudo mount -t lustre <DNS>@tcp:/<MOUNT_NAME> /fsx
```

### Lifecycle Script Failures

```bash
# Check script execution logs on nodes
sudo tail -f /opt/ml/lifecycle-scripts/logs/on_create.log

# SSH into a worker node and check
sudo tail -f /var/log/cloud-init-output.log
```

## Best Practices

1. **Cost Optimization**
   - Use `debug` partition for testing (smaller instance type)
   - Stop cluster when not in use
   - Set appropriate job time limits in SLURM partitions

2. **Security**
   - Restrict security group ingress to necessary ports
   - Use VPC endpoints for S3 and other AWS services
   - Enable CloudTrail for audit logging

3. **Monitoring**
   - Set up CloudWatch alarms for cluster events
   - Monitor FSx usage and costs
   - Track SLURM job metrics

4. **Data Management**
   - Organize data in `/fsx/datasets` for shared access
   - Use `/fsx/checkpoints` for model checkpoints
   - Clean up `/fsx/scratch` periodically

5. **Disaster Recovery**
   - Document custom SLURM configurations
   - Version control lifecycle scripts
   - Maintain snapshots of FSx file systems
