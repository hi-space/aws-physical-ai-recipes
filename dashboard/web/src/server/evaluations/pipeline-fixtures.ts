import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { Repo } from '../store/repo';
import { MemoryKV } from '../store/dynamo';
import { SageMakerSources } from './sagemaker-source';
import { S3PipelineArchiveStorage } from './pipeline-storage';
import { S3EvidenceStorage } from './s3-storage';
import { PipelineArchives } from '../services/pipeline-archives';
import { ModelsService } from '../services/models';
import type { Session } from '../auth/session';
import { directoryManifest } from './bundles';

export const testTime = '2026-09-16T01:00:00.000Z';
export const executionArn = 'arn:aws:sagemaker:us-east-1:123456789012:pipeline/groot/execution/owned';
export const trainingArn = 'arn:aws:sagemaker:us-east-1:123456789012:training-job/train-owned';
export const packageArn = 'arn:aws:sagemaker:us-east-1:123456789012:model-package/groot-models/1';
export const modelUri = 's3://source/output/train-owned/output/model.tar.gz';
export const reportUri = 's3://source/reports/owned/evaluation.json';
export const pipelineAdmin: Session = { user: 'alice', subject: 'alice-sub', role: 'researcher', email: '' };
export const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const sum = (value: Uint8Array) => createHash('sha256').update(value).digest('base64');
export const bundleFiles = { 'config.json': '{"model_type":"fixture"}', 'model.safetensors': 'fixture weights, not a trained model', 'processor_config.json': '{}' };
export function tarFixture(files: Record<string, string>, format = 'PAX_FORMAT') {
  return execFileSync('python3', ['-c', `
import io,json,sys,tarfile
files=json.loads(sys.argv[1])
with tarfile.open(fileobj=sys.stdout.buffer,mode="w|gz",format=getattr(tarfile,sys.argv[2])) as archive:
 for name,data in files.items():
  body=data.encode(); info=tarfile.TarInfo(name); info.size=len(body);info.mtime=0
  archive.addfile(info,io.BytesIO(body))
`, JSON.stringify(files), format]);
}
interface Stored { body: Buffer; version: string; checksumType: string; checksum: string }
export class FixtureS3 {
  objects = new Map<string, Stored>();
  serial = 0;
  commands: { name: string; input: Record<string, any> }[] = [];
  put(bucket: string, key: string, body: Uint8Array | string) {
    const bytes = Buffer.from(body), value = { body: bytes, version: `version-${++this.serial}`, checksum: sum(bytes), checksumType: 'FULL_OBJECT' };
    this.objects.set(`${bucket}/${key}`, value); return value;
  }
  async send(command: { constructor: { name: string }; input: Record<string, any> }) {
    const name = command.constructor.name, input = command.input;
    this.commands.push({ name, input });
    const key = `${input.Bucket}/${input.Key}`, value = this.objects.get(key);
    const missing = () => Object.assign(new Error('missing fixture object'), { name: 'NoSuchKey' });
    if (name === 'HeadObjectCommand' || name === 'GetObjectCommand') {
      if (!value || input.VersionId && input.VersionId !== value.version) throw missing();
      const meta = { VersionId: value.version, ETag: `"${sha(value.body)}"`, ContentLength: value.body.length,
        ChecksumSHA256: value.checksum, ChecksumType: value.checksumType };
      if (name === 'HeadObjectCommand') return meta;
      const chunks = Array.from({ length: Math.ceil(value.body.length / 127) }, (_, i) => value.body.subarray(i * 127, (i + 1) * 127));
      const Body = Readable.from(chunks) as Readable & { transformToString: () => Promise<string> };
      Body.transformToString = async () => value.body.toString('utf8');
      return { ...meta, Body };
    }
    if (name === 'PutObjectCommand') {
      if (value && input.IfNoneMatch === '*') throw Object.assign(new Error('exists'), { name: 'PreconditionFailed' });
      return { VersionId: this.put(input.Bucket, input.Key, input.Body).version };
    }
    if (name === 'CopyObjectCommand') {
      const [raw, query] = String(input.CopySource).split('?'), source = this.objects.get(decodeURIComponent(raw));
      if (!source || query && new URLSearchParams(query).get('versionId') !== source.version ||
          input.CopySourceIfMatch !== `"${sha(source.body)}"`) throw missing();
      return { VersionId: this.put(input.Bucket, input.Key, source.body).version };
    }
    if (name === 'ListObjectsV2Command') throw new Error('No directory-list fallback is allowed');
    throw new Error(`Unexpected fixture S3 command ${name}`);
  }
}
export class FixtureSageMaker {
  commands: { name: string; input: Record<string, any> }[] = [];
  pipelineStatus = 'Succeeded'; trainingStatus = 'Completed'; reportModelUri = modelUri;
  modelArtifactUri = modelUri; modelPackageUri = modelUri; cached = false;
  approval = 'Approved'; metadata: Record<string, string> = {};
  failUpdate = false; confirmUpdate = true;
  processingReport = false; packageStatus = 'Completed'; statusAfterUpdate = 'Completed';
  async send(command: { constructor: { name: string }; input: Record<string, any> }) {
    const name = command.constructor.name, input = command.input;
    this.commands.push({ name, input });
    if (name === 'DescribePipelineExecutionCommand') return { PipelineExecutionArn: executionArn,
      PipelineExecutionStatus: this.pipelineStatus, LastModifiedTime: new Date(testTime) };
    if (name === 'ListPipelineExecutionStepsCommand') return { PipelineExecutionSteps: [
      { StepName: 'GR00TFinetune', StepStatus: 'Succeeded', ...(this.cached ? { CacheHitResult: { SourcePipelineExecutionArn: 'foreign' } } : {}),
        Metadata: { TrainingJob: { Arn: trainingArn } } },
      { StepName: 'SmokeEval', StepStatus: 'Succeeded', Metadata: this.processingReport
        ? { ProcessingJob: { Arn: trainingArn.replace('training-job/train-owned', 'processing-job/eval-owned') } }
        : { TrainingJob: { Arn: trainingArn.replace('train-owned', 'eval-owned') } } },
      { StepName: 'RegisterModel', StepStatus: 'Succeeded', Metadata: { RegisterModel: { Arn: packageArn } } },
    ] };
    if (name === 'ListPipelineParametersForExecutionCommand') return { PipelineParameters: [] };
    if (name === 'DescribePipelineDefinitionForExecutionCommand') return { PipelineDefinition: JSON.stringify({
      Steps: [{ Name: 'GR00TFinetune', Type: 'Training' }, { Name: 'SmokeEval', Type: 'Training' }],
    }) };
    if (name === 'DescribeTrainingJobCommand') {
      const evaluation = input.TrainingJobName === 'eval-owned';
      return { TrainingJobArn: evaluation ? trainingArn.replace('train-owned', 'eval-owned') : trainingArn,
        TrainingJobStatus: evaluation ? 'Completed' : this.trainingStatus, TrainingEndTime: new Date(testTime),
        AlgorithmSpecification: { TrainingImage: 'registry/groot@sha256:' + 'a'.repeat(64) },
        ModelArtifacts: { S3ModelArtifacts: this.modelArtifactUri },
        InputDataConfig: [{ ChannelName: evaluation ? 'model' : 'dataset', DataSource: { S3DataSource: {
          S3Uri: evaluation ? this.reportModelUri : 's3://source/demonstrations/', S3DataType: 'S3Prefix',
        } } }],
        HyperParameters: evaluation ? { report_s3_uri: JSON.stringify(reportUri) } : {},
      };
    }
    if (name === 'DescribeProcessingJobCommand') return {
      ProcessingJobArn: trainingArn.replace('training-job/train-owned', 'processing-job/eval-owned'), ProcessingJobStatus: 'Completed',
      ProcessingEndTime: new Date(testTime), AppSpecification: { ImageUri: 'registry/evaluator' },
      ProcessingInputs: [{ InputName: 'model', S3Input: { S3Uri: this.reportModelUri } }],
      ProcessingOutputConfig: { Outputs: [{ OutputName: 'evaluation', S3Output: { S3Uri: reportUri.slice(0, -'/evaluation.json'.length) } }] },
    };
    if (name === 'DescribeModelPackageCommand') return { ModelPackageArn: packageArn, ModelPackageGroupName: 'groot-models',
      ModelPackageStatus: this.packageStatus, ModelApprovalStatus: this.approval, CustomerMetadataProperties: { ...this.metadata },
      InferenceSpecification: { Containers: [{ ModelDataUrl: this.modelPackageUri, Image: 'registry/groot' }] } };
    if (name === 'UpdateModelPackageCommand') {
      if (this.failUpdate) throw Object.assign(new Error('fixture denied'), { name: 'AccessDeniedException' });
      if (this.confirmUpdate) { this.approval = input.ModelApprovalStatus; this.metadata = { ...input.CustomerMetadataProperties }; this.packageStatus = this.statusAfterUpdate; }
      return {};
    }
    throw new Error(`Unexpected fixture SageMaker command ${name}`);
  }
}
export async function pipelineFixture() {
  const repo = new Repo(new MemoryKV()), storage = new FixtureS3(), aws = new FixtureSageMaker();
  await repo.kv.put({ pk: 'PROJECT#a', sk: 'META', gsi1pk: 'TYPE#PROJECT', gsi1sk: 'a', id: 'a', name: 'a',
    namespace: 'hyperpod-ns-a', queue: 'q', members: { 'alice-sub': 'project-admin', 'reader-sub': 'viewer', 'peer-sub': 'researcher' },
    credentialRefs: [], createdAt: testTime, updatedAt: testTime });
  await repo.kv.put({ pk: 'PROJECT#b', sk: 'META', gsi1pk: 'TYPE#PROJECT', gsi1sk: 'b', id: 'b', name: 'b',
    namespace: 'hyperpod-ns-b', queue: 'q', members: { 'bob-sub': 'researcher' }, credentialRefs: [], createdAt: testTime, updatedAt: testTime });
  await repo.kv.put({ pk: `PIPELINE_EXECUTION#${executionArn}`, sk: 'META', projectId: 'a', ownerSubject: 'alice-sub', owner: 'alice' });
  storage.put('source', 'output/train-owned/output/model.tar.gz', tarFixture(bundleFiles));
  storage.put('source', 'reports/owned/evaluation.json', JSON.stringify({ smoke: { passed: 1, all_finite: 1, action_shape: [16, 7], error: '' } }));
  const sources = new SageMakerSources({ accountId: '123456789012', region: 'us-east-1', pipelineName: 'groot', artifactBucket: 'source', packageGroup: 'groot-models' });
  const archives = new PipelineArchives({ repo, sources, storage: new S3PipelineArchiveStorage('archive'), now: () => new Date(testTime) });
  const models = new ModelsService({ repo, objects: new S3EvidenceStorage(), artifactBucket: 'archive', now: () => new Date(testTime),
    registry: { sources, storage: new S3PipelineArchiveStorage('archive') } });
  const directory = directoryManifest(Object.entries(bundleFiles).map(([path, bytes]) => ({ path, bytes: Buffer.byteLength(bytes), sha256: sha(bytes) })));
  return { repo, storage, aws, archives, models, sources, directory };
}
