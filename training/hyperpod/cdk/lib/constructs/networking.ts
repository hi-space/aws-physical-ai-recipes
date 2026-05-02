import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export interface NetworkingProps {
  namePrefix: string;
  vpcCidr?: string;
  createVpc?: boolean;
  userId?: string;
}

export class NetworkingConstruct extends Construct {
  public readonly vpcId: string;
  public readonly privateSubnetId: string;
  public readonly vpc?: ec2.CfnVPC;
  public readonly publicSubnet?: ec2.CfnSubnet;
  public readonly privateSubnet?: ec2.CfnSubnet;
  public readonly privateRouteTable?: ec2.CfnRouteTable;

  constructor(scope: Construct, id: string, props: NetworkingProps) {
    super(scope, id);
    const createVpc = props.createVpc ?? true;
    const p = props.namePrefix;

    if (!createVpc) {
      // Lookup existing VPC by UserId tag
      const vpcLookup = new cr.AwsCustomResource(this, 'VpcLookup', {
        onCreate: {
          service: 'EC2',
          action: 'describeVpcs',
          parameters: { Filters: [{ Name: 'tag:UserId', Values: [props.userId ?? ''] }] },
          physicalResourceId: cr.PhysicalResourceId.of('vpc-lookup'),
        },
        installLatestAwsSdk: false,
        policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE }),
      });
      this.vpcId = vpcLookup.getResponseField('Vpcs.0.VpcId');

      const subnetLookup = new cr.AwsCustomResource(this, 'SubnetLookup', {
        onCreate: {
          service: 'EC2',
          action: 'describeSubnets',
          parameters: {
            Filters: [
              { Name: 'vpc-id', Values: [this.vpcId] },
              { Name: 'tag:Name', Values: ['*Private*'] },
            ],
          },
          physicalResourceId: cr.PhysicalResourceId.of('subnet-lookup'),
        },
        installLatestAwsSdk: false,
        policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE }),
      });
      this.privateSubnetId = subnetLookup.getResponseField('Subnets.0.SubnetId');
      return;
    }

    // Create new VPC
    const vpcCidr = props.vpcCidr ?? '10.0.0.0/16';
    const cidrPrefix = vpcCidr.split('.').slice(0, 2).join('.');
    const publicSubnetCidr = `${cidrPrefix}.0.0/24`;
    const privateSubnetCidr = `${cidrPrefix}.1.0/24`;

    const vpc = new ec2.CfnVPC(this, 'VPC', {
      cidrBlock: vpcCidr,
      enableDnsSupport: true,
      enableDnsHostnames: true,
      tags: [{ key: 'Name', value: `${p}-VPC` }],
    });
    this.vpc = vpc;
    this.vpcId = vpc.ref;

    // IGW
    const igw = new ec2.CfnInternetGateway(this, 'IGW', { tags: [{ key: 'Name', value: `${p}-IGW` }] });
    const vpcGwAttachment = new ec2.CfnVPCGatewayAttachment(this, 'VPCGwAttach', {
      vpcId: vpc.ref,
      internetGatewayId: igw.ref,
    });

    // Public Subnet
    const publicSubnet = new ec2.CfnSubnet(this, 'PublicSubnet', {
      vpcId: vpc.ref,
      cidrBlock: publicSubnetCidr,
      availabilityZone: cdk.Fn.select(0, cdk.Fn.getAzs('')),
      mapPublicIpOnLaunch: true,
      tags: [{ key: 'Name', value: `${p}-Public` }],
    });
    this.publicSubnet = publicSubnet;

    const publicRT = new ec2.CfnRouteTable(this, 'PublicRT', { vpcId: vpc.ref, tags: [{ key: 'Name', value: `${p}-Public-RT` }] });
    const publicRoute = new ec2.CfnRoute(this, 'PublicRoute', { routeTableId: publicRT.ref, destinationCidrBlock: '0.0.0.0/0', gatewayId: igw.ref });
    (publicRoute as cdk.CfnResource).addDependency(vpcGwAttachment);
    new ec2.CfnSubnetRouteTableAssociation(this, 'PublicRTAssoc', { subnetId: publicSubnet.ref, routeTableId: publicRT.ref });

    // Private Subnet
    const privateSubnet = new ec2.CfnSubnet(this, 'PrivateSubnet', {
      vpcId: vpc.ref,
      cidrBlock: privateSubnetCidr,
      availabilityZone: cdk.Fn.select(0, cdk.Fn.getAzs('')),
      tags: [{ key: 'Name', value: `${p}-Private` }],
    });
    this.privateSubnet = privateSubnet;
    this.privateSubnetId = privateSubnet.ref;

    // NAT
    const natEip = new ec2.CfnEIP(this, 'NatEIP', { domain: 'vpc', tags: [{ key: 'Name', value: `${p}-NAT-EIP` }] });
    const natGw = new ec2.CfnNatGateway(this, 'NatGW', { subnetId: publicSubnet.ref, allocationId: natEip.attrAllocationId, tags: [{ key: 'Name', value: `${p}-NAT-GW` }] });

    const privateRT = new ec2.CfnRouteTable(this, 'PrivateRT', { vpcId: vpc.ref, tags: [{ key: 'Name', value: `${p}-Private-RT` }] });
    this.privateRouteTable = privateRT;
    new ec2.CfnRoute(this, 'PrivateRoute', { routeTableId: privateRT.ref, destinationCidrBlock: '0.0.0.0/0', natGatewayId: natGw.ref });
    new ec2.CfnSubnetRouteTableAssociation(this, 'PrivateRTAssoc', { subnetId: privateSubnet.ref, routeTableId: privateRT.ref });

    // S3 Gateway Endpoint
    new ec2.CfnVPCEndpoint(this, 'S3Endpoint', {
      vpcId: vpc.ref,
      serviceName: `com.amazonaws.${cdk.Aws.REGION}.s3`,
      vpcEndpointType: 'Gateway',
      routeTableIds: [privateRT.ref],
    });

    // SageMaker API Interface Endpoint (for MLflow)
    new ec2.CfnVPCEndpoint(this, 'SageMakerApiEndpoint', {
      vpcId: vpc.ref,
      serviceName: `com.amazonaws.${cdk.Aws.REGION}.sagemaker.api`,
      vpcEndpointType: 'Interface',
      subnetIds: [privateSubnet.ref],
      privateDnsEnabled: true,
    });

    // VPC Flow Log
    const logGroup = new logs.CfnLogGroup(this, 'FlowLogGroup', { retentionInDays: 7, tags: [{ key: 'Name', value: `${p}-FlowLog` }] });
    const flowLogRole = new iam.CfnRole(this, 'FlowLogRole', {
      assumeRolePolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'vpc-flow-logs.amazonaws.com' }, Action: 'sts:AssumeRole' }] },
      policies: [{ policyName: 'FlowLogPolicy', policyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'], Resource: '*' }] } }],
    });
    new ec2.CfnFlowLog(this, 'FlowLog', { resourceId: vpc.ref, resourceType: 'VPC', trafficType: 'ALL', logDestinationType: 'cloud-watch-logs', logGroupName: logGroup.ref, deliverLogsPermissionArn: flowLogRole.attrArn });
  }
}
