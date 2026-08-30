import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface SmContainerBuildProjectsProps {
  trainingProjectName: string;
  role: iam.IRole;
  trainingRepository: ecr.IRepository;
  /** 비워두면 NO_SOURCE — scripts/trigger_build.py가 zip 업로드 후 트리거. */
  repositoryUrl: string;
}

/**
 * SageMaker 학습 이미지 빌드용 공용 CodeBuild 프로젝트 (shared 스택).
 *   - PrivilegedMode (Docker in Docker), aws/codebuild/standard:7.0.
 *   - repositoryUrl 비어 있으면 NO_SOURCE 모드 (S3 zip 업로드).
 */
export class SmContainerBuildProjects extends Construct {
  public readonly trainingProject: codebuild.Project;

  constructor(scope: Construct, id: string, props: SmContainerBuildProjectsProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);
    const ecrRegistry = `${stack.account}.dkr.ecr.${stack.region}.amazonaws.com`;

    const noSourceBuildSpec = codebuild.BuildSpec.fromObject({
      version: '0.2',
      phases: {
        build: {
          commands: ['echo "소스 없음: S3에서 소스를 업로드한 후 빌드를 트리거하세요."'],
        },
      },
    });

    const baseSource = props.repositoryUrl
      ? codebuild.Source.gitHub({
          owner: parseGithubOwner(props.repositoryUrl),
          repo: parseGithubRepo(props.repositoryUrl),
        })
      : undefined;

    this.trainingProject = new codebuild.Project(this, 'TrainingBuild', {
      projectName: props.trainingProjectName,
      description: 'GR00T-N1.6 학습 컨테이너 빌드 및 ECR 푸시',
      role: props.role,
      ...(baseSource ? { source: baseSource } : {}),
      buildSpec: props.repositoryUrl
        ? codebuild.BuildSpec.fromSourceFilename('container/training/buildspec.yml')
        : noSourceBuildSpec,
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.LARGE,
        privileged: true,
      },
      environmentVariables: {
        ECR_REGISTRY: { value: ecrRegistry },
        AWS_DEFAULT_REGION: { value: stack.region },
        IMAGE_REPO: { value: props.trainingRepository.repositoryName },
        GROOT_VERSION: { value: 'n1.6' },
        USE_STABLE: { value: 'true' },
        BASE_MODEL_PATH: { value: 'nvidia/GR00T-N1.6-3B' },
        IMAGE_TAG: { value: 'latest' },
      },
      logging: {
        cloudWatch: {
          enabled: true,
          logGroup: new logs.LogGroup(this, 'TrainingLogGroup', {
            logGroupName: `/aws/codebuild/${props.trainingProjectName}`,
            retention: logs.RetentionDays.ONE_MONTH,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          }),
        },
      },
    });
  }
}

function parseGithubOwner(url: string): string {
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!m) throw new Error(`GitHub URL 형식이 아닙니다: ${url}`);
  return m[1];
}

function parseGithubRepo(url: string): string {
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!m) throw new Error(`GitHub URL 형식이 아닙니다: ${url}`);
  return m[2];
}
