import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as s3Assets from 'aws-cdk-lib/aws-s3-assets';
import * as path from 'node:path';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import { AlarmsConstruct } from './constructs/alarms';
import { AuthConstruct } from './constructs/auth';
import { ServiceConstruct } from './constructs/service';
import { TableConstruct } from './constructs/table';
import { buildEnv, type DiscoveredOutputs } from './env-contract';
import { ArtifactsConstruct } from './constructs/artifacts';
import { WorkloadImages } from './constructs/workload-images';
import { OperationsConstruct } from './constructs/operations';
import { SourceBuildProject } from './constructs/source-build-project';

export interface DashboardStackProps extends cdk.StackProps {
  accountId: string;
  region: string;
  discovered: DiscoveredOutputs;
  network: { vpcId: string; azs: string[]; publicSubnetIds: string[]; privateSubnetIds: string[]; vpcCidr?: string };
  domainName: string;
  hostedZoneId: string;
  hostedZoneName: string;
  adminUsername: string;
  adminEmail: string;
  notifyEmail?: string;
  webAppPath: string;
  /** Buckets the task role may read/write (discovered). */
  buckets: string[];
  /** EKS cluster security group (control-plane ENIs); the service SG is allowed in on 443. */
  eksClusterSecurityGroupId?: string;
  extendedImages?: boolean;
  workflowNamespaces?: string[];
  mlflowTrackingServerArns?: string[];
}

export class DashboardStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DashboardStackProps) {
    super(scope, id, props);
    const prefix = `physical-ai-dashboard-${props.accountId}`;
    const d = props.discovered;

    cdk.Tags.of(this).add('Project', 'PhysicalAiDashboard');
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('UserId', props.accountId);

    const vpc = ec2.Vpc.fromVpcAttributes(this, 'Vpc', {
      vpcId: props.network.vpcId,
      availabilityZones: props.network.azs,
      publicSubnetIds: props.network.publicSubnetIds,
      privateSubnetIds: props.network.privateSubnetIds,
      vpcCidrBlock: props.network.vpcCidr,
    });
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', { hostedZoneId: props.hostedZoneId, zoneName: props.hostedZoneName });

    const table = new TableConstruct(this, 'Store', { tableName: `${prefix}-${props.region}` });
    const artifacts = new ArtifactsConstruct(this, 'Orchestration');
    const workloadImages = new WorkloadImages(this, 'WorkloadImages', {
      repositoryRoot: path.resolve(props.webAppPath, '..', '..'),
      extended: props.extendedImages,
      optionalImages: typeof this.node.tryGetContext('optionalImages') === 'string'
        ? JSON.parse(this.node.tryGetContext('optionalImages')) : this.node.tryGetContext('optionalImages'),
    });
    const sourceDirectory = this.node.tryGetContext('sourceBuildDirectory');
    if (sourceDirectory !== undefined && typeof sourceDirectory !== 'string') throw new Error('sourceBuildDirectory must be a local source path');
    const sourceBuild = new SourceBuildProject(this, 'ResearcherSourceBuild', {
      repositoryRoot: path.resolve(props.webAppPath, '..', '..'), projectId: 'workshop',
      ...(sourceDirectory ? { sourceDirectory: path.resolve(props.webAppPath, '..', '..', sourceDirectory) } : {}),
    });
    const runtimeImage = new ecrAssets.DockerImageAsset(this, 'TaskRuntimeImage', {
      directory: path.resolve(props.webAppPath, '..', 'runtime'), platform: ecrAssets.Platform.LINUX_AMD64,
      exclude: ['pai-runtime', 'pai-runtime-arm64'],
    });
    const runtimeSigningSecret = new secretsmanager.Secret(this, 'RuntimeSigningSecret', {
      generateSecretString: { secretStringTemplate: '{}', generateStringKey: 'key', passwordLength: 64, excludePunctuation: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const dcvSsoSecret = d.isaacLab?.InstanceId ? new secretsmanager.Secret(this, 'DcvSsoSecret', {
      generateSecretString: { secretStringTemplate: '{}', generateStringKey: 'key', passwordLength: 64, excludePunctuation: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    }) : undefined;
    const dcvAgent = dcvSsoSecret ? new s3Assets.Asset(this, 'DcvAgent', {
      path: path.resolve(props.webAppPath, '..', 'dcv-agent'),
      exclude: ['__pycache__', 'test_*'],
    }) : undefined;
    if (dcvSsoSecret && dcvAgent && d.isaacLab?.InstanceRoleArn) {
      const hostRole = iam.Role.fromRoleArn(this, 'DcvHostRole', d.isaacLab.InstanceRoleArn, { mutable: true });
      dcvSsoSecret.grantRead(hostRole);
      dcvAgent.grantRead(hostRole);
    }
    artifacts.bucket.addCorsRule({
      allowedOrigins: [`https://${props.domainName}`],
      allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.POST, s3.HttpMethods.HEAD],
      allowedHeaders: ['*'], exposedHeaders: ['ETag', 'x-amz-version-id', 'x-amz-checksum-sha256'], maxAge: 3600,
    });
    const topic = new sns.Topic(this, 'Notifications', { topicName: `${prefix}-notifications`, displayName: 'Physical AI Dashboard' });
    if (props.notifyEmail) topic.addSubscription(new subs.EmailSubscription(props.notifyEmail));

    const auth = new AuthConstruct(this, 'Auth', { accountId: props.accountId, domainName: props.domainName, adminUsername: props.adminUsername, adminEmail: props.adminEmail });

    const discoveredEnvironment = buildEnv(d, { TABLE_NAME: table.table.tableName, SNS_TOPIC_ARN: topic.topicArn });
    const pipelineName = discoveredEnvironment.SM_PIPELINE_NAME;
    const pipelineArn = pipelineName ? `arn:aws:sagemaker:${props.region}:${props.accountId}:pipeline/${pipelineName}` : undefined;
    const environment = {
      ...discoveredEnvironment,
      ...workloadImages.environment,
      IMAGE_PROFILES_ENFORCED: '1',
      LOG_ARCHIVE_ENABLED: '1',
      SOURCE_BUILD_TARGETS_JSON: cdk.Stack.of(this).toJsonString([sourceBuild.target]),
      BACKEND_HOME_VPC_ID: vpc.vpcId,
      EKS_BACKENDS_JSON: JSON.stringify(typeof this.node.tryGetContext('eksBackends') === 'string'
        ? JSON.parse(this.node.tryGetContext('eksBackends')) : this.node.tryGetContext('eksBackends') ?? []),
      DASHBOARD_ARTIFACT_BUCKET: artifacts.bucket.bucketName,
      TASK_RUNTIME_IMAGE: runtimeImage.imageUri,
      RUNTIME_API_URL: `http://controller.${prefix}.internal:3001`,
      GATEWAY_BASE_DOMAIN: `apps.${props.domainName}`,
      ...(dcvSsoSecret && dcvAgent ? { DCV_SSO_SECRET_ARN: dcvSsoSecret.secretArn, DCV_AGENT_ASSET_URI: dcvAgent.s3ObjectUrl } : {}),
      BUILD_PROJECTS: [`${prefix}-operations`, d.groot?.SmTrainingBuildProjectName, d.groot?.RuntimeCodeBuildProjectName].filter(Boolean).join(','),
    };

    const svc = new ServiceConstruct(this, 'Web', {
      vpc,
      domainName: props.domainName,
      hostedZone: zone,
      userPool: auth.userPool,
      userPoolClient: auth.userPoolClient,
      userPoolDomain: auth.userPoolDomain,
      environment,
      webAppPath: props.webAppPath,
      namePrefix: prefix,
      runtimeSigningSecret,
    });
    if (props.network.vpcCidr) svc.serviceSecurityGroup.addIngressRule(ec2.Peer.ipv4(props.network.vpcCidr), ec2.Port.tcp(3001), 'Scoped workload runtime protocol from private VPC');
    new AlarmsConstruct(this, 'Alarms', {
      namePrefix: prefix,
      loadBalancer: svc.loadBalancer,
      controllerService: svc.controllerService,
      clusterName: prefix,
      webAclName: `${prefix}-web`,
      topic,
    });
    if (d.hyperPodEks?.EksClusterName) {
      const operations = new OperationsConstruct(this, 'Operations', {
        name: prefix, clusterName: d.hyperPodEks.EksClusterName,
        sourcePath: path.resolve(props.webAppPath, '..', 'infra', 'ops'),
        vpc, securityGroup: svc.serviceSecurityGroup,
      });
      operations.project.addToRolePolicy(new iam.PolicyStatement({
        actions: ['eks:DescribeCluster'],
        resources: [`arn:aws:eks:${props.region}:${props.accountId}:cluster/${d.hyperPodEks.EksClusterName}`],
      }));
      new eks.CfnAccessEntry(this, 'OperationsEksAccessEntry', {
        clusterName: d.hyperPodEks.EksClusterName, principalArn: operations.project.role!.roleArn, type: 'STANDARD',
        accessPolicies: [{ policyArn: 'arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy', accessScope: { type: 'cluster' } }],
      });
    }

    // ------------------------------------------------------------------ IAM
    const role = svc.taskRole;
    sourceBuild.grantControlPlane(role);
    sourceBuild.grantControlPlane(svc.controllerRole);
    if (d.hyperPodEks?.ClusterArn) for (const operator of [role, svc.controllerRole]) {
      operator.addToPolicy(new iam.PolicyStatement({
        sid: 'ReviewedHyperPodCapacity', actions: ['sagemaker:DescribeCluster', 'sagemaker:ListClusterNodes',
          'sagemaker:UpdateCluster', 'sagemaker:BatchDeleteClusterNodes'],
        resources: [d.hyperPodEks.ClusterArn],
      }));
    }
    const builds = environment.BUILD_PROJECTS.split(',');
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['codebuild:BatchGetProjects', 'codebuild:ListBuildsForProject', 'codebuild:StartBuild', 'codebuild:BatchGetBuilds'],
      resources: builds.flatMap((name) => [`arn:aws:codebuild:${props.region}:${props.accountId}:project/${name}`, `arn:aws:codebuild:${props.region}:${props.accountId}:build/${name}:*`]),
    }));
    table.table.grantReadWriteData(role);
    dcvSsoSecret?.grantRead(role);
    topic.grantPublish(role);
    artifacts.bucket.grantReadWrite(role);
    table.table.grantReadWriteData(svc.controllerRole);
    table.table.grantReadWriteData(svc.gatewayRole);
    svc.gatewayRole.addToPolicy(new iam.PolicyStatement({ actions: ['eks:DescribeCluster', 'sts:GetCallerIdentity'], resources: ['*'] }));
    topic.grantPublish(svc.controllerRole);
    artifacts.bucket.grantReadWrite(svc.controllerRole);
    svc.controllerRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CheckpointMultipartDiscovery', actions: ['s3:ListBucketMultipartUploads'],
      resources: [artifacts.bucket.bucketArn],
    }));
    svc.controllerRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CheckpointMultipartLifecycle',
      actions: ['s3:ListMultipartUploadParts', 's3:AbortMultipartUpload', 's3:GetObjectVersion', 's3:DeleteObjectVersion'],
      resources: [artifacts.bucket.arnForObjects('projects/*')],
    }));
    svc.controllerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['eks:DescribeCluster', 'sts:GetCallerIdentity', 'fsx:CreateDataRepositoryTask', 'fsx:DescribeDataRepositoryTasks', 'fsx:DescribeDataRepositoryAssociations'], resources: ['*'],
    }));
    if (props.buckets.length) {
      svc.controllerRole.addToPolicy(new iam.PolicyStatement({
        actions: ['s3:ListBucket', 's3:GetBucketLocation'], resources: props.buckets.map((b) => `arn:aws:s3:::${b}`),
      }));
      svc.controllerRole.addToPolicy(new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:GetObjectVersion'], resources: props.buckets.map((b) => `arn:aws:s3:::${b}/*`),
      }));
    }
    if (d.groot?.MlflowTrackingServerArn) {
      svc.controllerRole.addToPolicy(new iam.PolicyStatement({ actions: ['sagemaker:DescribeMlflowTrackingServer', 'sagemaker-mlflow:*'], resources: [d.groot.MlflowTrackingServerArn] }));
      svc.controllerRole.addToPolicy(new iam.PolicyStatement({ actions: ['s3:PutObject'], resources: [`arn:aws:s3:::${d.groot.BucketName}/mlflow-artifacts/*`] }));
    }
    svc.controllerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'], resources: [`arn:aws:ssm:${props.region}:${props.accountId}:parameter/groot/*`, `arn:aws:ssm:${props.region}:${props.accountId}:parameter/physical-ai/*`, `arn:aws:ssm:${props.region}:${props.accountId}:parameter/pai/*`],
    }));
    svc.controllerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt'], resources: ['*'], conditions: { StringEquals: { 'kms:ViaService': `ssm.${props.region}.amazonaws.com` } },
    }));

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'HyperPodAndSageMaker',
        actions: [
          'sagemaker:ListClusters',
          'sagemaker:DescribeCluster',
          'sagemaker:ListClusterNodes',
          'sagemaker:DescribeClusterNode',
          'sagemaker:UpdateCluster',
          // Node recovery from the Compute page (plan → acknowledge → apply); preferred over the node-label path.
          'sagemaker:BatchRebootClusterNodes',
          'sagemaker:BatchReplaceClusterNodes',
          'sagemaker:ListClusterEvents',
          'sagemaker:DescribeClusterEvent',
          'sagemaker:ListComputeQuotas',
          'sagemaker:DescribeComputeQuota',
          'sagemaker:CreateComputeQuota',
          'sagemaker:DeleteComputeQuota',
          'sagemaker:UpdateComputeQuota',
          'sagemaker:ListClusterSchedulerConfigs',
          'sagemaker:DescribeClusterSchedulerConfig',
          'sagemaker:CreateClusterSchedulerConfig',
          'sagemaker:DeleteClusterSchedulerConfig',
          'sagemaker:ListTrainingJobs',
          'sagemaker:DescribeTrainingJob',
          'sagemaker:ListModelPackages',
          'sagemaker:DescribeMlflowTrackingServer',
          'sagemaker:CreatePresignedMlflowTrackingServerUrl',
          'sagemaker:AddTags',
        ],
        resources: ['*'],
      }),
    );
    role.addToPolicy(new iam.PolicyStatement({ sid: 'MlflowRest', actions: ['sagemaker-mlflow:*'], resources: [`arn:aws:sagemaker:${props.region}:${props.accountId}:mlflow-tracking-server/*`] }));
    if (d.groot?.SageMakerRoleArn) role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PassRoleToSageMakerPipeline',
        actions: ['iam:PassRole'],
        resources: [d.groot.SageMakerRoleArn],
        conditions: { StringEquals: { 'iam:PassedToService': 'sagemaker.amazonaws.com' } },
      }),
    );
    if (d.groot?.SageMakerRoleArn) svc.controllerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'], resources: [d.groot.SageMakerRoleArn],
      conditions: { StringEquals: { 'iam:PassedToService': 'sagemaker.amazonaws.com' } },
    }));
    if (pipelineArn) {
      const packages = `arn:aws:sagemaker:${props.region}:${props.accountId}:model-package/groot-sm-models-${props.accountId}/*`;
      for (const reader of [role, svc.controllerRole]) {
        reader.addToPolicy(new iam.PolicyStatement({
          actions: ['sagemaker:StartPipelineExecution'], resources: [pipelineArn],
        }));
        reader.addToPolicy(new iam.PolicyStatement({
          sid: 'PipelineArchiveEvidence',
          actions: ['sagemaker:DescribePipeline', 'sagemaker:DescribePipelineExecution', 'sagemaker:DescribePipelineDefinitionForExecution',
            'sagemaker:ListPipelineExecutions', 'sagemaker:ListPipelineExecutionSteps', 'sagemaker:ListPipelineParametersForExecution'],
          resources: [pipelineArn, `${pipelineArn}/execution/*`],
        }));
        reader.addToPolicy(new iam.PolicyStatement({
          sid: 'PipelineJobEvidence', actions: ['sagemaker:DescribeTrainingJob', 'sagemaker:DescribeProcessingJob'],
          resources: [`arn:aws:sagemaker:${props.region}:${props.accountId}:training-job/*`, `arn:aws:sagemaker:${props.region}:${props.accountId}:processing-job/*`],
        }));
        reader.addToPolicy(new iam.PolicyStatement({ sid: 'ConfiguredModelPackageEvidence',
          actions: ['sagemaker:DescribeModelPackage'], resources: [packages] }));
      }
      role.addToPolicy(new iam.PolicyStatement({
        actions: ['sagemaker:StopPipelineExecution'], resources: [`${pipelineArn}/execution/*`],
      }));
      // Stop a single training job started by the pipeline (SageMaker names them `pipelines-<execution-id>-<step>-…`).
      role.addToPolicy(new iam.PolicyStatement({
        sid: 'StopPipelineTrainingJob', actions: ['sagemaker:StopTrainingJob'],
        resources: [`arn:aws:sagemaker:${props.region}:${props.accountId}:training-job/pipelines-*`],
      }));
      role.addToPolicy(new iam.PolicyStatement({ sid: 'ExplicitVerifiedModelApproval',
        actions: ['sagemaker:UpdateModelPackage'], resources: [packages] }));
    }
    role.addToPolicy(new iam.PolicyStatement({ sid: 'Eks', actions: ['eks:DescribeCluster', 'eks:ListAddons', 'eks:DescribeAddon', 'eks:ListClusters'], resources: ['*'] }));
    role.addToPolicy(new iam.PolicyStatement({ sid: 'Sts', actions: ['sts:GetCallerIdentity'], resources: ['*'] }));
    role.addToPolicy(new iam.PolicyStatement({ sid: 'Amp', actions: ['aps:QueryMetrics', 'aps:GetLabels', 'aps:GetSeries', 'aps:GetMetricMetadata', 'aps:DescribeWorkspace'], resources: ['*'] }));
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'Fsx',
        actions: ['fsx:DescribeFileSystems', 'fsx:DescribeDataRepositoryAssociations', 'fsx:DescribeDataRepositoryTasks', 'fsx:CreateDataRepositoryTask', 'fsx:TagResource'],
        resources: ['*'],
      }),
    );
    if (props.buckets.length) {
      role.addToPolicy(new iam.PolicyStatement({ sid: 'S3Buckets', actions: ['s3:ListBucket', 's3:GetBucketLocation'], resources: props.buckets.map((b) => `arn:aws:s3:::${b}`) }));
      role.addToPolicy(new iam.PolicyStatement({ sid: 'S3Objects', actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload'], resources: props.buckets.map((b) => `arn:aws:s3:::${b}/*`) }));
    }
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CloudWatchLogsRead',
        actions: ['logs:DescribeLogGroups', 'logs:DescribeLogStreams', 'logs:GetLogEvents', 'logs:FilterLogEvents', 'logs:StartLiveTail'],
        resources: ['*'],
      }),
    );
    role.addToPolicy(new iam.PolicyStatement({ sid: 'Ec2Describe', actions: ['ec2:DescribeInstances', 'ec2:DescribeInstanceStatus'], resources: ['*'] }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'ImageProfileInspection',
      actions: ['ecr:DescribeImages', 'ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
      resources: [`arn:aws:ecr:${props.region}:${props.accountId}:repository/*`],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'ImageProfileDiscovery', actions: ['ecr:GetAuthorizationToken', 'ec2:DescribeInstanceTypes'], resources: ['*'],
    }));
    if (d.isaacLab?.InstanceId) {
      role.addToPolicy(
        new iam.PolicyStatement({
          sid: 'DcvInstanceControl',
          actions: ['ec2:StartInstances', 'ec2:StopInstances'],
          resources: [`arn:aws:ec2:${props.region}:${props.accountId}:instance/${d.isaacLab.InstanceId}`],
        }),
      );
      const instanceArn = `arn:aws:ec2:${props.region}:${props.accountId}:instance/${d.isaacLab.InstanceId}`;
      role.addToPolicy(new iam.PolicyStatement({
        actions: ['ssm:SendCommand'], resources: [instanceArn, `arn:aws:ssm:${props.region}::document/AWS-RunShellScript`],
      }));
      for (const reader of [role, svc.controllerRole]) reader.addToPolicy(new iam.PolicyStatement({ actions: ['ssm:GetCommandInvocation'], resources: ['*'] }));
      svc.gatewayRole.addToPolicy(new iam.PolicyStatement({
        actions: ['ssm:StartSession'], resources: [instanceArn, `arn:aws:ssm:${props.region}::document/AWS-StartPortForwardingSession`],
      }));
      svc.gatewayRole.addToPolicy(new iam.PolicyStatement({
        actions: ['ssm:TerminateSession', 'ssmmessages:OpenDataChannel'],
        resources: [`arn:aws:ssm:${props.region}:${props.accountId}:session/*`],
      }));
    }
    if (d.isaacLab?.SecretArn) {
      role.addToPolicy(new iam.PolicyStatement({ sid: 'DcvSecret', actions: ['secretsmanager:GetSecretValue'], resources: [d.isaacLab.SecretArn] }));
    }
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SsmCredentialParameters',
        actions: ['ssm:GetParameter'],
        resources: [`arn:aws:ssm:${props.region}:${props.accountId}:parameter/groot/*`, `arn:aws:ssm:${props.region}:${props.accountId}:parameter/physical-ai/*`, `arn:aws:ssm:${props.region}:${props.accountId}:parameter/pai/*`],
      }),
    );
    role.addToPolicy(new iam.PolicyStatement({ sid: 'KmsForSecureStrings', actions: ['kms:Decrypt'], resources: ['*'], conditions: { StringEquals: { 'kms:ViaService': `ssm.${props.region}.amazonaws.com` } } }));
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'Greengrass',
        actions: [
          'greengrass:ListCoreDevices',
          'greengrass:ListComponents',
          'greengrass:ListDeployments',
          'greengrass:ListEffectiveDeployments',
          'greengrass:ListInstalledComponents',
          'greengrass:CreateDeployment',
          'greengrass:GetDeployment',
          'greengrass:GetCoreDevice',
          'greengrass:GetComponent',
          'greengrass:DescribeComponent',
          'greengrass:ResolveComponentCandidates',
          'iot:DescribeThingGroup',
          'iot:ListThingsInThingGroup',
          'iot:DescribeJob',
          'iot:CreateJob',
          'iot:DescribeThing',
        ],
        resources: ['*'],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CognitoUserAdmin',
        actions: [
          'cognito-idp:ListUsers',
          'cognito-idp:ListGroups',
          'cognito-idp:AdminListGroupsForUser',
          'cognito-idp:AdminGetUser',
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminSetUserPassword',
          'cognito-idp:AdminAddUserToGroup',
          'cognito-idp:AdminRemoveUserFromGroup',
        ],
        resources: [auth.userPool.userPoolArn],
      }),
    );
    role.addToPolicy(new iam.PolicyStatement({ sid: 'CostExplorer', actions: ['ce:GetCostAndUsage'], resources: ['*'] }));
    for (const reader of [svc.gatewayRole, svc.controllerRole]) reader.addToPolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:AdminGetUser', 'cognito-idp:AdminListGroupsForUser'],
      resources: [auth.userPool.userPoolArn],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'ProjectCredentialManagement', actions: ['ssm:PutParameter', 'ssm:DeleteParameter'],
      resources: [`arn:aws:ssm:${props.region}:${props.accountId}:parameter/physical-ai/projects/*`],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'ProjectCredentialEncryption', actions: ['kms:Encrypt'], resources: ['*'],
      conditions: { StringEquals: { 'kms:ViaService': `ssm.${props.region}.amazonaws.com` } },
    }));

    // ------------------------------------------------------------------ EKS network + access entry
    if (props.eksClusterSecurityGroupId) {
      new ec2.CfnSecurityGroupIngress(this, 'EksControlPlaneIngress', {
        groupId: props.eksClusterSecurityGroupId,
        ipProtocol: 'tcp',
        fromPort: 443,
        toPort: 443,
        sourceSecurityGroupId: svc.serviceSecurityGroup.securityGroupId,
        description: 'Physical AI Dashboard to EKS API private endpoint',
      });
    }
    // Preserve the existing deployment's legacy workflow identity. New scoped
    // workloads use pai-workload and receive no ambient AWS credentials.
    if (d.hyperPodEks?.EksClusterName) {
      const podRole = new iam.Role(this, 'WorkflowPodRole', {
        roleName: `${prefix}-workflow-pods`,
        assumedBy: new iam.ServicePrincipal('pods.eks.amazonaws.com').withSessionTags(),
        description: 'Physical AI Dashboard workflow pods (EKS Pod Identity): dataset/model S3 export, MLflow logging, SSM credentials',
      });
      podRole.addToPolicy(new iam.PolicyStatement({
        sid: 'MlflowTracking', actions: ['sagemaker-mlflow:*'],
        resources: props.mlflowTrackingServerArns?.length ? props.mlflowTrackingServerArns : [`arn:aws:sagemaker:${props.region}:${props.accountId}:mlflow-tracking-server/*`],
      }));
      if (props.buckets.length) {
        podRole.addToPolicy(new iam.PolicyStatement({ sid: 'S3Buckets', actions: ['s3:ListBucket', 's3:GetBucketLocation'], resources: props.buckets.map((bucket) => `arn:aws:s3:::${bucket}`) }));
        podRole.addToPolicy(new iam.PolicyStatement({ sid: 'S3Objects', actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts'], resources: props.buckets.map((bucket) => `arn:aws:s3:::${bucket}/*`) }));
      }
      podRole.addToPolicy(new iam.PolicyStatement({
        sid: 'SsmCredentialParameters', actions: ['ssm:GetParameter'],
        resources: [`arn:aws:ssm:${props.region}:${props.accountId}:parameter/groot/*`, `arn:aws:ssm:${props.region}:${props.accountId}:parameter/physical-ai/*`, `arn:aws:ssm:${props.region}:${props.accountId}:parameter/pai/*`],
      }));
      podRole.addToPolicy(new iam.PolicyStatement({ sid: 'KmsForSecureStrings', actions: ['kms:Decrypt'], resources: ['*'], conditions: { StringEquals: { 'kms:ViaService': `ssm.${props.region}.amazonaws.com` } } }));
      for (const namespace of props.workflowNamespaces ?? ['rl', 'hyperpod-ns-team-a', 'hyperpod-ns-team-b']) {
        new eks.CfnPodIdentityAssociation(this, `PodIdentity-${namespace}`, { clusterName: d.hyperPodEks.EksClusterName, namespace, serviceAccount: 'pai-workflow', roleArn: podRole.roleArn });
      }
      new cdk.CfnOutput(this, 'WorkflowPodRoleArn', { value: podRole.roleArn, description: 'IAM role assumed by workflow pods via ServiceAccount pai-workflow' });
    }
    if (d.hyperPodEks?.EksClusterName) {
      const entry = new eks.CfnAccessEntry(this, 'EksAccessEntry', {
        clusterName: d.hyperPodEks.EksClusterName,
        principalArn: role.roleArn,
        type: 'STANDARD',
        kubernetesGroups: ['physical-ai:web'],
      });
      entry.node.addDependency(role);
      svc.service.node.addDependency(entry);
      const controllerEntry = new eks.CfnAccessEntry(this, 'ControllerEksAccessEntry', {
        clusterName: d.hyperPodEks.EksClusterName,
        principalArn: svc.controllerRole.roleArn,
        type: 'STANDARD',
        kubernetesGroups: ['physical-ai:controller'],
      });
      svc.controllerService.node.addDependency(controllerEntry);
      const gatewayEntry = new eks.CfnAccessEntry(this, 'GatewayEksAccessEntry', {
        clusterName: d.hyperPodEks.EksClusterName, principalArn: svc.gatewayRole.roleArn,
        type: 'STANDARD', kubernetesGroups: ['physical-ai:gateway'],
      });
      svc.gatewayService.node.addDependency(gatewayEntry);
    }

    // ------------------------------------------------------------------ Outputs
    new cdk.CfnOutput(this, 'DashboardUrl', { value: `https://${props.domainName}/`, description: 'Dashboard (Cognito login)' });
    new cdk.CfnOutput(this, 'AlbDnsName', { value: svc.loadBalancer.loadBalancerDnsName });
    new cdk.CfnOutput(this, 'AdminCredentialsSecret', { value: auth.adminSecret.secretName, description: 'Secrets Manager secret with the bootstrap admin username/password' });
    new cdk.CfnOutput(this, 'AdminCredentialsCommand', {
      value: `aws secretsmanager get-secret-value --secret-id ${auth.adminSecret.secretName} --region ${props.region} --query SecretString --output text`,
    });
    new cdk.CfnOutput(this, 'UserPoolId', { value: auth.userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: auth.userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'TableName', { value: table.table.tableName });
    new cdk.CfnOutput(this, 'TaskRoleArn', { value: role.roleArn });
    new cdk.CfnOutput(this, 'LogGroupName', { value: svc.logGroup.logGroupName });
    new cdk.CfnOutput(this, 'EcsServiceName', { value: svc.service.serviceName });
    new cdk.CfnOutput(this, 'EcsClusterName', { value: svc.service.cluster.clusterName });
    new cdk.CfnOutput(this, 'NotificationsTopicArn', { value: topic.topicArn });
    new cdk.CfnOutput(this, 'DiscoveredStacks', {
      value: [d.hyperPodEks && 'HyperPodEks', d.hyperPodSlurm && 'HyperPod', d.groot && 'GrootFinetune', d.isaacLab && 'IsaacLab'].filter(Boolean).join(', ') || 'none',
    });
    new cdk.CfnOutput(this, 'ControllerRoleArn', { value: svc.controllerRole.roleArn });
    new cdk.CfnOutput(this, 'ControllerServiceName', { value: svc.controllerService.serviceName });
    new cdk.CfnOutput(this, 'ArtifactBucketName', { value: artifacts.bucket.bucketName });
    new cdk.CfnOutput(this, 'GatewayServiceName', { value: svc.gatewayService.serviceName });
  }
}
