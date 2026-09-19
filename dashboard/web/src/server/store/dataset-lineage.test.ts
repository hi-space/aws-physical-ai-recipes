import { expect, it } from 'vitest';
import { MemoryKV } from './dynamo';
import { Repo } from './repo';
import type { Dataset, Workflow } from './types';
const ds: Dataset = { name:'data',projectId:'p',owner:'alice',tags:[],latestVersion:1,createdAt:'2026-01-01',updatedAt:'2026-01-01' };
const wf = (id: string): Workflow => ({id,name:id,projectId:'p',owner:'alice',namespace:'n',status:'SUCCEEDED',createdAt:'2020-01-01',updatedAt:'2020-01-01',taskCount:1,succeededCount:1,failedCount:0,vars:{},specYaml:'',
  datasetSnapshots:{t:{0:{name:'data',version:1,uri:'s3://archive/v1/',fsxPath:'/fsx/datasets/data/v1'}}},
  spec:{workflow:{tasks:[{name:'t',inputs:[{dataset:{name:'data',version:'latest'}}]}]}}} as unknown as Workflow);
async function fixture() { const kv=new MemoryKV(),repo=new Repo(kv);await repo.putDataset(ds);await repo.putVersion({dataset:'data',version:1,projectId:'p',uri:'s3://archive/v1/',createdAt:'',createdBy:'alice',tags:[],state:'READY'});return {kv,repo}; }
it('finds a pinned consumer beyond 200 newer workflows without depending on the GSI', async () => {
  const {repo,kv}=await fixture();await repo.putWorkflow(wf('old'));
  for(let i=0;i<205;i++) await repo.putWorkflow({...wf('new'+i),createdAt:'2026-09-16',datasetSnapshots:{},spec:{workflow:{tasks:[]}}} as unknown as Workflow);
  kv.queryGsi1Page=async()=>({items:[],cursor:undefined});
  const history=await repo.datasetLineage('data');
  expect(history.consumers).toEqual([expect.objectContaining({workflowId:'old',task:'t',inputIndex:0,version:1})]);
  await expect(repo.deleteDataset('data')).rejects.toThrow(/history|referenced/);
  expect(await repo.getDataset('data')).toBeDefined();
});
it('retains consumption history after workflow metadata deletion', async () => {
  const {repo}=await fixture();await repo.putWorkflow(wf('old'));await repo.deleteWorkflow('old');
  expect(await repo.getWorkflow('old')).toBeUndefined();
  expect((await repo.datasetLineage('data')).consumers[0]).toMatchObject({workflowId:'old',version:1,workflowDeleted:true});
  await expect(repo.deleteDataset('data')).rejects.toThrow(/history|referenced/);
});
it('serializes deletion against a concurrent new reference and reserves deleted dataset names', async () => {
  const {repo,kv}=await fixture();const before=kv.transaction.bind(kv);let raced=false;
  kv.transaction=async writes=>{
    if(!raced && writes.some(w=>w.kind==='put' && w.item.pk==='DS#data' && w.item.sk==='META' && w.item.deletedAt)) {
      raced=true;await repo.recordDatasetReference('data','external:experiment',{workflowId:'external',workflowName:'external',task:'train',inputIndex:0,version:1,status:'RUNNING',projectId:'p'});
    }
    return before(writes);
  };
  await expect(repo.deleteDataset('data')).rejects.toThrow(/referenced|changed|history/);
  const other={...ds,name:'unused'};await repo.putDataset(other);await repo.deleteDataset('unused');
  expect(await repo.getDataset('unused')).toBeUndefined();
  expect(await kv.get('DS#unused','META')).toMatchObject({deletedAt:expect.any(String)});
  await expect(repo.recordDatasetReference('unused','new',{workflowId:'w',workflowName:'w',task:'t',inputIndex:0,version:1,status:'PENDING'})).rejects.toThrow(/deleted|unavailable/);
});
it('rejects known oversized input metadata before a workflow or dispatch record is admitted', async()=>{
  const {repo}=await fixture();const v=(await repo.getVersion('data',1))!;await repo.putVersion({...v,objectCount:1025});
  await expect(repo.createWorkflow(wf('large'),[])).rejects.toThrow(/1024/);
  expect(await repo.getWorkflow('large')).toBeUndefined();
});
it('rejects reuse of an input index with a changed immutable version',async()=>{
  const {repo}=await fixture();const run=wf('mismatch');run.datasetSnapshots!.t[0].uri='s3://wrong/';
  await expect(repo.createWorkflow(run,[])).rejects.toThrow(/immutable version/);
  expect(await repo.getWorkflow('mismatch')).toBeUndefined();
});
it('new submission atomically pins history before workflow deletion',async()=>{
  const {repo}=await fixture();await repo.createWorkflow(wf('new'),[]);
  await repo.deleteWorkflow('new');
  expect((await repo.datasetLineage('data')).consumers).toEqual([expect.objectContaining({workflowId:'new',version:1,workflowDeleted:true})]);
});
it('archives final workflow status without changing immutable consumption provenance',async()=>{
  const {repo}=await fixture();const run={...wf('final'),status:'PENDING' as const};await repo.createWorkflow(run,[]);
  await repo.putWorkflow({...run,status:'SUCCEEDED'});await repo.deleteWorkflow(run.id);
  expect((await repo.datasetLineage('data')).consumers[0]).toMatchObject({status:'SUCCEEDED',version:1,workflowDeleted:true});
});
it('does not collapse distinct pinned versions of the same dataset used by one task',async()=>{
  const {repo}=await fixture();const first=(await repo.getVersion('data',1))!;await repo.putVersion({...first,version:2,uri:'s3://archive/v2/'});
  const run=wf('two');run.spec.workflow.tasks[0].inputs.push({dataset:{name:'data',version:2}});
  run.datasetSnapshots!.t[1]={...run.datasetSnapshots!.t[0],version:2,uri:'s3://archive/v2/'};
  await repo.createWorkflow(run,[]);
  expect((await repo.datasetLineage('data')).consumers.map(c=>[c.inputIndex,c.version])).toEqual([[0,1],[1,2]]);
});
it('a metadata update cannot resurrect a concurrently deleted dataset',async()=>{
 const {repo,kv}=await fixture();const original=kv.transaction.bind(kv);let raced=false;
 kv.transaction=async writes=>{
  if(!raced&&writes.some(w=>w.kind==='put'&&w.item.pk==='DS#data'&&w.item.sk==='META'&&!w.item.deletedAt)){
   raced=true;await repo.deleteDataset('data');
  }
  return original(writes);
 };
 await expect(repo.putDataset({...ds,description:'late update'})).rejects.toThrow(/deleted|unavailable/);
 expect(await repo.getDataset('data')).toBeUndefined();
});
