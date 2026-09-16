import { createHash } from 'node:crypto';
import { CreateDeploymentCommand, GetComponentCommand, GetCoreDeviceCommand, GetDeploymentCommand,
  ListDeploymentsCommand, ListEffectiveDeploymentsCommand, ListInstalledComponentsCommand,
  type ComponentDeploymentSpecification, type GreengrassV2Client, type ListEffectiveDeploymentsCommandOutput } from '@aws-sdk/client-greengrassv2';
import { DescribeThingCommand, DescribeThingGroupCommand, ListThingsInThingGroupCommand, type IoTClient } from '@aws-sdk/client-iot';
import { config } from '../config';
import { greengrass, iot } from './clients';

export type EdgeArchitecture = 'amd64' | 'arm64';
export type EdgePurpose = 'inference' | 'benchmark' | 'communication';
export interface CloudTarget { arn: string; name: string; kind: 'thing' | 'core' | 'thing-group'; architecture?: EdgeArchitecture; members?: string[] }
export interface ComponentProfile {
  id: string; name: string; version: string; architecture: EdgeArchitecture;
  purpose: EdgePurpose; engine: 'sb3-ppo' | 'groot-pytorch' | 'virtual-communication';
  modelFormat: 'mujoco-ppo-bundle' | 'groot-directory-tar' | 'none'; recipeHash: string; runtimeImage?: string;
}
export interface DeploymentSnapshot {
  targetArn: string; deploymentId?: string; components: Record<string, ComponentDeploymentSpecification>; tags?: Record<string, string>;
}
export interface DeploymentRequest extends DeploymentSnapshot { name: string; clientToken: string; projectId: string; operationId: string; deviceId: string }
export interface CoreObservation {
  coreStatus: string; executionStatus: string; message?: string;
  installed: { name: string; version: string; state: string; details?: string }[];
}
export interface EdgeCloud {
  target(kind: 'thing' | 'core' | 'thing-group', name: string): Promise<CloudTarget>;
  component(name: string, version: string, architecture: EdgeArchitecture): Promise<ComponentProfile>;
  current(targetArn: string): Promise<DeploymentSnapshot>;
  inspect(name: string, deploymentId?: string): Promise<CoreObservation>;
  create(request: DeploymentRequest): Promise<{ deploymentId: string }>;
}
const validName = (value: string) => /^[A-Za-z0-9:_-]{1,128}$/.test(value);
const architectureOf = (value?: string): EdgeArchitecture | undefined =>
  ['amd64', 'x86_64'].includes(value ?? '') ? 'amd64' : ['arm64', 'aarch64'].includes(value ?? '') ? 'arm64' : undefined;

/** Injectable SDK boundary. No global device enumeration or browser-supplied target ARN. */
export class GreengrassGateway implements EdgeCloud {
  constructor(private readonly clients: { gg: Pick<GreengrassV2Client, 'send'>; iot: Pick<IoTClient, 'send'> },
    private readonly scope: { accountId: string; region: string; partition?: string }) {}
  private assertArn(arn: string, service: string) {
    if (!arn.startsWith(`arn:${this.scope.partition ?? 'aws'}:${service}:${this.scope.region}:${this.scope.accountId}:`)) throw new Error('AWS target is outside the configured account/region');
  }
  async target(kind: 'thing' | 'core' | 'thing-group', name: string): Promise<CloudTarget> {
    if (!validName(name)) throw new Error('Invalid IoT target name');
    if (kind === 'thing-group') {
      const group = await this.clients.iot.send(new DescribeThingGroupCommand({ thingGroupName: name }));
      if (!group.thingGroupArn) throw new Error('Thing group was not found');
      this.assertArn(group.thingGroupArn, 'iot');
      const members: string[] = []; let nextToken: string | undefined;
      do {
        const page = await this.clients.iot.send(new ListThingsInThingGroupCommand({ thingGroupName: name, recursive: true, maxResults: 100, nextToken }));
        members.push(...(page.things ?? [])); nextToken = page.nextToken;
      } while (nextToken);
      return { arn: group.thingGroupArn, name, kind, members: [...new Set(members)].sort() };
    }
    const thing = await this.clients.iot.send(new DescribeThingCommand({ thingName: name }));
    if (!thing.thingArn) throw new Error('Thing was not found');
    this.assertArn(thing.thingArn, 'iot');
    if (kind === 'thing') return { arn: thing.thingArn, name, kind };
    const core = await this.clients.gg.send(new GetCoreDeviceCommand({ coreDeviceThingName: name }));
    const architecture = architectureOf(core.architecture);
    if (!architecture) throw new Error('Core architecture is unavailable or unsupported');
    return { arn: thing.thingArn, name, kind, architecture };
  }
  async component(name: string, version: string, architecture: EdgeArchitecture): Promise<ComponentProfile> {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name) || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new Error('An explicit component name/version is required');
    const arn = `arn:${this.scope.partition ?? 'aws'}:greengrass:${this.scope.region}:${this.scope.accountId}:components:${name}:versions:${version}`;
    const result = await this.clients.gg.send(new GetComponentCommand({ arn, recipeOutputFormat: 'JSON' }));
    if (!result.recipe) throw new Error('Component recipe is unavailable');
    const text = new TextDecoder().decode(result.recipe);
    const recipe = JSON.parse(text);
    const settings = recipe.ComponentConfiguration?.DefaultConfiguration;
    if (recipe.ComponentName !== name || recipe.ComponentVersion !== version || settings?.edgeContract !== 'physical-ai-pinned-v1') throw new Error('Component does not implement the versioned pinned-artifact contract');
    if (!recipe.Manifests?.some((m: { Platform?: { os?: string; architecture?: string } }) => m.Platform?.os === 'linux' && architectureOf(m.Platform.architecture) === architecture)) throw new Error('Component architecture does not match this target');
    if (!['inference', 'benchmark', 'communication'].includes(settings.purpose) ||
        !['sb3-ppo', 'groot-pytorch', 'virtual-communication'].includes(settings.engine) ||
        !['mujoco-ppo-bundle', 'groot-directory-tar', 'none'].includes(settings.modelFormat)) throw new Error('Unsupported component execution contract');
    const formats: Record<string, string> = { 'sb3-ppo': 'mujoco-ppo-bundle', 'groot-pytorch': 'groot-directory-tar', 'virtual-communication': 'none' };
    if (formats[settings.engine] !== settings.modelFormat) throw new Error('Component engine/model format mismatch');
    if (settings.purpose !== 'communication' && !/^\S+@sha256:[a-f0-9]{64}$/.test(settings.runtimeImage ?? '')) throw new Error('Workload runtime image must be pinned by digest');
    if (settings.purpose === 'communication' && (settings.engine !== 'virtual-communication' || settings.modelFormat !== 'none')) throw new Error('Communication profile must not execute a model');
    const recipeHash = createHash('sha256').update(text).digest('hex');
    return { id: `profile-${recipeHash.slice(0, 16)}`, name, version, architecture, purpose: settings.purpose,
      engine: settings.engine, modelFormat: settings.modelFormat, recipeHash, ...(settings.runtimeImage ? { runtimeImage: settings.runtimeImage } : {}) };
  }
  async current(targetArn: string): Promise<DeploymentSnapshot> {
    this.assertArn(targetArn, 'iot');
    const page = await this.clients.gg.send(new ListDeploymentsCommand({ targetArn, historyFilter: 'LATEST_ONLY', maxResults: 10 }));
    const latest = page.deployments?.find(d => d.isLatestForTarget) ?? page.deployments?.[0];
    if (!latest?.deploymentId) return { targetArn, components: {} };
    const result = await this.clients.gg.send(new GetDeploymentCommand({ deploymentId: latest.deploymentId }));
    if (result.targetArn !== targetArn) throw new Error('Deployment target mismatch');
    return { targetArn, deploymentId: result.deploymentId, components: result.components ?? {}, tags: result.tags };
  }
  async inspect(name: string, deploymentId?: string): Promise<CoreObservation> {
    const core = await this.clients.gg.send(new GetCoreDeviceCommand({ coreDeviceThingName: name }));
    const installed: CoreObservation['installed'] = []; let token: string | undefined;
    do {
      const page = await this.clients.gg.send(new ListInstalledComponentsCommand({ coreDeviceThingName: name, maxResults: 100, nextToken: token }));
      installed.push(...(page.installedComponents ?? []).map(c => ({ name: c.componentName!, version: c.componentVersion!, state: c.lifecycleState ?? 'UNKNOWN', details: c.lifecycleStateDetails })));
      token = page.nextToken;
    } while (token);
    let effective: { status?: string; reason?: string } | undefined;
    if (deploymentId) {
      token = undefined;
      do {
        const page: ListEffectiveDeploymentsCommandOutput = await this.clients.gg.send(new ListEffectiveDeploymentsCommand({ coreDeviceThingName: name, maxResults: 100, nextToken: token }));
        const match = page.effectiveDeployments?.find(d => d.deploymentId === deploymentId);
        if (match) { effective = { status: match.coreDeviceExecutionStatus, reason: match.reason }; break; }
        token = page.nextToken;
      } while (token);
    }
    return { coreStatus: core.status ?? 'UNKNOWN', executionStatus: effective?.status ?? 'UNKNOWN', message: effective?.reason, installed };
  }
  async create(request: DeploymentRequest) {
    this.assertArn(request.targetArn, 'iot');
    // Group selection is expanded to fixed registered cores by the service. Never continuously
    // deploy a model to unregistered devices later added to an IoT group.
    if (!request.targetArn.includes(':thing/')) throw new Error('Deployment requires a registered individual core target');
    const result = await this.clients.gg.send(new CreateDeploymentCommand({
      targetArn: request.targetArn, deploymentName: request.name, components: request.components,
      clientToken: request.clientToken, tags: { 'pai:project': request.projectId, 'pai:operation': request.operationId, 'pai:device': request.deviceId },
      deploymentPolicies: { failureHandlingPolicy: 'ROLLBACK', componentUpdatePolicy: { action: 'NOTIFY_COMPONENTS', timeoutInSeconds: 60 } },
    }));
    if (!result.deploymentId) throw new Error('AWS did not return a deployment ID; submission outcome is unknown');
    return { deploymentId: result.deploymentId };
  }
}
export function edgeCloud(): EdgeCloud {
  const c = config();
  return new GreengrassGateway({ gg: greengrass(), iot: iot() }, { accountId: c.accountId, region: c.region,
    partition: c.region.startsWith('cn-') ? 'aws-cn' : c.region.startsWith('us-gov-') ? 'aws-us-gov' : 'aws' });
}
