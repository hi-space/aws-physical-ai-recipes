import { inputChecksumType } from '../runtime/checksums';
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3 } from '../aws/clients';
import { badRequest, notFound } from '../errors';
import type { Repo } from '../store/repo';
import type { Workflow } from '../store/types';
import { loadSnapshot } from '../storage/snapshots';
import { safeDataPath } from './selection';
import { contentTypeFor, previewKind } from './artifact-preview';
import { assertConsumableObjects, assertTaskInputBudget } from './limits';
export function versionNumber(value: string | number): number {
  const n=Number(value);if(!Number.isSafeInteger(n)||n<1||n>999999)throw badRequest('Invalid dataset version');return n;
}
const parse=(uri:string)=>{const m=/^s3:\/\/([^/]+)\/(.+)$/.exec(uri);if(!m||/[?#\\\x00-\x1f]/.test(uri))throw badRequest('Invalid snapshot URI');return {bucket:m[1],key:m[2]};};
export async function pinnedDatasetManifest(repo: Repo,name:string,number:number,signal?:AbortSignal) {
  const version=versionNumber(number),dataset=await repo.getDataset(name),v=await repo.getVersion(name,version);
  if(!dataset||!v || (dataset.projectId??'')!==(v.projectId??''))throw notFound('dataset version');
  if(v.state!=='READY'||!v.manifestUri||!v.manifestHash)throw badRequest('This version has no verified immutable manifest; publish a new version');
  const {bucket,key}=parse(v.manifestUri),root=parse(v.uri);const prefix=root.key.replace(/\/?$/,'/');
  if(bucket!==process.env.DASHBOARD_ARTIFACT_BUCKET||bucket!==root.bucket||key!==prefix+'manifest.json'||v.projectId&&!prefix.startsWith(`projects/${v.projectId}/`))throw badRequest('Snapshot is outside the version/project archive');
  const result=await loadSnapshot(bucket,key,signal,v.manifestVersionId);
  if(result.hash!==v.manifestHash)throw badRequest('Pinned manifest hash mismatch');
  const seen=new Set<string>();
  for(const o of result.manifest.objects) {
    if(!safeDataPath(o.path)||seen.has(o.path)||o.key!==prefix+o.path||!o.versionId||o.versionId==='null'||!Number.isSafeInteger(o.bytes)||o.bytes<0)throw badRequest('Invalid pinned snapshot object');
    const checksumType=inputChecksumType(o.checksumType,o.checksumSHA256);
    if(!checksumType)throw badRequest('Invalid pinned snapshot checksum');
    o.checksumType=checksumType;
    seen.add(o.path);
  }
  for(const path of seen) {const parts=path.split('/');parts.pop();while(parts.length){if(seen.has(parts.join('/')))throw badRequest('Snapshot contains a file/directory conflict');parts.pop();}}
  return {...result,version:v,bucket,prefix};
}
export async function immutableFiles(repo:Repo,name:string,version:number,sub='',token?:string) {
  const snap=await pinnedDatasetManifest(repo,name,version);
  if(sub.startsWith(snap.prefix))sub=sub.slice(snap.prefix.length);
  if(sub && (!sub.endsWith('/')||!safeDataPath(sub.slice(0,-1))))throw badRequest('Invalid version-relative directory');
  const entries=new Map<string,{key:string;name:string;isPrefix:boolean;size?:number;versionId?:string;checksumSHA256?:string;checksumType?:string;path?:string}>();
  for(const o of snap.manifest.objects) {
    if(!o.path.startsWith(sub))continue;
    const remaining=o.path.slice(sub.length),slash=remaining.indexOf('/');
    if(slash>=0){const leaf=remaining.slice(0,slash);entries.set(leaf+'/',{key:snap.prefix+sub+leaf+'/',name:leaf,isPrefix:true});}
    else entries.set(remaining,{key:o.key,name:remaining,isPrefix:false,path:o.path,size:o.bytes,versionId:o.versionId,checksumSHA256:o.checksumSHA256,checksumType:o.checksumType});
  }
  let offset=0;
  if(token && token.length>4096)throw badRequest('Invalid dataset cursor');
  if(token)try {const c=JSON.parse(Buffer.from(token,'base64url').toString());if(c.hash!==snap.hash||c.sub!==sub||c.name!==name||c.version!==version||!Number.isSafeInteger(c.offset)||c.offset<0)throw Error();offset=c.offset;}catch{throw badRequest('Cursor does not belong to this immutable version/directory');}
  const all=[...entries.values()].sort((a,b)=>a.name.localeCompare(b.name)),page=all.slice(offset,offset+200);
  return {bucket:snap.bucket,prefix:snap.prefix+sub,entries:page,immutable:true,manifestHash:snap.hash,
    nextToken:offset+page.length<all.length?Buffer.from(JSON.stringify({name,version,hash:snap.hash,sub,offset:offset+page.length})).toString('base64url'):undefined};
}
/** `inline` serves the pinned object for in-page viewing (Artifacts viewer): browser-renderable
 * disposition plus an explicit content type, since exported objects are stored as octet-stream. */
export async function immutableDownload(repo:Repo,name:string,version:number,path:string,signal?:AbortSignal,options:{inline?:boolean}={}) {
  if(!safeDataPath(path))throw badRequest('Invalid version-relative file');
  const snap=await pinnedDatasetManifest(repo,name,version,signal),o=snap.manifest.objects.find(o=>o.path===path);
  if(!o)throw notFound('file in this dataset version');
  const head=await s3().send(new HeadObjectCommand({Bucket:snap.bucket,Key:o.key,VersionId:o.versionId,ChecksumMode:'ENABLED'}),{abortSignal:signal});
  if(head.VersionId!==o.versionId||head.ContentLength!==o.bytes||head.ChecksumSHA256!==o.checksumSHA256||inputChecksumType(head.ChecksumType,head.ChecksumSHA256)!==o.checksumType)throw badRequest('Pinned file verification failed');
  const filename=encodeURIComponent(path.split('/').pop()!);
  const url=await getSignedUrl(s3(),new GetObjectCommand({Bucket:snap.bucket,Key:o.key,VersionId:o.versionId,
    ResponseContentDisposition:`${options.inline?'inline':'attachment'}; filename*=UTF-8''${filename}`,
    ...(options.inline?{ResponseContentType:contentTypeFor(path)}:{})}),{expiresIn:300});
  return {url,versionId:o.versionId,path:o.path,size:o.bytes,manifestHash:snap.hash,expiresIn:300,kind:previewKind(path)};
}
/** Parent may use this as an early validation hook; Repo also enforces certified metadata budgets. */
export async function validateDatasetInputs(repo:Repo,wf:Workflow,signal?:AbortSignal) {
  for(const task of wf.spec.workflow.tasks) {
    const budgets:number[]=[],counts:number[]=[],destinations:string[]=[];
    for(const [index,input] of task.inputs.entries()) if('dataset' in input) {
      const pinned=wf.datasetSnapshots?.[task.name]?.[index];
      if(!pinned||pinned.name!==input.dataset.name)throw badRequest('Dataset input has no indexed immutable snapshot');
      const snap=await pinnedDatasetManifest(repo,pinned.name,pinned.version,signal);
      if(snap.version.projectId!==wf.projectId||snap.version.uri!==pinned.uri||snap.hash!==pinned.manifestHash)throw badRequest('Dataset input snapshot/project mismatch');
      if(!pinned.fsxPath.startsWith(`/fsx/datasets/projects/${wf.projectId}/`) || /[\\%\x00-\x1f]/.test(pinned.fsxPath) || pinned.fsxPath.split('/').some(p=>p==='.'||p==='..'))throw badRequest('Dataset hydration destination is outside the project cache');
      if(destinations.some(path=>path===pinned.fsxPath||path.startsWith(pinned.fsxPath+'/')||pinned.fsxPath.startsWith(path+'/')))throw badRequest('Runtime dataset hydration destinations overlap; reference each version once per task');
      destinations.push(pinned.fsxPath);
      budgets.push(assertConsumableObjects(snap.manifest.objects,snap.manifestBytes));
      counts.push(snap.manifest.objects.length);
    }
    assertTaskInputBudget(budgets,counts);
  }
}
