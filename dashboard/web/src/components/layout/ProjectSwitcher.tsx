'use client';
import * as React from 'react';
import { useApi, useMe } from '@/lib/api-client';
import { useT } from '@/lib/i18n';

export function ProjectSwitcher() {
  const t = useT('nav');
  const projects = useApi<Array<{ id: string; name: string; attachment?: string }>>('/api/projects');
  const me = useMe();
  const [selected, setSelected] = React.useState('');
  React.useEffect(() => {
    const cookie = document.cookie.split('; ').find((value) => value.startsWith('pai-project='));
    if (cookie) setSelected(decodeURIComponent(cookie.slice('pai-project='.length)));
  }, []);
  return <div className="border-b border-border px-3 py-3">
    <label htmlFor="project-switcher" className="mb-1 block text-xs font-medium text-fg-muted">{t('project')}</label>
    <select id="project-switcher" className="h-9 w-full rounded-md border border-border-strong bg-bg px-2 text-[13px]" value={selected}
      onChange={(event) => {
        const value = event.target.value;
        document.cookie = `pai-project=${encodeURIComponent(value)}; Path=/; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
        location.reload();
      }}>
      <option value="">{me.data?.role === 'admin' ? t('allProjects') : t('selectProject')}</option>
      {projects.data?.map((project) => <option key={project.id} value={project.id}>{project.name}{project.attachment === 'DETACHED' ? ` ⚠ ${t('detached')}` : ''}</option>)}
    </select>
    {projects.error && <p className="mt-1 text-xs text-err">{t('projectsLoadFailed')}</p>}
  </div>;
}
