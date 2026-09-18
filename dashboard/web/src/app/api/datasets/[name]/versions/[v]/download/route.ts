import { NextResponse } from 'next/server';
import { q, route } from '@/server/api';
import { getRepo } from '@/server/store/repo';
import { immutableDownload, versionNumber } from '@/server/data/versions';
import { assertResourceAccess } from '@/server/auth/projects';
export const dynamic = 'force-dynamic';
export const GET = route<{name:string;v:string}>('viewer',async({params,url,req,session})=>{
  const repo=getRepo();
  await assertResourceAccess(session,await repo.getDataset(params.name),'dataset');
  const result=await immutableDownload(repo,params.name,versionNumber(params.v),q(url,'path')??'',req.signal,{inline:q(url,'inline')==='1'});
  await assertResourceAccess(session,await repo.getDataset(params.name),'dataset');
  return NextResponse.json(result,{headers:{'cache-control':'no-store'}});
});
