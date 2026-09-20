import type { Repo } from '../store/repo';
import type { Duplex } from 'node:stream';
import { HttpError } from '../errors';
import type { CurrentUserAuthorization } from '../aws/cognito';
import type { validateExecutionProfile } from '../services/execution-profiles';
import type { getPod } from '../k8s/resources';

export interface DerivedTokenBinding {
  authMethod: 'token';
  tokenId: string;
  tokenProjectId: string;
  tokenRole: 'researcher';
  tokenExpiresAt: string;
}

/** Gateway's strict view of the parent-owned session record. */
export interface GatewaySession {
  backendId?: string;
  backendConfigHash?: string;
  id: string;
  kind: 'terminal' | 'port-forward' | 'tensorboard' | 'jupyter' | 'code-server' | 'dcv';
  owner?: string;
  ownerSubject: string;
  expiresAt: string;
  namespace: string;
  podName?: string;
  container?: string;
  port?: number;
  nodeName?: string;
  ssmTarget?: string;
  dcvSessionId?: string;
  projectId?: string;
  workflowId?: string;
  attempt?: number;
  taskName?: string;
  attemptEpoch?: string;
  podUid?: string;
  hostNetwork?: boolean;
  trustedExecution?: boolean;
  replicaIndex?: number;
  revokedAt?: string;
  status?: string;
  createdAt?: string;
  authMethod?: 'alb' | 'cognito' | 'token';
  tokenId?: string;
  tokenProjectId?: string;
  tokenRole?: 'viewer' | 'researcher';
  tokenExpiresAt?: string;
}

export interface AuthOptions {
  repo?: Repo;
  now?: () => number;
  baseDomain?: string;
  mode?: 'host' | 'path';
  publicOrigin?: string;
  currentUser?: (username: string) => Promise<CurrentUserAuthorization>;
  validateExecutionProfile?: typeof validateExecutionProfile;
  getPod?: typeof getPod;
}

export class GatewayError extends HttpError {
  constructor(status: number, message: string) {
    super(status, message, 'gateway_error');
    this.name = 'GatewayError';
  }
}

export interface TerminalCallbacks {
  stdout(data: string): void;
  stderr(data: string): void;
  exit(code: number): void;
  error(): void;
}

export interface TerminalConnection {
  input(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

/** Implementations use only the validated, registered target in session. */
export interface GatewayTransport {
  connect(session: GatewaySession, signal: AbortSignal): Promise<Duplex>;
  exec(session: GatewaySession, callbacks: TerminalCallbacks, signal: AbortSignal): Promise<TerminalConnection>;
}

export interface DcvUpstream {
  /** An already established SSM tunnel; HTTPS on a literal loopback address. */
  url: URL;
  ca?: string | Buffer;
  /** Registered certificate DNS name. Standard TLS hostname validation stays on. */
  servername: string;
  close(): void | Promise<void>;
}

export type GetDcvUpstream = (session: GatewaySession, context: { signal: AbortSignal }) => Promise<DcvUpstream>;
