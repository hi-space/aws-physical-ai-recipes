import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface NetworkingProps {
  namePrefix: string;
  vpcCidr?: string;
  azCount?: number;
}

export class NetworkingConstruct extends Construct {
  public readonly vpc: ec2.CfnVPC;
  public readonly publicSubnets: ec2.CfnSubnet[];
  public readonly privateSubnets: ec2.CfnSubnet[];
  public readonly privateRouteTable: ec2.CfnRouteTable;

  constructor(scope: Construct, id: string, props: NetworkingProps) {
    super(scope, id);

    const p = props.namePrefix;
    const vpcCidr = props.vpcCidr ?? '10.0.0.0/16';
    const azCount = props.azCount ?? 2;
    const cidrPrefix = vpcCidr.split('.').slice(0, 2).join('.');

    // VPC
    this.vpc = new ec2.CfnVPC(this, 'VPC', {
      cidrBlock: vpcCidr,
      enableDnsSupport: true,
      enableDnsHostnames: true,
      tags: [{ key: 'Name', value: `${p}-VPC` }],
    });

    // Internet Gateway
    const igw = new ec2.CfnInternetGateway(this, 'IGW', {
      tags: [{ key: 'Name', value: `${p}-IGW` }],
    });
    const vpcGwAttachment = new ec2.CfnVPCGatewayAttachment(this, 'VPCGwAttach', {
      vpcId: this.vpc.ref,
      internetGatewayId: igw.ref,
    });

    // Public Route Table
    const publicRT = new ec2.CfnRouteTable(this, 'PublicRT', {
      vpcId: this.vpc.ref,
      tags: [{ key: 'Name', value: `${p}-Public-RT` }],
    });
    const publicRoute = new ec2.CfnRoute(this, 'PublicRoute', {
      routeTableId: publicRT.ref,
      destinationCidrBlock: '0.0.0.0/0',
      gatewayId: igw.ref,
    });
    (publicRoute as cdk.CfnResource).addDependency(vpcGwAttachment);

    // Public Subnets (multi-AZ)
    this.publicSubnets = [];
    for (let i = 0; i < azCount; i++) {
      const subnet = new ec2.CfnSubnet(this, `PublicSubnet${i}`, {
        vpcId: this.vpc.ref,
        cidrBlock: `${cidrPrefix}.${i * 2}.0/24`,
        availabilityZone: cdk.Fn.select(i, cdk.Fn.getAzs('')),
        mapPublicIpOnLaunch: true,
        tags: [
          { key: 'Name', value: `${p}-Public-${i}` },
          { key: 'kubernetes.io/role/elb', value: '1' },
        ],
      });
      new ec2.CfnSubnetRouteTableAssociation(this, `PublicRTAssoc${i}`, {
        subnetId: subnet.ref,
        routeTableId: publicRT.ref,
      });
      this.publicSubnets.push(subnet);
    }

    // NAT Gateway (single, in first public subnet)
    const natEip = new ec2.CfnEIP(this, 'NatEIP', {
      domain: 'vpc',
      tags: [{ key: 'Name', value: `${p}-NAT-EIP` }],
    });
    const natGw = new ec2.CfnNatGateway(this, 'NatGW', {
      subnetId: this.publicSubnets[0].ref,
      allocationId: natEip.attrAllocationId,
      tags: [{ key: 'Name', value: `${p}-NAT-GW` }],
    });

    // Private Route Table
    this.privateRouteTable = new ec2.CfnRouteTable(this, 'PrivateRT', {
      vpcId: this.vpc.ref,
      tags: [{ key: 'Name', value: `${p}-Private-RT` }],
    });
    new ec2.CfnRoute(this, 'PrivateRoute', {
      routeTableId: this.privateRouteTable.ref,
      destinationCidrBlock: '0.0.0.0/0',
      natGatewayId: natGw.ref,
    });

    // Private Subnets (multi-AZ)
    this.privateSubnets = [];
    for (let i = 0; i < azCount; i++) {
      const subnet = new ec2.CfnSubnet(this, `PrivateSubnet${i}`, {
        vpcId: this.vpc.ref,
        cidrBlock: `${cidrPrefix}.${i * 2 + 1}.0/24`,
        availabilityZone: cdk.Fn.select(i, cdk.Fn.getAzs('')),
        tags: [
          { key: 'Name', value: `${p}-Private-${i}` },
          { key: 'kubernetes.io/role/internal-elb', value: '1' },
        ],
      });
      new ec2.CfnSubnetRouteTableAssociation(this, `PrivateRTAssoc${i}`, {
        subnetId: subnet.ref,
        routeTableId: this.privateRouteTable.ref,
      });
      this.privateSubnets.push(subnet);
    }

    // S3 Gateway Endpoint
    new ec2.CfnVPCEndpoint(this, 'S3Endpoint', {
      vpcId: this.vpc.ref,
      serviceName: `com.amazonaws.${cdk.Aws.REGION}.s3`,
      vpcEndpointType: 'Gateway',
      routeTableIds: [publicRT.ref, this.privateRouteTable.ref],
    });

    // ECR/STS Interface Endpoints
    const endpointSG = new ec2.CfnSecurityGroup(this, 'EndpointSG', {
      groupDescription: 'VPC Interface Endpoints',
      vpcId: this.vpc.ref,
      securityGroupIngress: [{
        ipProtocol: 'tcp',
        fromPort: 443,
        toPort: 443,
        cidrIp: vpcCidr,
        description: 'HTTPS from VPC',
      }],
      tags: [{ key: 'Name', value: `${p}-Endpoint-SG` }],
    });

    const interfaceEndpoints = ['ecr.api', 'ecr.dkr', 'sts'];
    for (const svc of interfaceEndpoints) {
      new ec2.CfnVPCEndpoint(this, `${svc.replace('.', '')}Endpoint`, {
        vpcId: this.vpc.ref,
        serviceName: `com.amazonaws.${cdk.Aws.REGION}.${svc}`,
        vpcEndpointType: 'Interface',
        subnetIds: this.privateSubnets.map(s => s.ref),
        securityGroupIds: [endpointSG.ref],
        privateDnsEnabled: true,
      });
    }

    // VPC Flow Log
    const logGroup = new logs.CfnLogGroup(this, 'FlowLogGroup', {
      retentionInDays: 7,
      tags: [{ key: 'Name', value: `${p}-FlowLog` }],
    });
    const flowLogRole = new iam.CfnRole(this, 'FlowLogRole', {
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow',
          Principal: { Service: 'vpc-flow-logs.amazonaws.com' },
          Action: 'sts:AssumeRole',
        }],
      },
      policies: [{
        policyName: 'FlowLogPolicy',
        policyDocument: {
          Version: '2012-10-17',
          Statement: [{
            Effect: 'Allow',
            Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
            Resource: '*',
          }],
        },
      }],
    });
    new ec2.CfnFlowLog(this, 'FlowLog', {
      resourceId: this.vpc.ref,
      resourceType: 'VPC',
      trafficType: 'ALL',
      logDestinationType: 'cloud-watch-logs',
      logGroupName: logGroup.ref,
      deliverLogsPermissionArn: flowLogRole.attrArn,
    });
  }
}
