import { EC2Client } from '@aws-sdk/client-ec2';
import { BatchClient } from '@aws-sdk/client-batch';

const region = process.env.DASHBOARD_AWS_REGION || process.env.AWS_REGION || 'us-west-2';

export const ec2Client = new EC2Client({ region });
export const batchClient = new BatchClient({ region });

export const TAG_KEY = process.env.AWS_RESOURCE_TAG_KEY || 'Project';
export const TAG_VALUE = process.env.AWS_RESOURCE_TAG_VALUE || 'IsaacLab-RL';
export const useMockData = process.env.USE_MOCK_DATA === 'true';
