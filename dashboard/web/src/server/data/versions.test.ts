import { beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
const {send,sign}=vi.hoisted(()=>({send:vi.fn(),sign:vi.fn(async(..._args:any[])=> 'https://download.invalid/pinned')}));
vi.mock('../aws/clients',()=>({s3:()=>({send})}));vi.mock('@aws-sdk/s3-request-presigner',()=>({getSignedUrl:sign}));
import { immutableFiles, immutableDownload } from './versions';
import { MemoryKV } from '../store/dynamo';import { Repo } from '../store/repo';
let repo:Repo,body:string;
const checksum=Buffer.alloc(32).toString('base64');
beforeEach(async()=>{
 vi.stubEnv('DASHBOARD_ARTIFACT_BUCKET','archive');repo=new Repo(new MemoryKV());
 body=JSON.stringify({schemaVersion:1,identity:'dataset:data:v1',createdAt:'',source:{bucket:'source',prefix:'x/'},objects:[{path:'train/a.bin',key:'projects/p/v1/train/a.bin',bytes:3,versionId:'old-version',checksumSHA256:checksum,checksumType:'FULL_OBJECT'}]});
 await repo.putDataset({name:'data',projectId:'p',owner:'alice',tags:[],latestVersion:1,createdAt:'',updatedAt:''});
 await repo.putVersion({dataset:'data',projectId:'p',version:1,uri:'s3://archive/projects/p/v1/',manifestUri:'s3://archive/projects/p/v1/manifest.json',manifestHash:createHash('sha256').update(body).digest('hex'),state:'READY',tags:[],createdAt:'',createdBy:'alice'});
 send.mockReset().mockImplementation(async command=>command.constructor.name==='GetObjectCommand'?{Body:{transformToString:async()=>body},ContentLength:Buffer.byteLength(body)}:{VersionId:'old-version',ContentLength:3,ChecksumSHA256:checksum,ChecksumType:'FULL_OBJECT'});sign.mockClear();
});
it('lists only the committed manifest and downloads the exact old S3 VersionId', async()=>{
 expect((await immutableFiles(repo,'data',1)).entries).toEqual([expect.objectContaining({name:'train',isPrefix:true})]);
 const files=await immutableFiles(repo,'data',1,'train/');expect(files.entries[0]).toMatchObject({path:'train/a.bin',versionId:'old-version',size:3});
 await immutableDownload(repo,'data',1,'train/a.bin');
 expect(sign.mock.calls[0][1].input).toMatchObject({VersionId:'old-version',Key:'projects/p/v1/train/a.bin'});
 expect(send.mock.calls.every(([c])=>c.constructor.name!=='ListObjectsV2Command')).toBe(true);
});
it('fails closed on mutable manifest replacement, unknown files and mismatched version ownership',async()=>{
 await expect(immutableDownload(repo,'data',1,'unlisted.bin')).rejects.toThrow(/file/);
 await expect(immutableFiles(repo,'data',1,'../')).rejects.toThrow();
 body=body.replace('old-version','replaced');await expect(immutableFiles(repo,'data',1)).rejects.toThrow(/hash/);
 const v=(await repo.getVersion('data',1))!;await repo.putVersion({...v,projectId:'foreign'});
 await expect(immutableFiles(repo,'data',1)).rejects.toThrow(/dataset version/);
 expect(sign).not.toHaveBeenCalled();
});
it('uses a persisted manifest VersionId instead of relying on the mutable manifest key',async()=>{
 const v=(await repo.getVersion('data',1))!;await repo.putVersion({...v,manifestVersionId:'manifest-old'});
 const base=send.getMockImplementation()!;send.mockImplementation(async c=>{const r=await base(c);if(c.constructor.name==='GetObjectCommand'){expect(c.input.VersionId).toBe('manifest-old');r.VersionId='manifest-old';}return r;});
 expect((await immutableFiles(repo,'data',1)).immutable).toBe(true);
});
it('paginates immutable file entries and binds continuation to the version and directory',async()=>{
 const manifest=JSON.parse(body);manifest.objects=Array.from({length:201},(_,i)=>({...manifest.objects[0],path:`file-${String(i).padStart(3,'0')}`,key:`projects/p/v1/file-${String(i).padStart(3,'0')}`}));body=JSON.stringify(manifest);
 const v=(await repo.getVersion('data',1))!;await repo.putVersion({...v,manifestHash:createHash('sha256').update(body).digest('hex')});
 const first=await immutableFiles(repo,'data',1);expect(first.entries).toHaveLength(200);expect(first.nextToken).toBeDefined();
 const second=await immutableFiles(repo,'data',1,'',first.nextToken);expect(second.entries).toHaveLength(1);expect(second.nextToken).toBeUndefined();
 await expect(immutableFiles(repo,'data',1,'another/',first.nextToken)).rejects.toThrow(/Cursor/);
});
it('uses the same default checksum interpretation as the runtime consumer',async()=>{
 const manifest=JSON.parse(body);delete manifest.objects[0].checksumType;body=JSON.stringify(manifest);
 const v=(await repo.getVersion('data',1))!;await repo.putVersion({...v,manifestHash:createHash('sha256').update(body).digest('hex')});
 expect((await immutableFiles(repo,'data',1,'train/')).entries[0].checksumType).toBe('FULL_OBJECT');
 await expect(immutableDownload(repo,'data',1,'train/a.bin')).resolves.toMatchObject({versionId:'old-version'});
});
