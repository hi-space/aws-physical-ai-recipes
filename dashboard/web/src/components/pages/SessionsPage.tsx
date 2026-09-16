'use client';
import * as React from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge, Button, Card, CodeBlock, CopyButton, Dialog, EmptyState, ErrorBox, Input, Spinner, StatusPill, Table, Toast } from '@/components/ui';
import { ago, classNames as cx, fmtTime } from '@/lib/format';
import { useApi, useApiMutation, useMe, can } from '@/lib/api-client';

interface DcvWorkstation {
  instanceId: string;
  state: string;
  instanceType?: string;
  publicIp?: string;
  privateIp?: string;
  launchTime?: string;
  dcvUrl?: string;
  codeServerUrl?: string;
  hasSecret: boolean;
}

interface HyperPodNode {
  cluster: string;
  orchestrator: 'eks' | 'slurm';
  group: string;
  instanceId: string;
  instanceType: string;
  status: string;
  target: string;
  portForward: string;
  login: string;
}

interface DcvData {
  workstation?: DcvWorkstation | { error: string };
  nodes: HyperPodNode[];
}

interface TensorboardSession {
  id: string;
  kind: string;
  namespace: string;
  owner: string;
  logDir: string;
  name: string;
  createdAt: string;
  status: string;
  url: string;
}

interface SessionsData {
  dcv: DcvData;
  tensorboard: TensorboardSession[];
}

export function SessionsPage() {
  const me = useMe() as any;
  const { data, isLoading, error, refetch } = useApi<any>('/api/sessions/dcv', { refetch: 10000 });
  const { data: sessions } = useApi<TensorboardSession[]>('/api/sessions', { refetch: 10000 });
  const [showTbDialog, setShowTbDialog] = React.useState(false);
  const [logDir, setLogDir] = React.useState('/fsx/checkpoints/rl');
  const [namespace, setNamespace] = React.useState('default');
  const [credentials, setCredentials] = React.useState<{ username: string; password: string } | null>(null);
  const [showCredentials, setShowCredentials] = React.useState(false);
  const [toast, setToast] = React.useState<{ message: string; tone: 'ok' | 'err' } | null>(null);

  const workstation = data?.workstation && !('error' in data.workstation) ? (data.workstation as DcvWorkstation) : null;
  const workstationError = data?.workstation && ('error' in data.workstation) ? (data.workstation.error as string) : null;
  const nodes = (data?.nodes ?? []) as HyperPodNode[];

  const startWorkstationMutation = useApiMutation(
    () => fetch('/api/sessions/dcv/start', { method: 'POST' }).then((r) => r.json()),
    ['/api/sessions/dcv']
  );

  const stopWorkstationMutation = useApiMutation(
    () => fetch('/api/sessions/dcv/stop', { method: 'POST' }).then((r) => r.json()),
    ['/api/sessions/dcv']
  );

  const credentialsMutation = useApiMutation(
    () => fetch('/api/sessions/dcv/credentials', { method: 'POST' }).then((r) => r.json()),
    []
  );

  const createTbMutation = useApiMutation(
    (params: { logDir: string; namespace?: string }) =>
      fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'tensorboard', ...params }),
      }).then((r) => r.json()),
    ['/api/sessions']
  );

  const deleteTbMutation = useApiMutation(
    (id: string) => fetch(`/api/sessions/${id}`, { method: 'DELETE' }).then((r) => r.json()),
    ['/api/sessions']
  );

  const handleStartWorkstation = async () => {
    try {
      await startWorkstationMutation.mutateAsync();
      setToast({ message: 'Workstation starting', tone: 'ok' });
      refetch();
    } catch (e) {
      setToast({ message: (e as Error).message, tone: 'err' });
    }
  };

  const handleStopWorkstation = async () => {
    if (!confirm('Stop the workstation? This will terminate the instance.')) return;
    try {
      await stopWorkstationMutation.mutateAsync();
      setToast({ message: 'Workstation stopping', tone: 'ok' });
      refetch();
    } catch (e) {
      setToast({ message: (e as Error).message, tone: 'err' });
    }
  };

  const handleRevealCredentials = async () => {
    try {
      const creds = await credentialsMutation.mutateAsync();
      setCredentials(creds);
      setShowCredentials(true);
      // Auto-hide after 60s
      const timer = setTimeout(() => setShowCredentials(false), 60000);
      return () => clearTimeout(timer);
    } catch (e) {
      setToast({ message: (e as Error).message, tone: 'err' });
    }
  };

  const handleCreateTensorBoard = async () => {
    try {
      await createTbMutation.mutateAsync({ logDir, namespace: namespace || undefined });
      setLogDir('/fsx/checkpoints/rl');
      setNamespace('default');
      setShowTbDialog(false);
      setToast({ message: 'TensorBoard session created (starting…)', tone: 'ok' });
    } catch (e) {
      setToast({ message: (e as Error).message, tone: 'err' });
    }
  };

  const handleDeleteTensorBoard = async (id: string) => {
    if (!confirm('Delete this TensorBoard session?')) return;
    try {
      await deleteTbMutation.mutateAsync(id);
      setToast({ message: 'TensorBoard session deleted', tone: 'ok' });
    } catch (e) {
      setToast({ message: (e as Error).message, tone: 'err' });
    }
  };

  if (isLoading && !data) return <Spinner label="Loading sessions…" />;

  return (
    <>
      <PageHeader title="Sessions" />

      {error && <ErrorBox error={error} />}

      <div className="space-y-4">
        {/* Isaac Sim Workstation */}
        {workstation ? (
          <Card title="Isaac Sim Workstation (DCV)">
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
                <div>
                  <span className="text-fg-muted">State</span>
                  <div className="mt-1">
                    <StatusPill status={workstation.state} />
                  </div>
                </div>
                <div>
                  <span className="text-fg-muted">Instance Type</span>
                  <div className="mt-1 font-mono text-xs">{workstation.instanceType || '—'}</div>
                </div>
                <div>
                  <span className="text-fg-muted">Public IP</span>
                  <div className="mt-1 font-mono text-xs">{workstation.publicIp || '—'}</div>
                </div>
                {workstation.launchTime && (
                  <div>
                    <span className="text-fg-muted">Launched</span>
                    <div className="mt-1 text-xs">{ago(workstation.launchTime)}</div>
                  </div>
                )}
              </div>

              <div className="flex flex-wrap gap-2 pt-2 border-t border-border">
                {workstation.state === 'stopped' ? (
                  <Button onClick={handleStartWorkstation} disabled={startWorkstationMutation.isPending}>
                    {startWorkstationMutation.isPending ? 'Starting…' : 'Start'}
                  </Button>
                ) : (
                  <Button onClick={handleStopWorkstation} disabled={stopWorkstationMutation.isPending} variant="secondary">
                    {stopWorkstationMutation.isPending ? 'Stopping…' : 'Stop'}
                  </Button>
                )}
                {workstation.dcvUrl && (
                  <Button
                    onClick={() => window.open(workstation.dcvUrl!, '_blank')}
                    variant="secondary"
                  >
                    Open DCV
                  </Button>
                )}
                {workstation.codeServerUrl && (
                  <Button
                    onClick={() => window.open(workstation.codeServerUrl!, '_blank')}
                    variant="secondary"
                  >
                    Open code-server
                  </Button>
                )}
                {workstation.hasSecret && (
                  <Button onClick={handleRevealCredentials} variant="secondary" disabled={credentialsMutation.isPending}>
                    Reveal Credentials
                  </Button>
                )}
              </div>

              <div className="text-xs text-fg-muted pt-2 border-t border-border">
                DCV runs on the IsaacLab EC2 instance. Isaac Sim GUI, closed-loop RL eval, and Greengrass edge demo run here.
              </div>
            </div>
          </Card>
        ) : workstationError ? (
          <Card title="Isaac Sim Workstation (DCV)">
            <ErrorBox error={new Error(workstationError)} />
          </Card>
        ) : null}

        {/* Credentials Dialog */}
        {showCredentials && credentials && (
          <Card title="DCV Credentials" className="border-l-2 border-l-accent">
            <div className="space-y-2">
              <div>
                <div className="text-xs text-fg-muted">Username</div>
                <div className="mt-1 flex items-center gap-2">
                  <code className="mono bg-bg-elev-2 px-3 py-2 rounded flex-1">{credentials.username}</code>
                  <CopyButton text={credentials.username} />
                </div>
              </div>
              <div>
                <div className="text-xs text-fg-muted">Password</div>
                <div className="mt-1 flex items-center gap-2">
                  <code className="mono bg-bg-elev-2 px-3 py-2 rounded flex-1">{credentials.password}</code>
                  <CopyButton text={credentials.password} />
                </div>
              </div>
            </div>
          </Card>
        )}

        {/* HyperPod GPU/Debug Nodes */}
        <Card title="HyperPod Node DCV (GPU / Debug Nodes)">
          {nodes.length === 0 ? (
            <EmptyState
              title="No GPU nodes available"
              hint={
                <>
                  Run <code className="mono text-xs">e2e-workshop/edge/scripts/setup-greengrass-workshop-N16.sh</code> on the workstation to set up Greengrass edge
                  device, or scale up GPU nodes.
                  <div className="mt-3">
                    <Link href="/compute">
                      <Button variant="secondary">Go to Compute</Button>
                    </Link>
                  </div>
                </>
              }
            />
          ) : (
            <>
              <Table
                head={['Cluster', 'Orchestrator', 'Group', 'Instance Type', 'Status']}
                dense
              >
                {nodes.map((n) => (
                  <tr key={`${n.cluster}-${n.instanceId}`}>
                    <td className="text-sm">{n.cluster}</td>
                    <td>
                      <Badge tone={n.orchestrator === 'eks' ? 'info' : 'accent'}>
                        {n.orchestrator.toUpperCase()}
                      </Badge>
                    </td>
                    <td className="text-sm">{n.group}</td>
                    <td className="mono text-xs">{n.instanceType}</td>
                    <td>
                      <StatusPill status={n.status} />
                    </td>
                  </tr>
                ))}
              </Table>

              <div className="mt-4 space-y-3 text-xs">
                {nodes.map((n) => (
                  <div key={`${n.cluster}-${n.instanceId}`}>
                    <div className="font-medium mb-1">{n.instanceId}</div>
                    <CodeBlock code={n.portForward} lang="bash" />
                    <div className="mt-1 text-fg-muted">
                      Login as <code className="mono">{n.login}</code>, then open{' '}
                      <code className="mono">https://localhost:8444</code>
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-3 text-xs text-fg-muted">
                Run the port-forward command on your laptop or the workstation, then submit the{' '}
                <code className="mono">isaaclab-play</code> workflow template.
              </div>
            </>
          )}
        </Card>

        {/* TensorBoard Sessions */}
        <Card
          title="TensorBoard Sessions"
          description={`${sessions?.length ?? 0} total`}
        >
          {can(me, 'researcher') && (
            <div className="mb-4">
              <Button onClick={() => setShowTbDialog(true)}>New TensorBoard</Button>
            </div>
          )}

          {!sessions?.length ? (
            <EmptyState title="No TensorBoard sessions" />
          ) : (
            <Table
              head={['Session ID', 'Log Directory', 'Namespace', 'Owner', 'Status', 'Created', 'Action']}
              dense
            >
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td className="mono text-xs">{s.id}</td>
                  <td className="mono text-xs">{s.logDir}</td>
                  <td className="text-sm">{s.namespace}</td>
                  <td className="text-sm">{s.owner}</td>
                  <td>
                    <StatusPill status={s.status} />
                  </td>
                  <td className="text-xs text-fg-muted">{ago(s.createdAt)}</td>
                  <td>
                    <Button
                      size="sm"
                      onClick={() => window.open(s.url, '_blank')}
                      disabled={s.status !== 'ready'}
                    >
                      Open
                    </Button>
                    {can(me, 'admin') && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => handleDeleteTensorBoard(s.id)}
                      >
                        Delete
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>

      {/* New TensorBoard Dialog */}
      <Dialog
        title="Create TensorBoard Session"
        open={showTbDialog}
        onClose={() => setShowTbDialog(false)}
        footer={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setShowTbDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateTensorBoard} disabled={createTbMutation.isPending || !logDir}>
              Create
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium">Log Directory</label>
            <Input
              value={logDir}
              onChange={(e) => setLogDir(e.target.value)}
              placeholder="/fsx/checkpoints/rl"
              className="mt-1"
            />
            <div className="mt-2 text-xs text-fg-muted">Common directories:</div>
            <div className="mt-1 space-y-1">
              {['/fsx/checkpoints/rl/reach-mujoco', '/fsx/checkpoints/rl/reach', '/fsx/checkpoints/workflows'].map((d) => (
                <button
                  key={d}
                  onClick={() => setLogDir(d)}
                  className="text-xs text-accent hover:underline"
                >
                  {d}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-sm font-medium">Namespace (optional)</label>
            <Input
              value={namespace}
              onChange={(e) => setNamespace(e.target.value)}
              placeholder="default"
              className="mt-1"
            />
          </div>
        </div>
      </Dialog>

      {toast && <Toast message={toast.message} tone={toast.tone} onClose={() => setToast(null)} />}
    </>
  );
}
