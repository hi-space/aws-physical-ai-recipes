'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button, LinkButton, Dialog, Tabs, Stat, StatusPill, Badge, Input, Select, Toggle, EmptyState, ErrorBox, Skeleton, Toast, Bar } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useApi, useApiMutation, can, useMe } from '@/lib/api-client';
import { shortId, ago, fmtDuration } from '@/lib/format';
import type { Workflow, WorkflowStatus } from '@/server/store/types';

export function WorkflowsPage() {
  const router = useRouter();
  const me = useMe();
  const [status, setStatus] = useState<WorkflowStatus | 'all'>('all');
  const [namespace, setNamespace] = useState<string>('');
  const [search, setSearch] = useState('');
  const [mineOnly, setMineOnly] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const { data: workflows = [], isLoading } = useApi<Workflow[]>(`/api/workflows?status=${status === 'all' ? '' : status}&namespace=${namespace}&q=${search}${mineOnly ? `&owner=${me.data?.user}` : ''}`, {
    refetch: 5000,
    enabled: me.data !== undefined,
  });

  const { data: namespaces = [] } = useApi<string[]>('/api/k8s/namespaces');

  const deleteMut = useApiMutation(
    async (id: string) => {
      await fetch(`/api/workflows/${id}`, { method: 'DELETE' });
    },
    ['/api/workflows']
  );

  const handleDelete = async (id: string) => {
    try {
      await deleteMut.mutateAsync(id);
      setDeleteConfirm(null);
    } catch (err) {
      console.error('Failed to delete workflow:', err);
    }
  };

  const stats = {
    running: workflows.filter((w) => w.status === 'RUNNING').length,
    pending: workflows.filter((w) => w.status === 'PENDING').length,
    succeeded24h: workflows.filter((w) => {
      if (w.status !== 'SUCCEEDED') return false;
      const time = new Date(w.finishedAt || w.createdAt).getTime();
      return time > Date.now() - 24 * 60 * 60 * 1000;
    }).length,
    failed24h: workflows.filter((w) => {
      if (w.status !== 'FAILED') return false;
      const time = new Date(w.finishedAt || w.createdAt).getTime();
      return time > Date.now() - 24 * 60 * 60 * 1000;
    }).length,
  };

  const rows = workflows.map((wf) => {
    const duration = wf.startedAt && wf.finishedAt ? fmtDuration(new Date(wf.finishedAt).getTime() - new Date(wf.startedAt).getTime()) : wf.startedAt ? fmtDuration(Date.now() - new Date(wf.startedAt).getTime()) : '-';
    const failedCount = wf.failedCount || 0;
    const progressPercent = wf.taskCount > 0 ? (wf.succeededCount / wf.taskCount) * 100 : 0;

    return (
      <tr key={wf.id}>
        <td>
          <div>
            <Link href={`/workflows/${wf.id}`} className="text-blue-400 hover:text-blue-300 font-medium">
              {wf.name}
            </Link>
            <div className="mono text-xs text-gray-400">{shortId(wf.id)}</div>
          </div>
        </td>
        <td>
          <StatusPill status={wf.status} />
        </td>
        <td>
          <div className="flex items-center gap-2 w-32">
            <Bar value={progressPercent} max={100} tone={failedCount > 0 ? 'err' : 'ok'} />
            <span className="text-xs whitespace-nowrap">{wf.succeededCount}/{wf.taskCount}</span>
          </div>
        </td>
        <td className="text-sm">{wf.namespace}</td>
        <td className="text-sm">{wf.owner}</td>
        <td className="text-xs">{ago(new Date(wf.createdAt))}</td>
        <td className="text-xs">{duration}</td>
        <td>
          <div className="flex gap-1">
            {!['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(wf.status) && can(me.data, 'researcher') && (
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  try {
                    await fetch(`/api/workflows/${wf.id}/cancel`, { method: 'POST' });
                  } catch (err) {
                    console.error('Failed to cancel:', err);
                  }
                }}
              >
                Cancel
              </Button>
            )}
            {['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(wf.status) && can(me.data, 'researcher') && (
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  try {
                    await fetch(`/api/workflows/${wf.id}/retry`, { method: 'POST' });
                  } catch (err) {
                    console.error('Failed to retry:', err);
                  }
                }}
              >
                Retry
              </Button>
            )}
            {['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(wf.status) && can(me.data, 'researcher') && (
              <Button size="sm" variant="ghost" onClick={() => setDeleteConfirm(wf.id)}>
                Delete
              </Button>
            )}
          </div>
        </td>
      </tr>
    );
  });

  return (
    <div className="space-y-6">
      <PageHeader title="Workflows" actions={
        can(me.data, 'researcher') && (
          <LinkButton href="/workflows/new" variant="primary">
            New workflow
          </LinkButton>
        )
      } />

      <div className="grid grid-cols-4 gap-4">
        <Stat label="Running" value={String(stats.running)} />
        <Stat label="Pending" value={String(stats.pending)} />
        <Stat label="Succeeded (24h)" value={String(stats.succeeded24h)} tone="ok" />
        <Stat label="Failed (24h)" value={String(stats.failed24h)} tone={stats.failed24h > 0 ? 'err' : 'ok'} />
      </div>

      <div className="flex gap-4 flex-wrap">
        <div className="flex-1 min-w-48">
          <Input type="search" placeholder="Search by name, id, or owner..." value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="min-w-40">
          <Select value={status} onChange={(e) => setStatus(e.target.value as WorkflowStatus | 'all')}>
            <option value="all">All statuses</option>
            <option value="PENDING">Pending</option>
            <option value="RUNNING">Running</option>
            <option value="SUCCEEDED">Succeeded</option>
            <option value="FAILED">Failed</option>
            <option value="CANCELLED">Cancelled</option>
          </Select>
        </div>
        <div className="min-w-40">
          <Select value={namespace} onChange={(e) => setNamespace(e.target.value)}>
            <option value="">All namespaces</option>
            {namespaces.map((ns) => (
              <option key={ns} value={ns}>
                {ns}
              </option>
            ))}
          </Select>
        </div>
        <label className="flex items-center gap-2">
          <Toggle checked={mineOnly} onChange={setMineOnly} />
          <span className="text-sm">Mine only</span>
        </label>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : workflows.length === 0 ? (
        <EmptyState title="No workflows" hint={search || status !== 'all' || mineOnly ? 'Try adjusting your filters.' : 'Create your first workflow to get started.'} />
      ) : (
        <div className="overflow-x-auto bg-gray-900/50 rounded border border-gray-800">
          <table className="tbl">
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Progress</th>
                <th>Namespace</th>
                <th>Owner</th>
                <th>Created</th>
                <th>Duration</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>{rows}</tbody>
          </table>
        </div>
      )}

      <Dialog open={deleteConfirm !== null} onClose={() => setDeleteConfirm(null)} title="Delete workflow?" footer={
        <>
          <Button variant="ghost" onClick={() => setDeleteConfirm(null)}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => deleteConfirm && handleDelete(deleteConfirm)} disabled={deleteMut.isPending}>
            Delete
          </Button>
        </>
      }>
        This action cannot be undone.
      </Dialog>
    </div>
  );
}
