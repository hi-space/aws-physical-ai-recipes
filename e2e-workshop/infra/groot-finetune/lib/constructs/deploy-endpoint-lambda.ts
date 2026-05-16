import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as fs from 'fs';
import * as path from 'path';
import { Construct } from 'constructs';

export interface DeployEndpointLambdaProps {
  functionName: string;
  roleName: string;
  /** Lambda가 SageMaker Model에 PassRole 할 SageMaker 실행 역할 ARN. */
  sageMakerRoleArn: string;
}

/**
 * Pipeline LambdaStep용 endpoint 통합 배포 Lambda.
 *   - 핸들러 코드는 ../../../pipeline/lambda_deploy_endpoint.py를 inline으로 패킹.
 *   - cleanup → create_model → create_endpoint_config → create_endpoint atomic 수행.
 */
export class DeployEndpointLambda extends Construct {
  public readonly function: lambda.Function;

  constructor(scope: Construct, id: string, props: DeployEndpointLambdaProps) {
    super(scope, id);

    const lambdaSrcPath = path.resolve(
      __dirname,
      '..',
      '..',
      'lambda',
      'deploy-endpoint',
      'index.py',
    );
    const code = fs.readFileSync(lambdaSrcPath, 'utf-8');

    const role = new iam.Role(this, 'Role', {
      roleName: props.roleName,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaBasicExecutionRole',
        ),
      ],
    });

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SageMakerEndpointAndModel',
        actions: [
          'sagemaker:DescribeEndpoint',
          'sagemaker:DescribeEndpointConfig',
          'sagemaker:DeleteEndpoint',
          'sagemaker:DeleteEndpointConfig',
          'sagemaker:DeleteModel',
          'sagemaker:CreateModel',
          'sagemaker:CreateEndpointConfig',
          'sagemaker:CreateEndpoint',
          'sagemaker:AddTags',
        ],
        resources: ['*'],
      }),
    );

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PassExecutionRole',
        actions: ['iam:PassRole'],
        resources: [props.sageMakerRoleArn],
        conditions: {
          StringEquals: { 'iam:PassedToService': 'sagemaker.amazonaws.com' },
        },
      }),
    );

    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/aws/lambda/${props.functionName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.function = new lambda.Function(this, 'Function', {
      functionName: props.functionName,
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'index.handler',
      role,
      timeout: cdk.Duration.seconds(600),
      memorySize: 256,
      code: lambda.Code.fromInline(code),
      logGroup,
    });
  }
}
