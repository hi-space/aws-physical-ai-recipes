import { GetResourcesCommand } from '@aws-sdk/client-resource-groups-tagging-api';
import { DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { config } from '../config';
import { ec2, tagging } from './clients';
import { consoleUrl, type ConsoleResource } from '@/lib/console-links';

export type ResourceService = 'EC2' | 'FSx' | 'EKS' | 'SageMaker' | 'S3' | 'DynamoDB' | 'ECS' | 'ELB' | 'Lambda' | 'CodeBuild' | 'ECR' | 'Cognito' | 'Other';
export interface TaggedResource { arn: string; service: ResourceService; type: string; name: string; region: string; consoleUrl?: string; details?: Record<string, string | number | undefined> }
export interface ResourcesResponse { tag: { key: string; value: string }; fetchedAt: string; region: string; accountId: string; groups: { service: ResourceService; items: TaggedResource[]; error?: string }[] }

const ORDER: ResourceService[] = ['EC2', 'EKS', 'SageMaker', 'FSx', 'S3', 'DynamoDB', 'ECS', 'ELB', 'CodeBuild', 'ECR', 'Cognito', 'Lambda', 'Other'];
const SERVICES: Record<string, ResourceService> = { ec2: 'EC2', fsx: 'FSx', eks: 'EKS', sagemaker: 'SageMaker', s3: 'S3', dynamodb: 'DynamoDB', ecs: 'ECS', elasticloadbalancing: 'ELB', lambda: 'Lambda', codebuild: 'CodeBuild', ecr: 'ECR', 'cognito-idp': 'Cognito' };

export function parseArn(arn: string): { service: ResourceService; type: string; name: string; region: string } {
  const [, , svc, region, , ...rest] = arn.split(':');
  const resource = rest.join(':');
  const service = SERVICES[svc] ?? 'Other';
  const home = region || config().region;
  if (svc === 's3') return { service, type: 'bucket', name: resource, region: home };
  const [type, ...pathParts] = resource.includes('/') ? resource.split('/') : resource.split(':');
  const path = pathParts.join('/');
  if (svc === 'elasticloadbalancing' && type === 'loadbalancer') return { service, type: pathParts[0] === 'app' ? 'application-load-balancer' : 'load-balancer', name: pathParts[1] ?? path, region: home };
  if (svc === 'sagemaker' && type === 'cluster') return { service, type: 'hyperpod-cluster', name: path, region: home };
  if (service === 'Other') return { service, type: svc, name: pathParts.at(-1) ?? resource, region: home };
  return { service, type, name: path || type, region: home };
}
function link(r: { service: ResourceService; type: string; name: string }): ConsoleResource | undefined {
  if (r.service === 'EC2' && r.type === 'instance') return { kind: 'ec2-instance', id: r.name };
  if (r.service === 'FSx') return { kind: 'fsx-filesystem', id: r.name };
  if (r.service === 'EKS') return { kind: 'eks-cluster', name: r.name };
  if (r.service === 'SageMaker' && r.type === 'hyperpod-cluster') return { kind: 'hyperpod-cluster', name: r.name };
  if (r.service === 'S3') return { kind: 's3-bucket', bucket: r.name };
  if (r.service === 'DynamoDB') return { kind: 'dynamodb-table', name: r.name };
  if (r.service === 'Cognito') return { kind: 'cognito-user-pool', id: r.name };
  return undefined;
}
const TTL_MS = 60_000;
let cache: { at: number; value: ResourcesResponse } | undefined;
export function resetTaggedResourcesCache(): void { cache = undefined; }

export async function listTaggedResources(now: () => number = Date.now): Promise<ResourcesResponse> {
  if (cache && now() - cache.at < TTL_MS) return cache.value;
  const c = config(), tag = c.resourceTag ?? { key: 'PhysicalAI', value: 'true' };
  const items: TaggedResource[] = [];
  const seen = new Set<string>(); let token: string | undefined;
  do {
    const out = await tagging().send(new GetResourcesCommand({ TagFilters: [{ Key: tag.key, Values: [tag.value] }], ResourcesPerPage: 100, PaginationToken: token }));
    for (const m of out.ResourceTagMappingList ?? []) {
      if (!m.ResourceARN) continue;
      const parsed = parseArn(m.ResourceARN);
      const nameTag = m.Tags?.find(t => t.Key === 'Name')?.Value;
      const resource: TaggedResource = { arn: m.ResourceARN, ...parsed, name: nameTag ?? parsed.name };
      const target = link(parsed);
      if (target) resource.consoleUrl = consoleUrl(target, parsed.region);
      items.push(resource);
    }
    token = out.PaginationToken || undefined;
    if (token && (seen.has(token) || seen.size >= 50)) throw new Error('Tagging API pagination is incomplete');
    if (token) seen.add(token);
  } while (token);
  const groups: ResourcesResponse['groups'] = ORDER.filter(s => items.some(i => i.service === s)).map(service => ({ service, items: items.filter(i => i.service === service).sort((a, b) => a.name.localeCompare(b.name)) }));
  const ec2Group = groups.find(g => g.service === 'EC2');
  const instances = ec2Group?.items.filter(i => i.type === 'instance') ?? [];
  if (ec2Group && instances.length) {
    for (const i of instances) i.details = { instanceId: parseArn(i.arn).name };
    try {
      const out = await ec2().send(new DescribeInstancesCommand({ InstanceIds: instances.map(i => parseArn(i.arn).name) }));
      for (const inst of (out.Reservations ?? []).flatMap(r => r.Instances ?? [])) {
        const item = instances.find(i => parseArn(i.arn).name === inst.InstanceId);
        if (!item) continue;
        item.name = inst.Tags?.find(t => t.Key === 'Name')?.Value ?? item.name;
        item.details = { instanceId: inst.InstanceId, state: inst.State?.Name, instanceType: inst.InstanceType, privateIp: inst.PrivateIpAddress, az: inst.Placement?.AvailabilityZone, launchedAt: inst.LaunchTime?.toISOString() };
      }
    } catch (error) { ec2Group.error = error instanceof Error ? error.message : String(error); }
  }
  const value: ResourcesResponse = { tag, fetchedAt: new Date(now()).toISOString(), region: c.region, accountId: c.accountId, groups };
  cache = { at: now(), value };
  return value;
}
