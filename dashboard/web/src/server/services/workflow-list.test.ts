import { beforeEach,expect,it } from 'vitest';
import { Repo } from '../store/repo';import { MemoryKV } from '../store/dynamo';
import { putProject, testSession } from '../auth/session.test-helpers';import type { Session } from '../auth/session';import type { Workflow } from '../store/types';
import { listMatchingWorkflows } from './workflow-list';
let repo:Repo;
const user:Session=testSession('alice','sub-a','researcher',['proj-p']),admin:Session={...user,role:'admin'};
// A session without the proj-p group: equivalent of the old "members: {}" membership removal.
const userNoAccess:Session=testSession('alice','sub-a','researcher');
beforeEach(async()=>{repo=new Repo(new MemoryKV());await putProject(repo.kv,'p');await putProject(repo.kv,'q');});
async function add(index:number,changes:Partial<Workflow>={}){const w:Workflow={id:`run-${String(index).padStart(4,'0')}`,name:'other',projectId:'p',namespace:'hyperpod-ns-p',owner:'alice',status:'SUCCEEDED',spec:{} as never,specYaml:'private yaml',vars:{},taskCount:1,succeededCount:1,failedCount:0,createdAt:new Date(Date.UTC(2026,0,1)+index*1000).toISOString(),updatedAt:'x',...changes};await repo.putWorkflow(w);return w;}
it('fills 50 matching rows across earlier nonmatching history and resumes without skipped matches',async()=>{
  for(let i=0;i<65;i++)await add(i,{name:'target',status:'RUNNING'});for(let i=65;i<240;i++)await add(i);
  const first=await listMatchingWorkflows(user,{projectId:'p',limit:50,status:'RUNNING',search:'TARGET'},repo);
  expect(first.items).toHaveLength(50);expect(first.items[0].id).toBe('run-0064');expect(first.items.at(-1)?.id).toBe('run-0015');expect(first.cursor).toBeDefined();
  const second=await listMatchingWorkflows(user,{projectId:'p',limit:50,status:'RUNNING',search:'target',cursor:first.cursor},repo);
  expect(second.items.map(w=>w.id)).toEqual(Array.from({length:15},(_,i)=>`run-${String(14-i).padStart(4,'0')}`));expect(second.exhausted).toBe(true);expect(second.cursor).toBeUndefined();
});
it('requests at most the remaining match capacity, including after mostly matching partial pages',async()=>{
  for(let i=0;i<80;i++)await add(i,{name:i===79?'miss':'match'});
  const original=repo.listWorkflowsPage.bind(repo),sizes:number[]=[];repo.listWorkflowsPage=async options=>{sizes.push(options?.limit??0);return original(options);};
  const page=await listMatchingWorkflows(user,{projectId:'p',limit:50,search:'match'},repo);
  expect(page.items).toHaveLength(50);expect(sizes).toEqual([50,1]);
  expect((await listMatchingWorkflows(user,{projectId:'p',limit:50,search:'match',cursor:page.cursor},repo)).items).toHaveLength(29);
});
it('returns an explicit continuation instead of claiming no matches when the scan budget ends',async()=>{
  await add(0,{name:'target'});for(let i=1;i<121;i++)await add(i);
  const partial=await listMatchingWorkflows(user,{projectId:'p',search:'target',maxPages:2},repo);
  expect(partial).toMatchObject({items:[],scanLimited:true,exhausted:false});expect(partial.cursor).toBeDefined();expect(partial.message).toMatch(/계속|continue/i);
  const rest=await listMatchingWorkflows(user,{projectId:'p',search:'target',cursor:partial.cursor},repo);expect(rest.items.map(w=>w.id)).toEqual(['run-0000']);expect(rest.exhausted).toBe(true);
});
it('uses current workflow metadata and project permission rather than stale GSI projections',async()=>{
  const old=await add(1,{name:'stale',status:'SUCCEEDED'});await add(2,{name:'target',projectId:'q',namespace:'hyperpod-ns-q'});
  const page=repo.listWorkflowsPage.bind(repo);repo.listWorkflowsPage=async options=>{const result=await page(options);await repo.putWorkflow({...old,name:'TARGET',status:'RUNNING'});return result;};
  const current=await listMatchingWorkflows(user,{projectId:'p',search:'target',status:'RUNNING'},repo);expect(current.items.map(w=>w.id)).toEqual([old.id]);expect(current.items[0].name).toBe('TARGET');
  await expect(listMatchingWorkflows(userNoAccess,{projectId:'p'},repo)).rejects.toMatchObject({status:403});
});
it('rechecks result authorization and drops deleted/moved workflows before returning',async()=>{
  const w=await add(1,{name:'target'});const original=repo.getWorkflow.bind(repo);let reads=0;
  repo.getWorkflow=async id=>{if(id===w.id && ++reads===2){await repo.putWorkflow({...w,projectId:'q',namespace:'hyperpod-ns-q'});}return original(id);};
  const result=await listMatchingWorkflows(user,{projectId:'p',search:'target'},repo);expect(result.items).toEqual([]);expect(result.exhausted).toBe(true);
});
it('binds opaque cursors to filters, project and principal and restricts token administrators',async()=>{
  for(let i=0;i<3;i++)await add(i,{name:'target'});
  const page=await listMatchingWorkflows(user,{projectId:'p',limit:1,search:'target'},repo);
  await expect(listMatchingWorkflows(user,{projectId:'p',search:'different',cursor:page.cursor},repo)).rejects.toMatchObject({status:400});
  await expect(listMatchingWorkflows(admin,{projectId:'q',search:'target',cursor:page.cursor},repo)).rejects.toMatchObject({status:400});
  await expect(listMatchingWorkflows(user,{projectId:'p',cursor:'malformed'},repo)).rejects.toMatchObject({status:400});
  const token={...admin,authMethod:'token' as const,tokenProjectId:'p'};await add(10,{projectId:'q'});
  expect((await listMatchingWorkflows(token,{},repo)).items.every(w=>w.projectId==='p')).toBe(true);
  await expect(listMatchingWorkflows(token,{projectId:'q'},repo)).rejects.toMatchObject({status:403});
});
it('handles empty underlying pages but rejects a nonadvancing cursor',async()=>{
  const w=await add(1);let call=0;repo.listWorkflowsPage=async()=>++call===1?{items:[],cursor:'opaque-next'}:{items:[w],cursor:undefined};
  expect((await listMatchingWorkflows(user,{projectId:'p'},repo)).items).toHaveLength(1);
  repo.listWorkflowsPage=async()=>({items:[],cursor:'same'});await expect(listMatchingWorkflows(user,{projectId:'p'},repo)).rejects.toThrow(/cursor|pagination/i);
});
it('honors a row budget with a smaller final fetch and retains continuation',async()=>{
  for(let i=0;i<80;i++)await add(i,{name:i===0?'target':'other'});
  const fetch=repo.listWorkflowsPage.bind(repo),sizes:number[]=[];repo.listWorkflowsPage=async options=>{sizes.push(options?.limit??0);return fetch(options);};
  const result=await listMatchingWorkflows(user,{projectId:'p',search:'target',maxScanned:60},repo);
  expect(sizes).toEqual([50,10]);expect(result).toMatchObject({items:[],scanned:60,scanLimited:true,exhausted:false});
  expect((await listMatchingWorkflows(user,{projectId:'p',search:'target',cursor:result.cursor},repo)).items.map(w=>w.id)).toEqual(['run-0000']);
});
