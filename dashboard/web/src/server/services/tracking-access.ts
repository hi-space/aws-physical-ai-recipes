import { z } from 'zod';
import { resolveProject } from '../auth/projects';
import { requireRole, type Session } from '../auth/session';
import { badRequest, forbidden, notFound } from '../errors';
import { getRepo, type Repo } from '../store/repo';
import * as mlflow from '../aws/mlflow';
import type { MlExperiment, MlRun } from '../aws/mlflow';

export interface TrackingUpstream {
  searchExperiments: typeof mlflow.searchExperiments;
  getExperiment: typeof mlflow.getExperiment;
  searchRuns: typeof mlflow.searchRuns;
  getRun: typeof mlflow.getRun;
  listArtifacts: typeof mlflow.listArtifacts;
  getMetricHistory: typeof mlflow.getMetricHistory;
  searchRegisteredModels: typeof mlflow.searchRegisteredModels;
}
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const projectIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const metricKey = z.string().min(1).max(250).refine(value => value.trim().length > 0 && !/[\u0000-\u001f]/.test(value));
function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw badRequest('Invalid tracking query', { issues: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`) });
  return parsed.data;
}
function experimentInProject(experiment: MlExperiment | undefined, projectId: string, id?: string): experiment is MlExperiment {
  const prefix = `pai/${projectId}/`;
  return Boolean(experiment && typeof experiment.name === 'string' && experiment.name.startsWith(prefix) &&
    experiment.name.length > prefix.length && identifier.safeParse(experiment.experiment_id).success &&
    (id === undefined || experiment.experiment_id === id));
}
function runInProject(run: MlRun | undefined, projectId: string): run is MlRun {
  if (!run?.info || !identifier.safeParse(run.info.run_id).success || !identifier.safeParse(run.info.experiment_id).success ||
      !Array.isArray(run.data?.tags)) return false;
  const ownership = run.data.tags.filter(tag => tag.key === 'pai.project_id');
  return ownership.length === 1 && ownership[0].value === projectId;
}

/** Browser-facing MLflow reads. Upstream filters are optimization, not authorization.
 * No run/experiment ownership is cached across requests, including for platform admins.
 */
export class TrackingAccess {
  constructor(private readonly repo: Repo, private readonly upstream: TrackingUpstream) {}
  private async access(session: Session, projectId: string) {
    validate(projectIdSchema, projectId);
    if (session.authMethod === 'token' && !session.tokenProjectId ||
        session.tokenProjectId && session.tokenProjectId !== projectId) throw forbidden('Tracking token belongs to another project context');
    return resolveProject(session, projectId, this.repo, 'viewer');
  }
  private async ownedExperiment(projectId: string, id: string) {
    const experiment = await this.upstream.getExperiment(validate(identifier, id));
    if (!experimentInProject(experiment, projectId, id)) throw notFound('experiment');
    return experiment;
  }
  private async ownedRun(session: Session, projectId: string, id: string) {
    await this.access(session, projectId);
    validate(identifier, id);
    const run = await this.upstream.getRun(id);
    if (!runInProject(run, projectId) || run.info.run_id !== id) throw notFound('run');
    await this.ownedExperiment(projectId, run.info.experiment_id);
    return run;
  }
  async experiments(session: Session, projectId: string): Promise<MlExperiment[]> {
    await this.access(session, projectId);
    const found = await this.upstream.searchExperiments(`name LIKE 'pai/${projectId}/%'`);
    await this.access(session, projectId);
    return found.filter(experiment => experimentInProject(experiment, projectId));
  }
  async runs(session: Session, projectId: string, experimentIds: string[], filter = '', max = 100): Promise<MlRun[]> {
    await this.access(session, projectId);
    validate(z.array(identifier).min(1).max(50), experimentIds);
    validate(z.number().int().min(1).max(500), max);
    validate(z.string().max(4000).refine(value => !/[\u0000-\u001f]/.test(value)), filter);
    const ids = [...new Set(experimentIds)];
    await Promise.all(ids.map(id => this.ownedExperiment(projectId, id)));
    const query = `tags.\`pai.project_id\` = '${projectId}'${filter.trim() ? ` AND ${filter.trim()}` : ''}`;
    const found = await this.upstream.searchRuns(ids, query, max);
    await this.access(session, projectId);
    await Promise.all(ids.map(id => this.ownedExperiment(projectId, id)));
    const allowed = new Set(ids);
    // A caller filter or a misbehaving upstream cannot broaden the returned project data.
    return found.filter(run => runInProject(run, projectId) && allowed.has(run.info.experiment_id)).slice(0, max);
  }
  async detail(session: Session, projectId: string, id: string) {
    await this.ownedRun(session, projectId, id);
    const artifacts = await this.upstream.listArtifacts(id);
    // Ownership tags/experiment names may change while the subresource is read.
    const run = await this.ownedRun(session, projectId, id);
    return { run, artifacts };
  }
  async history(session: Session, projectId: string, id: string, keys: string[]) {
    await this.access(session, projectId);
    validate(z.array(metricKey).min(1).max(16), keys);
    await this.ownedRun(session, projectId, id);
    const records = await Promise.all([...new Set(keys)].map(async key => [key, await this.upstream.getMetricHistory(id, key)] as const));
    await this.ownedRun(session, projectId, id);
    return Object.fromEntries(records);
  }
  async legacyModels(session: Session) {
    requireRole(session, 'admin');
    if (session.authMethod === 'token' || session.tokenProjectId) throw forbidden('Legacy MLflow models require an explicit platform-admin browser context');
    return this.upstream.searchRegisteredModels();
  }
}

export function trackingAccess() {
  return new TrackingAccess(getRepo(), mlflow);
}
