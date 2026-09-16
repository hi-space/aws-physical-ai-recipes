import { beforeEach,expect,it,vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Repo } from '../store/repo';import { MemoryKV } from '../store/dynamo';import { createProject } from '../auth/projects';
import { MultipartUploads,freezeVersionUploads } from './multipart-uploads';
const alice={user:'alice',subject:'alice',email:'',role:'researcher' as const},admin={...alice,role:'admin' as const};
let repo:Repo,service:MultipartUploads,parts:any[],head:any,removed:boolean,calls:any[],loseReply:boolean;
const sha=(s:string)=>createHash('sha256').update(s).digest('base64');
beforeEach(async()=>{
  repo=new Repo(new MemoryKV());await createProject(admin,{id:'p',name:'p',namespace:'hyperpod-ns-p',members:{alice:'researcher',viewer:'viewer'}},repo);
  await repo.putDataset({name:'data',projectId:'p',owner:'alice',ownerSubject:'alice',latestVersion:1,tags:[],createdAt:'x',updatedAt:'x'});
  await repo.putVersion({dataset:'data',version:1,projectId:'p',uri:'s3://archive/projects/p/datasets/data/uploads/draft/',state:'PENDING',tags:[],createdAt:'x',createdBy:'alice'});
  parts=[];head=undefined;removed=false;calls=[];loseReply=false;
  const client={send:vi.fn(async(command:any)=>{calls.push(command);const input=command.input;
    switch(command.constructor.name){
      case 'ListMultipartUploadsCommand':return{Uploads:[]};
      case 'CreateMultipartUploadCommand':return{UploadId:'s3-owned-id'};
      case 'ListPartsCommand':if(removed)throw Object.assign(new Error('missing'),{name:'NoSuchUpload'});return{Parts:parts};
      case 'CompleteMultipartUploadCommand':head={ContentLength:parts.reduce((n,p)=>n+p.Size,0),VersionId:'object-v1',Metadata:calls.find(c=>c.constructor.name==='CreateMultipartUploadCommand').input.Metadata,ChecksumType:'COMPOSITE',ChecksumSHA256:createHash('sha256').update(Buffer.concat(input.MultipartUpload.Parts.map((p:any)=>Buffer.from(p.ChecksumSHA256,'base64')))).digest('base64')+'-'+parts.length};removed=true;if(loseReply)throw new Error('lost reply');return{VersionId:'object-v1'};
      case 'HeadObjectCommand':if(!head)throw Object.assign(new Error('missing'),{name:'NotFound'});return head;
      case 'AbortMultipartUploadCommand':removed=true;return{};
      default:throw new Error(command.constructor.name);
    }
  })};
  service=new MultipartUploads({repo,client:client as never,bucket:'archive',sign:async()=> 'https://upload.invalid/part'});
});
it('reserves filenames, resumes the same selection and blocks version finalization until abort',async()=>{
  const first=await service.start(alice,'data',1,{filename:'folder/a.bin',size:9*1024**2,lastModified:1});
  expect((await service.start(alice,'data',1,{filename:'folder/a.bin',size:9*1024**2,lastModified:1})).id).toBe(first.id);
  expect(calls.filter(c=>c.constructor.name==='CreateMultipartUploadCommand')).toHaveLength(1);
  await expect(service.start(alice,'data',1,{filename:'folder/a.bin',size:2,lastModified:2})).rejects.toMatchObject({status:409});
  await expect(freezeVersionUploads('data',1,repo)).rejects.toThrow(/upload/i);
  expect((await service.abort(alice,'data',1,first.id)).state).toBe('ABORTED');
  await expect(freezeVersionUploads('data',1,repo)).resolves.toBeUndefined();
  await expect(service.start(alice,'data',1,{filename:'other',size:1,lastModified:1})).rejects.toMatchObject({status:409});
});
it('requires project writer and dataset owner, pending state, safe filename and bounded part numbers',async()=>{
  for(const filename of ['../a','a/../../b','/root','a\\b','manifest.json','folder/manifest.json'])await expect(service.start(alice,'data',1,{filename,size:1,lastModified:1})).rejects.toMatchObject({status:400});
  await expect(service.start({...alice,user:'viewer',subject:'viewer'},'data',1,{filename:'a',size:1,lastModified:1})).rejects.toMatchObject({status:403});
  const upload=await service.start(alice,'data',1,{filename:'a',size:1,lastModified:1});
  await expect(service.part(alice,'data',1,upload.id,2,sha('x'))).rejects.toMatchObject({status:400});
  await repo.putVersion({...(await repo.getVersion('data',1))!,state:'READY'});
  await expect(service.part(alice,'data',1,upload.id,1,sha('x'))).rejects.toMatchObject({status:409});
});
it('uses S3 part sizes/checksums/ETags and refuses missing or mismatched parts',async()=>{
  const upload=await service.start(alice,'data',1,{filename:'a.bin',size:9*1024**2,lastModified:1});const hashes=[sha('first'),sha('last')];
  parts=[{PartNumber:1,Size:upload.partSize,ETag:'server-etag-1',ChecksumSHA256:hashes[0]}];
  await expect(service.complete(alice,'data',1,upload.id,hashes)).rejects.toMatchObject({status:409});
  parts.push({PartNumber:2,Size:9*1024**2-upload.partSize,ETag:'server-etag-2',ChecksumSHA256:hashes[1]});
  await expect(service.complete(alice,'data',1,upload.id,[hashes[0],sha('different')])).rejects.toMatchObject({status:409});
  const send=service.deps.client.send as any;const prior=send.getMockImplementation();send.mockImplementation(async(c:any,...rest:any[])=>{
    const result=await prior(c,...rest);if(c.constructor.name==='CompleteMultipartUploadCommand'){const create=calls.find(x=>x.constructor.name==='CreateMultipartUploadCommand');head.Metadata=create.input.Metadata;head.ChecksumType='COMPOSITE';}return result;
  });
  expect((await service.complete(alice,'data',1,upload.id,hashes)).state).toBe('COMPLETED');
  expect(calls.find(c=>c.constructor.name==='CompleteMultipartUploadCommand').input.MultipartUpload.Parts.map((p:any)=>p.ETag)).toEqual(['server-etag-1','server-etag-2']);
  await expect(freezeVersionUploads('data',1,repo)).resolves.toBeUndefined();
});

it('adopts completed S3 data after losing the completion reply without completing twice',async()=>{
  const upload=await service.start(alice,'data',1,{filename:'a',size:3,lastModified:1});const digest=sha('abc');parts=[{PartNumber:1,Size:3,ETag:'etag',ChecksumSHA256:digest}];loseReply=true;
  await expect(service.complete(alice,'data',1,upload.id,[digest])).rejects.toMatchObject({status:503});
  expect((await service.status(alice,'data',1,upload.id)).state).toBe('COMPLETING');
  expect((await service.complete(alice,'data',1,upload.id,[digest])).state).toBe('COMPLETED');
  expect(calls.filter(c=>c.constructor.name==='CompleteMultipartUploadCommand')).toHaveLength(1);
});
it('retains a blocked registration until S3 confirms abort',async()=>{
  const upload=await service.start(alice,'data',1,{filename:'a',size:1,lastModified:1});
  const send=service.deps.client.send as any,prior=send.getMockImplementation();send.mockImplementation(async(c:any)=>c.constructor.name==='AbortMultipartUploadCommand'?{}:prior(c));
  await expect(service.abort(alice,'data',1,upload.id)).rejects.toMatchObject({status:409});
  await expect(freezeVersionUploads('data',1,repo)).rejects.toMatchObject({status:409});
});

it('adopts an initiated multipart upload after a lost create reply',async()=>{
  const send=service.deps.client.send as any,prior=send.getMockImplementation();let initiated:string|undefined;
  send.mockImplementation(async(c:any)=>{if(c.constructor.name==='CreateMultipartUploadCommand'){initiated=c.input.Key;throw new Error('lost create reply');}if(c.constructor.name==='ListMultipartUploadsCommand'&&initiated)return{Uploads:[{Key:initiated,UploadId:'adopted'}]};return prior(c);});
  await expect(service.start(alice,'data',1,{filename:'adopt',size:1,lastModified:1})).rejects.toMatchObject({status:503});
  expect((await service.start(alice,'data',1,{filename:'adopt',size:1,lastModified:1})).state).toBe('UPLOADING');
  expect(send.mock.calls.filter((call:any)=>call[0].constructor.name==='CreateMultipartUploadCommand')).toHaveLength(1);
});
it('follows every S3 parts page using server continuation markers',async()=>{
  const upload=await service.start(alice,'data',1,{filename:'pages',size:9*1024**2,lastModified:1});const send=service.deps.client.send as any,prior=send.getMockImplementation();
  send.mockImplementation(async(c:any)=>c.constructor.name==='ListPartsCommand'?(c.input.PartNumberMarker?{Parts:[{PartNumber:2,Size:1024**2,ETag:'two',ChecksumSHA256:sha('two')}]}:{Parts:[{PartNumber:1,Size:8*1024**2,ETag:'one',ChecksumSHA256:sha('one')}],IsTruncated:true,NextPartNumberMarker:'1'}):prior(c));
  expect((await service.status(alice,'data',1,upload.id)).parts.map(p=>p.number)).toEqual([1,2]);
});
it('reports completion rather than abort when S3 commits during an abort race',async()=>{
  const upload=await service.start(alice,'data',1,{filename:'racing',size:3,lastModified:1}),digest=sha('abc');parts=[{PartNumber:1,Size:3,ETag:'e',ChecksumSHA256:digest}];
  const send=service.deps.client.send as any,prior=send.getMockImplementation();
  send.mockImplementation(async(c:any)=>{if(c.constructor.name==='CompleteMultipartUploadCommand')throw new Error('request still settling');return prior(c);});
  await expect(service.complete(alice,'data',1,upload.id,[digest])).rejects.toMatchObject({status:503});
  send.mockImplementation(async(c:any)=>{if(c.constructor.name==='AbortMultipartUploadCommand'){const record=(await repo.kv.query('DS#data','UPLOAD#1#'))[0];head={Metadata:{'pai-upload':upload.id},ContentLength:3,VersionId:'committed',ChecksumType:'COMPOSITE',ChecksumSHA256:record.composite};removed=true;return{};}return prior(c);});
  expect((await service.abort(alice,'data',1,upload.id)).state).toBe('COMPLETED');
});
