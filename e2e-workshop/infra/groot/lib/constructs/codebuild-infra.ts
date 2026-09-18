import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3_assets from 'aws-cdk-lib/aws-s3-assets';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as path from 'path';
import { Construct } from 'constructs';

export interface CodeBuildInfraProps {
  repository: ecr.IRepository;
  useStableGroot?: boolean;
  grootVersion?: string;
  /**
   * 자동 트리거 커스텀 리소스 Lambda 의 실행 역할. 스택에 AwsCustomResource 가 여럿이면
   * singleton Lambda 를 공유하므로 스택에서 하나 만들어 모든 construct 에 같은 것을 넘긴다.
   * 생략하면 이 construct 가 groot-runtime-build 전용 역할을 만든다.
   */
  triggerRole?: iam.IRole;
  /**
   * 이 빌드가 끝난 뒤 이어서 시작할 CodeBuild 프로젝트(학습 이미지 빌드).
   *
   * 배포 시 두 프로젝트를 동시에 StartBuild 하면 새 계정(Workshop Studio 이벤트 계정 등)의
   * CodeBuild 한도("Cannot have more than 1 builds in queue for the account")에 걸려
   * 커스텀 리소스가 실패하고 스택이 롤백된다. 그래서 배포 시에는 런타임 빌드 하나만 시작하고,
   * 그 빌드의 post_build 끝에서 `NEXT_BUILD_PROJECT` 를 StartBuild 한다(buildspec 참고).
   * 변수는 자동 트리거의 environmentVariablesOverride 로만 주므로 수동 재빌드는 이어지지 않는다.
   * `assetHash` 를 주면 그 값이 바뀔 때(학습 Dockerfile 변경)도 체인이 다시 돈다.
   */
  nextBuild?: { project: codebuild.IProject; assetHash?: string };
}

export class CodeBuildInfra extends Construct {
  public readonly project: codebuild.Project;
  public readonly triggerRole: iam.IRole;

  constructor(scope: Construct, id: string, props: CodeBuildInfraProps) {
    super(scope, id);

    const useStable = props.useStableGroot ?? true;
    const grootVersion = props.grootVersion ?? 'n1.6';

    const sourceAsset = new s3_assets.Asset(this, 'SourceAsset', {
      path: path.join(__dirname, '../../assets'),
      exclude: ['*.pyc', '__pycache__', '.git', '*.egg-info'],
    });

    this.project = new codebuild.Project(this, 'BuildProject', {
      projectName: 'groot-runtime-build',
      description: 'Builds the GR00T runtime container (inference + fine-tuning) and pushes to ECR',
      source: codebuild.Source.s3({
        bucket: sourceAsset.bucket,
        path: sourceAsset.s3ObjectKey,
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.X2_LARGE,
        privileged: true,
      },
      environmentVariables: {
        ECR_REPOSITORY_NAME: { value: props.repository.repositoryName },
        USE_STABLE: { value: useStable ? 'true' : 'false' },
        GROOT_VERSION: { value: grootVersion },
        IMAGE_TAG: { value: 'latest' },
      },
      buildSpec: codebuild.BuildSpec.fromSourceFilename('buildspec.yml'),
      timeout: cdk.Duration.hours(2),
    });

    props.repository.grantPullPush(this.project.role!);
    sourceAsset.grantRead(this.project.role!);

    this.project.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecr:GetAuthorizationToken'],
      resources: ['*'],
    }));

    // Auto-trigger build on deploy.
    //
    // 커스텀 리소스 Lambda의 권한은 별도 AWS::IAM::Policy가 아니라 Role 자체의
    // inlinePolicies로 넣는다. `policy` prop을 쓰면 Policy 리소스가 붙는 즉시 Lambda가
    // 호출되어 IAM 전파가 끝나기 전에 AccessDenied가 날 수 있다. Role → Lambda 함수 생성
    // → 호출 순서로 두면 함수 생성 시간이 전파 시간을 덮는다.
    //
    // AwsCustomResource 는 스택당 Lambda 하나를 공유(singleton)하므로, 이 스택에 다른
    // AwsCustomResource 를 추가할 때는 스택에서 만든 공용 Role(props.triggerRole)을 쓰고
    // 그 Role 의 inlinePolicies 에 모든 프로젝트의 StartBuild 권한을 함께 넣는다.
    this.triggerRole = props.triggerRole ?? new iam.Role(this, 'TriggerBuildRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
      inlinePolicies: {
        StartBuild: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['codebuild:StartBuild'],
              resources: [this.project.projectArn],
            }),
          ],
        }),
      },
    });
    const triggerRole = this.triggerRole;

    // 체인 빌드: 런타임 빌드 자신이 다음 프로젝트를 StartBuild 하므로 그 권한은 빌드 롤에 준다.
    const startParams: Record<string, unknown> = { projectName: this.project.projectName };
    let physicalId = `${this.project.projectName}-${sourceAsset.assetHash}`;
    if (props.nextBuild) {
      this.project.addToRolePolicy(new iam.PolicyStatement({
        actions: ['codebuild:StartBuild'],
        resources: [props.nextBuild.project.projectArn],
      }));
      startParams.environmentVariablesOverride = [
        { name: 'NEXT_BUILD_PROJECT', value: props.nextBuild.project.projectName, type: 'PLAINTEXT' },
      ];
      if (props.nextBuild.assetHash) physicalId += `-${props.nextBuild.assetHash}`;
    }

    const startBuild = {
      service: 'CodeBuild',
      action: 'startBuild',
      parameters: startParams,
      physicalResourceId: cr.PhysicalResourceId.of(physicalId),
    };
    const trigger = new cr.AwsCustomResource(this, 'TriggerBuild', {
      onCreate: startBuild,
      onUpdate: startBuild,
      role: triggerRole,
      installLatestAwsSdk: false,
    });
    // 다음 프로젝트가 아직 없으면 체인 StartBuild 가 실패하므로 그 프로젝트 생성 뒤에 트리거한다.
    if (props.nextBuild) trigger.node.addDependency(props.nextBuild.project);
  }
}
