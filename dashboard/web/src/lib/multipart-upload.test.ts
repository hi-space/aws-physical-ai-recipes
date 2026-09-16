import { expect,it } from 'vitest';
import { uploadDatasetFile } from './multipart-upload';
it('resumes only checksum-matching parts, retries an interrupted PUT, and completes with expected checksums',async()=>{
  const file=new File(['abcdef'],'data.bin',{lastModified:1});const saved=new Map<string,string>();let puts=0;const completed:any[]=[];
  const hash=async(s:string)=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))).toString('base64');
  const request=async(path:string,init:any={})=>{
    if(init.json?.action==='complete'){completed.push(init.json.checksums);return{state:'COMPLETED'};}
    if(init.json?.action==='part')return{url:'https://upload.invalid',headers:{}};
    if(init.method==='POST')return{id:'owned',filename:'data.bin',size:6,lastModified:1,partSize:3,partCount:2,state:'UPLOADING'};
    return{id:'owned',filename:'data.bin',size:6,lastModified:1,partSize:3,partCount:2,state:'UPLOADING',parts:[{number:1,size:3,checksum:await hash('abc')}]};
  };
  const progress:number[]=[];
  await uploadDatasetFile('data',1,file,'data.bin',n=>progress.push(n),new AbortController().signal,{request,storage:{getItem:k=>saved.get(k)??null,setItem:(k,v)=>{saved.set(k,v);},removeItem:k=>{saved.delete(k);}},put:async()=>{if(++puts===1)throw new Error('network');},wait:async()=>{}});
  expect(puts).toBe(2);expect(completed[0]).toEqual([await hash('abc'),await hash('def')]);expect(progress.at(-1)).toBe(100);expect(saved.size).toBe(0);
});
it('keeps resumable metadata after cancellation and never claims 100% before server completion',async()=>{
  const saved=new Map<string,string>(),abort=new AbortController();const progress:number[]=[];
  const request=async(_p:string,init:any={})=>init.method==='POST'?{id:'id',size:1,lastModified:1,partSize:3,partCount:1,state:'UPLOADING'}:{id:'id',size:1,lastModified:1,partSize:3,partCount:1,state:'UPLOADING',parts:[]};
  await expect(uploadDatasetFile('data',1,new File(['x'],'x',{lastModified:1}),'x',n=>progress.push(n),abort.signal,{request,storage:{getItem:k=>saved.get(k)??null,setItem:(k,v)=>{saved.set(k,v);},removeItem:k=>{saved.delete(k);}},put:async()=>{abort.abort();throw new DOMException('paused','AbortError');},wait:async()=>{}})).rejects.toThrow();
  expect(saved.size).toBe(1);expect(progress).not.toContain(100);
});
