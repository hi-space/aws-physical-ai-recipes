/**
 * AzSelectorConstruct
 *
 * Custom Resource Lambda를 사용하여 배포 시점에 GPU 인스턴스 capacity가 있는
 * 가용 영역과 인스턴스 타입을 자동으로 탐색하는 Construct.
 *
 * 동작 방식:
 * 1. 인스턴스 타입 fallback 리스트를 순차 시도 (예: g6.12xlarge → g5.12xlarge → g6.xlarge → g5.xlarge)
 * 2. 각 인스턴스 타입에 대해 describe-instance-type-offerings로 지원 AZ 목록 조회
 * 3. AZ 목록을 셔플하여 특정 AZ 집중 방지
 * 4. 각 AZ에서 RunInstances (MinCount=1) 시도
 * 5. 성공하면 즉시 terminate하고 해당 AZ + 인스턴스 타입 반환
 * 6. InsufficientInstanceCapacity이면 다음 AZ 시도
 * 7. 해당 타입의 모든 AZ 실패 시 다음 인스턴스 타입으로 fallback
 * 8. 모든 타입/AZ 실패 시 에러 반환
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

/**
 * AzSelectorConstruct Props
 */
export interface AzSelectorProps {
  /** 인스턴스 타입 fallback 리스트 (우선순위 순) */
  instanceTypes: string[];
  /** 탐색에 사용할 AMI ID */
  amiId: string;
}

/** 기본 인스턴스 타입 fallback 순서 */
export const DEFAULT_INSTANCE_TYPE_FALLBACK = [
  'g6e.4xlarge',  // L40S × 1 — 고성능 단일 GPU
  'g6.4xlarge',   // L4 × 1 — 단일 GPU (vCPU 16, 64GB)
  'g6.12xlarge',  // L4 × 4 — 분산 학습 최적
  'g6e.12xlarge', // L40S × 4 — 고성능 분산 학습
];

/**
 * 배포 시점에 GPU capacity가 있는 AZ와 인스턴스 타입을 자동 탐색하는 Construct
 */
export class AzSelectorConstruct extends Construct {
  /** 탐색된 가용 영역 이름 (CloudFormation 런타임 값) */
  public readonly availabilityZone: string;
  /** 탐색된 인스턴스 타입 (CloudFormation 런타임 값) */
  public readonly resolvedInstanceType: string;

  constructor(scope: Construct, id: string, props: AzSelectorProps) {
    super(scope, id);

    const lambdaRole = new iam.Role(this, 'AzSelectorRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
      inlinePolicies: {
        AzSelectorPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'ec2:DescribeInstanceTypeOfferings',
                'ec2:RunInstances',
                'ec2:TerminateInstances',
                'ec2:DescribeInstances',
                'ec2:CreateTags',
              ],
              resources: ['*'],
            }),
          ],
        }),
      },
    });

    const azSelectorFn = new lambda.Function(this, 'AzSelectorFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      role: lambdaRole,
      timeout: cdk.Duration.minutes(10),
      code: lambda.Code.fromInline(AZ_SELECTOR_LAMBDA_CODE),
      description: 'Finds AZ + instance type with GPU capacity by trial launch with fallback',
    });

    const customResource = new cdk.CustomResource(this, 'AzSelectorResource', {
      serviceToken: azSelectorFn.functionArn,
      properties: {
        InstanceTypes: props.instanceTypes.join(','),
        AmiId: props.amiId,
        Timestamp: Date.now().toString(),
      },
    });

    azSelectorFn.addPermission('CfnInvoke', {
      principal: new iam.ServicePrincipal('cloudformation.amazonaws.com'),
    });

    this.availabilityZone = customResource.getAttString('AvailabilityZone');
    this.resolvedInstanceType = customResource.getAttString('InstanceType');
  }
}

/**
 * AZ + 인스턴스 타입 탐색 Lambda 코드 (Python 인라인)
 *
 * 인스턴스 타입 fallback 리스트를 순차 시도하여
 * capacity가 있는 AZ + 인스턴스 타입 조합을 찾는다.
 */
const AZ_SELECTOR_LAMBDA_CODE = `
import json
import boto3
import random
import cfnresponse

def handler(event, context):
    print(json.dumps(event))

    if event['RequestType'] == 'Delete':
        cfnresponse.send(event, context, cfnresponse.SUCCESS, {},
            physicalResourceId=event.get('PhysicalResourceId', 'az-selector-deleted'))
        return

    try:
        instance_types = event['ResourceProperties']['InstanceTypes'].split(',')
        ami_id = event['ResourceProperties']['AmiId']
        region = context.invoked_function_arn.split(':')[3]

        ec2 = boto3.client('ec2', region_name=region)

        all_tried = []

        for instance_type in instance_types:
            print(f'--- Trying instance type: {instance_type} ---')

            # 지원 AZ 목록 조회
            resp = ec2.describe_instance_type_offerings(
                LocationType='availability-zone',
                Filters=[{'Name': 'instance-type', 'Values': [instance_type]}]
            )
            azs = [o['Location'] for o in resp['InstanceTypeOfferings']]
            print(f'Supported AZs for {instance_type}: {azs}')

            if not azs:
                print(f'{instance_type} is not available in any AZ, skipping...')
                all_tried.append(f'{instance_type}(no AZ)')
                continue

            random.shuffle(azs)

            for az in azs:
                print(f'Trying {instance_type} in {az}')
                try:
                    run_resp = ec2.run_instances(
                        InstanceType=instance_type,
                        ImageId=ami_id,
                        MinCount=1,
                        MaxCount=1,
                        Placement={'AvailabilityZone': az},
                        TagSpecifications=[{
                            'ResourceType': 'instance',
                            'Tags': [{'Key': 'Name', 'Value': 'az-selector-probe'}]
                        }]
                    )
                    instance_id = run_resp['Instances'][0]['InstanceId']
                    print(f'SUCCESS: {instance_type} in {az} (probe: {instance_id})')

                    ec2.terminate_instances(InstanceIds=[instance_id])
                    print(f'Terminated probe {instance_id}')

                    cfnresponse.send(event, context, cfnresponse.SUCCESS,
                        {'AvailabilityZone': az, 'InstanceType': instance_type},
                        physicalResourceId=f'az-selector-{az}-{instance_type}')
                    return

                except Exception as e:
                    error_msg = str(e)
                    if 'InsufficientInstanceCapacity' in error_msg:
                        print(f'InsufficientCapacity: {instance_type} in {az}')
                        all_tried.append(f'{instance_type}/{az}')
                        continue
                    elif 'Unsupported' in error_msg:
                        print(f'Unsupported: {instance_type} in {az}')
                        all_tried.append(f'{instance_type}/{az}(unsupported)')
                        continue
                    else:
                        print(f'Unexpected error: {e}')
                        raise

            print(f'All AZs exhausted for {instance_type}, falling back...')

        cfnresponse.send(event, context, cfnresponse.FAILED, {},
            reason=f'No capacity available for any instance type in any AZ: {all_tried}',
            physicalResourceId='az-selector-failed')

    except Exception as e:
        print(f'Error: {e}')
        cfnresponse.send(event, context, cfnresponse.FAILED, {},
            reason=str(e),
            physicalResourceId='az-selector-error')
`;
