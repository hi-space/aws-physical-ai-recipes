import { createHmac, randomBytes, X509Certificate } from 'node:crypto';
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { SendCommandCommand, GetCommandInvocationCommand } from '@aws-sdk/client-ssm';
import { config } from '../config';
import { secrets, ssm } from '../aws/clients';
import { getRepo } from '../store/repo';
import { requireRole, type Session as Principal } from '../auth/session';
import { resolveProject } from '../auth/projects';
import { badRequest, HttpError, notFound } from '../errors';
import type { Session } from '../store/types';
import { issueLaunchTicket } from '../gateway/auth';
import type { GatewaySession } from '../gateway/types';

export interface DcvRegistration {
  instanceId: string;
  sessionId: string;
  user: string;
  hostname: string;
  certificate: string;
  configuredAt: string;
}
export async function dcvRegistration(): Promise<DcvRegistration | undefined> {
  const record = await getRepo().kv.get('SYS', 'DCV_REGISTRATION');
  return record?.registration as DcvRegistration | undefined;
}
export async function configureDcvHost() {
  const c = config(), uri = process.env.DCV_AGENT_ASSET_URI, secret = process.env.DCV_SSO_SECRET_ARN;
  if (!c.dcv || !uri || !secret) throw new HttpError(503, 'DCV 연결 구성이 아직 배포되지 않았습니다.');
  if (!/^s3:\/\/[a-z0-9.-]+\/[a-zA-Z0-9/_.-]+$/.test(uri) || !/^arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:[a-zA-Z0-9/_+=.@-]+$/.test(secret)) throw new Error('Invalid server DCV configuration');
  const commands = [
    'set -eu',
    'mkdir -p /opt/physical-ai-dcv-install',
    `aws s3 cp '${uri}' /opt/physical-ai-dcv-install/agent.zip`,
    "python3 -c \"import zipfile; zipfile.ZipFile('/opt/physical-ai-dcv-install/agent.zip').extractall('/opt/physical-ai-dcv-install')\"",
    `python3 /opt/physical-ai-dcv-install/bootstrap.py --region '${c.region}' --secret '${secret}' --session console --user ubuntu --activate-if-idle`,
  ];
  const response = await ssm().send(new SendCommandCommand({
    InstanceIds: [c.dcv.instanceId], DocumentName: 'AWS-RunShellScript',
    Parameters: { commands }, Comment: 'Physical AI DCV external authentication setup',
  }));
  await getRepo().kv.put({ pk: 'SYS', sk: 'DCV_SETUP', commandId: response.Command!.CommandId, instanceId: c.dcv.instanceId });
  return { commandId: response.Command!.CommandId, status: 'CONFIGURING' };
}
export async function reconcileDcvSetup() {
  const repo = getRepo();
  const pending = await repo.kv.get('SYS', 'DCV_SETUP');
  if (!pending) return;
  const response = await ssm().send(new GetCommandInvocationCommand({ CommandId: String(pending.commandId), InstanceId: String(pending.instanceId) }));
  if (response.Status === 'Success') {
    const line = (response.StandardOutputContent ?? '').trim().split('\n').at(-1)!;
    const value = JSON.parse(line) as Omit<DcvRegistration, 'instanceId' | 'configuredAt'> & { ready?: boolean };
    if (!value.ready || !value.certificate || !value.hostname || !new X509Certificate(value.certificate).checkHost(value.hostname)) throw new Error('DCV host certificate registration failed');
    const registration: DcvRegistration = { ...value, instanceId: String(pending.instanceId), configuredAt: new Date().toISOString() };
    await repo.kv.put({ pk: 'SYS', sk: 'DCV_REGISTRATION', registration });
    await repo.kv.del('SYS', 'DCV_SETUP');
  } else if (['Failed', 'Cancelled', 'TimedOut'].includes(response.Status ?? '')) {
    await repo.kv.put({ ...pending, failed: true, status: response.Status });
  }
}
export async function createDcvBrowserSession(principal: Principal, projectId: string, minutes = 60) {
  requireRole(principal, 'admin'); // imported workshop host carries shared operator privileges
  if (!principal.subject) throw new HttpError(401, 'Verified identity required');
  const project = await resolveProject(principal, projectId, getRepo(), 'researcher');
  const registration = await dcvRegistration();
  if (!registration || registration.instanceId !== config().dcv?.instanceId) throw new HttpError(503, '먼저 DCV 브라우저 연결을 준비해 주세요.');
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 240) throw badRequest('세션 시간은 5–240분입니다.');
  const now = new Date(), id = randomBytes(8).toString('hex');
  const session: Session = {
    id, name: `dcv-${id}`, kind: 'dcv', owner: principal.user, ownerSubject: principal.subject,
    projectId: project.id, namespace: project.namespace, status: 'READY',
    createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + minutes * 60_000).toISOString(),
    nodeName: registration.hostname, ssmTarget: registration.instanceId, dcvSessionId: registration.sessionId,
  };
  await getRepo().putSession(session);
  return session;
}
export async function launchDcvBrowserSession(id: string, principal: Principal) {
  requireRole(principal, 'admin');
  const session = await getRepo().getSession(id);
  if (!session || session.kind !== 'dcv' || session.ownerSubject !== principal.subject) throw notFound('DCV session');
  const registration = await dcvRegistration();
  if (!registration || registration.instanceId !== session.ssmTarget) throw new HttpError(503, 'DCV 연결 정보가 변경되었습니다.');
  const secretArn = process.env.DCV_SSO_SECRET_ARN;
  if (!secretArn) throw new HttpError(503, 'DCV authentication is not configured');
  const secret = await secrets().send(new GetSecretValueCommand({ SecretId: secretArn }));
  const key = JSON.parse(secret.SecretString ?? '{}').key as string;
  if (!key || key.length < 32) throw new Error('Invalid DCV signing key');
  const iat = Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify({ aud: 'pai-dcv', sessionId: registration.sessionId, user: registration.user, iat, exp: iat + 120, nonce: randomBytes(16).toString('hex') })).toString('base64url');
  const token = `v1.${body}.${createHmac('sha256', key).update(`v1.${body}`).digest('base64url')}`;
  const ticket = await issueLaunchTicket(session as GatewaySession, principal);
  const url = new URL(ticket.url);
  url.searchParams.set('authToken', token);
  url.hash = registration.sessionId;
  return { url: url.toString(), expiresAt: session.expiresAt };
}
export async function closeDcvBrowserSession(id: string, principal: Principal) {
  const session = await getRepo().getSession(id);
  if (!session || session.kind !== 'dcv' || session.ownerSubject !== principal.subject) throw notFound('DCV session');
  await getRepo().putSession({ ...session, status: 'CLOSED', revokedAt: new Date().toISOString() });
}
export async function cleanupDcvSessions() {
  for (const session of await getRepo().listSessions()) {
    if (session.kind === 'dcv' && !session.revokedAt && Date.parse(session.expiresAt ?? '') <= Date.now()) {
      await getRepo().putSession({ ...session, status: 'CLOSED', revokedAt: new Date().toISOString() });
    }
  }
}
