import { NextResponse } from 'next/server';
import {
  ListJobsCommand,
  DescribeJobsCommand,
  DescribeJobQueuesCommand,
  type JobStatus,
} from '@aws-sdk/client-batch';
import { batchClient, TAG_KEY, TAG_VALUE, useMockData } from '@/lib/aws-clients';
import { mockBatchJobs } from '@/data/mockWorkers';
import type { BatchJob } from '@/types/worker';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const queueName = searchParams.get('queue');
  const statusFilter = searchParams.get('status');

  if (useMockData) {
    let jobs = mockBatchJobs;
    if (queueName) jobs = jobs.filter((j) => j.jobQueue === queueName);
    if (statusFilter) jobs = jobs.filter((j) => j.status === statusFilter);
    return NextResponse.json({ jobs, source: 'mock' });
  }

  try {
    // Step 1: Get all job queues
    const queuesResp = await batchClient.send(new DescribeJobQueuesCommand({}));
    const queueNames = (queuesResp.jobQueues || [])
      .map((q) => q.jobQueueName)
      .filter((name): name is string => !!name);

    if (queueName) {
      const idx = queueNames.indexOf(queueName);
      if (idx === -1) {
        return NextResponse.json({ jobs: [], source: 'aws', message: `Queue "${queueName}" not found` });
      }
    }

    const targetQueues = queueName ? [queueName] : queueNames;

    // Step 2: List jobs from each queue across statuses
    const statuses = statusFilter
      ? [statusFilter]
      : ['SUBMITTED', 'PENDING', 'RUNNABLE', 'STARTING', 'RUNNING', 'SUCCEEDED', 'FAILED'];

    const allJobIds: string[] = [];
    for (const queue of targetQueues) {
      for (const status of statuses) {
        try {
          const listResp = await batchClient.send(
            new ListJobsCommand({ jobQueue: queue, jobStatus: status as JobStatus, maxResults: 50 }),
          );
          for (const summary of listResp.jobSummaryList || []) {
            if (summary.jobId) allJobIds.push(summary.jobId);
          }
        } catch {
          // Queue/status combo might not exist, skip
        }
      }
    }

    if (allJobIds.length === 0) {
      return NextResponse.json({ jobs: [], source: 'aws' });
    }

    // Step 3: Describe jobs in batches of 100
    const allJobs: BatchJob[] = [];
    for (let i = 0; i < allJobIds.length; i += 100) {
      const batch = allJobIds.slice(i, i + 100);
      const descResp = await batchClient.send(new DescribeJobsCommand({ jobs: batch }));

      for (const job of descResp.jobs || []) {
        const tags = job.tags || {};

        // Filter by project tag if present
        if (tags[TAG_KEY] !== TAG_VALUE && !Object.values(tags).includes(TAG_VALUE)) {
          continue;
        }

        const resourceReqs = job.container?.resourceRequirements || [];
        const gpus = resourceReqs.find((r) => r.type === 'GPU');
        const vcpus = resourceReqs.find((r) => r.type === 'VCPU');
        const memory = resourceReqs.find((r) => r.type === 'MEMORY');

        allJobs.push({
          jobId: job.jobId || '',
          jobName: job.jobName || '',
          jobQueue: job.jobQueue || '',
          status: job.status || 'UNKNOWN',
          createdAt: job.createdAt ? new Date(job.createdAt).toISOString() : '',
          startedAt: job.startedAt ? new Date(job.startedAt).toISOString() : '',
          stoppedAt: job.stoppedAt ? new Date(job.stoppedAt).toISOString() : '',
          container: {
            image: job.container?.image || '',
            vcpus: parseInt(vcpus?.value || '0', 10),
            memory: parseInt(memory?.value || '0', 10),
            gpus: parseInt(gpus?.value || '0', 10),
          },
          tags,
        });
      }
    }

    return NextResponse.json({ jobs: allJobs, source: 'aws' });
  } catch (error) {
    console.error('Batch API error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch Batch jobs', details: String(error) },
      { status: 500 },
    );
  }
}
