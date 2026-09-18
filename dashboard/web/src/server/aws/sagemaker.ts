import {
  DescribePipelineCommand,
  DescribePipelineExecutionCommand,
  DescribeTrainingJobCommand,
  DescribeProcessingJobCommand,
  DescribePipelineDefinitionForExecutionCommand,
  DescribeModelPackageCommand,
  UpdateModelPackageCommand,
  ListModelPackagesCommand,
  ListPipelineExecutionStepsCommand,
  ListPipelineExecutionsCommand,
  ListPipelineParametersForExecutionCommand,
  ListTrainingJobsCommand,
  StartPipelineExecutionCommand,
  StopPipelineExecutionCommand,
} from '@aws-sdk/client-sagemaker';
import { config } from '../config';
import { notConfigured } from '../errors';
import { sagemaker } from './clients';

export function pipelineName(): string {
  const n = config().groot?.pipelineName;
  if (!n) throw notConfigured('SageMaker pipeline');
  return n;
}

export async function describePipeline() {
  const out = await sagemaker().send(new DescribePipelineCommand({ PipelineName: pipelineName() }));
  let parameters: { Name: string; DefaultValue?: string; Type?: string }[] = [];
  try {
    const def = JSON.parse(out.PipelineDefinition ?? '{}') as { Parameters?: { Name: string; DefaultValue?: string; Type?: string }[] };
    parameters = def.Parameters ?? [];
  } catch {
    /* definition may be an S3 pointer */
  }
  return { ...out, PipelineDefinition: undefined, parameters };
}

export async function listExecutions(max = 25) {
  const out = await sagemaker().send(new ListPipelineExecutionsCommand({ PipelineName: pipelineName(), MaxResults: max, SortBy: 'CreationTime', SortOrder: 'Descending' }));
  return out.PipelineExecutionSummaries ?? [];
}

export async function startExecution(params: Record<string, string>, displayName?: string, clientRequestToken = crypto.randomUUID(), expectedPipelineArn?: string) {
  const out = await sagemaker().send(
    new StartPipelineExecutionCommand({
      PipelineName: expectedPipelineArn ?? pipelineName(),
      PipelineExecutionDisplayName: displayName?.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 82),
      PipelineParameters: Object.entries(params).map(([Name, Value]) => ({ Name, Value })),
      ClientRequestToken: clientRequestToken,
    }),
  );
  return out.PipelineExecutionArn!;
}

export async function stopExecution(arn: string, clientRequestToken: string) {
  return sagemaker().send(new StopPipelineExecutionCommand({ PipelineExecutionArn: arn, ClientRequestToken: clientRequestToken }));
}

export async function describeExecution(arn: string) {
  async function pages<T>(fetch: (token?: string) => Promise<{ items: T[]; token?: string }>) {
    const items: T[] = [], seen = new Set<string>(); let token: string | undefined;
    do {
      const page = await fetch(token); items.push(...page.items); token = page.token;
      if (token && seen.has(token)) throw new Error('Repeated SageMaker pagination token');
      if (token) seen.add(token);
    } while (token);
    return items;
  }
  const [exec, steps, params] = await Promise.all([
    sagemaker().send(new DescribePipelineExecutionCommand({ PipelineExecutionArn: arn })),
    pages(async NextToken => {
      const page = await sagemaker().send(new ListPipelineExecutionStepsCommand({ PipelineExecutionArn: arn, MaxResults: 100, NextToken }));
      return { items: page.PipelineExecutionSteps ?? [], token: page.NextToken };
    }),
    pages(async NextToken => {
      const page = await sagemaker().send(new ListPipelineParametersForExecutionCommand({ PipelineExecutionArn: arn, MaxResults: 50, NextToken }));
      return { items: page.PipelineParameters ?? [], token: page.NextToken };
    }),
  ]);
  return { execution: exec, steps, parameters: params };
}
export async function definitionForExecution(arn: string) {
  return sagemaker().send(new DescribePipelineDefinitionForExecutionCommand({ PipelineExecutionArn: arn }));
}
export async function describeProcessingJob(name: string) {
  return sagemaker().send(new DescribeProcessingJobCommand({ ProcessingJobName: name }));
}
export async function describeModelPackage(arn: string) {
  return sagemaker().send(new DescribeModelPackageCommand({ ModelPackageName: arn }));
}
export async function approveModelPackage(arn: string, token: string, description: string, metadata: Record<string, string>) {
  return sagemaker().send(new UpdateModelPackageCommand({
    ModelPackageArn: arn, ModelApprovalStatus: 'Approved', ClientToken: token,
    ApprovalDescription: description, CustomerMetadataProperties: metadata,
  }));
}

export async function describeTrainingJob(name: string) {
  return sagemaker().send(new DescribeTrainingJobCommand({ TrainingJobName: name }));
}

export async function listTrainingJobs(max = 25, nameContains?: string) {
  const out = await sagemaker().send(new ListTrainingJobsCommand({ MaxResults: max, SortBy: 'CreationTime', SortOrder: 'Descending', NameContains: nameContains }));
  return out.TrainingJobSummaries ?? [];
}

export async function listModelPackages() {
  const group = config().groot?.modelPackageGroup;
  if (!group) return [];
  const out = await sagemaker().send(new ListModelPackagesCommand({ ModelPackageGroupName: group, MaxResults: 50, SortBy: 'CreationTime', SortOrder: 'Descending' }));
  return out.ModelPackageSummaryList ?? [];
}
