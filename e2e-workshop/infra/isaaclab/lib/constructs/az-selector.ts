/**
 * AzSelectorConstruct
 *
 * Custom Resource Lambda를 사용하여 배포 시점에 GPU 인스턴스 capacity가 있는
 * 가용 영역과 인스턴스 타입을 자동으로 탐색하고, 찾은 capacity를 **온디맨드
 * 용량 예약(ODCR)** 으로 잠시 붙잡아 두는 Construct.
 *
 * 왜 예약인가:
 *   과거에는 probe 인스턴스를 띄웠다 바로 종료하는 방식이었는데, probe 성공과
 *   실제 DCV 인스턴스 생성 사이에 FSx 생성(~10분+)이 끼어 있어 그 사이 GPU
 *   capacity가 소진되는 레이스(TOCTOU)가 자주 발생했다. 이제는 capacity를 찾는
 *   순간 InstanceMatchCriteria='open' 예약을 만들어 두므로, 이후 같은 타입/AZ로
 *   뜨는 DCV 인스턴스가 자동으로 이 예약에 매칭되어 확정적으로 기동한다.
 *
 * 동작 방식:
 * 1. 인스턴스 타입 fallback 리스트를 순차 시도
 * 2. 각 인스턴스 타입에 대해 describe-instance-type-offerings로 지원 AZ 목록 조회
 * 3. AZ 목록을 셔플하여 특정 AZ 집중 방지
 * 4. 각 AZ에서 CreateCapacityReservation (1대, 3시간 한정, open 매칭) 시도
 * 5. 성공하면 해당 AZ + 인스턴스 타입 반환 (예약은 3시간 후 자동 만료 — 배포
 *    완료 후 인스턴스가 계속 예약을 점유하다가 만료돼도 인스턴스는 영향 없음)
 * 6. InsufficientInstanceCapacity이면 다음 AZ 시도
 * 7. 해당 타입의 모든 AZ 실패 시 다음 인스턴스 타입으로 fallback
 * 8. 모든 타입/AZ 실패 시 에러 반환
 * 9. 스택 삭제/롤백 시 예약을 취소 (이미 만료됐으면 무시)
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
  /** (미사용 — 과거 probe 방식과의 호환을 위해 남김) */
  amiId?: string;
}

/** 기본 인스턴스 타입 fallback 순서 */
export const DEFAULT_INSTANCE_TYPE_FALLBACK = [
  'g6e.4xlarge',  // L40S × 1 — 고성능 단일 GPU (vCPU 16, 128GB)
  'g6.4xlarge',   // L4 × 1 — 단일 GPU (vCPU 16, 64GB)
  'g6e.8xlarge',  // L40S × 1 — 4xlarge와 GPU 동일, vCPU/RAM 2배 (vCPU 32, 256GB)
  'g6.8xlarge',   // L4 × 1 — 4xlarge와 GPU 동일, vCPU/RAM 2배 (vCPU 32, 128GB)
  'g6.12xlarge',  // L4 × 4 — 분산 학습 최적
  'g6e.12xlarge', // L40S × 4 — 고성능 분산 학습
  'g6e.2xlarge',  // L40S × 1 — 최후 수단 (vCPU 8, 64GB: 시뮬레이션 로딩이 느릴 수 있음)
  'g6.2xlarge',   // L4 × 1 — 정말 최후 수단 (vCPU 8, 32GB: RAM이 Isaac Sim 최소 사양 수준, OOM 주의)
];

/**
 * 배포 시점에 GPU capacity가 있는 AZ와 인스턴스 타입을 자동 탐색하고
 * 용량 예약으로 확보하는 Construct
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
                'ec2:CreateCapacityReservation',
                'ec2:CancelCapacityReservation',
                'ec2:DescribeCapacityReservations',
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
      description: 'Finds AZ + instance type with GPU capacity and holds it with a short-lived ODCR',
    });

    const probeName = `${cdk.Stack.of(this).stackName}-AzProbe`;

    const customResource = new cdk.CustomResource(this, 'AzSelectorResource', {
      serviceToken: azSelectorFn.functionArn,
      properties: {
        InstanceTypes: props.instanceTypes.join(','),
        ProbeName: probeName,
        // 주의: Timestamp 같은 매번 바뀌는 값을 넣으면 안 된다. 재배포 때마다
        // 셀렉터가 다시 실행되어 AZ가 바뀌면 서브넷/인스턴스 교체(replacement)가
        // 발생하고, 같은 CIDR의 새 서브넷 생성이 충돌해 업데이트가 실패한다.
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
 * capacity를 찾으면 3시간 한정 open 용량 예약을 만들어 배포가 끝날 때까지
 * capacity를 확보한다. PhysicalResourceId에 예약 ID를 넣어 Delete 시 취소한다.
 */
const AZ_SELECTOR_LAMBDA_CODE = `
import json
import boto3
import random
import datetime
import cfnresponse

RESERVATION_HOURS = 3

def handler(event, context):
    print(json.dumps(event))
    region = context.invoked_function_arn.split(':')[3]
    ec2 = boto3.client('ec2', region_name=region)

    if event['RequestType'] == 'Delete':
        # PhysicalResourceId: 'az-selector-cr-<reservation-id>' 형태면 예약 취소
        pid = event.get('PhysicalResourceId', '')
        if pid.startswith('az-selector-cr-'):
            cr_id = pid.replace('az-selector-cr-', '')
            try:
                ec2.cancel_capacity_reservation(CapacityReservationId=cr_id)
                print(f'Cancelled capacity reservation {cr_id}')
            except Exception as e:
                print(f'Cancel skipped ({cr_id}): {e}')  # 이미 만료/취소된 경우
        cfnresponse.send(event, context, cfnresponse.SUCCESS, {},
            physicalResourceId=pid or 'az-selector-deleted')
        return

    try:
        instance_types = event['ResourceProperties']['InstanceTypes'].split(',')
        probe_name = event['ResourceProperties'].get('ProbeName', 'az-selector-probe')

        all_tried = []
        end_date = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=RESERVATION_HOURS)

        for instance_type in instance_types:
            print(f'--- Trying instance type: {instance_type} ---')

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
                    cr = ec2.create_capacity_reservation(
                        InstanceType=instance_type,
                        InstancePlatform='Linux/UNIX',
                        AvailabilityZone=az,
                        InstanceCount=1,
                        InstanceMatchCriteria='open',
                        EndDateType='limited',
                        EndDate=end_date,
                        TagSpecifications=[{
                            'ResourceType': 'capacity-reservation',
                            'Tags': [{'Key': 'Name', 'Value': probe_name}]
                        }]
                    )
                    cr_id = cr['CapacityReservation']['CapacityReservationId']
                    print(f'SUCCESS: reserved {instance_type} in {az} ({cr_id}, expires {end_date.isoformat()})')

                    cfnresponse.send(event, context, cfnresponse.SUCCESS,
                        {'AvailabilityZone': az, 'InstanceType': instance_type,
                         'CapacityReservationId': cr_id},
                        physicalResourceId=f'az-selector-cr-{cr_id}')
                    return

                except Exception as e:
                    error_msg = str(e)
                    if 'InsufficientInstanceCapacity' in error_msg or 'ReservationCapacityExceeded' in error_msg:
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
