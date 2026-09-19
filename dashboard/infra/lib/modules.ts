export const WORKLOAD_IMAGES = ['mujoco', 'isaaclab', 'ros2', 'workspace', 'groot', 'openpi'] as const;
export type WorkloadImageName = typeof WORKLOAD_IMAGES[number];
export const IMAGE_ENV: Record<WorkloadImageName, string> = {
  mujoco: 'MUJOCO_IMAGE_URI', isaaclab: 'ISAACLAB_IMAGE_URI', ros2: 'ROS2_IMAGE_URI',
  workspace: 'WORKSPACE_IMAGE_URI', groot: 'GROOT_RUNTIME_IMAGE_URI', openpi: 'OPENPI_IMAGE_URI',
};
const BASE_IMAGES: WorkloadImageName[] = ['mujoco', 'isaaclab', 'ros2', 'workspace'];
const EXTENDED_IMAGES: WorkloadImageName[] = ['groot', 'openpi'];
const ECR_URI = /^\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9._/-]+(@sha256:[a-f0-9]{64}|:[A-Za-z0-9._-]{1,128})$/;

export interface DashboardModules {
  ingress: { mode: 'https'; domainName: string; hostedZoneId: string; hostedZoneName: string } | { mode: 'http' };
  gateway: boolean; sourceBuild: boolean; edge: boolean; waf: boolean; alarms: boolean;
  images: { build: WorkloadImageName[]; overrides: Partial<Record<WorkloadImageName, string>> };
  resourceTag: { key: string; value: string };
}
export type ContextReader = (key: string) => unknown;

function flag(ctx: ContextReader, key: string, fallback: boolean): boolean {
  const v = ctx(key);
  if (v === undefined || v === '') return fallback;
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  throw new Error(`${key} must be true or false`);
}
function text(ctx: ContextReader, key: string): string | undefined {
  const v = ctx(key);
  if (v === undefined || v === '') return undefined;
  if (typeof v !== 'string') throw new Error(`${key} must be a string`);
  return v;
}
export function resolveModules(ctx: ContextReader): DashboardModules {
  const domainName = text(ctx, 'domainName'), hostedZoneId = text(ctx, 'hostedZoneId'), hostedZoneName = text(ctx, 'hostedZoneName');
  const given = [domainName, hostedZoneId, hostedZoneName].filter(Boolean).length;
  if (given !== 0 && given !== 3) throw new Error('domainName, hostedZoneId and hostedZoneName must be given together (or all omitted for HTTP ingress)');
  const ingress: DashboardModules['ingress'] = given === 3 ? { mode: 'https', domainName: domainName!, hostedZoneId: hostedZoneId!, hostedZoneName: hostedZoneName! } : { mode: 'http' };

  const listed = text(ctx, 'images');
  let build: WorkloadImageName[] = listed
    ? listed.split(',').map(s => s.trim()).filter(Boolean).map(name => {
        if (!(WORKLOAD_IMAGES as readonly string[]).includes(name)) throw new Error(`Unknown workload image "${name}"; known: ${WORKLOAD_IMAGES.join(', ')}`);
        return name as WorkloadImageName;
      })
    : [...BASE_IMAGES, ...(flag(ctx, 'extendedImages', false) ? EXTENDED_IMAGES : [])];
  const overridesRaw = ctx('imageOverrides');
  let overrides: Partial<Record<WorkloadImageName, string>> = {};
  if (overridesRaw !== undefined && overridesRaw !== '') {
    let parsed: unknown = overridesRaw;
    if (typeof overridesRaw === 'string') { try { parsed = JSON.parse(overridesRaw); } catch { throw new Error('imageOverrides must be a JSON object'); } }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('imageOverrides must be a JSON object');
    for (const [name, uri] of Object.entries(parsed as Record<string, unknown>)) {
      if (!(WORKLOAD_IMAGES as readonly string[]).includes(name)) throw new Error(`Unknown workload image "${name}" in imageOverrides`);
      if (typeof uri !== 'string' || !ECR_URI.test(uri)) throw new Error(`imageOverrides.${name} must be an ECR image URI pinned by digest or tag`);
      overrides[name as WorkloadImageName] = uri;
    }
    build = build.filter(name => !(name in overrides));
  }
  const key = text(ctx, 'resourceTagKey') ?? 'PhysicalAI', value = text(ctx, 'resourceTagValue') ?? 'true';
  if (!/^(?!aws:)[A-Za-z0-9 _.:/=+\-@]{1,128}$/.test(key)) throw new Error('resourceTagKey must be a valid tag key not starting with aws:');
  if (!/^[A-Za-z0-9 _.:/=+\-@]{0,256}$/.test(value)) throw new Error('resourceTagValue must be a valid tag value');
  return {
    ingress, gateway: flag(ctx, 'gateway', true), sourceBuild: flag(ctx, 'sourceBuild', true), edge: flag(ctx, 'edge', true),
    waf: flag(ctx, 'waf', true), alarms: flag(ctx, 'alarms', true), images: { build, overrides }, resourceTag: { key, value },
  };
}
export function describeModules(m: DashboardModules): string {
  const onOff = (b: boolean) => (b ? 'on' : 'off');
  return [
    `ingress: ${m.ingress.mode}${m.ingress.mode === 'https' ? ` ${m.ingress.domainName}` : ' (ALB DNS name, no TLS)'}`,
    `gateway: ${onOff(m.gateway)}`, `sourceBuild: ${onOff(m.sourceBuild)}`, `edge: ${onOff(m.edge)}`, `waf: ${onOff(m.waf)}`, `alarms: ${onOff(m.alarms)}`,
    `images: ${m.images.build.join(', ') || '(none)'}${Object.keys(m.images.overrides).length ? ` + overrides ${Object.keys(m.images.overrides).join(', ')}` : ''}`,
    `resourceTag: ${m.resourceTag.key}=${m.resourceTag.value}`,
  ].join('\n');
}
export const DEFAULT_MODULES: DashboardModules = resolveModules(() => undefined);
