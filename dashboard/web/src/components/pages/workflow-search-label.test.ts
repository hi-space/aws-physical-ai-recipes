import { expect,it } from 'vitest';
import { createElement } from 'react';import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient,QueryClientProvider } from '@tanstack/react-query';
import { WorkflowsPage } from './WorkflowsPage';
it('labels whole-history search and explicitly warns when an empty result has unscanned continuation',()=>{
  const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity}}});
  client.setQueryData(['api','/api/me'],{role:'viewer'});
  client.setQueryData(['api','/api/workflows?page=1&status=&q='],{items:[],cursor:'continue',scanLimited:true,exhausted:false});
  const html=renderToStaticMarkup(createElement(QueryClientProvider,{client},createElement(WorkflowsPage)));client.clear();
  expect(html).toContain('전체 이력에서 이름·ID·소유자 검색');expect(html).not.toContain('현재 페이지에서');
  expect(html).toContain('아직 검색하지 않은 이력이 있습니다.');expect(html.match(/<button[^>]*>다음<\/button>/)?.[0]).not.toMatch(/\sdisabled(?:=|\s|>)/);
});
