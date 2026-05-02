import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface HyperPodStackProps extends cdk.StackProps {
  userId: string;
  createVpc: boolean;
  vpcCidr: string;
  simMaxCount: number;
  trainMaxCount: number;
  simInstanceType: string;
  trainInstanceType: string;
  fsxCapacityGiB: number;
  simUseSpot: boolean;
}

/**
 * HyperPod training infrastructure stack
 * This is a minimal stub that will be expanded in subsequent tasks.
 */
export class HyperPodStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: HyperPodStackProps) {
    super(scope, id, props);
  }
}
