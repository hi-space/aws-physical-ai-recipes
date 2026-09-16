import { describe, expect, it, vi } from 'vitest';
import type { GreengrassV2Client } from '@aws-sdk/client-greengrassv2';
import type { IoTClient } from '@aws-sdk/client-iot';
import { GreengrassGateway } from '@/server/aws/greengrass';
const scope = { region: 'us-east-1', accountId: '123456789012' };
const arn = 'arn:aws:iot:us-east-1:123456789012:thing/new-test-core';
const recipe = { ComponentName: 'com.pai.inference', ComponentVersion: '2.3.4',
  ComponentConfiguration: { DefaultConfiguration: { edgeContract: 'physical-ai-pinned-v1', purpose: 'inference', engine: 'sb3-ppo', modelFormat: 'mujoco-ppo-bundle', runtimeImage: 'example/image@sha256:' + '1'.repeat(64) } },
  Manifests: [{ Platform: { os: 'linux', architecture: 'amd64' } }] };
describe('injectable Greengrass adapter', () => {
  it('uses the exact published component recipe/version and rejects legacy mutable-path recipes', async () => {
    let document: unknown = recipe;
    const gg = { send: vi.fn(async () => ({ recipe: Buffer.from(JSON.stringify(document)) })) } as unknown as Pick<GreengrassV2Client, 'send'>;
    const api = new GreengrassGateway({ gg, iot: {} as Pick<IoTClient, 'send'> }, scope);
    const profile = await api.component('com.pai.inference', '2.3.4', 'amd64');
    expect(profile.version).toBe('2.3.4'); expect(profile.recipeHash).toMatch(/^[a-f0-9]{64}$/);
    expect((gg.send as any).mock.calls[0][0].input.arn).toMatch(/:versions:2\.3\.4$/);
    await expect(api.component('com.pai.inference', '2.3.4', 'arm64')).rejects.toThrow(/architecture/);
    document = { ...recipe, ComponentConfiguration: { DefaultConfiguration: { modelPath: '/mutable/model' } } };
    await expect(api.component('com.pai.inference', '2.3.4', 'amd64')).rejects.toThrow(/pinned-artifact/);
  });
  it('scopes target lookup and creates only individual registered-target requests with idempotency tokens', async () => {
    const send = vi.fn(async (command: any) => command.constructor.name === 'GetCoreDeviceCommand' ? { architecture: 'x86_64' } : { deploymentId: 'accepted-id' });
    const iotSend = vi.fn(async () => ({ thingArn: arn }));
    const api = new GreengrassGateway({ gg: { send } as unknown as Pick<GreengrassV2Client, 'send'>, iot: { send: iotSend } as unknown as Pick<IoTClient, 'send'> }, scope);
    expect(await api.target('core', 'new-test-core')).toMatchObject({ arn, architecture: 'amd64' });
    const result = await api.create({ targetArn: arn, components: { 'com.pai.inference': { componentVersion: '2.3.4' } },
      name: 'Explicit', clientToken: 'stable-token', operationId: 'op', projectId: 'a', deviceId: 'dev' });
    expect(result).toEqual({ deploymentId: 'accepted-id' });
    const input = send.mock.calls.at(-1)![0].input;
    expect(input.clientToken).toBe('stable-token'); expect(input.components['com.pai.inference'].componentVersion).toBe('2.3.4');
    expect(input.components).not.toHaveProperty('aws.greengrass.Nucleus');
    await expect(api.create({ ...input, targetArn: 'arn:aws:iot:us-east-1:123456789012:thinggroup/shared', name: 'no', projectId: 'a', operationId: 'o', deviceId: 'd' })).rejects.toThrow(/individual/);
  });
});
