import { NextResponse } from 'next/server';
import { DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { ec2Client, TAG_KEY, TAG_VALUE, useMockData } from '@/lib/aws-clients';
import { mockWorkers } from '@/data/mockWorkers';
import type { Worker, WorkerStatus } from '@/types/worker';

const GPU_COUNTS: Record<string, number> = {
  'g5.xlarge': 1, 'g5.2xlarge': 1, 'g5.4xlarge': 1, 'g5.8xlarge': 1,
  'g5.12xlarge': 4, 'g5.16xlarge': 1, 'g5.24xlarge': 4, 'g5.48xlarge': 8,
  'p4d.24xlarge': 8, 'p4de.24xlarge': 8, 'p5.48xlarge': 8,
  'g6.xlarge': 1, 'g6.2xlarge': 1, 'g6.4xlarge': 1, 'g6.8xlarge': 1,
  'g6.12xlarge': 4, 'g6.16xlarge': 1, 'g6.24xlarge': 4, 'g6.48xlarge': 8,
};

function ec2StateToStatus(state: string): WorkerStatus {
  switch (state) {
    case 'running': return 'RUNNING';
    case 'pending': return 'PENDING';
    case 'stopped':
    case 'stopping':
    case 'shutting-down': return 'STOPPED';
    case 'terminated': return 'FAILED';
    default: return 'STOPPED';
  }
}

function uptimeString(launchTime: Date | undefined): string {
  if (!launchTime) return '-';
  const diff = Date.now() - launchTime.getTime();
  const hours = Math.floor(diff / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  return `${hours}h ${mins}m`;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const region = searchParams.get('region');

  if (useMockData) {
    const workers = region && region !== 'all'
      ? mockWorkers.filter((w) => w.region === region)
      : mockWorkers;
    return NextResponse.json({ workers, source: 'mock' });
  }

  try {
    const filters = [
      { Name: `tag:${TAG_KEY}`, Values: [TAG_VALUE] },
      { Name: 'instance-state-name', Values: ['running', 'pending', 'stopped', 'stopping'] },
    ];

    const command = new DescribeInstancesCommand({ Filters: filters, MaxResults: 100 });
    const response = await ec2Client.send(command);

    const workers: Worker[] = [];
    for (const reservation of response.Reservations || []) {
      for (const instance of reservation.Instances || []) {
        const tags: Record<string, string> = {};
        for (const tag of instance.Tags || []) {
          if (tag.Key && tag.Value) tags[tag.Key] = tag.Value;
        }

        const instanceType = instance.InstanceType || 'unknown';
        const status = ec2StateToStatus(instance.State?.Name || 'unknown');

        workers.push({
          id: instance.InstanceId || 'unknown',
          instanceId: instance.InstanceId || 'unknown',
          batchJobId: tags['aws:batch:job-id'] || tags['BatchJobId'] || '-',
          batchJobQueue: tags['aws:batch:job-queue'] || tags['BatchJobQueue'] || '-',
          status,
          publicIp: instance.PublicIpAddress || '-',
          privateIp: instance.PrivateIpAddress || '-',
          instanceType,
          region: instance.Placement?.AvailabilityZone?.slice(0, -1) || process.env.AWS_REGION || 'us-west-2',
          taskName: tags['TaskName'] || tags['IsaacLabTask'] || '-',
          gpuCount: GPU_COUNTS[instanceType] || 0,
          gpuUtilization: 0,
          gpuMemoryUtilization: 0,
          gpuTemperature: 0,
          cpuUtilization: 0,
          memoryUtilization: 0,
          uptime: uptimeString(instance.LaunchTime),
          startedAt: instance.LaunchTime?.toISOString() || '',
          ddpRank: parseInt(tags['DDPRank'] || '0', 10),
          ddpWorldSize: parseInt(tags['DDPWorldSize'] || '1', 10),
          ddpBackend: tags['DDPBackend'] || 'nccl',
          experimentName: tags['ExperimentName'] || tags['TrainingRun'] || '-',
          currentStep: parseInt(tags['CurrentStep'] || '0', 10),
          totalSteps: parseInt(tags['TotalSteps'] || '10000', 10),
          currentReward: parseFloat(tags['CurrentReward'] || '0'),
          tags,
          rerunPort: parseInt(tags['RerunPort'] || '9090', 10),
          rerunDataPort: parseInt(tags['RerunDataPort'] || '9876', 10),
          tensorboardPort: parseInt(tags['TensorBoardPort'] || '6006', 10),
        });
      }
    }

    // Apply region filter
    const filtered = region && region !== 'all'
      ? workers.filter((w) => w.region === region)
      : workers;

    return NextResponse.json({ workers: filtered, source: 'aws' });
  } catch (error) {
    console.error('EC2 DescribeInstances error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch EC2 instances', details: String(error) },
      { status: 500 },
    );
  }
}
