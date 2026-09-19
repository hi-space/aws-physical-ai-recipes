import { beforeEach,expect,it,vi } from 'vitest';
import { NextRequest } from 'next/server';
import { Repo,setRepoForTests } from '@/server/store/repo';
import { MemoryKV } from '@/server/store/dynamo';
import { createProject } from '@/server/auth/projects';
import type { Session } from '@/server/auth/session';
import { SESSION_HEADERS } from '@/server/auth/session';
import { BUILTIN_TEMPLATES } from '@/server/workflow/builtin-templates';
import { GET as list,POST as save } from './route';
import { GET as get,DELETE as remove } from './[id]/route';
import { GET as versions } from './[id]/versions/route';
let repo:Repo;
const admin:Session={user:'admin',subject:'admin-sub',email:'',role:'admin'};
const alice:Session={user:'alice',subject:'alice-sub',email:'',role:'researcher'};
const bob:Session={user:'bob',subject:'bob-sub',email:'',role:'researcher'};
const viewer:Session={user:'viewer',subject:'viewer-sub',email:'',role:'researcher'};
const manager:Session={user:'manager',subject:'manager-sub',email:'',role:'researcher'};
const outsider:Session={user:'outsider',subject:'outsider-sub',email:'',role:'researcher'};
const yaml='workflow:\n  name: recipe\n  resources: {cpu: {cpu: 1}}\n  tasks: [{name: train, resource: cpu, image: busybox, command: [echo, ok]}]\n';
const input={id:'personal',title:'Recipe',description:'Initial',category:'custom',yaml,params:[]};
function request(session:Session,path='/api/templates',method='GET',data?:unknown){
  return new NextRequest('http://localhost'+path,{method,headers:{[SESSION_HEADERS.user]:session.user,[SESSION_HEADERS.subject]:session.subject!,[SESSION_HEADERS.role]:session.role,origin:'http://localhost','x-pai-project':'p','content-type':'application/json',...(session.tokenProjectId?{[SESSION_HEADERS.authMethod]:'token',[SESSION_HEADERS.tokenProjectId]:session.tokenProjectId}:{})},...(data===undefined?{}:{body:JSON.stringify(data)})});
}
const ctx=(id='personal')=>({params:Promise.resolve({id})});
beforeEach(async()=>{
  repo=new Repo(new MemoryKV());setRepoForTests(repo);
  await createProject(admin,{id:'p',name:'P',namespace:'hyperpod-ns-p',members:{'alice-sub':'researcher','bob-sub':'researcher','viewer-sub':'viewer','manager-sub':'project-admin'}},repo);
  await createProject(admin,{id:'q',name:'Q',namespace:'hyperpod-ns-q',members:{'outsider-sub':'researcher'}},repo);
});
it('requires project researcher and prevents peer/builtin overwrites while allowing project administrators',async()=>{
  expect((await save(request(viewer,'/api/templates','POST',input))).status).toBe(403);
  const first=await save(request(alice,'/api/templates','POST',input));expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({projectId:'p',ownerSubject:'alice-sub',createdBy:'alice',templateVersion:1});
  expect((await save(request(bob,'/api/templates','POST',{...input,yaml:yaml.replace('ok','changed')}))).status).toBe(403);
  expect((await save(request(manager,'/api/templates','POST',{...input,description:'Managed'}))).status).toBe(200);
  expect((await repo.getTemplate('personal'))?.ownerSubject).toBe('alice-sub');
  expect((await save(request(admin,'/api/templates','POST',{...input,id:BUILTIN_TEMPLATES[0].id}))).status).toBe(403);
});
it('lists only accessible custom recipes plus every builtin, including token-scoped administrators',async()=>{
  await save(request(alice,'/api/templates','POST',input));
  await repo.putTemplate({...input,id:'private-alice',category:'custom',builtin:false,createdBy:'alice',createdAt:'x'});
  await repo.putTemplate({...input,id:'private-bob',category:'custom',builtin:false,createdBy:'bob',createdAt:'x'});
  await repo.putTemplate({...input,id:'other-project',category:'custom',builtin:false,projectId:'q',ownerSubject:'outsider-sub',createdBy:'outsider',createdAt:'x'});
  const visible=await (await list(request(alice))).json();const ids=visible.map((t:{id:string})=>t.id);
  expect(ids).toContain('personal');expect(ids).toContain('private-alice');expect(ids).not.toContain('private-bob');expect(ids).not.toContain('other-project');
  expect(ids).toEqual(expect.arrayContaining(BUILTIN_TEMPLATES.map(t=>t.id)));
  const scoped=await(await list(request({...admin,tokenProjectId:'p'}))).json();expect(scoped.map((t:{id:string})=>t.id)).not.toContain('other-project');
});
it('returns pinned revisions/history and restores old content without mutating it',async()=>{
  await save(request(alice,'/api/templates','POST',input));
  await save(request(alice,'/api/templates','POST',{...input,description:'Second',baseVersion:1}));
  const first=await(await get(request(alice,'/api/templates/personal?version=1'),ctx())).json();expect(first.description).toBe('Initial');expect(first.templateVersion).toBe(1);
  const restored=await save(request(alice,'/api/templates','POST',{...input,baseVersion:2}));expect(await restored.json()).toMatchObject({templateVersion:3,description:'Initial'});
  const history=await(await versions(request(alice,'/api/templates/personal/versions'),ctx())).json();expect(history.map((t:{templateVersion:number})=>t.templateVersion)).toEqual([3,2,1]);
  expect((await get(request(outsider,'/api/templates/personal?version=1'),ctx())).status).toBe(404);
  expect((await versions(request(outsider,'/api/templates/personal/versions'),ctx())).status).toBe(404);
});
it('keeps legacy recipes private and owner controlled while preserving their original revision',async()=>{
  await repo.kv.put({pk:'TPL#legacy',sk:'META',gsi1pk:'TYPE#TPL',gsi1sk:'1#Legacy',...input,id:'legacy',builtin:false,createdBy:'alice',createdAt:'2025-01-01'});
  expect((await get(request(bob,'/api/templates/legacy'),ctx('legacy'))).status).toBe(404);
  expect((await save(request(bob,'/api/templates','POST',{...input,id:'legacy'}))).status).not.toBe(200);
  expect((await save(request(alice,'/api/templates','POST',{...input,id:'legacy',description:'Changed'}))).status).toBe(200);
  const latest=await repo.getTemplate('legacy');expect(latest?.projectId).toBeUndefined();expect(latest?.createdBy).toBe('alice');
  expect((await repo.getTemplate('legacy',1))?.description).toBe('Initial');
});
it('rejects stale edits, invalid version selectors and literal secrets without persisting secret content',async()=>{
  await save(request(alice,'/api/templates','POST',input));await save(request(alice,'/api/templates','POST',{...input,description:'v2',baseVersion:1}));
  expect((await save(request(alice,'/api/templates','POST',{...input,description:'stale',baseVersion:1}))).status).toBe(409);
  for(const version of ['0','-1','abc','1.5'])expect((await get(request(alice,`/api/templates/personal?version=${version}`),ctx())).status).toBe(400);
  const secret='private-secret-value';const response=await save(request(alice,'/api/templates','POST',{...input,id:'secret',yaml:yaml.replace('command: [echo, ok]','command: [echo, ok], credentials: {hf: {HF_TOKEN: '+secret+'}}')}));
  expect(response.status).toBe(400);expect(await response.text()).not.toContain(secret);expect(await repo.getTemplate('secret')).toBeUndefined();
});
it('archives only authorized custom templates and preserves readable history',async()=>{
  await save(request(alice,'/api/templates','POST',input));expect((await remove(request(bob,'/api/templates/personal','DELETE'),ctx())).status).toBe(403);
  expect((await remove(request(manager,'/api/templates/personal','DELETE'),ctx())).status).toBe(200);
  expect((await get(request(alice,'/api/templates/personal'),ctx())).status).toBe(404);
  expect((await get(request(alice,'/api/templates/personal?version=1'),ctx())).status).toBe(200);
});

it('attaches recipe metadata for builtins and null for custom recipes without ui.recipe',async()=>{
  await save(request(alice,'/api/templates','POST',input));
  const visible=await (await list(request(alice))).json();
  const custom=visible.find((t:{id:string})=>t.id==='personal');
  expect(custom.recipe).toBeNull();
  const builtin=visible.find((t:{id:string})=>t.id===BUILTIN_TEMPLATES[0].id);
  expect(builtin.recipe).toMatchObject({revision:expect.any(String),readiness:expect.any(String)});
});

it('accepts dataset-typed params with a versionParam reference',async()=>{
  const withDatasetParam={...input,id:'dataset-param',params:[{name:'dataset_name',label:'Dataset',type:'dataset',default:'x',versionParam:'dataset_version'},{name:'dataset_version',label:'Version',type:'number',default:'1'}]};
  const response=await save(request(alice,'/api/templates','POST',withDatasetParam));
  expect(response.status).toBe(200);
  const saved=await repo.getTemplate('dataset-param');
  expect(saved?.params).toEqual([{name:'dataset_name',label:'Dataset',type:'dataset',default:'x',versionParam:'dataset_version'},{name:'dataset_version',label:'Version',type:'number',default:'1'}]);
});

it('sanitizes malformed YAML errors rather than logging source lines with possible secret values',async()=>{
  const log=vi.spyOn(console,'error').mockImplementation(()=>{});
  try{
    const response=await save(request(alice,'/api/templates','POST',{...input,id:'malformed',yaml:'workflow: [private-secret-value'}));
    expect(response.status).toBe(400);expect(await response.text()).not.toContain('private-secret-value');expect(log).not.toHaveBeenCalled();
  }finally{log.mockRestore();}
});
