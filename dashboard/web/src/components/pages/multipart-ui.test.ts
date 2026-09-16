import { expect,it,vi } from 'vitest';
import { createElement } from 'react';import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient,QueryClientProvider } from '@tanstack/react-query';
vi.mock('next/navigation',()=>({useRouter:()=>({push:vi.fn()})}));
import { DatasetDetailPage } from './DatasetDetailPage';
it('offers a file picker for the original pending filename and blocks finalization',()=>{
  const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity}}});
  client.setQueryData(['api','/api/me'],{role:'researcher'});
  client.setQueryData(['api','/api/datasets/data'],{dataset:{name:'data',owner:'a',tags:[]},versions:[{version:1,state:'PENDING',uri:'s3://archive/projects/p/datasets/data/uploads/x/',tags:[]}],lineage:{produced:[],consumers:[]}});
  client.setQueryData(['api','/api/datasets/data/versions/1?prefix=&token='],{entries:[]});
  client.setQueryData(['api','/api/datasets/data/versions/1/uploads'],[{id:'session',filename:'folder/a.bin',size:9,state:'UPLOADING'}]);
  const html=renderToStaticMarkup(createElement(QueryClientProvider,{client},createElement(DatasetDetailPage,{name:'data'})));client.clear();
  expect(html).toContain('aria-label="folder/a.bin 이어올리기"');
  expect(html.match(/<button[^>]*>검증 및 버전 확정<\/button>/)?.[0]).toContain('disabled');
});
