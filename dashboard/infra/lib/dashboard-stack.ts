import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import { AuthConstruct } from './constructs/auth';
import { ServiceConstruct } from './constructs/service';
import { TableConstruct } from './constructs/table';
import { buildEnv, type DiscoveredOutputs } from './env-contract';

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
  /** Namespaces whose `pai-workflow` ServiceAccount is bound to the workflow-pods IAM role (EKS Pod Identity). */
  workflowNamespaces: string[];
  /** MLflow tracking servers the workflow pods may log to (ARNs); defaults to every server in the account. */
  mlflowTrackingServerArns?: string[];
}

/** ServiceAccount name the controller attaches to every workflow Job. */
export const WORKFLOW_SERVICE_ACCOUNT = 'pai-workflow';

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
    const topic = new sns.Topic(this, 'Notifications', { topicName: `${prefix}-notifications`, displayName: 'Physical AI Dashboard' });
    if (props.notifyEmail) topic.addSubscription(new subs.EmailSubscription(props.notifyEmail));

    const auth = new AuthConstruct(this, 'Auth', { accountId: props.accountId, domainName: props.domainName, adminUsername: props.adminUsername, adminEmail: props.adminEmail });

    const environment = buildEnv(d, {
      TABLE_NAME: table.table.tableName,
      SNS_TOPIC_ARN: topic.topicArn,
      WORKFLOW_SERVICE_ACCOUNT: d.hyperPodEks?.EksClusterName ? WORKFLOW_SERVICE_ACCOUNT : undefined,
    });

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
    });

    // ------------------------------------------------------------------ IAM
    const role = svc.taskRole;
    table.table.grantReadWriteData(role);
    topic.grantPublish(role);

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'HyperPodAndSageMaker',
        actions: [
          'sagemaker:ListClusters',
          'sagemaker:DescribeCluster',
          'sagemaker:ListClusterNodes',
          'sagemaker:DescribeClusterNode',
          'sagemaker:UpdateCluster',
          'sagemaker:ListClusterEvents',
          'sagemaker:DescribeClusterEvent',
          'sagemaker:ListComputeQuotas',
          'sagemaker:DescribeComputeQuota',
          'sagemaker:CreateComputeQuota',
          'sagemaker:DeleteComputeQuota',
          'sagemaker:ListClusterSchedulerConfigs',
          'sagemaker:DescribeClusterSchedulerConfig',
          'sagemaker:CreateClusterSchedulerConfig',
          'sagemaker:DeleteClusterSchedulerConfig',
          'sagemaker:DescribePipeline',
          'sagemaker:ListPipelineExecutions',
          'sagemaker:StartPipelineExecution',
          'sagemaker:DescribePipelineExecution',
          'sagemaker:ListPipelineExecutionSteps',
          'sagemaker:ListPipelineParametersForExecution',
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
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PassRoleToSageMakerPipeline',
        actions: ['iam:PassRole'],
        resources: [`arn:aws:iam::${props.accountId}:role/*`],
        conditions: { StringEquals: { 'iam:PassedToService': 'sagemaker.amazonaws.com' } },
      }),
    );
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
    if (d.isaacLab?.InstanceId) {
      role.addToPolicy(
        new iam.PolicyStatement({
          sid: 'DcvInstanceControl',
          actions: ['ec2:StartInstances', 'ec2:StopInstances'],
          resources: [`arn:aws:ec2:${props.region}:${props.accountId}:instance/${d.isaacLab.InstanceId}`],
        }),
      );
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
          'greengrass:DescribeComponent',
          'greengrass:ResolveComponentCandidates',
          'iot:DescribeThingGroup',
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
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminSetUserPassword',
          'cognito-idp:AdminAddUserToGroup',
          'cognito-idp:AdminRemoveUserFromGroup',
        ],
        resources: [auth.userPool.userPoolArn],
      }),
    );
    role.addToPolicy(new iam.PolicyStatement({ sid: 'CostExplorer', actions: ['ce:GetCostAndUsage'], resources: ['*'] }));

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
    // ------------------------------------------------------------------ Workflow pods identity
    // HyperPod EKS nodes block IMDS from pods and the cluster ships the eks-pod-identity-agent addon, so the
    // only way a training/eval/register step can reach S3 or MLflow is a Pod Identity association. The
    // controller creates the `pai-workflow` ServiceAccount in each workflow namespace and sets it on every Job.
    if (d.hyperPodEks?.EksClusterName) {
      const podRole = new iam.Role(this, 'WorkflowPodRole', {
        roleName: `${prefix}-workflow-pods`,
        assumedBy: new iam.ServicePrincipal('pods.eks.amazonaws.com').withSessionTags(),
        description: 'Physical AI Dashboard workflow pods (EKS Pod Identity): dataset/model S3 export, MLflow logging, SSM credentials',
      });
      podRole.addToPolicy(
        new iam.PolicyStatement({
          sid: 'MlflowTracking',
          actions: ['sagemaker-mlflow:*'],
          resources: props.mlflowTrackingServerArns?.length ? props.mlflowTrackingServerArns : [`arn:aws:sagemaker:${props.region}:${props.accountId}:mlflow-tracking-server/*`],
        }),
      );
      if (props.buckets.length) {
        podRole.addToPolicy(new iam.PolicyStatement({ sid: 'S3Buckets', actions: ['s3:ListBucket', 's3:GetBucketLocation'], resources: props.buckets.map((b) => `arn:aws:s3:::${b}`) }));
        podRole.addToPolicy(new iam.PolicyStatement({ sid: 'S3Objects', actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts'], resources: props.buckets.map((b) => `arn:aws:s3:::${b}/*`) }));
      }
      podRole.addToPolicy(
        new iam.PolicyStatement({
          sid: 'SsmCredentialParameters',
          actions: ['ssm:GetParameter'],
          resources: [`arn:aws:ssm:${props.region}:${props.accountId}:parameter/groot/*`, `arn:aws:ssm:${props.region}:${props.accountId}:parameter/physical-ai/*`, `arn:aws:ssm:${props.region}:${props.accountId}:parameter/pai/*`],
        }),
      );
      podRole.addToPolicy(new iam.PolicyStatement({ sid: 'KmsForSecureStrings', actions: ['kms:Decrypt'], resources: ['*'], conditions: { StringEquals: { 'kms:ViaService': `ssm.${props.region}.amazonaws.com` } } }));
      for (const ns of props.workflowNamespaces) {
        new eks.CfnPodIdentityAssociation(this, `PodIdentity-${ns}`, {
          clusterName: d.hyperPodEks.EksClusterName,
          namespace: ns,
          serviceAccount: WORKFLOW_SERVICE_ACCOUNT,
          roleArn: podRole.roleArn,
        });
      }
      new cdk.CfnOutput(this, 'WorkflowPodRoleArn', { value: podRole.roleArn, description: `IAM role assumed by workflow pods via ServiceAccount ${WORKFLOW_SERVICE_ACCOUNT}` });
    }

    if (d.hyperPodEks?.EksClusterName) {
      const entry = new eks.CfnAccessEntry(this, 'EksAccessEntry', {
        clusterName: d.hyperPodEks.EksClusterName,
        principalArn: role.roleArn,
        type: 'STANDARD',
        accessPolicies: [{ policyArn: 'arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy', accessScope: { type: 'cluster' } }],
      });
      entry.node.addDependency(role);
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
  }
}
