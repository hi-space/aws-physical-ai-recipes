import {beforeEach,expect,it,vi} from 'vitest';
import {NextRequest} from 'next/server';
import {createHash} from 'node:crypto';
const {send,sign}=vi.hoisted(()=>({send:vi.fn(),sign:vi.fn(async(..._args:any[])=>'https://download.invalid/pinned')}));
vi.mock('@/server/aws/clients',()=>({s3:()=>({send})}));vi.mock('@aws-sdk/s3-request-presigner',()=>({getSignedUrl:sign}));
import {Repo,setRepoForTests} from '@/server/store/repo';import {MemoryKV} from '@/server/store/dynamo';
import {SESSION_HEADERS,type Session} from '@/server/auth/session';
import {GET as download} from './[name]/versions/[v]/download/route';
import {GET as browse} from './[name]/versions/[v]/route';
const alice:Session={user:'alice',subject:'alice',role:'viewer',email:''};
let repo:Repo;
const checksum=Buffer.alloc(32).toString('base64');
function req(session:Session,path:string) {return new NextRequest('http://localhost'+path,{headers:{[SESSION_HEADERS.user]:session.user,[SESSION_HEADERS.subject]:session.subject!,[SESSION_HEADERS.role]:session.role,'x-pai-project':'p',...(session.tokenProjectId?{[SESSION_HEADERS.authMethod]:'token',[SESSION_HEADERS.tokenProjectId]:session.tokenProjectId}:{})}});}
const params=(v='1')=>({params:Promise.resolve({name:'data',v})});
beforeEach(async()=>{
 vi.stubEnv('DASHBOARD_ARTIFACT_BUCKET','archive');repo=new Repo(new MemoryKV());setRepoForTests(repo);
 await repo.kv.put({pk:'PROJECT#p',sk:'META',id:'p',name:'P',namespace:'hyperpod-ns-p',queue:'q',members:{alice:'viewer'},credentialRefs:[],createdAt:'',updatedAt:''});
 await repo.putDataset({name:'data',projectId:'p',owner:'owner',tags:[],latestVersion:1,createdAt:'',updatedAt:''});
 const body=JSON.stringify({schemaVersion:1,identity:'dataset:data:v1',source:{bucket:'source',prefix:'x/'},objects:[{path:'file',key:'projects/p/v1/file',versionId:'old',bytes:1,checksumSHA256:checksum,checksumType:'FULL_OBJECT'}]});
 await repo.putVersion({dataset:'data',version:1,projectId:'p',uri:'s3://archive/projects/p/v1/',manifestUri:'s3://archive/projects/p/v1/manifest.json',manifestHash:createHash('sha256').update(body).digest('hex'),state:'READY',createdAt:'',createdBy:'owner',tags:[]});
 send.mockReset().mockImplementation(async c=>c.constructor.name==='GetObjectCommand'?{ContentLength:body.length,Body:{transformToString:async()=>body}}:{VersionId:'old',ContentLength:1,ChecksumSHA256:checksum,ChecksumType:'FULL_OBJECT'});sign.mockClear();
});
it('lets a project viewer browse/download pinned versions without requiring mutation permission',async()=>{
 const path='/api/datasets/data/versions/1';expect((await browse(req(alice,path),params())).status).toBe(200);
 const response=await download(req(alice,path+'/download?path=file'),params());expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');
 expect(sign.mock.calls[0][1].input.VersionId).toBe('old');
});
it('denies revoked/foreign project access, malformed versions and escaping file paths before signing',async()=>{
 const path='/api/datasets/data/versions/1/download?path=file';
 for(const actor of [{...alice,user:'other',subject:'other'},{...alice,role:'admin' as const,tokenProjectId:'foreign'}])expect((await download(req(actor,path),params())).status).toBe(404);
 expect((await download(req(alice,path),params('1.2'))).status).toBe(400);
 expect((await download(req(alice,path.replace('path=file','path=..%2Foutside')),params())).status).toBe(400);
 expect(sign).not.toHaveBeenCalled();
});
