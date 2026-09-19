import { datasetGuard, referenceWrites, workflowConsumers, workflowReferenceWrites, validateInputMetadata, type DatasetConsumer } from './dataset-references';
import { createHash, randomUUID } from 'node:crypto';
import { HttpError } from '../errors';
import type { Write } from './atomic';
import { config } from '../config';
import { DynamoKV, MemoryKV, type Item, type KV } from './dynamo';
import type { AuditEntry, Dataset, DatasetVersion, Session, Settings, Task, Template, Workflow, WorkflowEvent, RunLease, OutboxEntry } from './types';
function strip<T>(i: Item): T {
  const copy: Record<string, unknown> = {
    ...i
  };
  delete copy.pk;
  delete copy.sk;
  delete copy.gsi1pk;
  delete copy.gsi1sk;
  delete copy.ttl;
  return copy as T;
}
const pad = (n: number, w = 6) => String(n).padStart(w, '0');
let seqCounter = 0;
const nextSeq = () => seqCounter = (seqCounter + 1) % 1000;
export class Repo {
  constructor(readonly kv: KV, private readonly validateInputs?: (repo: Repo, workflow: Workflow) => Promise<void>) {}

  // ---- workflows
  async putWorkflow(w: Workflow, lease?: RunLease) {
    await this.write(this.workflowWrites(w), lease);
  }
  private workflowItem(w: Workflow): Item {
    return {
      pk: `WF#${w.id}`,
      sk: 'META',
      gsi1pk: 'TYPE#WF',
      gsi1sk: `${w.createdAt}#${w.id}`,
      ...w
    };
  }
  private workflowWrites(w: Workflow): Write[] {
    const writes: Write[] = [{
      kind: 'put',
      item: this.workflowItem(w)
    }];
    if (w.projectId) writes.push({
      kind: 'put',
      item: {
        ...this.workflowItem(w),
        sk: 'PROJECT',
        gsi1pk: `PROJECT#${w.projectId}#WF`
      }
    });
    return writes;
  }
  private taskItem(t: Task): Item {
    return {
      pk: `WF#${t.workflowId}`,
      sk: `TASK#${t.name}`,
      ...t
    };
  }
  private leaseCheck(lease: RunLease): Write {
    return {
      kind: 'check',
      pk: `WF#${lease.runId}`,
      sk: 'LEASE',
      condition: {
        equals: {
          holder: lease.holder
        },
        after: {
          expires: Date.now()
        }
      }
    };
  }
  async write(writes: Write[], lease?: RunLease) {
    if (!(await this.kv.transaction(lease ? [...writes, this.leaseCheck(lease)] : writes))) throw new Error('lease lost or conditional write conflict');
  }
  async createWorkflow(w: Workflow, tasks: Task[], key?: {
    scope: string;
    hash: string;
  }, outbox: OutboxEntry['kind'][] = []) {
    await this.validateInputs?.(this, w);
    await validateInputMetadata(this.kv, w);
    const writes: Write[] = [...this.workflowWrites(w).map(write => ({
      ...write,
      condition: {
        absent: true as const
      }
    })), ...tasks.map(t => ({
      kind: 'put' as const,
      item: this.taskItem(t),
      condition: {
        absent: true as const
      }
    })), ...outbox.map(kind => ({
      kind: 'put' as const,
      item: {
        pk: `WF#${w.id}`,
        sk: `OUT#${kind}`,
        kind,
        attempts: 0,
        idempotencyKey: `${w.id}:${kind}`
      }
    }))];
    if (key) writes.push({
      kind: 'put',
      item: {
        pk: `IDEM#${key.scope}`,
        sk: 'SUBMIT',
        runId: w.id,
        hash: key.hash
      },
      condition: {
        absent: true
      }
    });
    for (let attempt = 0; attempt < 8; attempt++) {
      const references = await workflowReferenceWrites(this.kv, w);
      if (writes.length + references.length > 100) throw new HttpError(400, 'Workflow and dataset references exceed the atomic admission budget');
      if (await this.kv.transaction([...writes, ...references])) return w;
      if (await this.getWorkflow(w.id)) break;
    }
    if (key) {
      const saved = await this.findSubmission(key.scope, key.hash);
      if (saved) return saved;
    }
    throw new HttpError(409, 'Concurrent submission conflict; retry using the same idempotency key');
  }
  async findSubmission(scope: string, hash: string) {
    const item = await this.kv.get(`IDEM#${scope}`, 'SUBMIT');
    if (!item) return undefined;
    if (item.hash !== hash) throw new HttpError(409, 'Idempotency key was already used for a different workflow');
    const wf = await this.getWorkflow(String(item.runId));
    if (!wf) throw new HttpError(409, 'Idempotent workflow was deleted');
    return wf;
  }
  async listWorkflowsPage(opts: {
    limit?: number;
    cursor?: string;
    projectId?: string;
  } = {}) {
    if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 1000)) throw new Error('invalid page limit');
    const page = await this.kv.queryGsi1Page(opts.projectId ? `PROJECT#${opts.projectId}#WF` : 'TYPE#WF', {
      ...opts,
      desc: true
    });
    return {
      items: page.items.map(i => strip<Workflow>(i)),
      cursor: page.cursor
    };
  }
  async getWorkflow(id: string) {
    const i = await this.kv.get(`WF#${id}`, 'META');
    return i ? strip<Workflow>(i) : undefined;
  }
  async listWorkflows(opts: {
    limit?: number;
    projectId?: string;
    cursor?: string;
  } = {}) {
    return (await this.listWorkflowsPage(opts)).items;
  }
  async deleteWorkflow(id: string) {
    const wf = await this.getWorkflow(id);
    if (wf) for (const name of new Set((wf.spec?.workflow?.tasks ?? []).flatMap(t => (t.inputs ?? []).flatMap(i => 'dataset' in i ? [i.dataset.name] : [])))) {
      if (await this.getDataset(name)) await this.recordDatasetReference(name, `workflow:${id}`, workflowConsumers(wf, name), true);
    }
    for (const it of await this.kv.query(`WF#${id}`)) await this.kv.del(it.pk, it.sk);
  }
  async putTask(t: Task, lease?: RunLease) {
    await this.write([{
      kind: 'put',
      item: this.taskItem(t)
    }], lease);
  }
  async putTasks(tasks: Task[], lease: RunLease) {
    await this.write(tasks.map(t => ({
      kind: 'put',
      item: this.taskItem(t)
    })), lease);
  }
  async listTasks(wfId: string) {
    return (await this.kv.query(`WF#${wfId}`, 'TASK#')).map(i => strip<Task>(i));
  }
  async appendEvent(e: Omit<WorkflowEvent, 'seq'>) {
    const seq = nextSeq();
    const ev: WorkflowEvent = {
      ...e,
      seq
    };
    await this.kv.put({
      pk: `WF#${e.workflowId}`,
      sk: `EVT#${e.ts}#${pad(seq, 3)}#${randomUUID()}`,
      ...ev
    });
  }
  async listEvents(wfId: string, limit = 300) {
    return (await this.kv.query(`WF#${wfId}`, 'EVT#', {
      desc: true,
      limit
    })).map(i => strip<WorkflowEvent>(i));
  }

  // ---- datasets
  async putDataset(d: Dataset) {
    for(let retry=0;retry<8;retry++) {
      const guard=await datasetGuard(this.kv,d.name),current=await this.kv.get(`DS#${d.name}`,'META');
      if(current?.deletedAt)throw new HttpError(409,'Deleted dataset names are reserved');
      if(current&&(current.projectId??'')!==(d.projectId??''))throw new HttpError(409,'Dataset project binding is immutable');
      if(await this.kv.transaction([
        {kind:'check',pk:guard.pk,sk:guard.sk,condition:{equals:{state:'ACTIVE'}}},
        {kind:'put',item:{pk:`DS#${d.name}`,sk:'META',gsi1pk:'TYPE#DS',gsi1sk:`${d.updatedAt}#${d.name}`,...d,latestVersion:Math.max(d.latestVersion,Number(current?.latestVersion??0))},
          condition:current?{equals:{latestVersion:current.latestVersion}}:{absent:true}}
      ]))return;
    }
    throw new HttpError(409,'Dataset metadata changed concurrently; retry');
  }
  async getDataset(name: string) {
    const i = await this.kv.get(`DS#${name}`, 'META');
    return i && !i.deletedAt ? strip<Dataset>(i) : undefined;
  }
  async listDatasets() {
    return (await this.kv.queryGsi1('TYPE#DS', {
      desc: true
    })).filter(i => !i.deletedAt).map(i => strip<Dataset>(i));
  }
  async recordDatasetReference(name: string, id: string, consumer: DatasetConsumer | DatasetConsumer[], historical = false) {
    for (let retry=0;retry<8;retry++) if(await this.kv.transaction(await referenceWrites(this.kv,name,id,Array.isArray(consumer)?consumer:[consumer],historical))) return;
    throw new HttpError(409,'Dataset references changed concurrently; retry');
  }
  async datasetLineage(name: string) {
    const consumers=new Map<string,DatasetConsumer>();
    const key=(c:DatasetConsumer)=>`${c.workflowId}/${c.task}/${c.inputIndex}`;
    for(const row of await this.kv.query(`DS#${name}`,'REFERENCE#')) for(const c of row.consumers as DatasetConsumer[]) {
      const wf=await this.getWorkflow(c.workflowId);
      consumers.set(key(c), {...c,status:wf?.status??c.status,workflowDeleted:!wf});
    }
    if(!this.kv.scanPage) throw new HttpError(503,'Complete historical reference inspection is unavailable; deletion is disabled');
    let cursor:string|undefined;const seen=new Set<string>();
    do {
      const page=await this.kv.scanPage(cursor);
      for(const item of page.items) for(const c of workflowConsumers(strip<Workflow>(item),name)) consumers.set(key(c),c);
      cursor=page.cursor;
      if(cursor){if(seen.has(cursor))throw new Error('Repeated historical scan cursor');seen.add(cursor);}
    }while(cursor);
    const produced=(await this.listVersions(name)).filter(v=>v.producedBy).map(v=>({version:v.version,...v.producedBy!}));
    return {produced,consumers:[...consumers.values()]};
  }
  async deleteDataset(name: string) {
    const ds=await this.getDataset(name);if(!ds)return;
    const guard=await datasetGuard(this.kv,name);
    const history=await this.datasetLineage(name);
    if(history.consumers.length || history.produced.length) throw new HttpError(409,'Dataset is referenced by experiment history and cannot be deleted');
    const current=await this.kv.get(`DS#${name}`,'META');
    if(!current || current.deletedAt)return;
    if(current.latestVersion!==ds.latestVersion) throw new HttpError(409,'Dataset changed during deletion; retry');
    const deletedAt=new Date().toISOString();
    if(!await this.kv.transaction([
      {kind:'put',item:{...guard,state:'DELETED',revision:Number(guard.revision)+1},condition:{equals:{state:'ACTIVE',revision:guard.revision}}},
      {kind:'put',item:{...current,deletedAt},condition:{equals:{latestVersion:ds.latestVersion}}}
    ])) throw new HttpError(409,'Dataset references changed during deletion; retry');
  }
  async putVersion(v: DatasetVersion) {
    await this.kv.put({
      pk: `DS#${v.dataset}`,
      sk: `V#${pad(v.version)}`,
      ...v
    });
  }
  async listVersions(name: string) {
    return (await this.kv.query(`DS#${name}`, 'V#', {
      desc: true
    })).map(i => strip<DatasetVersion>(i));
  }
  async getVersion(name: string, version: number) {
    const i = await this.kv.get(`DS#${name}`, `V#${pad(version)}`);
    return i ? strip<DatasetVersion>(i) : undefined;
  }

  /** Atomic latest/version/receipt publication. Retry with same publicationId after any ambiguous reply. */
  async publishDatasetVersion(dataset: Dataset, input: Omit<DatasetVersion, 'version'>, publicationId: string, lease?: RunLease): Promise<DatasetVersion> {
    const receiptKey = {
      pk: `PUB#${createHash('sha256').update(publicationId).digest('hex')}`,
      sk: 'META'
    };
    if (input.state === 'READY' && input.objectCount !== undefined && input.objectCount > 1024) throw new HttpError(400, 'Dataset publication exceeds runtime 1024-file limit');
    const guard = await datasetGuard(this.kv, dataset.name);
    if ((await this.kv.get(`DS#${dataset.name}`, 'META'))?.deletedAt) throw new HttpError(409, 'Dataset is deleted');
    const producer = input.producedBy,
      attempt = input.producedAttempt;
    const assertAttempt = async () => {
      if (!producer || attempt === undefined) return;
      const task = await this.kv.get(`WF#${producer.workflowId}`, `TASK#${producer.task}`);
      if (!lease || lease.runId !== producer.workflowId || task?.attempts !== attempt || task.phase !== 'FINALIZING') throw new Error('stale or non-finalizing artifact attempt');
    };
    await assertAttempt();
    for (let n = 0; n < 20; n++) {
      const receipt = await this.kv.get(receiptKey.pk, receiptKey.sk);
      if (receipt) {
        if (receipt.dataset !== dataset.name || receipt.uri !== input.uri) throw new HttpError(409, 'publication id reused with different artifact');
        return strip<DatasetVersion>(receipt);
      }
      const current = await this.getDataset(dataset.name);
      if (current && (current.projectId ?? '') !== (dataset.projectId ?? '')) throw new HttpError(409, 'dataset belongs to another project');
      const version = (current?.latestVersion ?? 0) + 1;
      const v: DatasetVersion = {
        ...input,
        projectId: dataset.projectId,
        ownerSubject: dataset.ownerSubject,
        version,
        publicationId
      };
      const ds = {
        ...(current ?? dataset),
        latestVersion: version,
        updatedAt: input.createdAt
      };
      const writes: Write[] = [{
        kind: 'put',
        item: {
          pk: `DS#${ds.name}`,
          sk: 'META',
          gsi1pk: 'TYPE#DS',
          gsi1sk: `${ds.updatedAt}#${ds.name}`,
          ...ds
        },
        condition: current ? {
          equals: {
            latestVersion: current.latestVersion
          }
        } : {
          absent: true
        }
      }, {
        kind: 'put',
        item: {
          pk: `DS#${ds.name}`,
          sk: `V#${pad(version)}`,
          ...v
        },
        condition: {
          absent: true
        }
      }, {
        kind: 'put',
        item: {
          ...receiptKey,
          ...v
        },
        condition: {
          absent: true
        }
      }];
      writes.push({kind:'check',pk:guard.pk,sk:guard.sk,condition:{equals:{state:'ACTIVE'}}});
      if (lease) writes.push(this.leaseCheck(lease));
      if (producer && attempt !== undefined) writes.push({
        kind: 'check',
        pk: `WF#${producer.workflowId}`,
        sk: `TASK#${producer.task}`,
        condition: {
          equals: {
            attempts: attempt,
            phase: 'FINALIZING'
          }
        }
      });
      if (await this.kv.transaction(writes)) return v;
      await assertAttempt();
      if (lease && !(await this.runLeaseValid(lease))) throw new Error('lease lost during artifact publication');
    }
    throw new HttpError(409, 'Dataset publication contention; retry with same publication id');
  }
  async acquireRunLease(runId: string, ttlSec = 30): Promise<RunLease | undefined> {
    const pk = `WF#${runId}`,
      sk = 'LEASE',
      old = await this.kv.get(pk, sk),
      now = Date.now();
    if (old && Number(old.expires) > now) return undefined;
    const lease: RunLease = {
      runId,
      holder: randomUUID()
    };
    const ok = await this.kv.transaction([{
      kind: 'put',
      item: {
        pk,
        sk,
        holder: lease.holder,
        expires: now + ttlSec * 1000
      },
      condition: old ? {
        equals: {
          holder: old.holder,
          expires: old.expires
        }
      } : {
        absent: true
      }
    }]);
    return ok ? lease : undefined;
  }
  async renewRunLease(lease: RunLease, ttlSec = 30) {
    return this.kv.transaction([{
      kind: 'put',
      item: {
        pk: `WF#${lease.runId}`,
        sk: 'LEASE',
        holder: lease.holder,
        expires: Date.now() + ttlSec * 1000
      },
      condition: {
        equals: {
          holder: lease.holder
        },
        after: {
          expires: Date.now()
        }
      }
    }]);
  }
  async runLeaseValid(lease: RunLease) {
    const item = await this.kv.get(`WF#${lease.runId}`, 'LEASE');
    return item?.holder === lease.holder && Number(item.expires) > Date.now();
  }
  async releaseRunLease(lease: RunLease) {
    await this.kv.transaction([{
      kind: 'delete',
      pk: `WF#${lease.runId}`,
      sk: 'LEASE',
      condition: {
        equals: {
          holder: lease.holder
        }
      }
    }]);
  }
  async requestCancellation(runId: string, actor: string, at: string) {
    await this.kv.put({
      pk: `WF#${runId}`,
      sk: 'CANCEL',
      actor,
      at
    }, 'not_exists');
  }
  async cancellation(runId: string) {
    return this.kv.get(`WF#${runId}`, 'CANCEL');
  }
  /** Kinds delivered by this release. Items from removed kinds (`dispatch`, `enqueue`) are ignored, never retried. */
  private static readonly OUTBOX_KINDS: ReadonlySet<string> = new Set(['complete', 'notify']);
  async listOutbox(runId: string) {
    return (await this.kv.query(`WF#${runId}`, 'OUT#'))
      .map(i => strip<OutboxEntry>(i))
      .filter(entry => Repo.OUTBOX_KINDS.has(entry.kind));
  }
  async putOutbox(runId: string, entry: OutboxEntry, lease: RunLease) {
    await this.write([{
      kind: 'put',
      item: {
        pk: `WF#${runId}`,
        sk: `OUT#${entry.kind}`,
        ...entry
      }
    }], lease);
  }
  async finishWorkflow(w: Workflow, kinds: OutboxEntry['kind'][], lease: RunLease) {
    await this.write([...this.workflowWrites(w), ...kinds.map(kind => ({
      kind: 'put' as const,
      item: {
        pk: `WF#${w.id}`,
        sk: `OUT#${kind}`,
        kind,
        attempts: 0,
        idempotencyKey: `${w.id}:${kind}`
      }
    }))], lease);
  }

  // ---- templates
  private templateHash(t: Template): string {
    const canonical = (value: unknown): string => {
      if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
      if (value && typeof value === 'object') return `{${Object.entries(value)
        .filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
      return JSON.stringify(value) ?? 'null';
    };
    return createHash('sha256').update(canonical({
      title: t.title, description: t.description, category: t.category,
      yaml: t.yaml, params: t.params, requires: t.requires ?? [],
    })).digest('hex');
  }
  private templateView(item: Item) {
    const t = structuredClone(strip<Template>(item));
    const version = t.templateVersion ?? 1;
    if (!Number.isSafeInteger(version) || version < 1 || version >= 1e12) throw new HttpError(409, 'Invalid template revision metadata');
    return {
      ...t, templateVersion: version, contentHash: this.templateHash(t),
      revisionCreatedAt: typeof item.revisionCreatedAt === 'string' ? item.revisionCreatedAt : t.createdAt,
      revisionCreatedBy: typeof item.revisionCreatedBy === 'string' ? item.revisionCreatedBy : t.createdBy,
      revisionOwnerSubject: typeof item.revisionOwnerSubject === 'string' ? item.revisionOwnerSubject : t.ownerSubject,
      deletedAt: typeof item.deletedAt === 'string' ? item.deletedAt : undefined,
    };
  }
  private templateRevisionKey(id: string, version: number) {
    return { pk: `TPL#${id}`, sk: `REV#${String(version).padStart(12, '0')}` };
  }
  /** Append immutable content; callers may supply a base version to reject stale edits. */
  async putTemplate(t: Template, options: { expectedVersion?: number; actor?: string; actorSubject?: string } = {}) {
    const hash = this.templateHash(t), pk = `TPL#${t.id}`;
    const identity = (value: Template) => JSON.stringify([value.builtin, value.projectId ?? null, value.ownerSubject ?? null, value.createdBy ?? null]);
    let restoring: boolean | undefined;
    for (let attempt = 0; attempt < 30; attempt++) {
      const raw = await this.kv.get(pk, 'META');
      const current = raw ? this.templateView(raw) : undefined;
      restoring ??= !!current?.deletedAt;
      if (!restoring && current?.deletedAt) throw new HttpError(409, 'Template was archived during this save; reload before restoring', 'template_conflict');
      if (current && identity(current) !== identity(t)) throw new HttpError(409, 'Template ownership and scope cannot change', 'template_conflict');
      const currentKey = current ? this.templateRevisionKey(t.id, current.templateVersion) : undefined;
      const previousRevision = currentKey ? await this.kv.get(currentKey.pk, currentKey.sk) : undefined;
      if (previousRevision && this.templateView(previousRevision).contentHash !== current!.contentHash) throw new HttpError(409, 'Template current revision conflicts with immutable history');
      const seen = t.builtin ? await this.kv.get(pk, `HASH#${hash}`) : undefined;
      const unchanged = current && !current.deletedAt && current.contentHash === hash;
      if (current && !current.deletedAt && previousRevision && (unchanged || t.builtin && seen)) return current;
      if (options.expectedVersion !== undefined && (current?.templateVersion ?? 0) !== options.expectedVersion && !unchanged) {
        throw new HttpError(409, 'Template changed; reload before saving', 'template_conflict', { templateVersion: current?.templateVersion });
      }
      const version = current ? unchanged ? current.templateVersion : current.templateVersion + 1 : 1;
      if (version >= 1e12) throw new HttpError(409, 'Template revision limit reached');
      const now = new Date().toISOString();
      const payload: Template = {
        id: t.id, title: t.title, description: t.description, category: t.category,
        builtin: t.builtin, yaml: t.yaml, params: t.params, requires: t.requires,
        createdAt: current?.createdAt ?? t.createdAt,
        createdBy: current ? current.createdBy : t.createdBy,
        projectId: current ? current.projectId : t.projectId,
        ownerSubject: current ? current.ownerSubject : t.ownerSubject,
      };
      const revision = unchanged ? { ...current, deletedAt: undefined } : {
        ...payload, templateVersion: version, contentHash: hash, revisionCreatedAt: now,
        revisionCreatedBy: options.actor ?? t.createdBy,
        revisionOwnerSubject: options.actorSubject ?? t.ownerSubject,
      };
      if (Buffer.byteLength(JSON.stringify(revision)) > 350_000) throw new HttpError(400, 'Template exceeds durable revision size limit');
      const writes: Write[] = [];
      if (current?.deletedAt) {
        const marker = await this.kv.get(pk, 'ARCHIVE');
        writes.push({ kind: 'delete', pk, sk: 'ARCHIVE', ...(marker ? { condition: { equals: { templateVersion: marker.templateVersion } } } : {}) });
      } else {
        // An archive racing this transaction cannot be erased by an active edit.
        writes.push({ kind: 'check', pk, sk: 'ARCHIVE', condition: { absent: true } });
      }
      // The original legacy head becomes a real immutable revision before replacement.
      if (current && !previousRevision) writes.push({
        kind: 'put', item: { ...currentKey!, ...current, deletedAt: undefined }, condition: { absent: true },
      });
      if (!current || version !== current.templateVersion) writes.push({
        kind: 'put', item: { ...this.templateRevisionKey(t.id, version), ...revision }, condition: { absent: true },
      });
      const compare: Record<string, unknown> = {};
      if (raw) for (const key of ['templateVersion', 'contentHash', 'yaml', 'description', 'title', 'category', 'createdAt', 'builtin', 'projectId', 'ownerSubject', 'createdBy', 'deletedAt']) {
        if (raw[key] !== undefined) compare[key] = raw[key];
      }
      writes.push({
        kind: 'put',
        item: { pk, sk: 'META', gsi1pk: 'TYPE#TPL', gsi1sk: `${t.builtin ? '0' : '1'}#${t.title}#${t.id}`, ...revision },
        condition: raw ? { equals: compare } : { absent: true },
      });
      if (t.builtin) for (const contentHash of new Set([hash, ...(current ? [current.contentHash] : [])])) {
        if (!await this.kv.get(pk, `HASH#${contentHash}`)) writes.push({
          kind: 'put', item: { pk, sk: `HASH#${contentHash}`, contentHash }, condition: { absent: true },
        });
      }
      if (await this.kv.transaction(writes)) return this.templateView({ pk, sk: 'META', ...revision });
    }
    throw new HttpError(409, 'Template update contention; retry', 'template_conflict');
  }
  async listTemplates() {
    return (await this.kv.queryGsi1('TYPE#TPL')).filter(item => !item.deletedAt).map(item => this.templateView(item));
  }
  async getTemplate(id: string, version?: number, options: { includeDeleted?: boolean } = {}) {
    if (version !== undefined && (!Number.isSafeInteger(version) || version < 1 || version >= 1e12)) throw new HttpError(400, 'Invalid template version');
    if (version !== undefined) {
      const key = this.templateRevisionKey(id, version);
      const revision = await this.kv.get(key.pk, key.sk);
      if (revision) return this.templateView(revision);
    }
    const item = await this.kv.get(`TPL#${id}`, 'META');
    if (!item) return undefined;
    const current = this.templateView(item);
    if (version !== undefined) return current.templateVersion === version ? current : undefined;
    return current.deletedAt && !options.includeDeleted ? undefined : current;
  }
  async listTemplateVersions(id: string) {
    const versions = (await this.kv.query(`TPL#${id}`, 'REV#', { desc: true })).map(item => this.templateView(item));
    const current = await this.getTemplate(id, undefined, { includeDeleted: true });
    if (current && !versions.some(v => v.templateVersion === current.templateVersion)) versions.push({ ...current, deletedAt: undefined });
    return versions.sort((a, b) => b.templateVersion - a.templateVersion);
  }
  /** Archive discovery metadata; keep all revision payloads for pinned runs. */
  async deleteTemplate(id: string, options: { expectedVersion?: number } = {}) {
    const current = await this.getTemplate(id, undefined, { includeDeleted: true });
    if (!current || current.deletedAt) return;
    if (options.expectedVersion !== undefined && current.templateVersion !== options.expectedVersion) throw new HttpError(409, 'Template changed; reload before deleting', 'template_conflict');
    const archived = await this.putTemplate(current, { expectedVersion: current.templateVersion });
    if (!await this.kv.transaction([{
      kind: 'put', item: { pk: `TPL#${id}`, sk: 'META', ...archived, deletedAt: new Date().toISOString() },
      condition: { equals: { templateVersion: archived.templateVersion, contentHash: archived.contentHash } },
    }, {
      kind: 'put', item: { pk: `TPL#${id}`, sk: 'ARCHIVE', templateVersion: archived.templateVersion },
      condition: { absent: true },
    }])) throw new HttpError(409, 'Template changed; reload before deleting', 'template_conflict');
  }

  // ---- sessions
  async putSession(s: Session) {
    await this.kv.put({
      pk: `SESS#${s.id}`,
      sk: 'META',
      gsi1pk: 'TYPE#SESS',
      gsi1sk: `${s.createdAt}#${s.id}`,
      ...s
    });
  }
  async listSessions() {
    return (await this.kv.queryGsi1('TYPE#SESS', {
      desc: true
    })).map(i => strip<Session>(i));
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
    await this.kv.put({
      pk: 'AUDIT',
      sk: `${e.ts}#${pad(seq, 3)}`,
      ttl: Math.floor(Date.now() / 1000) + 90 * 86400,
      ...e,
      seq
    });
  }
  async listAudit(limit = 200) {
    return (await this.kv.query('AUDIT', '', {
      desc: true,
      limit
    })).map(i => strip<AuditEntry>(i));
  }

  // ---- settings / lease
  async getSettings(): Promise<Settings> {
    const i = await this.kv.get('SYS', 'SETTINGS');
    return i ? strip<Settings>(i) : {
      notifyOn: ['SUCCEEDED', 'FAILED'],
      defaultNamespace: config().defaultNamespace
    };
  }
  async putSettings(s: Settings) {
    await this.kv.put({
      pk: 'SYS',
      sk: 'SETTINGS',
      ...s
    });
  }
  acquireLease(name: string, holder: string, ttlSec: number) {
    return this.kv.acquireLease('SYS', `LEASE#${name}`, holder, ttlSec);
  }
  async getLease(name: string) {
    return (await this.kv.get('SYS', `LEASE#${name}`)) as (Item & {
      holder?: string;
      expires?: number;
    }) | undefined;
  }
}
let repo: Repo | undefined;
export function getRepo(): Repo {
  if (!repo) {
    const c = config();
    repo = new Repo(c.authMode === 'dev' && !process.env.TABLE_NAME ? new MemoryKV() : new DynamoKV(c.tableName), async (store, workflow) => {
      if (workflow.projectId && workflow.spec.workflow.tasks.some(t => t.inputs.some(i => 'dataset' in i))) {
        const { validateDatasetInputs } = await import('../data/versions');
        await validateDatasetInputs(store, workflow);
      }
    });
  }
  return repo;
}
export function setRepoForTests(r: Repo) {
  repo = r;
}
