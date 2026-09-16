import { DescribeInstancesCommand, StartInstancesCommand, StopInstancesCommand } from '@aws-sdk/client-ec2';
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { config } from '../config';
import { notConfigured } from '../errors';
import { ec2, secrets } from './clients';

export async function describeWorkstation() {
  const d = config().dcv;
  if (!d) throw notConfigured('DCV workstation');
  const out = await ec2().send(new DescribeInstancesCommand({ InstanceIds: [d.instanceId] }));
  const i = out.Reservations?.[0]?.Instances?.[0];
  return {
    instanceId: d.instanceId,
    state: i?.State?.Name ?? 'unknown',
    instanceType: i?.InstanceType,
    publicIp: i?.PublicIpAddress,
    privateIp: i?.PrivateIpAddress,
    launchTime: i?.LaunchTime?.toISOString(),
    dcvUrl: i?.PublicIpAddress ? `https://${i.PublicIpAddress}:8443` : d.dcvUrl,
    codeServerUrl: d.codeServerUrl,
    hasSecret: Boolean(d.secretArn),
  };
}
export async function startWorkstation() {
  const d = config().dcv;
  if (!d) throw notConfigured('DCV workstation');
  await ec2().send(new StartInstancesCommand({ InstanceIds: [d.instanceId] }));
}
export async function stopWorkstation() {
  const d = config().dcv;
  if (!d) throw notConfigured('DCV workstation');
  await ec2().send(new StopInstancesCommand({ InstanceIds: [d.instanceId] }));
}
export async function workstationCredentials(): Promise<{ username: string; password: string }> {
  const arn = config().dcv?.secretArn;
  if (!arn) throw notConfigured('DCV secret');
  const out = await secrets().send(new GetSecretValueCommand({ SecretId: arn }));
  const j = JSON.parse(out.SecretString ?? '{}') as { username?: string; password?: string };
  return { username: j.username ?? 'ubuntu', password: j.password ?? '' };
}
