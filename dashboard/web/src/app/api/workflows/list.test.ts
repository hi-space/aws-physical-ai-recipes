import { beforeEach,expect,it } from 'vitest';
import { NextRequest } from 'next/server';
import { Repo,setRepoForTests } from '@/server/store/repo';import { MemoryKV } from '@/server/store/dynamo';import { createProject } from '@/server/auth/projects';import type { Workflow } from '@/server/store/types';
import { GET } from './route';
let repo:Repo;
beforeEach(async()=>{repo=new Repo(new MemoryKV());setRepoForTests(repo);await createProject({user:'a',subject:'a',email:'',role:'admin'},{id:'p',name:'P',namespace:'hyperpod-ns-p',members:{a:'viewer'}},repo);});
const request=(query:string)=>new NextRequest(`http://localhost/api/workflows?${query}`,{headers:{'x-pai-user':'a','x-pai-subject':'a','x-pai-role':'viewer','x-pai-project':'p'}});
async function seed(total:number){for(let i=0;i<total;i++)await repo.putWorkflow({id:`r${i}`,projectId:'p',name:i===0?'target':'other',namespace:'hyperpod-ns-p',owner:'a',status:'RUNNING',spec:{sensitive:'not in summary'} as never,specYaml:'not in summary',vars:{},createdAt:new Date(Date.UTC(2026,0,1)+i*1000).toISOString(),updatedAt:'x',taskCount:1,succeededCount:0,failedCount:0} satisfies Workflow);}
it('finds older matches across pages while retaining the compact summary response',async()=>{
  await seed(120);const response=await GET(request('page=1&q=target&status=RUNNING&owner=a&namespace=hyperpod-ns-p'));expect(response.status).toBe(200);
  const data=await response.json();expect(data.items.map((w:Workflow)=>w.id)).toEqual(['r0']);expect(data.exhausted).toBe(true);expect(data.items[0]).not.toHaveProperty('spec');expect(data.items[0]).not.toHaveProperty('specYaml');
});
it('exposes partial empty continuations and never returns a legacy no-match array for unscanned history',async()=>{
  await seed(2100);const first=await GET(request('page=1&q=target'));const data=await first.json();expect(data).toMatchObject({items:[],scanLimited:true,exhausted:false});expect(data.cursor).toBeTruthy();expect(data.message).toMatch(/계속/);
  const next=await GET(request(`page=1&q=target&cursor=${encodeURIComponent(data.cursor)}`));expect((await next.json()).items.map((w:Workflow)=>w.id)).toEqual(['r0']);
  const legacy=await GET(request('q=target'));expect(legacy.status).toBe(409);expect(legacy.headers.get('link')).toContain('rel="next"');expect((await legacy.json()).code).toBe('workflow_search_incomplete');
});
