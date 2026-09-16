import { beforeEach,expect,it } from 'vitest';
import { Repo } from './repo';
import { MemoryKV } from './dynamo';
import type { Template } from './types';
let repo:Repo;
const original:Template={id:'recipe',title:'Recipe',description:'Original',category:'custom',builtin:false,yaml:'original yaml',params:[{name:'steps',label:'Steps',type:'number',default:'10'}],projectId:'p',ownerSubject:'alice-sub',createdBy:'alice',createdAt:'2026-01-01T00:00:00Z'};
beforeEach(()=>{repo=new Repo(new MemoryKV());});
it('appends immutable revisions and treats identical semantic content as an idempotent save',async()=>{
  const one=await repo.putTemplate(original);
  const repeated=await repo.putTemplate({...original,createdAt:'2026-09-16T00:00:00Z'});
  expect(one.templateVersion).toBe(1);expect(repeated.templateVersion).toBe(1);expect(one.contentHash).toMatch(/^[a-f0-9]{64}$/);
  const two=await repo.putTemplate({...original,yaml:'changed yaml'});expect(two.templateVersion).toBe(2);
  expect((await repo.getTemplate('recipe',1))?.yaml).toBe('original yaml');expect((await repo.getTemplate('recipe'))?.yaml).toBe('changed yaml');
  expect((await repo.listTemplateVersions('recipe')).map(v=>v.templateVersion)).toEqual([2,1]);
});
it('versions params and description and restores historical content as a new revision',async()=>{
  await repo.putTemplate(original);
  await repo.putTemplate({...original,params:[{...original.params[0],default:'20'}]});
  const three=await repo.putTemplate({...original,description:'New description'});expect(three.templateVersion).toBe(3);
  const restored=await repo.putTemplate(original);expect(restored.templateVersion).toBe(4);
  expect((await repo.getTemplate('recipe',2))?.params[0].default).toBe('20');
  expect((await repo.getTemplate('recipe',1))?.contentHash).toBe(restored.contentHash);
});
it('archives the exact legacy current revision before the first update',async()=>{
  await repo.kv.put({pk:'TPL#recipe',sk:'META',gsi1pk:'TYPE#TPL',gsi1sk:'1#Recipe',...original,templateVersion:5});
  const next=await repo.putTemplate({...original,yaml:'new after migration'});
  expect(next.templateVersion).toBe(6);expect((await repo.getTemplate('recipe',5))?.yaml).toBe('original yaml');
  expect((await repo.listTemplateVersions('recipe')).map(v=>v.templateVersion)).toEqual([6,5]);
  expect(await repo.getTemplate('recipe',1)).toBeUndefined();
});
it('retains concurrent distinct updates and deduplicates concurrent identical updates',async()=>{
  await repo.putTemplate(original);
  const updates=await Promise.all([repo.putTemplate({...original,yaml:'A'}),repo.putTemplate({...original,yaml:'B'})]);
  expect(updates.map(v=>v.templateVersion).sort()).toEqual([2,3]);
  expect(new Set((await repo.listTemplateVersions('recipe')).map(v=>v.yaml))).toEqual(new Set(['original yaml','A','B']));
  const latest=(await repo.getTemplate('recipe'))!;
  await Promise.all(Array.from({length:6},()=>repo.putTemplate(latest)));
  expect(await repo.listTemplateVersions('recipe')).toHaveLength(3);
});
it('deduplicates builtin content across history so an older process seed cannot roll back latest',async()=>{
  const builtin={...original,builtin:true,projectId:undefined,ownerSubject:undefined,createdBy:undefined};
  await Promise.all(Array.from({length:4},()=>repo.putTemplate(builtin)));
  await repo.putTemplate({...builtin,yaml:'new builtin seed'});
  const oldSeed=await repo.putTemplate(builtin);expect(oldSeed.templateVersion).toBe(2);expect(oldSeed.yaml).toBe('new builtin seed');
  expect(await repo.listTemplateVersions('recipe')).toHaveLength(2);
});
it('rejects ownership changes and stale optimistic writes without losing current content',async()=>{
  await repo.putTemplate(original);
  await expect(repo.putTemplate({...original,ownerSubject:'intruder',yaml:'attack'})).rejects.toMatchObject({status:409});
  await repo.putTemplate({...original,yaml:'next'},{expectedVersion:1});
  await expect(repo.putTemplate({...original,yaml:'stale'},{expectedVersion:1})).rejects.toMatchObject({status:409});
  expect((await repo.getTemplate('recipe'))?.yaml).toBe('next');
});
it('archives deletion while keeping historical revisions and restores into a new revision',async()=>{
  await repo.putTemplate(original);await repo.deleteTemplate('recipe');
  expect(await repo.listTemplates()).toEqual([]);expect(await repo.getTemplate('recipe')).toBeUndefined();
  expect((await repo.getTemplate('recipe',1))?.yaml).toBe('original yaml');
  expect((await repo.putTemplate(original)).templateVersion).toBe(2);
});
it('does not resurrect an archive when deletion races a previously active save',async()=>{
  await repo.putTemplate(original);const transaction=repo.kv.transaction.bind(repo.kv);let archived=false;
  repo.kv.transaction=async writes=>{
    if(!archived && writes.some(w=>w.kind==='put' && w.item.pk==='TPL#recipe' && w.item.sk==='META' && w.item.yaml==='racing edit')){archived=true;await repo.deleteTemplate('recipe');}
    return transaction(writes);
  };
  await expect(repo.putTemplate({...original,yaml:'racing edit'},{expectedVersion:1})).rejects.toMatchObject({status:409});
  expect(await repo.getTemplate('recipe')).toBeUndefined();expect((await repo.getTemplate('recipe',1))?.yaml).toBe('original yaml');
});
