import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  test as base, expect, request, type APIRequestContext, type Page, type TestInfo,
} from '@playwright/test';
import type {
  DatasetDetail, ManagedSession, Principal, Project, Recipe, Run, RunDetail, Task, Version,
} from './contracts';
import type { CPUWorkflow } from './workflows';

export { expect };
export const budgets = {
  api: 30_000, login: 90_000, workflow: 12 * 60_000, running: 8 * 60_000,
  finalization: 5 * 60_000, session: 2 * 60_000, launch: 45_000,
  transfer: 60_000, cleanup: 3 * 60_000,
} as const;
const terminalRuns = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);
const terminalTasks = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'SKIPPED']);
const safeID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const projectMember = (project: Project, principal: Principal) =>
  ['researcher', 'project-admin'].includes(project.members[principal.subject]);
const safeMessage = (value: unknown) => String(value)
  .replace(/https?:\/\/\S+/gi, '[URL omitted]')
  .replace(/((?:ticket|token|password|signature|credential)=)[^\s&]+/gi, '$1[redacted]')
  .slice(0, 500);

export function requireCondition(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function httpsURL(raw: string, label: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`${label} returned an invalid URL`); }
  requireCondition(url.protocol === 'https:' && !url.username && !url.password && !url.hash, `${label} must use HTTPS without embedded credentials`);
  return url;
}

async function jsonRequest<T>(page: Page, origin: string, project: string | undefined,
  method: string, path: string, data?: unknown, statuses: readonly number[] = [200], timeout: number = budgets.api,
  extraHeaders: Record<string, string> = {}): Promise<T> {
  requireCondition(path.startsWith('/api/') && !path.includes('://'), 'Dashboard requests must stay on /api/');
  let response;
  try {
    response = await page.request.fetch(origin + path, {
      method, data, timeout, maxRedirects: 0, failOnStatusCode: false,
      headers: { ...extraHeaders, origin, ...(project ? { 'x-pai-project': project } : {}) },
    });
  } catch {
    throw new Error(`${method} ${path.split('?')[0]} failed (network, TLS, or ${timeout}ms deadline); response/credentials omitted`);
  }
  try {
    const contentType = response.headers()['content-type'] ?? '';
    requireCondition(contentType.includes('application/json'), `${method} ${path.split('?')[0]} returned HTTP ${response.status()} with non-JSON content`);
    const body = await response.json();
    if (!statuses.includes(response.status())) {
      const detail = typeof body?.error === 'string' ? `: ${safeMessage(body.error)}` : '';
      throw new Error(`${method} ${path.split('?')[0]} returned HTTP ${response.status()}${detail}; unsupported services are failures, not skips`);
    }
    return body as T;
  } finally { await response.dispose(); }
}

async function authenticate(page: Page): Promise<{ origin: string; principal: Principal; project: Project }> {
  // Import/list/typecheck never enters this fixture or reads password values.
  requireCondition(process.env.DASHBOARD_RESEARCHER_LIVE === '1',
    'Live researcher tests are disabled. Set DASHBOARD_RESEARCHER_LIVE=1 only after the parent confirms deployment.');
  requireCondition(process.env.DASHBOARD_URL, 'DASHBOARD_URL is required; no localhost/default deployment is assumed');
  const dashboard = httpsURL(process.env.DASHBOARD_URL, 'DASHBOARD_URL');
  requireCondition(dashboard.pathname === '/' && !dashboard.search, 'DASHBOARD_URL must be an HTTPS origin');
  const loginDeadline = Date.now() + budgets.login;
  const loginRemaining = () => {
    requireCondition(Date.now() < loginDeadline, 'Hosted login deadline exceeded');
    return Math.max(1, loginDeadline - Date.now());
  };
  try {
    await page.goto(dashboard.origin + '/', { waitUntil: 'domcontentloaded', timeout: loginRemaining() });
    if (page.url().includes('amazoncognito.com') || new URL(page.url()).pathname.includes('/login')) {
      requireCondition(new URL(page.url()).protocol === 'https:', 'Hosted login must use HTTPS');
      const password = process.env.DASHBOARD_PASSWORD;
      requireCondition(password, 'DASHBOARD_PASSWORD must be injected by the parent process');
      // Same auth variables and visible-form selectors as existing smoke.spec.ts.
      await page.locator('input[name="username"]:visible').first().fill(process.env.DASHBOARD_USER ?? 'admin', { timeout: loginRemaining() });
      await page.locator('input[name="password"]:visible').first().fill(password, { timeout: loginRemaining() });
      await page.locator('input[name="signInSubmitButton"]:visible, button[type="submit"]:visible').first().click({ timeout: loginRemaining() });
      await page.waitForURL(url => url.origin === dashboard.origin && !url.pathname.includes('/login'), { timeout: loginRemaining() });
    }
  } catch {
    // Playwright locator/navigation errors can otherwise include passwords or
    // identity-provider query strings. Never attach the original error.
    throw new Error('Hosted login failed; verify the parent-injected auth environment and deployed HTTPS origin (details redacted)');
  }
  const principal = await jsonRequest<Principal>(page, dashboard.origin, undefined, 'GET', '/api/me');
  requireCondition(principal.subject && principal.user && ['researcher', 'admin'].includes(principal.role),
    'A verified researcher/admin Cognito identity is required');
  requireCondition(principal.features.eks && principal.features.fsx, 'EKS and FSx must be enabled; this suite does not skip unsupported execution');
  const projects = await jsonRequest<Project[]>(page, dashboard.origin, undefined, 'GET', '/api/projects');
  const requested = process.env.DASHBOARD_PROJECT_ID;
  const project = requested ? projects.find(p => p.id === requested)
    : projects.find(p => p.id === principal.project?.id && projectMember(p, principal)) ?? projects.find(p => projectMember(p, principal));
  requireCondition(project && projectMember(project, principal),
    'The test identity needs explicit researcher/project-admin membership in a provisioned project (including admin identities)');
  requireCondition(/^hyperpod-ns-/.test(project.namespace) && !!project.queue, 'Project namespace and queue are not provisioned');
  await page.context().addCookies([{ name: 'pai-project', value: encodeURIComponent(project.id), url: dashboard.origin, secure: true, sameSite: 'Lax' }]);
  return { origin: dashboard.origin, principal, project };
}

interface RunRecord { id?: string; name: string; task: string; idempotencyKey: string; status?: string; cleanup?: string }
interface SessionRecord { id: string; kind: string; workflowId: string; origin?: string; status?: string; cleanup?: string }

export class Researcher {
  readonly tag = randomBytes(6).toString('hex');
  readonly runs: RunRecord[] = [];
  readonly sessions: SessionRecord[] = [];
  readonly datasets: { name: string; version?: number; state?: string; manifestHash?: string }[] = [];
  readonly phases: { at: string; phase: string; state: string }[] = [];
  private readonly openedPages: Page[] = [];
  private readonly cleanupErrors: string[] = [];

  constructor(readonly page: Page, readonly origin: string, readonly principal: Principal,
    readonly project: Project, private readonly transfers: APIRequestContext, private readonly info: TestInfo) {}

  api<T>(method: string, path: string, data?: unknown, statuses: readonly number[] = [200], timeout: number = budgets.api,
    extraHeaders: Record<string, string> = {}) {
    return jsonRequest<T>(this.page, this.origin, this.project.id, method, path, data, statuses, timeout, extraHeaders);
  }
  async recipe(): Promise<Recipe> { return this.api('GET', '/api/templates/custom'); }
  phase(phase: string, state: string) {
    const last = this.phases.at(-1);
    if (last?.phase === phase && last.state === state) return;
    this.phases.push({ at: new Date().toISOString(), phase, state: safeMessage(state) });
  }
  async poll<T>(phase: string, budget: number, read: (remaining: number) => Promise<T>,
    done: (value: T) => boolean, describe: (value: T) => string): Promise<T> {
    const deadline = Date.now() + budget;
    let last = 'not observed';
    while (Date.now() < deadline) {
      const value = await read(Math.max(1, Math.min(budgets.api, deadline - Date.now())));
      last = describe(value);
      this.phase(phase, last);
      if (done(value)) return value;
      await delay(Math.min(3_000, Math.max(0, deadline - Date.now())));
    }
    throw new Error(`${phase} exceeded ${budget}ms; last=${safeMessage(last)}; own run IDs=${this.runs.map(r => r.id ?? `unresolved:${r.name}`).join(',')}`);
  }

  async submit(workflow: CPUWorkflow): Promise<Run> {
    const record: RunRecord = { name: workflow.name, task: workflow.task, idempotencyKey: `researcher-${workflow.name}` };
    this.runs.push(record); // Record intent even if the creation reply is lost.
    if (workflow.dataset) this.datasets.push({ name: workflow.dataset });
    const run = await this.api<Run>('POST', '/api/workflows', { yaml: workflow.yaml, templateId: 'custom', acknowledgePreflight: true }, [202],
      budgets.api, { 'idempotency-key': record.idempotencyKey });
    requireCondition(typeof run.id === 'string' && safeID.test(run.id), 'Submission did not return a valid run ID');
    record.id = run.id;
    record.status = run.status;
    console.log(`[researcher] run=${run.id} workflow=${workflow.name} project=${this.project.id}`);
    this.assertOwnRun(run, workflow.name);
    return run;
  }
  private assertOwnRun(run: Run, name: string) {
    requireCondition(run.name === name && run.projectId === this.project.id && run.ownerSubject === this.principal.subject,
      'Run does not belong to this exact test identity/project/name; refusing to operate on it');
  }
  async detail(id: string, timeout: number = budgets.api): Promise<RunDetail> {
    const record = this.runs.find(r => r.id === id);
    requireCondition(record, 'Refusing to access an unrecorded run');
    const detail = await this.api<RunDetail>('GET', `/api/workflows/${id}`, undefined, [200], timeout);
    this.assertOwnRun(detail.workflow, record.name);
    record.status = detail.workflow.status;
    return detail;
  }
  async completed(id: string): Promise<RunDetail> {
    return this.poll(`run ${id} COMPLETE/READY`, budgets.workflow, remaining => this.detail(id, remaining), detail => {
      if (['FAILED', 'CANCELLED'].includes(detail.workflow.status)) throw new Error(`Own run ${id} ended ${detail.workflow.status}; no synthetic success`);
      return detail.workflow.status === 'SUCCEEDED' && detail.tasks.every(t => t.phase === 'SUCCEEDED');
    }, detail => `${detail.workflow.status}; ${detail.tasks.map(t => `${t.name}:${t.phase}`).join(',')}`);
  }
  async running(id: string, taskName: string): Promise<Task> {
    const detail = await this.poll(`run ${id} running`, budgets.running, remaining => this.detail(id, remaining), detail => {
      if (terminalRuns.has(detail.workflow.status)) throw new Error(`Session workload ${id} terminated before attachment: ${detail.workflow.status}`);
      return detail.workflow.status === 'RUNNING' && detail.tasks.some(t => t.name === taskName && t.phase === 'RUNNING');
    }, detail => `${detail.workflow.status}; ${detail.tasks.map(t => `${t.name}:${t.phase}`).join(',')}`);
    const task = detail.tasks.find(t => t.name === taskName)!;
    const expected = `/fsx/checkpoints/projects/${this.project.id}/runs/${id}/attempts/${task.attempts}/${taskName}`;
    requireCondition(task.outputPath === expected, 'Running task output path is not the expected project/run/attempt workspace');
    return task;
  }

  async dataset(name: string, timeout: number = budgets.api): Promise<DatasetDetail> {
    requireCondition(this.datasets.some(d => d.name === name), 'Refusing to access an unrecorded dataset');
    const result = await this.api<DatasetDetail>('GET', `/api/datasets/${name}`, undefined, [200], timeout);
    requireCondition(result.dataset.projectId === this.project.id && result.dataset.owner === this.principal.user,
      'Dataset is not owned by the test identity/project');
    return result;
  }
  async readyVersion(name: string, version: number): Promise<Version> {
    const detail = await this.poll(`dataset ${name} v${version} READY`, budgets.finalization,
      remaining => this.dataset(name, remaining),
      detail => detail.versions.some(v => v.version === version && v.state === 'READY'),
      detail => {
        const v = detail.versions.find(v => v.version === version);
        return `${v?.state ?? 'missing'}${v?.finalizationError ? `; ${safeMessage(v.finalizationError)}` : ''}`;
      });
    const ready = detail.versions.find(v => v.version === version)!;
    requireCondition(ready.manifestHash && /^[a-f0-9]{64}$/i.test(ready.manifestHash) &&
      ready.manifestUri?.startsWith('s3://') && ready.verifiedAt && Number.isFinite(Date.parse(ready.verifiedAt)) &&
      (ready.objectCount ?? 0) >= 1 && (ready.sizeBytes ?? 0) > 0, 'READY dataset lacks a verified nonempty durable manifest');
    const record = this.datasets.find(d => d.name === name)!;
    Object.assign(record, { version, state: ready.state, manifestHash: ready.manifestHash });
    return ready;
  }
  async signedTransfer(method: 'GET' | 'PUT', rawURL: string, bytes?: Buffer, contentType?: string): Promise<Buffer> {
    const url = httpsURL(rawURL, 'Presigned transfer');
    let response;
    try {
      // Separate context: dashboard/session cookies and identity headers never
      // reach object storage. No AWS SDK, profile, CLI, or credential lookup.
      response = await this.transfers.fetch(url.href, {
        method, data: bytes, maxRedirects: 0, timeout: budgets.transfer,
        headers: contentType ? { 'content-type': contentType } : {},
      });
    } catch { throw new Error('Presigned transfer failed (network/TLS/deadline); signed URL omitted'); }
    try {
      requireCondition(response.status() >= 200 && response.status() < 300, `Presigned ${method} returned HTTP ${response.status()}`);
      return method === 'GET' ? await response.body() : Buffer.alloc(0);
    } finally { await response.dispose(); }
  }
  async versionFile(version: Version, relative: string): Promise<Buffer> {
    requireCondition(!relative.startsWith('/') && !relative.includes('..') && !relative.includes('\\'), 'Unsafe proof filename');
    const uri = new URL(version.uri);
    requireCondition(uri.protocol === 's3:' && !uri.username && !uri.password && !uri.search && !uri.hash &&
      uri.pathname.startsWith(`/projects/${this.project.id}/`), 'Artifact URI is outside the test project');
    const key = uri.pathname.slice(1).replace(/\/?$/, '/') + relative;
    const signed = await this.api<{ url: string }>('POST', '/api/s3/presign', { bucket: uri.hostname, key, op: 'get' });
    return this.signedTransfer('GET', signed.url);
  }

  async connectionReady(runId: string, taskName: string) {
    await this.poll('own task terminal/files availability', budgets.session,
      remaining => this.api<{ replicas?: { replicaIndex: number; ports: string[] }[] }>('GET',
        `/api/sessions/connect?workflowId=${runId}&taskName=${taskName}`, undefined, [200, 409], remaining),
      options => {
        const replica = options.replicas?.find(r => r.replicaIndex === 0);
        if (!replica) return false;
        requireCondition(replica.ports.includes('pai-files'), 'Ready CPU task does not expose pai-files; F24 is unsupported in this deployment');
        return true;
      }, options => `${options.replicas?.length ?? 0} ready replicas`);
  }
  async createSession(kind: 'terminal' | 'port-forward', runId: string, taskName: string): Promise<ManagedSession> {
    requireCondition(this.runs.some(r => r.id === runId), 'Refusing to attach a session to an unrecorded run');
    const session = await this.api<ManagedSession>('POST', '/api/sessions', {
      kind, workflowId: runId, taskName, replicaIndex: 0, ttlMinutes: 10,
      ...(kind === 'port-forward' ? { portName: 'pai-files' } : {}),
    }, [202]);
    requireCondition(typeof session.id === 'string' && safeID.test(session.id), 'Session creation did not return a valid ID');
    this.sessions.push({ id: session.id, kind, workflowId: runId, status: session.status });
    console.log(`[researcher] session=${session.id} kind=${kind} run=${runId}`);
    this.assertOwnSession(session);
    return this.poll(`session ${session.id} READY`, budgets.session, async remaining => {
      const sessions = await this.api<ManagedSession[]>('GET', '/api/sessions', undefined, [200], remaining);
      return sessions.find(s => s.id === session.id);
    }, current => {
      if (!current) return false;
      this.assertOwnSession(current);
      if (['CLOSED', 'CLOSING', 'FAILED'].includes(current.status)) throw new Error(`Session ${session.id} ended before launch`);
      return current.status === 'READY' && current.canOpen;
    }, current => current?.status ?? 'missing') as Promise<ManagedSession>;
  }
  private assertOwnSession(session: ManagedSession) {
    requireCondition(this.sessions.some(s => s.id === session.id && s.workflowId === session.workflowId) &&
      session.owner === this.principal.user && session.projectId === this.project.id,
    'Session does not belong to this test identity/project/run; refusing to operate on it');
  }
  async launch(session: ManagedSession): Promise<Page> {
    const launch = await this.api<{ url: string; expiresAt: string }>('POST', `/api/sessions/${session.id}/launch`);
    const url = httpsURL(launch.url, 'Session launch');
    requireCondition(url.hostname.startsWith(session.id + '.') && url.pathname === '/' && url.searchParams.has('ticket'),
      'Launch URL is not the expected isolated session host/ticket');
    requireCondition(Date.parse(launch.expiresAt) > Date.now(), 'Session launch ticket is already expired');
    const opened = await this.page.context().newPage();
    this.openedPages.push(opened);
    try {
      const response = await opened.goto(url.href, { waitUntil: 'domcontentloaded', timeout: budgets.launch });
      requireCondition(response?.status() === 200, 'Session gateway did not serve a successful page');
      await opened.waitForURL(current => current.origin === url.origin && !current.searchParams.has('ticket'), { timeout: 15_000 });
    } catch { throw new Error(`Session ${session.id} HTTPS launch/exchange failed; ticket URL omitted`); }
    this.sessions.find(s => s.id === session.id)!.origin = url.origin;
    return opened;
  }

  async cleanup(): Promise<void> {
    const deadline = Date.now() + budgets.cleanup;
    const remaining = () => {
      requireCondition(Date.now() < deadline, 'Owned-resource cleanup deadline exceeded');
      return Math.max(1, Math.min(budgets.api, deadline - Date.now()));
    };
    for (const page of this.openedPages) await page.close().catch(() => undefined);
    for (const record of [...this.sessions].reverse()) {
      try {
        const current = (await this.api<ManagedSession[]>('GET', '/api/sessions', undefined, [200], remaining())).find(s => s.id === record.id);
        requireCondition(current, `Recorded session ${record.id} disappeared before cleanup confirmation`);
        this.assertOwnSession(current);
        const closed = await this.api<ManagedSession>('DELETE', `/api/sessions/${record.id}`, undefined, [200], remaining());
        requireCondition(closed.status === 'CLOSED', `Attached session ${record.id} did not close`);
        record.status = closed.status; record.cleanup = 'CLOSED';
        if (record.origin) {
          const response = await this.page.request.get(record.origin + '/', { headers: { origin: record.origin }, maxRedirects: 0, timeout: remaining() });
          try { requireCondition([401, 403, 404, 410].includes(response.status()), `Session ${record.id} grant was not rejected after closure`); }
          finally { await response.dispose(); }
        }
      } catch (error) { this.cleanupErrors.push(`session ${record.id}: ${safeMessage(error)}`); }
    }
    for (const record of this.runs) {
      if (!record.id) { this.cleanupErrors.push(`Run creation reply missing for ${record.name}; inspect its idempotent submission intent`); continue; }
      try {
        let detail = await this.detail(record.id, remaining());
        requireCondition(detail.tasks.some(t => t.name === record.task), `Recorded task ${record.task} is missing during cleanup`);
        if (!terminalRuns.has(detail.workflow.status)) {
          await this.api('POST', `/api/workflows/${record.id}/cancel`, undefined, [202], remaining());
          detail = await this.poll(`cleanup own run ${record.id}`, Math.max(1, deadline - Date.now()),
            timeout => this.detail(record.id!, timeout),
            result => terminalRuns.has(result.workflow.status) && result.tasks.every(task => terminalTasks.has(task.phase)),
            result => `${result.workflow.status}; ${result.tasks.map(t => t.phase).join(',')}`);
        }
        requireCondition(terminalRuns.has(detail.workflow.status) && detail.tasks.every(t => terminalTasks.has(t.phase)),
          `Run ${record.id} still has active work`);
        record.cleanup = `terminal:${detail.workflow.status}; history retained`;
      } catch (error) { this.cleanupErrors.push(`run ${record.id}: ${safeMessage(error)}`); }
    }
    await this.info.attach('researcher-resources', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
      test: this.info.title, projectId: this.project.id, runs: this.runs, datasets: this.datasets,
      sessions: this.sessions, phases: this.phases, cleanupErrors: this.cleanupErrors,
      retained: 'Completed workflow/dataset history and small durable proof artifacts are intentionally retained. No S3 purge or unrelated-resource deletion.',
    }, null, 2)) });
    if (this.cleanupErrors.length) throw new Error(`Owned-resource cleanup incomplete: ${this.cleanupErrors.join('; ')}`);
  }
}

export const test = base.extend<{ researcher: Researcher }>({
  researcher: [async ({ page }, use, info) => {
    const { origin, principal, project } = await authenticate(page);
    const transfers = await request.newContext({ ignoreHTTPSErrors: false, timeout: budgets.transfer });
    const harness = new Researcher(page, origin, principal, project, transfers, info);
    try { await use(harness); }
    finally {
      try { await harness.cleanup(); }
      finally { await transfers.dispose(); }
    }
  }, { timeout: budgets.login + budgets.cleanup + 2 * budgets.api + 60_000 }],
});
