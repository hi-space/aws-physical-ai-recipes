import { createHash } from 'node:crypto';
import { HttpError } from '../errors';
import type { Write } from './atomic';
import type { Item, KV } from './dynamo';
import type { Workflow } from './types';
export interface DatasetConsumer {
  workflowId:string;workflowName:string;task:string;inputIndex:number;version:number|'latest';status:string;
  projectId?:string;owner?:string;ownerSubject?:string;workflowDeleted?:boolean;
}
export function workflowConsumers(wf: Workflow, name: string): DatasetConsumer[] {
  return (wf.spec?.workflow?.tasks ?? []).flatMap(task=>(task.inputs ?? []).flatMap((input,index)=>{
    const snapshot=wf.datasetSnapshots?.[task.name]?.[index];
    if (!('dataset' in input) || input.dataset.name!==name) return [];
    return [{workflowId:wf.id,workflowName:wf.name,task:task.name,inputIndex:index,version:snapshot?.name===name?snapshot.version:input.dataset.version,
      status:wf.status,projectId:wf.projectId,owner:wf.owner,ownerSubject:wf.ownerSubject}];
  }));
}
export async function datasetGuard(kv:KV,name:string):Promise<Item> {
  const pk=`DS#${name}`;await kv.put({pk,sk:'REFERENCE_GUARD',state:'ACTIVE',revision:0},'not_exists');
  const guard=(await kv.get(pk,'REFERENCE_GUARD'))!;
  if(guard.state!=='ACTIVE') throw new HttpError(409,'Dataset is deleted or unavailable');
  return guard;
}
export async function referenceWrites(kv:KV,name:string,id:string,consumers:DatasetConsumer[],allowHistorical=false):Promise<Write[]> {
  const guard=await datasetGuard(kv,name),dataset=await kv.get(`DS#${name}`,'META');
  if(!dataset || dataset.deletedAt) throw new HttpError(409,'Dataset is deleted or unavailable');
  if(!allowHistorical) for(const consumer of consumers) {
    if((consumer.projectId??'')!==(dataset.projectId??'')) throw new HttpError(409,'Dataset reference belongs to another project');
    if(typeof consumer.version!=='number') throw new HttpError(409,'Dataset reference must pin an immutable version');
    const version=await kv.get(`DS#${name}`,`V#${String(consumer.version).padStart(6,'0')}`);
    if(!version || version.state==='PENDING' || (version.projectId??'')!==(dataset.projectId??'')) throw new HttpError(409,'Dataset reference version is not available');
  }
  const sk=`REFERENCE#${createHash('sha256').update(id).digest('hex')}`;
  const existing=await kv.get(guard.pk,sk);
  if(existing) {
    const identity=(items:DatasetConsumer[])=>JSON.stringify(items.map(c=>[c.workflowId,c.task,c.inputIndex,c.version,c.projectId??'']).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
    if(identity(existing.consumers as DatasetConsumer[])!==identity(consumers))throw new HttpError(409,'Dataset reference ID was reused with different provenance');
    const writes:Write[]=[{kind:'check',pk:guard.pk,sk:guard.sk,condition:{equals:{state:'ACTIVE',revision:guard.revision}}}];
    if(allowHistorical)writes.push({kind:'put',item:{...existing,consumers},condition:{equals:{referenceId:id}}});
    return writes;
  }
  const row={pk:guard.pk,sk,referenceId:id,consumers};
  if(Buffer.byteLength(JSON.stringify(row))>180000) throw new HttpError(400,'Dataset reference record exceeds supported size');
  return [{kind:'put',item:{...guard,revision:Number(guard.revision)+1},condition:{equals:{state:'ACTIVE',revision:guard.revision}}},
    {kind:'put',item:row,condition:{absent:true}}];
}
export async function workflowReferenceWrites(kv:KV,wf:Workflow):Promise<Write[]> {
  const names=new Set((wf.spec?.workflow?.tasks??[]).flatMap(t=>(t.inputs??[]).flatMap(i=>'dataset' in i?[i.dataset.name]:[])));
  const writes:Write[]=[];
  for(const name of names) writes.push(...await referenceWrites(kv,name,`workflow:${wf.id}`,workflowConsumers(wf,name)));
  return writes;
}

/** Cheap admission checks from already verified version metadata. The full manifest
 * validator is an API preflight hook for legacy rows without a certified budget. */
export async function validateInputMetadata(kv:KV,wf:Workflow):Promise<void> {
  const {assertTaskInputBudget,MAX_INPUT_OBJECTS}=await import('../data/limits');
  for(const task of wf.spec?.workflow?.tasks??[]) {
    const budgets:number[]=[],counts:number[]=[];
    for(const [index,input] of (task.inputs??[]).entries())if('dataset' in input) {
      const snap=wf.datasetSnapshots?.[task.name]?.[index];
      if(!snap||snap.name!==input.dataset.name||typeof input.dataset.version==='number'&&input.dataset.version!==snap.version)throw new HttpError(409,'Dataset input snapshot does not match its indexed declaration');
      const v=await kv.get(`DS#${snap.name}`,`V#${String(snap.version).padStart(6,'0')}`);
      if(!v||v.uri!==snap.uri||v.manifestHash!==snap.manifestHash)throw new HttpError(409,'Dataset input immutable version changed before admission');
      if(typeof v.objectCount==='number'&&(!Number.isSafeInteger(v.objectCount)||v.objectCount<1||v.objectCount>MAX_INPUT_OBJECTS))throw new HttpError(400,'Dataset input exceeds runtime 1024-file limit');
      budgets.push(typeof v.hydrationBytes==='number'?v.hydrationBytes:typeof v.objectCount==='number'?v.objectCount*1536+4096:4096);
      counts.push(typeof v.objectCount==='number'?v.objectCount:0);
    }
    assertTaskInputBudget(budgets,counts);
  }
}
