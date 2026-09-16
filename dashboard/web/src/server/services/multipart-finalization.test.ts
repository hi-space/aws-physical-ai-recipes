import { beforeEach,expect,it,vi } from 'vitest';
const {snapshot,head}=vi.hoisted(()=>({snapshot:vi.fn(),head:vi.fn()}));
vi.mock('../storage/snapshots',()=>({snapshotPrefix:snapshot}));
vi.mock('../aws/s3',()=>({parseS3Uri:(uri:string)=>{const m=/^s3:\/\/([^/]+)\/(.*)$/.exec(uri)!;return{bucket:m[1],key:m[2]};},listAll:async()=>[{key:'existing.bin'}],headObject:head,presignPut:async()=> 'https://unused.invalid'}));
import { Repo,setRepoForTests } from '../store/repo';import { MemoryKV } from '../store/dynamo';
import { finalizePendingVersions,uploadUrl } from './datasets';
let repo:Repo;
beforeEach(async()=>{
  vi.stubEnv('DASHBOARD_ARTIFACT_BUCKET','archive');repo=new Repo(new MemoryKV());setRepoForTests(repo);head.mockReset().mockResolvedValue({});snapshot.mockReset().mockResolvedValue({hash:'a'.repeat(64),manifest:{createdAt:'x',objects:[{path:'file',bytes:3,versionId:'v',checksumSHA256:Buffer.alloc(32).toString('base64'),checksumType:'FULL_OBJECT'}]}});
  await repo.putDataset({name:'data',projectId:'p',owner:'a',tags:[],latestVersion:1,createdAt:'x',updatedAt:'x'});
  await repo.putVersion({dataset:'data',version:1,projectId:'p',state:'PENDING',uri:'s3://archive/projects/p/datasets/data/uploads/draft/',createdAt:'x',createdBy:'a',tags:[]});
  await repo.kv.put({pk:'DS#data',sk:'FINALIZE#1',dataset:'data',version:1,gsi1pk:'TYPE#DATASET_FINALIZATION',gsi1sk:'1'});
});
it('blocks the real worker on unfinished registrations even if some objects already exist',async()=>{
  await repo.kv.put({pk:'DS#data',sk:'UPLOAD#1#a',mode:'MULTIPART',state:'UPLOADING',bucket:'archive',key:'a'});
  await finalizePendingVersions();expect(snapshot).not.toHaveBeenCalled();expect((await repo.getVersion('data',1))?.state).toBe('PENDING');
});
it('ignores confirmed aborts and never permits new uploads after snapshot publication begins',async()=>{
  await repo.kv.put({pk:'DS#data',sk:'UPLOAD#1#aborted',mode:'MULTIPART',state:'ABORTED',bucket:'archive',key:'aborted'});
  snapshot.mockRejectedValue(new Error('lost snapshot reply'));await finalizePendingVersions();expect(head).not.toHaveBeenCalled();
  await expect(uploadUrl('data',1,'late.bin')).rejects.toMatchObject({status:409});
});
it('does not let legacy single-PUT registration overwrite a multipart filename slot',async()=>{
  await repo.kv.put({pk:'DS#data',sk:'UPLOAD#1#a',mode:'MULTIPART',state:'UPLOADING',bucket:'archive',key:'a'});
  await expect(uploadUrl('data',1,'a')).rejects.toMatchObject({status:409});
});
