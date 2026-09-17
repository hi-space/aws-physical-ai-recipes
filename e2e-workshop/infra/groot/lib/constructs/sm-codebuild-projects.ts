import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3_assets from 'aws-cdk-lib/aws-s3-assets';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as path from 'path';
import { Construct } from 'constructs';

export interface SmContainerBuildProjectsProps {
  trainingProjectName: string;
  role: iam.IRole;
  trainingRepository: ecr.IRepository;
  /**
   * GitHub 소스 URL. 비워두면(기본) `../../groot/training/container` 디렉터리를 S3 asset 으로
   * 올려 CodeBuild 소스로 쓰고, 배포 시 빌드를 자동 트리거한다 (runtime 이미지와 같은 방식).
   */
  repositoryUrl: string;
  /**
   * 배포 시 빌드를 자동 시작하는 커스텀 리소스 Lambda 의 실행 역할. 스택의 다른
   * AwsCustomResource 와 singleton Lambda 를 공유하므로 스택에서 하나 만들어 넘긴다
   * (codebuild-infra.ts 주석 참고). 지정하지 않으면 자동 트리거를 만들지 않는다.
   */
  autoTriggerRole?: iam.IRole;
}

/**
 * SageMaker 학습 이미지 빌드용 CodeBuild 프로젝트.
 *   - PrivilegedMode (Docker in Docker), aws/codebuild/standard:7.0.
 *   - 기본: `groot/training/container` 를 S3 asset 으로 업로드해 소스로 쓰고, 배포/asset 변경 시
 *     자동으로 빌드를 시작한다. 참가자는 모듈 3 §3.4 에서 상태만 확인하면 된다.
 *   - `training/scripts/trigger_build.py` 는 Dockerfile 을 고친 뒤 수동 재빌드할 때 쓴다
 *     (같은 레이아웃의 zip 을 올려 sourceLocationOverride 로 빌드).
 */
export class SmContainerBuildProjects extends Construct {
  public readonly trainingProject: codebuild.Project;
  /** S3 asset 소스일 때만 존재. 해시가 바뀌면 재배포 시 빌드가 다시 돈다. */
  public readonly sourceAsset?: s3_assets.Asset;

  constructor(scope: Construct, id: string, props: SmContainerBuildProjectsProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);
    const ecrRegistry = `${stack.account}.dkr.ecr.${stack.region}.amazonaws.com`;

    // 빌드 컨텍스트 = training/container 디렉터리 루트 (Dockerfile/buildspec.yml 이 루트에 온다).
    // Dockerfile 은 COPY 를 하지 않으므로(train.py 등은 SageMaker source_dir 로 런타임 주입)
    // 디렉터리 내용은 빌드 결과에 영향이 없지만, 파일이 바뀌면 asset 해시가 바뀌어 다음
    // cdk deploy 때 빌드가 다시 트리거된다.
    let source: codebuild.ISource;
    let buildSpec: codebuild.BuildSpec;
    let dockerfileDir: string;
    if (props.repositoryUrl) {
      source = codebuild.Source.gitHub({
        owner: parseGithubOwner(props.repositoryUrl),
        repo: parseGithubRepo(props.repositoryUrl),
      });
      dockerfileDir = 'e2e-workshop/groot/training/container';
      buildSpec = codebuild.BuildSpec.fromSourceFilename(`${dockerfileDir}/buildspec.yml`);
    } else {
      this.sourceAsset = new s3_assets.Asset(this, 'SourceAsset', {
        path: path.join(__dirname, '../../../../groot/training/container'),
        exclude: ['*.pyc', '__pycache__', '.git'],
      });
      source = codebuild.Source.s3({
        bucket: this.sourceAsset.bucket,
        path: this.sourceAsset.s3ObjectKey,
      });
      dockerfileDir = '.';
      buildSpec = codebuild.BuildSpec.fromSourceFilename('buildspec.yml');
    }

    this.trainingProject = new codebuild.Project(this, 'TrainingBuild', {
      projectName: props.trainingProjectName,
      description: 'GR00T-N1.6 학습 컨테이너 빌드 및 ECR 푸시 (배포 시 자동 트리거)',
      role: props.role,
      source,
      buildSpec,
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
        DOCKERFILE_DIR: { value: dockerfileDir },
      },
      timeout: cdk.Duration.hours(2),
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

    // asset 버킷 읽기 권한은 codebuild.Source.s3 가 프로젝트 롤에 자동으로 부여한다
    // (GR00TCodeBuildRole 자체는 */codebuild-source/* 만 허용).

    if (this.sourceAsset && props.autoTriggerRole) {
      const physicalId = `${props.trainingProjectName}-${this.sourceAsset.assetHash}`;
      const startBuild = {
        service: 'CodeBuild',
        action: 'startBuild',
        parameters: { projectName: this.trainingProject.projectName },
        physicalResourceId: cr.PhysicalResourceId.of(physicalId),
      };
      const trigger = new cr.AwsCustomResource(this, 'TriggerBuild', {
        onCreate: startBuild,
        onUpdate: startBuild,
        role: props.autoTriggerRole,
        installLatestAwsSdk: false,
      });
      trigger.node.addDependency(this.trainingProject);
    }
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
