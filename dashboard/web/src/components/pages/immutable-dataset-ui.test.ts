import {expect,it,vi} from 'vitest';import {createElement} from 'react';import {renderToStaticMarkup} from 'react-dom/server';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
vi.mock('next/navigation',()=>({useRouter:()=>({push:vi.fn()})}));
import {DatasetDetailPage} from './DatasetDetailPage';
it('exposes downloads only for verified immutable listings, not pending mutable files',()=>{
 const render=(state:'PENDING'|'READY',immutable:boolean)=>{
  const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity}}});
  client.setQueryData(['api','/api/me'],{role:'viewer'});
  client.setQueryData(['api','/api/datasets/data'],{dataset:{name:'data',owner:'a',tags:[]},versions:[{version:1,state,uri:'s3://archive/projects/p/v1/',tags:[]}],lineage:{produced:[],consumers:[]}});
  client.setQueryData(['api','/api/datasets/data/versions/1?prefix=&token='],{immutable,entries:[{name:'file',key:'projects/p/v1/file',path:'file',versionId:'old',size:3,isPrefix:false}]});
  const html=renderToStaticMarkup(createElement(QueryClientProvider,{client},createElement(DatasetDetailPage,{name:'data'})));client.clear();return html;
 };
 expect(render('READY',true)).toContain('다운로드');expect(render('PENDING',false)).not.toContain('다운로드');
});
