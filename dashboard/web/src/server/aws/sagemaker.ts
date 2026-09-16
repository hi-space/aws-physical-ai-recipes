import {
  DescribePipelineCommand,
  DescribePipelineExecutionCommand,
  DescribeTrainingJobCommand,
  ListModelPackagesCommand,
  ListPipelineExecutionStepsCommand,
  ListPipelineExecutionsCommand,
  ListPipelineParametersForExecutionCommand,
  ListTrainingJobsCommand,
  StartPipelineExecutionCommand,
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

export async function startExecution(params: Record<string, string>, displayName?: string) {
  const out = await sagemaker().send(
    new StartPipelineExecutionCommand({
      PipelineName: pipelineName(),
      PipelineExecutionDisplayName: displayName?.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 82),
      PipelineParameters: Object.entries(params).map(([Name, Value]) => ({ Name, Value })),
      ClientRequestToken: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    }),
  );
  return out.PipelineExecutionArn!;
}

export async function describeExecution(arn: string) {
  const [exec, steps, params] = await Promise.all([
    sagemaker().send(new DescribePipelineExecutionCommand({ PipelineExecutionArn: arn })),
    sagemaker().send(new ListPipelineExecutionStepsCommand({ PipelineExecutionArn: arn, MaxResults: 100 })),
    sagemaker().send(new ListPipelineParametersForExecutionCommand({ PipelineExecutionArn: arn, MaxResults: 50 })),
  ]);
  return { execution: exec, steps: steps.PipelineExecutionSteps ?? [], parameters: params.PipelineParameters ?? [] };
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
