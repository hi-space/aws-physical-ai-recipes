'use client';
import * as React from 'react';
import { PageHeader } from '@/components/layout/PageHeader';
import { ResourceStrip } from '@/components/layout/ResourceStrip';
import { Badge, Button, Card, Dialog, EmptyState, ErrorBox, Input, Spinner, Tabs, Table, Toast } from '@/components/ui';
import { classNames as cx } from '@/lib/format';
import { api, useApi, useApiMutation, useMe } from '@/lib/api-client';
import { useT, useFormat } from '@/lib/i18n';
import type { AuditEntry } from '@/server/store/types';

interface User {
  username: string;
  email: string;
  status: string;
  enabled: boolean;
  created: string;
  groups: string[];
}

interface Group {
  name: string;
  description?: string;
}

interface UsersData {
  users: User[];
  groups: Group[];
}

interface SettingsData {
  notifyOn: string[];
  defaultPriority?: string;
}

interface AdminSettings {
  config: Record<string, any>;
  env: Record<string, string | undefined>;
  settings: SettingsData;
  controller: { running: boolean; holder?: string; lastTick?: string; lastError?: string; ticks?: number; leased?: boolean };
  lease: { expires: string; holder: string } | null;
}

interface CostData {
  total: number;
  byService: { service: string; amount: number }[];
  daily: { date: string; amount: number }[];
  estimated?: boolean;
  fetchedAt?: string;
  start?: string;
  end?: string;
}

export function AdminPage() {
  const t = useT('admin');
  const tr = useT('resources');
  const tc = useT('common');
  const me = useMe();
  const [tab, setTab] = React.useState<'users' | 'audit' | 'settings' | 'cost'>('users');
  const [toast, setToast] = React.useState<{ message: string; tone: 'ok' | 'err' } | null>(null);

  if (me.isLoading) return <><PageHeader title={t('title')} /><Spinner label={t('loadingIdentity')} /></>;
  if (me.error) return <><PageHeader title={t('title')} /><ErrorBox error={me.error} /></>;
  if (me.data?.role !== 'admin') {
    return (
      <>
        <PageHeader title={t('title')} />
        <EmptyState title={t('adminRoleRequired')} hint={t('adminOnlyHint')} />
      </>
    );
  }

  const res = me.data?.resources;
  return (
    <>
      <PageHeader title={t('adminPanel')} description={t('description')} />
      <ResourceStrip
        source={t('resourceSource')}
        items={[
          { label: tr('table'), value: res?.table, console: res?.table ? { kind: 'dynamodb-table', name: res.table } : undefined },
          { label: tr('userPool'), value: res?.cognito?.userPoolId, console: res?.cognito ? { kind: 'cognito-user-pool', id: res.cognito.userPoolId } : undefined },
        ]}
      />
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { id: 'users' as const, label: t('usersTab') },
          { id: 'audit' as const, label: t('auditTab') },
          { id: 'settings' as const, label: t('settingsTab') },
          { id: 'cost' as const, label: t('costTab') },
        ]}
      />
      <div className="mt-4">
        {tab === 'users' && <UsersTab setToast={setToast} />}
        {tab === 'audit' && <AuditTab />}
        {tab === 'settings' && <SettingsTab setToast={setToast} />}
        {tab === 'cost' && <CostTab />}
      </div>

      {toast && <Toast message={toast.message} tone={toast.tone} onClose={() => setToast(null)} />}
    </>
  );
}

function UsersTab({ setToast }: { setToast: any }) {
  const t = useT('admin');
  const tc = useT('common');
  const { data, isLoading, error, refetch } = useApi<UsersData>('/api/admin/users');
  const [showCreateDialog, setShowCreateDialog] = React.useState(false);
  const [newUserForm, setNewUserForm] = React.useState({
    username: '',
    email: '',
    password: '',
    group: 'researchers' as string,
  });
  const [showResetDialog, setShowResetDialog] = React.useState(false);
  const [resetUsername, setResetUsername] = React.useState('');
  const [resetPassword, setResetPassword] = React.useState('');
  const [showGroupDialog, setShowGroupDialog] = React.useState(false);
  const [groupUsername, setGroupUsername] = React.useState('');
  const [groupValue, setGroupValue] = React.useState('');

  const generatePassword = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
    const limit = 256 - (256 % chars.length);
    let pwd = '';
    while (pwd.length < 16) {
      const buf = new Uint8Array(32);
      crypto.getRandomValues(buf);
      for (const b of buf) if (b < limit && pwd.length < 16) pwd += chars.charAt(b % chars.length);
    }
    return pwd;
  };

  const createUserMutation = useApiMutation(
    (data: typeof newUserForm) => api('/api/admin/users', { method: 'POST', json: data }),
    ['/api/admin/users']
  );

  const setGroupMutation = useApiMutation<void>(
    () => api(`/api/admin/users/${groupUsername}`, { method: 'POST', json: { action: 'groups', groups: [groupValue] } }),
    ['/api/admin/users']
  );

  const resetPasswordMutation = useApiMutation<void>(
    () => api(`/api/admin/users/${resetUsername}`, { method: 'POST', json: { action: 'reset', password: resetPassword } }),
    ['/api/admin/users']
  );

  const handleCreateUser = async () => {
    try {
      await createUserMutation.mutateAsync(newUserForm);
      setNewUserForm({ username: '', email: '', password: '', group: 'researchers' });
      setShowCreateDialog(false);
      setToast({ message: t('userCreated'), tone: 'ok' });
      refetch();
    } catch (e) {
      setToast({ message: (e as Error).message, tone: 'err' });
    }
  };

  const handleSetGroup = async () => {
    try {
      await setGroupMutation.mutateAsync();
      setShowGroupDialog(false);
      setToast({ message: t('groupUpdated'), tone: 'ok' });
      refetch();
    } catch (e) {
      setToast({ message: (e as Error).message, tone: 'err' });
    }
  };

  const handleResetPassword = async () => {
    try {
      await resetPasswordMutation.mutateAsync();
      setShowResetDialog(false);
      setResetUsername('');
      setResetPassword('');
      setToast({ message: t('passwordReset'), tone: 'ok' });
      refetch();
    } catch (e) {
      setToast({ message: (e as Error).message, tone: 'err' });
    }
  };

  if (isLoading && !data) return <Spinner label={t('loadingUsers')} />;

  return (
    <div className="space-y-4">
      <Card>
        <Button variant="primary" onClick={() => setShowCreateDialog(true)}>{t('createUser')}</Button>
      </Card>

      {error && <ErrorBox error={error} />}

      <Card title={t('usersTab')} description={t('usersDesc', { count: data?.users.length ?? 0 })}>
        {!data?.users.length ? (
          <EmptyState title={t('noUsers')} />
        ) : (
          <Table
            head={[tc('name'), tc('email'), tc('status'), t('groups'), tc('created'), tc('actions')]}
            dense
          >
            {data.users.map((u) => (
              <tr key={u.username}>
                <td className="font-mono text-sm">{u.username}</td>
                <td className="text-sm">{u.email}</td>
                <td>
                  <Badge tone={u.enabled ? 'ok' : 'warn'}>{u.status}</Badge>
                </td>
                <td className="text-sm">{u.groups.join(', ')}</td>
                <td className="text-xs text-fg-muted">{u.created}</td>
                <td className="flex gap-1">
                  <Button
                    size="sm"
                    onClick={() => {
                      setGroupUsername(u.username);
                      setGroupValue(u.groups[0] || 'viewers');
                      setShowGroupDialog(true);
                    }}
                  >
                    {t('roleBtn')}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setResetUsername(u.username);
                      setShowResetDialog(true);
                    }}
                  >
                    {t('resetBtn')}
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Dialog
        title={t('createUserTitle')}
        open={showCreateDialog}
        onClose={() => setShowCreateDialog(false)}
        footer={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setShowCreateDialog(false)}>
              {tc('cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={handleCreateUser}
              disabled={createUserMutation.isPending || !newUserForm.username || !newUserForm.email || !newUserForm.password}
            >
              {tc('create')}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium">{t('username')}</label>
            <Input
              value={newUserForm.username}
              onChange={(e) => setNewUserForm((p) => ({ ...p, username: e.target.value }))}
              className="mt-1"
            />
          </div>
          <div>
            <label className="text-sm font-medium">{tc('email')}</label>
            <Input
              type="email"
              value={newUserForm.email}
              onChange={(e) => setNewUserForm((p) => ({ ...p, email: e.target.value }))}
              className="mt-1"
            />
          </div>
          <div>
            <label className="text-sm font-medium">{t('password')}</label>
            <div className="mt-1 flex gap-2">
              <Input
                type="password"
                value={newUserForm.password}
                onChange={(e) => setNewUserForm((p) => ({ ...p, password: e.target.value }))}
                className="flex-1"
              />
              <Button onClick={() => setNewUserForm(p => ({ ...p, password: generatePassword() }))} variant="secondary">
                {t('generate')}
              </Button>
            </div>
          </div>
          <div>
            <label className="text-sm font-medium">{t('role')}</label>
            <select
              value={newUserForm.group}
              onChange={(e) => setNewUserForm((p) => ({ ...p, group: e.target.value }))}
              className="mt-1 w-full rounded border border-border bg-bg px-3 py-2 text-sm"
            >
              <option value="admins">{t('adminRole')}</option>
              <option value="researchers">{t('researcherRole')}</option>
              <option value="viewers">{t('viewerRole')}</option>
            </select>
          </div>
        </div>
      </Dialog>

      <Dialog
        title={t('setRoleTitle', { username: groupUsername })}
        open={showGroupDialog}
        onClose={() => setShowGroupDialog(false)}
        footer={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setShowGroupDialog(false)}>
              {tc('cancel')}
            </Button>
            <Button variant="primary" onClick={handleSetGroup} disabled={setGroupMutation.isPending}>
              {tc('save')}
            </Button>
          </div>
        }
      >
        <div>
          <select
            value={groupValue}
            onChange={(e) => setGroupValue(e.target.value)}
            className="w-full rounded border border-border bg-bg px-3 py-2 text-sm"
          >
            <option value="admins">{t('adminRole')}</option>
            <option value="researchers">{t('researcherRole')}</option>
            <option value="viewers">{t('viewerRole')}</option>
          </select>
        </div>
      </Dialog>

      <Dialog
        title={t('resetPasswordTitle')}
        open={showResetDialog}
        onClose={() => setShowResetDialog(false)}
        footer={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setShowResetDialog(false)}>
              {tc('cancel')}
            </Button>
            <Button variant="primary" onClick={handleResetPassword} disabled={resetPasswordMutation.isPending || !resetPassword}>
              {t('resetBtn')}
            </Button>
          </div>
        }
      >
        <div className="space-y-2">
          <div>
            <label className="text-sm font-medium">{t('newPassword')}</label>
            <Input
              type="password"
              value={resetPassword}
              onChange={(e) => setResetPassword(e.target.value)}
              className="mt-1"
            />
          </div>
          <Button onClick={() => setResetPassword(generatePassword())} variant="secondary" className="w-full">
            {t('generate')}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

function AuditTab() {
  const t = useT('admin');
  const tc = useT('common');
  const { fmtTime } = useFormat();
  const { data, isLoading, error } = useApi<AuditEntry[]>('/api/admin/audit?limit=200', { refetch: 30000 });

  if (isLoading && !data) return <Spinner label={t('loadingUsers')} />;

  return (
    <Card title={t('auditTab')} description={t('auditDesc')}>
      {error && <ErrorBox error={error} />}
      {!data?.length ? (
        <EmptyState title={tc('empty')} />
      ) : (
        <Table
          head={[t('timestamp'), t('actor'), tc('role'), t('action'), t('resource'), t('result'), t('details')]}
          dense
        >
          {data.map((e, i) => (
            <tr key={i} className={cx(e.result === 'ok' ? 'text-ok' : 'text-err')}>
              <td className="text-xs text-fg-muted">{fmtTime(e.ts)}</td>
              <td className="font-mono text-xs">{e.actor}</td>
              <td className="text-xs">{e.role}</td>
              <td className="text-sm">{e.action}</td>
              <td className="text-sm">{e.target}</td>
              <td className="font-mono text-xs">{e.result}</td>
              <td className="text-xs text-fg-muted">{e.message || '—'}</td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

function SettingsTab({ setToast }: { setToast: any }) {
  const t = useT('admin');
  const tc = useT('common');
  const { ago } = useFormat();
  const { data, isLoading, error, refetch } = useApi<AdminSettings>('/api/admin/settings');
  const [notifyOn, setNotifyOn] = React.useState<string[]>(['SUCCEEDED', 'FAILED']);
  const [defaultPriority, setDefaultPriority] = React.useState('');

  React.useEffect(() => {
    if (data?.settings) {
      setNotifyOn(data.settings.notifyOn || []);
      setDefaultPriority(data.settings.defaultPriority || '');
    }
  }, [data?.settings]);

  const saveMutation = useApiMutation(
    (payload: SettingsData) => api('/api/admin/settings', { method: 'PUT', json: payload }),
    ['/api/admin/settings']
  );

  const handleSave = async () => {
    if (!data?.settings || error) return;
    try {
      await saveMutation.mutateAsync({ notifyOn, defaultPriority: defaultPriority || undefined });
      setToast({ message: tc('saved'), tone: 'ok' });
    } catch (e) {
      setToast({ message: (e as Error).message, tone: 'err' });
    }
  };

  if (isLoading && !data) return <Spinner label={t('loadingUsers')} />;

  return (
    <div className="space-y-4">
      {error && <div className="space-y-2">
        <ErrorBox error={error} />
        <Button variant="secondary" onClick={() => void refetch()}>{tc('retry')}</Button>
      </div>}

      <Card title={t('notifications')}>
        <div className="space-y-2">
          {['SUCCEEDED', 'FAILED', 'CANCELLED'].map((status) => (
            <div key={status} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={notifyOn.includes(status)}
                onChange={(e) => {
                  if (e.target.checked) {
                    setNotifyOn([...notifyOn, status]);
                  } else {
                    setNotifyOn(notifyOn.filter((s) => s !== status));
                  }
                }}
              />
              <span className="text-sm">{status}</span>
            </div>
          ))}
        </div>
      </Card>

      <Card title={tc('value')}>
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium">{t('defaultPriority')}</label>
            <Input
              value={defaultPriority}
              onChange={(e) => setDefaultPriority(e.target.value)}
              className="mt-1"
            />
          </div>
        </div>
      </Card>

      {data?.controller && (
        <Card title={t('controllerStatus')}>
          <div className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-fg-muted">{t('running')}</span>
              <Badge tone={data.controller.running ? 'ok' : 'err'}>
                {data.controller.running ? tc('yes') : tc('no')}
              </Badge>
            </div>
            {data.controller.holder && (
              <div className="flex justify-between">
                <span className="text-fg-muted">{t('leaseHolder')}</span>
                <span className="font-mono">{data.controller.holder}</span>
              </div>
            )}
            {data.controller.lastTick && (
              <div className="flex justify-between">
                <span className="text-fg-muted">{t('lastTick')}</span>
                <span>{ago(data.controller.lastTick)}</span>
              </div>
            )}
            {data.controller.ticks && (
              <div className="flex justify-between">
                <span className="text-fg-muted">{t('ticks')}</span>
                <span className="num">{data.controller.ticks}</span>
              </div>
            )}
            {data.controller.lastError && (
              <div className="flex justify-between text-err">
                <span>{t('lastError')}</span>
                <span className="text-xs">{data.controller.lastError}</span>
              </div>
            )}
          </div>
        </Card>
      )}

      {data?.config && (
        <Card title={t('discoveredConfiguration')}>
          <div className="space-y-2 text-xs">
            {flattenConfig(data.config).map(([k, v]) => (
              <div key={k} className="flex justify-between">
                <span className="font-mono text-fg-muted">{k}</span>
                <span className="mono">{String(v).slice(0, 100)}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card>
        <Button variant="primary" onClick={handleSave} disabled={saveMutation.isPending || !data?.settings || Boolean(error)}>
          {saveMutation.isPending ? tc('saving') : tc('save')}
        </Button>
      </Card>
    </div>
  );
}

function flattenConfig(obj: Record<string, any>, prefix = ''): Array<[string, any]> {
  const result: Array<[string, any]> = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      result.push(...flattenConfig(v, key));
    } else {
      result.push([key, v]);
    }
  }
  return result;
}

function CostTab() {
  const t = useT('admin');
  const tc = useT('common');
  const { fmtUsd } = useFormat();
  const { ago } = useFormat();
  const { data, isLoading, error } = useApi<CostData>('/api/cost', { refetch: 600000 });

  if (isLoading && !data) return <Spinner label={tc('loading')} />;

  return (
    <div className="space-y-4">
      {error && <ErrorBox error={error} />}

      {data && (
        <>
          <Card title={t('costDesc')}>
            <div className="mb-3 text-xs text-fg-muted space-y-0.5">
              <div>{t('costExplorer')} · {t('fetchedAt', { time: data.fetchedAt ? ago(new Date(data.fetchedAt)) : '—' })}</div>
              <div>{t('costPeriod', { start: data.start, end: data.end })}</div>
              {data.estimated && <div className="text-accent">{t('costEstimated')}</div>}
            </div>
            <div className="text-2xl font-bold">{fmtUsd(data.total)}</div>
          </Card>

          <Card title={t('byService')}>
            {!data.byService.length ? (
              <EmptyState title={t('noCost')} />
            ) : (
              <Table head={[tc('name'), tc('value')]} dense>
                {data.byService.slice(0, 10).map((s) => (
                  <tr key={s.service}>
                    <td className="text-sm">{s.service}</td>
                    <td className="num text-sm">{fmtUsd(s.amount)}</td>
                  </tr>
                ))}
                {data.byService.length > 10 && (
                  <tr>
                    <td className="text-sm">{t('costOther', { count: data.byService.length - 10 })}</td>
                    <td className="num text-sm">{fmtUsd(data.byService.slice(10).reduce((a, b) => a + b.amount, 0))}</td>
                  </tr>
                )}
              </Table>
            )}
          </Card>

          {data.daily.length > 0 && (
            <Card title={t('daily')}>
              <div className="space-y-2 text-xs">
                {data.daily.map((d) => (
                  <div key={d.date} className="flex justify-between">
                    <span className="text-fg-muted">{d.date}</span>
                    <span className="num">{fmtUsd(d.amount)}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
