import {
  CreateDeploymentCommand,
  ListComponentsCommand,
  ListCoreDevicesCommand,
  ListDeploymentsCommand,
  ListEffectiveDeploymentsCommand,
  ListInstalledComponentsCommand,
} from '@aws-sdk/client-greengrassv2';
import { config } from '../config';
import { greengrass } from './clients';

export function thingGroupArn(): string | undefined {
  const c = config();
  return c.edge?.thingGroup ? `arn:aws:iot:${c.region}:${c.accountId}:thinggroup/${c.edge.thingGroup}` : undefined;
}

export async function overview() {
  const [devices, components] = await Promise.all([
    greengrass().send(new ListCoreDevicesCommand({ maxResults: 50 })),
    greengrass().send(new ListComponentsCommand({ scope: 'PRIVATE', maxResults: 100 })),
  ]);
  const target = thingGroupArn();
  const deployments = target ? await greengrass().send(new ListDeploymentsCommand({ targetArn: target, historyFilter: 'ALL', maxResults: 25 })) : undefined;
  const cores = await Promise.all(
    (devices.coreDevices ?? []).map(async (d) => {
      const [installed, effective] = await Promise.all([
        greengrass().send(new ListInstalledComponentsCommand({ coreDeviceThingName: d.coreDeviceThingName!, maxResults: 50 })).catch(() => undefined),
        greengrass().send(new ListEffectiveDeploymentsCommand({ coreDeviceThingName: d.coreDeviceThingName!, maxResults: 10 })).catch(() => undefined),
      ]);
      return { ...d, installed: installed?.installedComponents ?? [], effective: effective?.effectiveDeployments ?? [] };
    }),
  );
  return { thingGroupArn: target, cores, components: components.components ?? [], deployments: deployments?.deployments ?? [] };
}

export interface InferenceDeploymentInput {
  name: string;
  modelPath: string;
  embodimentTag: string;
  ecrImage: string;
  policyPort?: number;
  extraComponents?: Record<string, { version: string; merge?: Record<string, unknown> }>;
}

export async function createInferenceDeployment(i: InferenceDeploymentInput) {
  const c = config();
  const target = thingGroupArn();
  if (!target || !c.edge?.inferenceComponent) throw new Error('Greengrass thing group is not configured');
  const components: Record<string, { componentVersion: string; configurationUpdate?: { merge: string } }> = {
    'aws.greengrass.Nucleus': { componentVersion: '2.17.0' },
    'aws.greengrass.Cli': { componentVersion: '2.17.0' },
    [c.edge.inferenceComponent]: {
      componentVersion: '1.0.0',
      configurationUpdate: {
        merge: JSON.stringify({ modelPath: i.modelPath, embodimentTag: i.embodimentTag, ecrImage: i.ecrImage, policyPort: String(i.policyPort ?? 5555) }),
      },
    },
  };
  for (const [name, v] of Object.entries(i.extraComponents ?? {})) {
    components[name] = { componentVersion: v.version, configurationUpdate: v.merge ? { merge: JSON.stringify(v.merge) } : undefined };
  }
  const out = await greengrass().send(
    new CreateDeploymentCommand({
      targetArn: target,
      deploymentName: i.name,
      components,
      deploymentPolicies: { componentUpdatePolicy: { action: 'SKIP_NOTIFY_COMPONENTS', timeoutInSeconds: 60 } },
    }),
  );
  return out.deploymentId;
}
