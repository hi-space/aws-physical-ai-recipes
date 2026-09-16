import * as sm from '../aws/sagemaker';
import { config } from '../config';
import { badRequest, forbidden } from '../errors';
import { digest } from './evidence';
import { safeRelativePath } from './report';
import type { PipelineJobSource, PipelineProvenance } from './pipeline-types';

export interface SelectiveExecutionSource { selectiveExecutionSourceArn?: string }
export type InspectedPipelineProvenance = PipelineProvenance & {
  training: PipelineProvenance['training'] & SelectiveExecutionSource;
  reports: (PipelineProvenance['reports'][number] & SelectiveExecutionSource)[];
  package?: NonNullable<PipelineProvenance['package']> & SelectiveExecutionSource;
};

/** Older receipts did not record this AWS reuse fact. Enrich only the missing
 * field; existing facts (including an existing reuse ARN) are never replaced.
 * Callers must still compare every other value before adopting the result. */
export function retainSelectiveExecutionSources(recorded: PipelineProvenance, observed: PipelineProvenance): InspectedPipelineProvenance {
  const old = recorded as InspectedPipelineProvenance, fresh = observed as InspectedPipelineProvenance;
  const enrich = <T extends object>(value: T & SelectiveExecutionSource, source?: SelectiveExecutionSource) =>
    value.selectiveExecutionSourceArn === undefined && source?.selectiveExecutionSourceArn !== undefined
      ? { ...value, selectiveExecutionSourceArn: source.selectiveExecutionSourceArn } : value;
  return { ...old, training: enrich(old.training, fresh.training),
    reports: old.reports.map((report, index) => enrich(report, fresh.reports[index])),
    ...(old.package ? { package: enrich(old.package, fresh.package) } : {}) };
}

export type SageMakerSourceClient = Pick<typeof sm, 'describeExecution' | 'definitionForExecution' | 'describeTrainingJob' | 'describeProcessingJob' | 'describeModelPackage' | 'approveModelPackage'>;
export interface SageMakerSourceScope { accountId: string; region: string; pipelineName: string; artifactBucket: string; packageGroup?: string }
const nameOf = (arn: string) => arn.slice(arn.lastIndexOf('/') + 1);
const timestamp = (value: Date | string | undefined) => {
  if (!value || !Number.isFinite(new Date(value).getTime())) throw badRequest('Completed backend job lacks a valid completion timestamp');
  return new Date(value).toISOString();
};
function scalar(value: string | undefined) {
  if (value === undefined) return '';
  try { const parsed = JSON.parse(value); return typeof parsed === 'string' ? parsed : value; } catch { return value; }
}
export function sourceObject(uri: string, bucket: string) {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match || match[1] !== bucket || /[?#]/.test(match[2])) throw forbidden('Artifact is outside the configured SageMaker repository');
  safeRelativePath(match[2]);
  return { bucket, key: match[2] };
}

/** Uses executed definitions and backend step/job metadata. No browser ARN can
 * select a training job, artifact URI or ModelPackage independently. */
export class SageMakerSources {
  constructor(readonly scope: SageMakerSourceScope, readonly client: SageMakerSourceClient = sm) {}
  assertExecution(arn: string) {
    const prefix = `arn:aws:sagemaker:${this.scope.region}:${this.scope.accountId}:pipeline/${this.scope.pipelineName}/execution/`;
    if (!arn.startsWith(prefix) || !/^[A-Za-z0-9-]+$/.test(arn.slice(prefix.length))) throw forbidden('Execution is not in the configured account/pipeline');
  }
  private jobArn(arn: string, kind: 'training' | 'processing') {
    const prefix = `arn:aws:sagemaker:${this.scope.region}:${this.scope.accountId}:${kind}-job/`;
    if (!arn.startsWith(prefix) || !/^[A-Za-z0-9-]+$/.test(arn.slice(prefix.length))) throw forbidden('Job ARN is outside the execution account');
  }
  async inspect(arn: string, trainingStep: string, reportSteps: string[] = []): Promise<InspectedPipelineProvenance> {
    this.assertExecution(arn);
    const [{ execution, steps }, definition] = await Promise.all([
      this.client.describeExecution(arn), this.client.definitionForExecution(arn),
    ]);
    if (execution.PipelineExecutionArn !== arn || execution.PipelineExecutionStatus !== 'Succeeded') throw badRequest('Only a successful completed pipeline execution can be archived');
    if (!definition.PipelineDefinition) throw badRequest('Executed pipeline definition is unavailable');
    let parsed: { Steps?: { Name: string; Type: string; Arguments?: unknown }[] };
    try { parsed = JSON.parse(definition.PipelineDefinition); } catch { throw badRequest('Executed pipeline definition is invalid'); }
    if (!Array.isArray(parsed.Steps)) throw badRequest('Executed pipeline has no step definitions');
    const selectiveSource = (step: typeof steps[number]): SelectiveExecutionSource => {
      const sourceArn = step.SelectiveExecutionResult?.SourcePipelineExecutionArn;
      if (!sourceArn) return {};
      this.assertExecution(sourceArn);
      if (sourceArn === arn) throw badRequest('Selective execution cannot reuse itself');
      return { selectiveExecutionSourceArn: sourceArn };
    };
    const select = (name: string) => {
      const matches = steps.filter(step => step.StepName === name);
      if (matches.length !== 1 || matches[0].StepStatus !== 'Succeeded' || matches[0].CacheHitResult) {
        throw badRequest('Selected step must have its own successful job; cached output requires separate source ownership verification');
      }
      return matches[0];
    };
    const train = select(trainingStep), trainingArn = train.Metadata?.TrainingJob?.Arn;
    if (!trainingArn || parsed.Steps.find(step => step.Name === trainingStep)?.Type !== 'Training') throw badRequest('Select an executed training step');
    this.jobArn(trainingArn, 'training');
    const job = await this.client.describeTrainingJob(nameOf(trainingArn));
    if (job.TrainingJobArn !== trainingArn || job.TrainingJobStatus !== 'Completed' || !job.AlgorithmSpecification?.TrainingImage ||
        !job.ModelArtifacts?.S3ModelArtifacts) throw badRequest('Training job did not produce completed model artifacts');
    const modelUri = job.ModelArtifacts.S3ModelArtifacts;
    sourceObject(modelUri, this.scope.artifactBucket);
    if (!modelUri.endsWith('.tar.gz')) throw badRequest('A model.tar.gz bundle is required; an unverified directory listing is not a model inventory');
    const training: InspectedPipelineProvenance['training'] = {
      step: trainingStep, jobArn: trainingArn, jobType: 'training', image: job.AlgorithmSpecification.TrainingImage,
      ...selectiveSource(train),
      completedAt: timestamp(job.TrainingEndTime), artifactUri: modelUri,
      inputs: (job.InputDataConfig ?? []).flatMap(channel => channel.DataSource?.S3DataSource?.S3Uri
        ? [{ channel: channel.ChannelName!, uri: channel.DataSource.S3DataSource.S3Uri, verification: 'backend-declared-uri' as const }] : []),
    };
    const reports: InspectedPipelineProvenance['reports'] = [];
    for (const stepName of reportSteps) {
      const step = select(stepName);
      let source: PipelineJobSource, uri: string;
      if (step.Metadata?.TrainingJob?.Arn) {
        const reportArn = step.Metadata.TrainingJob.Arn; this.jobArn(reportArn, 'training');
        const reportJob = await this.client.describeTrainingJob(nameOf(reportArn));
        if (reportJob.TrainingJobArn !== reportArn || reportJob.TrainingJobStatus !== 'Completed') throw badRequest('Report job is not completed');
        uri = scalar(reportJob.HyperParameters?.report_s3_uri);
        source = { step: stepName, jobArn: reportArn, jobType: 'training', completedAt: timestamp(reportJob.TrainingEndTime),
          image: reportJob.AlgorithmSpecification?.TrainingImage ?? '',
          inputs: (reportJob.InputDataConfig ?? []).flatMap(channel => channel.DataSource?.S3DataSource?.S3Uri
            ? [{ channel: channel.ChannelName!, uri: channel.DataSource.S3DataSource.S3Uri, verification: 'backend-declared-uri' as const }] : []) };
      } else if (step.Metadata?.ProcessingJob?.Arn) {
        const reportArn = step.Metadata.ProcessingJob.Arn; this.jobArn(reportArn, 'processing');
        const reportJob = await this.client.describeProcessingJob(nameOf(reportArn));
        if (reportJob.ProcessingJobArn !== reportArn || reportJob.ProcessingJobStatus !== 'Completed') throw badRequest('Processing report job is not completed');
        const outputs = reportJob.ProcessingOutputConfig?.Outputs?.filter(output => ['evaluation', 'report'].includes(output.OutputName ?? '')) ?? [];
        if (outputs.length !== 1 || !outputs[0].S3Output?.S3Uri) throw badRequest('Processing report output is ambiguous or absent');
        uri = outputs[0].S3Output.S3Uri.replace(/\/$/, '') + '/evaluation.json';
        source = { step: stepName, jobArn: reportArn, jobType: 'processing', image: reportJob.AppSpecification?.ImageUri ?? '',
          completedAt: timestamp(reportJob.ProcessingEndTime),
          inputs: (reportJob.ProcessingInputs ?? []).flatMap(channel => channel.S3Input?.S3Uri
            ? [{ channel: channel.InputName!, uri: channel.S3Input.S3Uri, verification: 'backend-declared-uri' as const }] : []) };
      } else throw badRequest('Report step has no supported backend job');
      sourceObject(uri, this.scope.artifactBucket);
      if (!uri.endsWith('/evaluation.json') || !source.image || !source.inputs.some(input => input.uri === modelUri)) {
        throw badRequest('Report must be the completed job output for this exact model input URI');
      }
      reports.push({ ...source, uri, ...selectiveSource(step) });
    }
    const packages = steps.filter(step => step.StepStatus === 'Succeeded' && step.Metadata?.RegisterModel?.Arn);
    if (packages.length > 1) throw badRequest('Multiple registered packages require an explicit pipeline profile');
    let linked: InspectedPipelineProvenance['package'];
    if (packages.length === 1) {
      if (packages[0].CacheHitResult) throw badRequest('Cached package ownership is unsupported');
      const packageArn = packages[0].Metadata!.RegisterModel!.Arn!;
      const result = await this.package(packageArn, modelUri);
      linked = { arn: packageArn, group: this.scope.packageGroup!, modelUri, observedApprovalStatus: result.ModelApprovalStatus ?? 'Unknown',
        ...selectiveSource(packages[0]) };
    }
    return { executionArn: arn, pipelineName: this.scope.pipelineName, definitionHash: digest(definition.PipelineDefinition),
      completedAt: timestamp(execution.LastModifiedTime), training, reports, ...(linked ? { package: linked } : {}) };
  }
  async package(arn: string, modelUri: string, allowPending = false) {
    const prefix = `arn:aws:sagemaker:${this.scope.region}:${this.scope.accountId}:model-package/${this.scope.packageGroup}/`;
    if (!this.scope.packageGroup || !arn.startsWith(prefix) || !/^[1-9]\d*$/.test(arn.slice(prefix.length))) throw forbidden('ModelPackage is outside the configured group');
    const result = await this.client.describeModelPackage(arn);
    const containers = result.InferenceSpecification?.Containers;
    const uri = containers?.[0]?.ModelDataUrl ?? containers?.[0]?.ModelDataSource?.S3DataSource?.S3Uri;
    if (result.ModelPackageArn !== arn || result.ModelPackageGroupName !== this.scope.packageGroup ||
        !(allowPending ? ['Completed', 'Pending', 'InProgress'].includes(result.ModelPackageStatus ?? '') : result.ModelPackageStatus === 'Completed') ||
        containers?.length !== 1 || uri !== modelUri) {
      throw forbidden('Linked package does not describe this completed model artifact');
    }
    return result;
  }
}
export function sageMakerSources() {
  const c = config();
  if (!c.groot?.pipelineName || !c.groot.artifactsBucket) throw badRequest('SageMaker artifact integration is not configured');
  return new SageMakerSources({ accountId: c.accountId, region: c.region, pipelineName: c.groot.pipelineName,
    artifactBucket: c.groot.artifactsBucket, packageGroup: c.groot.modelPackageGroup });
}
