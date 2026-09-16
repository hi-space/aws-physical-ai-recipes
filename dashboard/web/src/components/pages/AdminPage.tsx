'use client';
import * as React from 'react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge, Button, Card, Dialog, EmptyState, ErrorBox, Input, KeyValue, Spinner, Tabs, Table, Toast, Toggle, Textarea } from '@/components/ui';
import { ago, classNames as cx, fmtTime, fmtUsd } from '@/lib/format';
import { useApi, useApiMutation, useMe } from '@/lib/api-client';

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

interface AuditEntry {
  ts: string;
  actor: string;
  role: string;
  action: string;
  target: string;
  result: string;
  message?: string;
}

interface SettingsData {
  notifyOn: string[];
  defaultNamespace: string;
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
}

interface UseMe {
  role: string;
  [key: string]: any;
}

export function AdminPage() {
  const me = useMe() as any;
  const [tab, setTab] = React.useState<'users' | 'audit' | 'settings' | 'cost'>('users');
  const [toast, setToast] = React.useState<{ message: string; tone: 'ok' | 'err' } | null>(null);

  if (!me || me.role !== 'admin') {
    return (
      <>
        <PageHeader title="Admin" />
        <EmptyState title="Admin role required" hint="You do not have permission to access this page" />
      </>
    );
  }

  return (
    <>
      <PageHeader title="Admin Panel" />
      <Tabs
        value={tab}
        onChange={(t) => setTab(t as any)}
        items={[
          { id: 'users' as const, label: 'Users' },
          { id: 'audit' as const, label: 'Audit Log' },
          { id: 'settings' as const, label: 'Settings' },
          { id: 'cost' as const, label: 'Cost' },
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
    let pwd = '';
    for (let i = 0; i < 16; i++) {
      pwd += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    setNewUserForm((p) => ({ ...p, password: pwd }));
  };

  const createUserMutation = useApiMutation(
    (data: any) =>
      fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }).then((r) => r.json()),
    ['/api/admin/users']
  );

  const setGroupMutation = useApiMutation(
    (data: any) =>
      fetch(`/api/admin/users/${groupUsername}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'groups', groups: [groupValue] }),
      }).then((r) => r.json()),
    ['/api/admin/users']
  );

  const resetPasswordMutation = useApiMutation(
    (data: any) =>
      fetch(`/api/admin/users/${resetUsername}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reset', password: resetPassword }),
      }).then((r) => r.json()),
    ['/api/admin/users']
  );

  const handleCreateUser = async () => {
    try {
      await createUserMutation.mutateAsync(newUserForm);
      setNewUserForm({ username: '', email: '', password: '', group: 'researchers' });
      setShowCreateDialog(false);
      setToast({ message: 'User created', tone: 'ok' });
      refetch();
    } catch (e) {
      setToast({ message: (e as Error).message, tone: 'err' });
    }
  };

  const handleSetGroup = async () => {
    try {
      await setGroupMutation.mutateAsync({});
      setShowGroupDialog(false);
      setToast({ message: 'Group updated', tone: 'ok' });
      refetch();
    } catch (e) {
      setToast({ message: (e as Error).message, tone: 'err' });
    }
  };

  const handleResetPassword = async () => {
    try {
      await resetPasswordMutation.mutateAsync({});
      setShowResetDialog(false);
      setResetUsername('');
      setResetPassword('');
      setToast({ message: 'Password reset', tone: 'ok' });
      refetch();
    } catch (e) {
      setToast({ message: (e as Error).message, tone: 'err' });
    }
  };

  if (isLoading && !data) return <Spinner label="Loading users…" />;

  return (
    <div className="space-y-4">
      <Card>
        <Button onClick={() => setShowCreateDialog(true)}>Create User</Button>
      </Card>

      {error && <ErrorBox error={error} />}

      <Card title="Users" description={`${data?.users.length ?? 0} total`}>
        {!data?.users.length ? (
          <EmptyState title="No users" />
        ) : (
          <Table
            head={['Username', 'Email', 'Status', 'Groups', 'Created', 'Actions']}
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
                <td className="text-xs text-fg-muted">{ago(u.created)}</td>
                <td>
                  <Button
                    size="sm"
                    onClick={() => {
                      setGroupUsername(u.username);
                      setGroupValue(u.groups[0] || 'viewers');
                      setShowGroupDialog(true);
                    }}
                  >
                    Role
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setResetUsername(u.username);
                      setShowResetDialog(true);
                    }}
                  >
                    Reset
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {/* Create User Dialog */}
      <Dialog
        title="Create User"
        open={showCreateDialog}
        onClose={() => setShowCreateDialog(false)}
        footer={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setShowCreateDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleCreateUser}
              disabled={createUserMutation.isPending || !newUserForm.username || !newUserForm.email || !newUserForm.password}
            >
              Create
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium">Username</label>
            <Input
              value={newUserForm.username}
              onChange={(e) => setNewUserForm((p) => ({ ...p, username: e.target.value }))}
              className="mt-1"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Email</label>
            <Input
              type="email"
              value={newUserForm.email}
              onChange={(e) => setNewUserForm((p) => ({ ...p, email: e.target.value }))}
              className="mt-1"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Password</label>
            <div className="mt-1 flex gap-2">
              <Input
                type="password"
                value={newUserForm.password}
                onChange={(e) => setNewUserForm((p) => ({ ...p, password: e.target.value }))}
                className="flex-1"
              />
              <Button onClick={generatePassword} variant="secondary">
                Generate
              </Button>
            </div>
          </div>
          <div>
            <label className="text-sm font-medium">Role</label>
            <select
              value={newUserForm.group}
              onChange={(e) => setNewUserForm((p) => ({ ...p, group: e.target.value }))}
              className="mt-1 w-full rounded border border-border bg-bg px-3 py-2 text-sm"
            >
              <option value="admins">Admin</option>
              <option value="researchers">Researcher</option>
              <option value="viewers">Viewer</option>
            </select>
          </div>
        </div>
      </Dialog>

      {/* Set Group Dialog */}
      <Dialog
        title={`Set Role for ${groupUsername}`}
        open={showGroupDialog}
        onClose={() => setShowGroupDialog(false)}
        footer={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setShowGroupDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleSetGroup} disabled={setGroupMutation.isPending}>
              Update
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
            <option value="admins">Admin</option>
            <option value="researchers">Researcher</option>
            <option value="viewers">Viewer</option>
          </select>
        </div>
      </Dialog>

      {/* Reset Password Dialog */}
      <Dialog
        title={`Reset Password for ${resetUsername}`}
        open={showResetDialog}
        onClose={() => setShowResetDialog(false)}
        footer={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setShowResetDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleResetPassword} disabled={resetPasswordMutation.isPending || !resetPassword}>
              Reset
            </Button>
          </div>
        }
      >
        <div className="space-y-2">
          <div>
            <label className="text-sm font-medium">New Password (min 12 chars)</label>
            <Input
              type="password"
              value={resetPassword}
              onChange={(e) => setResetPassword(e.target.value)}
              className="mt-1"
            />
          </div>
          <Button onClick={generatePassword} variant="secondary" className="w-full">
            Generate
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

function AuditTab() {
  const { data, isLoading, error } = useApi<AuditEntry[]>('/api/admin/audit?limit=200', { refetch: 30000 });

  if (isLoading && !data) return <Spinner label="Loading audit log…" />;

  return (
    <Card title="Audit Log" description={`${data?.length ?? 0} entries`}>
      {error && <ErrorBox error={error} />}
      {!data?.length ? (
        <EmptyState title="No audit entries" />
      ) : (
        <Table
          head={['Time', 'Actor', 'Role', 'Action', 'Target', 'Result', 'Message']}
          dense
        >
          {data.map((e, i) => (
            <tr key={i} className={cx(e.result === 'OK' ? 'text-ok' : 'text-err')}>
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
  const { data, isLoading, error, refetch } = useApi<AdminSettings>('/api/admin/settings');
  const [notifyOn, setNotifyOn] = React.useState<string[]>(['SUCCEEDED', 'FAILED']);
  const [defaultNamespace, setDefaultNamespace] = React.useState('default');
  const [defaultPriority, setDefaultPriority] = React.useState('');

  React.useEffect(() => {
    if (data?.settings) {
      setNotifyOn(data.settings.notifyOn || []);
      setDefaultNamespace(data.settings.defaultNamespace || 'default');
      setDefaultPriority(data.settings.defaultPriority || '');
    }
  }, [data?.settings]);

  const saveMutation = useApiMutation(
    (payload: any) =>
      fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then((r) => r.json()),
    ['/api/admin/settings']
  );

  const handleSave = async () => {
    try {
      await saveMutation.mutateAsync({ notifyOn, defaultNamespace, defaultPriority: defaultPriority || undefined });
      setToast({ message: 'Settings saved', tone: 'ok' });
    } catch (e) {
      setToast({ message: (e as Error).message, tone: 'err' });
    }
  };

  if (isLoading && !data) return <Spinner label="Loading settings…" />;

  return (
    <div className="space-y-4">
      {error && <ErrorBox error={error} />}

      <Card title="Notifications">
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

      <Card title="Defaults">
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium">Default Namespace</label>
            <Input
              value={defaultNamespace}
              onChange={(e) => setDefaultNamespace(e.target.value)}
              className="mt-1"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Default Priority (optional)</label>
            <Input
              value={defaultPriority}
              onChange={(e) => setDefaultPriority(e.target.value)}
              className="mt-1"
            />
          </div>
        </div>
      </Card>

      {data?.controller && (
        <Card title="Controller Status">
          <div className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-fg-muted">Running</span>
              <Badge tone={data.controller.running ? 'ok' : 'err'}>
                {data.controller.running ? 'Yes' : 'No'}
              </Badge>
            </div>
            {data.controller.holder && (
              <div className="flex justify-between">
                <span className="text-fg-muted">Lease Holder</span>
                <span className="font-mono">{data.controller.holder}</span>
              </div>
            )}
            {data.controller.lastTick && (
              <div className="flex justify-between">
                <span className="text-fg-muted">Last Tick</span>
                <span>{ago(data.controller.lastTick)}</span>
              </div>
            )}
            {data.controller.ticks && (
              <div className="flex justify-between">
                <span className="text-fg-muted">Ticks</span>
                <span className="num">{data.controller.ticks}</span>
              </div>
            )}
            {data.controller.lastError && (
              <div className="flex justify-between text-err">
                <span>Last Error</span>
                <span className="text-xs">{data.controller.lastError}</span>
              </div>
            )}
          </div>
        </Card>
      )}

      {data?.config && (
        <Card title="Discovered Configuration">
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
        <Button onClick={handleSave} disabled={saveMutation.isPending}>
          {saveMutation.isPending ? 'Saving…' : 'Save Settings'}
        </Button>
      </Card>
    </div>
  );
}

function CostTab() {
  const { data, isLoading, error } = useApi<CostData>('/api/cost', { refetch: 60000 });

  if (isLoading && !data) return <Spinner label="Loading cost data…" />;

  return (
    <div className="space-y-4">
      {error && <ErrorBox error={error} />}

      {data && (
        <>
          <Card title="30-Day Total">
            <div className="text-2xl font-bold">{fmtUsd(data.total)}</div>
          </Card>

          <Card title="By Service" description={`Top ${data.byService.length} services`}>
            {!data.byService.length ? (
              <EmptyState title="No cost data" />
            ) : (
              <Table head={['Service', 'Amount']} dense>
                {data.byService.map((s) => (
                  <tr key={s.service}>
                    <td className="text-sm">{s.service}</td>
                    <td className="num text-sm">{fmtUsd(s.amount)}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>

          {data.daily.length > 0 && (
            <Card title="Daily Trend">
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
