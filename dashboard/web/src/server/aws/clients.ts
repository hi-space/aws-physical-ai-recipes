import { SageMakerClient } from '@aws-sdk/client-sagemaker';
import { EKSClient } from '@aws-sdk/client-eks';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { FSxClient } from '@aws-sdk/client-fsx';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { EC2Client } from '@aws-sdk/client-ec2';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GreengrassV2Client } from '@aws-sdk/client-greengrassv2';
import { IoTClient } from '@aws-sdk/client-iot';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { SNSClient } from '@aws-sdk/client-sns';
import { CostExplorerClient } from '@aws-sdk/client-cost-explorer';
import { SSMClient } from '@aws-sdk/client-ssm';
import { STSClient } from '@aws-sdk/client-sts';
import { config } from '../config';

function memo<T>(f: () => T): () => T {
  let v: T | undefined;
  return () => (v ??= f());
}
const region = () => ({ region: config().region });

export const sagemaker = memo(() => new SageMakerClient(region()));
export const eks = memo(() => new EKSClient(region()));
export const s3 = memo(() => new S3Client(region()));
export const dynamo = memo(() => new DynamoDBClient(region()));
export const fsx = memo(() => new FSxClient(region()));
export const cwlogs = memo(() => new CloudWatchLogsClient(region()));
export const ec2 = memo(() => new EC2Client(region()));
export const secrets = memo(() => new SecretsManagerClient(region()));
export const greengrass = memo(() => new GreengrassV2Client(region()));
export const iot = memo(() => new IoTClient(region()));
export const cognito = memo(() => new CognitoIdentityProviderClient(region()));
export const sns = memo(() => new SNSClient(region()));
// Cost Explorer is a global service; its endpoint is always us-east-1 regardless of home region.
export const costExplorer = memo(() => new CostExplorerClient({ region: 'us-east-1' }));
export const ssm = memo(() => new SSMClient(region()));
export const sts = memo(() => new STSClient(region()));
