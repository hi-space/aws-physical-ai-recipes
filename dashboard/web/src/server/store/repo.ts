import { config } from '../config';
import { DynamoKV, MemoryKV, type Item, type KV } from './dynamo';
import type { AuditEntry, Dataset, DatasetVersion, Session, Settings, Task, Template, Workflow, WorkflowEvent } from './types';

function strip<T>(i: Item): T {
  const copy: Record<string, unknown> = { ...i };
  delete copy.pk;
  delete copy.sk;
  delete copy.gsi1pk;
  delete copy.gsi1sk;
  delete copy.ttl;
  return copy as T;
}
const pad = (n: number, w = 6) => String(n).padStart(w, '0');
let seqCounter = 0;
const nextSeq = () => (seqCounter = (seqCounter + 1) % 1000);

export class Repo {
  constructor(readonly kv: KV) {}

  // ---- workflows
  async putWorkflow(w: Workflow) {
    await this.kv.put({ pk: `WF#${w.id}`, sk: 'META', gsi1pk: 'TYPE#WF', gsi1sk: `${w.createdAt}#${w.id}`, ...w });
  }
  async getWorkflow(id: string) {
    const i = await this.kv.get(`WF#${id}`, 'META');
    return i ? strip<Workflow>(i) : undefined;
  }
  async listWorkflows(opts: { limit?: number } = {}) {
    return (await this.kv.queryGsi1('TYPE#WF', { desc: true, limit: opts.limit ?? 200 })).map((i) => strip<Workflow>(i));
  }
  async deleteWorkflow(id: string) {
    for (const it of await this.kv.query(`WF#${id}`)) await this.kv.del(it.pk, it.sk);
  }
  async putTask(t: Task) {
    await this.kv.put({ pk: `WF#${t.workflowId}`, sk: `TASK#${t.name}`, ...t });
  }
  async listTasks(wfId: string) {
    return (await this.kv.query(`WF#${wfId}`, 'TASK#')).map((i) => strip<Task>(i));
  }
  async appendEvent(e: Omit<WorkflowEvent, 'seq'>) {
    const seq = nextSeq();
    const ev: WorkflowEvent = { ...e, seq };
    await this.kv.put({ pk: `WF#${e.workflowId}`, sk: `EVT#${e.ts}#${pad(seq, 3)}`, ...ev });
  }
  async listEvents(wfId: string, limit = 300) {
    return (await this.kv.query(`WF#${wfId}`, 'EVT#', { desc: true, limit })).map((i) => strip<WorkflowEvent>(i));
  }

  // ---- datasets
  async putDataset(d: Dataset) {
    await this.kv.put({ pk: `DS#${d.name}`, sk: 'META', gsi1pk: 'TYPE#DS', gsi1sk: `${d.updatedAt}#${d.name}`, ...d });
  }
  async getDataset(name: string) {
    const i = await this.kv.get(`DS#${name}`, 'META');
    return i ? strip<Dataset>(i) : undefined;
  }
  async listDatasets() {
    return (await this.kv.queryGsi1('TYPE#DS', { desc: true })).map((i) => strip<Dataset>(i));
  }
  async deleteDataset(name: string) {
    for (const it of await this.kv.query(`DS#${name}`)) await this.kv.del(it.pk, it.sk);
  }
  async putVersion(v: DatasetVersion) {
    await this.kv.put({ pk: `DS#${v.dataset}`, sk: `V#${pad(v.version)}`, ...v });
  }
  async listVersions(name: string) {
    return (await this.kv.query(`DS#${name}`, 'V#', { desc: true })).map((i) => strip<DatasetVersion>(i));
  }
  async getVersion(name: string, version: number) {
    const i = await this.kv.get(`DS#${name}`, `V#${pad(version)}`);
    return i ? strip<DatasetVersion>(i) : undefined;
  }

  // ---- templates
  async putTemplate(t: Template) {
    await this.kv.put({ pk: `TPL#${t.id}`, sk: 'META', gsi1pk: 'TYPE#TPL', gsi1sk: `${t.builtin ? '0' : '1'}#${t.title}`, ...t });
  }
  async listTemplates() {
    return (await this.kv.queryGsi1('TYPE#TPL')).map((i) => strip<Template>(i));
  }
  async getTemplate(id: string) {
    const i = await this.kv.get(`TPL#${id}`, 'META');
    return i ? strip<Template>(i) : undefined;
  }
  async deleteTemplate(id: string) {
    await this.kv.del(`TPL#${id}`, 'META');
  }

  // ---- sessions
  async putSession(s: Session) {
    await this.kv.put({ pk: `SESS#${s.id}`, sk: 'META', gsi1pk: 'TYPE#SESS', gsi1sk: `${s.createdAt}#${s.id}`, ...s });
  }
  async listSessions() {
    return (await this.kv.queryGsi1('TYPE#SESS', { desc: true })).map((i) => strip<Session>(i));
  }
  async getSession(id: string) {
    const i = await this.kv.get(`SESS#${id}`, 'META');
    return i ? strip<Session>(i) : undefined;
  }
  async deleteSession(id: string) {
    await this.kv.del(`SESS#${id}`, 'META');
  }

  // ---- audit
  async audit(e: Omit<AuditEntry, 'seq'>) {
    const seq = nextSeq();
    await this.kv.put({ pk: 'AUDIT', sk: `${e.ts}#${pad(seq, 3)}`, ttl: Math.floor(Date.now() / 1000) + 90 * 86400, ...e, seq });
  }
  async listAudit(limit = 200) {
    return (await this.kv.query('AUDIT', '', { desc: true, limit })).map((i) => strip<AuditEntry>(i));
  }

  // ---- settings / lease
  async getSettings(): Promise<Settings> {
    const i = await this.kv.get('SYS', 'SETTINGS');
    return i ? strip<Settings>(i) : { notifyOn: ['SUCCEEDED', 'FAILED'], defaultNamespace: config().defaultNamespace };
  }
  async putSettings(s: Settings) {
    await this.kv.put({ pk: 'SYS', sk: 'SETTINGS', ...s });
  }
  acquireLease(name: string, holder: string, ttlSec: number) {
    return this.kv.acquireLease('SYS', `LEASE#${name}`, holder, ttlSec);
  }
  async getLease(name: string) {
    return (await this.kv.get('SYS', `LEASE#${name}`)) as (Item & { holder?: string; expires?: number }) | undefined;
  }
}

let repo: Repo | undefined;
export function getRepo(): Repo {
  if (!repo) {
    const c = config();
    repo = new Repo(c.authMode === 'dev' && !process.env.TABLE_NAME ? new MemoryKV() : new DynamoKV(c.tableName));
  }
  return repo;
}
export function setRepoForTests(r: Repo) {
  repo = r;
}
