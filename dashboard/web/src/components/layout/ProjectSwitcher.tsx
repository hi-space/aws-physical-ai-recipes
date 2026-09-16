'use client';
import * as React from 'react';
import { useApi, useMe } from '@/lib/api-client';

export function ProjectSwitcher() {
  const projects = useApi<Array<{ id: string; name: string }>>('/api/projects');
  const me = useMe();
  const [selected, setSelected] = React.useState('');
  React.useEffect(() => {
    const cookie = document.cookie.split('; ').find((value) => value.startsWith('pai-project='));
    if (cookie) setSelected(decodeURIComponent(cookie.slice('pai-project='.length)));
  }, []);
  return <div className="border-b border-border px-3 py-3">
    <label htmlFor="project-switcher" className="mb-1 block text-[11px] font-medium text-fg-muted">연구 프로젝트</label>
    <select id="project-switcher" className="w-full rounded border border-border bg-bg px-2 py-2 text-xs" value={selected}
      onChange={(event) => {
        const value = event.target.value;
        document.cookie = `pai-project=${encodeURIComponent(value)}; Path=/; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
        location.reload();
      }}>
      <option value="">{me.data?.role === 'admin' ? '전체 프로젝트 / 이전 실행' : '프로젝트 선택'}</option>
      {projects.data?.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
    </select>
    {projects.error && <p className="mt-1 text-xs text-err">프로젝트를 불러오지 못했습니다.</p>}
  </div>;
}
