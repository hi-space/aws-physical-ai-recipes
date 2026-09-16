'use client';
import * as React from 'react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge, Button, Card, Dialog, EmptyState, ErrorBox, Input, Spinner, StatusPill, Table, Toast } from '@/components/ui';
import { ago, classNames as cx, fmtTime } from '@/lib/format';
import { useApi, useApiMutation, useMe } from '@/lib/api-client';

interface InstalledComponent {
  componentName: string;
  componentVersion: string;
  lifecycleState: string;
  lifecycleStateDetails?: string;
}

interface EffectiveDeployment {
  deploymentId: string;
  deploymentName: string;
  coreDeviceExecutionStatus: string;
  reason?: string;
  modifiedTimestamp?: string;
}

interface CoreDevice {
  coreDeviceThingName: string;
  status: string;
  lastStatusUpdateTimestamp?: number;
  installed: InstalledComponent[];
  effective: EffectiveDeployment[];
}

interface Component {
  componentName: string;
  latestVersion?: { componentVersion: string; creationTimestamp?: string; description?: string };
}

interface Deployment {
  deploymentId: string;
  deploymentName: string;
  deploymentStatus: string;
  creationTimestamp?: string;
  isLatestForTarget?: boolean;
}

interface EdgeData {
  thingGroupArn?: string;
  cores: CoreDevice[];
  components: Component[];
  deployments: Deployment[];
}

interface UseMe {
  role: string;
  [key: string]: any;
}

function canAccess(me: any, role: string): boolean {
  if (!me) return false;
  if (me.role === 'admin') return true;
  if (role === 'viewer') return true;
  if (me.role === 'researcher' && role === 'researcher') return true;
  return false;
}

export function EdgePage() {
  const me = useMe() as any;
  const { data, isLoading, error, refetch } = useApi<EdgeData>('/api/edge', { refetch: 10000 });
  const [showDialog, setShowDialog] = React.useState(false);
  const [formData, setFormData] = React.useState({
    name: '',
    modelPath: '/home/ubuntu/environment/models/GR00T-N1.6-3B',
    embodimentTag: 'NEW_EMBODIMENT',
    ecrImage: '',
    policyPort: '5555',
  });
  const [toast, setToast] = React.useState<{ message: string; tone: 'ok' | 'err' } | null>(null);

  const deployMutation = useApiMutation(
    (payload: any) =>
      fetch('/api/edge/deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then((r) => r.json()),
    ['/api/edge']
  );

  const handleDeploy = async () => {
    try {
      const payload = {
        name: formData.name,
        modelPath: formData.modelPath,
        embodimentTag: formData.embodimentTag,
        ecrImage: formData.ecrImage,
        ...(formData.policyPort && { policyPort: parseInt(formData.policyPort) }),
      };
      await deployMutation.mutateAsync(payload);
      setShowDialog(false);
      setFormData({
        name: '',
        modelPath: '/home/ubuntu/environment/models/GR00T-N1.6-3B',
        embodimentTag: 'NEW_EMBODIMENT',
        ecrImage: '',
        policyPort: '5555',
      });
      setToast({ message: 'Deployment started', tone: 'ok' });
      refetch();
    } catch (e) {
      setToast({ message: (e as Error).message, tone: 'err' });
    }
  };

  if (isLoading && !data) return <Spinner label="Loading edge devices…" />;

  if (!data?.thingGroupArn || !data.cores.length) {
    return (
      <>
        <PageHeader title="Edge" />
        <EmptyState
          title="No Greengrass core device registered"
          hint={
            <>
              Run <code className="mono text-xs">e2e-workshop/edge/scripts/setup-greengrass-workshop-N16.sh</code> on the workstation to set up the Greengrass core device.
            </>
          }
        />
      </>
    );
  }

  return (
    <>
      <PageHeader title="Edge" />

      {error && <ErrorBox error={error} />}

      <div className="space-y-4">
        {/* Deploy button */}
        {canAccess(me, 'admin') && (
          <div>
            <Button onClick={() => setShowDialog(true)}>Deploy Inference</Button>
          </div>
        )}

        {/* Explanation */}
        <Card>
          <div className="text-sm text-fg-muted space-y-2">
            <p>
              Greengrass v2 deploys the GR00T policy server container to the workstation acting as the edge device. The inference component listens on ZMQ :5555.
            </p>
          </div>
        </Card>

        {/* Core Devices */}
        <Card title="Core Devices" description={`${data.cores.length} device(s)`}>
          {data.cores.map((core) => (
            <div key={core.coreDeviceThingName} className="border-b border-border py-4 last:border-b-0">
              <div className="mb-3">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{core.coreDeviceThingName}</span>
                  <StatusPill status={core.status} />
                </div>
                {core.lastStatusUpdateTimestamp && (
                  <div className="text-xs text-fg-muted mt-1">
                    Last update {ago(core.lastStatusUpdateTimestamp)}
                  </div>
                )}
              </div>

              {core.installed.length > 0 && (
                <div>
                  <div className="text-xs font-medium text-fg-muted mb-2">Installed Components</div>
                  <Table
                    head={['Component', 'Version', 'State']}
                    dense
                    className="mb-3"
                  >
                    {core.installed.map((c) => (
                      <tr key={c.componentName}>
                        <td className="text-sm">{c.componentName}</td>
                        <td className="mono text-xs">{c.componentVersion}</td>
                        <td>
                          <Badge tone={c.lifecycleState === 'RUNNING' ? 'ok' : 'warn'}>
                            {c.lifecycleState}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </Table>
                </div>
              )}
            </div>
          ))}
        </Card>

        {/* Deployments */}
        {data.deployments.length > 0 && (
          <Card title="Deployments" description={`${data.deployments.length} total`}>
            <Table
              head={['Name', 'Status', 'Created', 'Latest']}
              dense
            >
              {data.deployments.map((d) => (
                <tr key={d.deploymentId}>
                  <td className="text-sm">{d.deploymentName}</td>
                  <td>
                    <StatusPill status={d.deploymentStatus} />
                  </td>
                  <td className="text-xs text-fg-muted">
                    {d.creationTimestamp ? ago(d.creationTimestamp) : '—'}
                  </td>
                  <td>
                    {d.isLatestForTarget && (
                      <Badge tone="ok">Latest</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </Table>
          </Card>
        )}

        {/* Components */}
        {data.components.length > 0 && (
          <Card title="Components" description={`${data.components.length} available`}>
            <div className="space-y-2">
              {data.components.map((c) => (
                <div key={c.componentName} className="flex items-start gap-3 border-b border-border py-2 last:border-b-0">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm">{c.componentName}</div>
                    {c.latestVersion?.description && (
                      <div className="text-xs text-fg-muted mt-1">{c.latestVersion.description}</div>
                    )}
                  </div>
                  {c.latestVersion && (
                    <Badge tone="info">{c.latestVersion.componentVersion}</Badge>
                  )}
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>

      {/* Deploy Dialog */}
      <Dialog
        title="Deploy Inference"
        open={showDialog}
        onClose={() => setShowDialog(false)}
        footer={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setShowDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleDeploy} disabled={deployMutation.isPending || !formData.name || !formData.ecrImage}>
              Deploy
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium">Deployment Name *</label>
            <Input
              value={formData.name}
              onChange={(e) => setFormData((p) => ({ ...p, name: e.target.value }))}
              placeholder="e.g. groot-v1"
              className="mt-1"
            />
          </div>

          <div>
            <label className="text-sm font-medium">Model Path</label>
            <Input
              value={formData.modelPath}
              onChange={(e) => setFormData((p) => ({ ...p, modelPath: e.target.value }))}
              className="mt-1"
            />
          </div>

          <div>
            <label className="text-sm font-medium">Embodiment Tag</label>
            <Input
              value={formData.embodimentTag}
              onChange={(e) => setFormData((p) => ({ ...p, embodimentTag: e.target.value }))}
              className="mt-1"
            />
          </div>

          <div>
            <label className="text-sm font-medium">ECR Image *</label>
            <Input
              value={formData.ecrImage}
              onChange={(e) => setFormData((p) => ({ ...p, ecrImage: e.target.value }))}
              placeholder="e.g. 123456789.dkr.ecr.us-east-1.amazonaws.com/groot-runtime:latest"
              className="mt-1"
            />
          </div>

          <div>
            <label className="text-sm font-medium">Policy Port</label>
            <Input
              type="number"
              value={formData.policyPort}
              onChange={(e) => setFormData((p) => ({ ...p, policyPort: e.target.value }))}
              className="mt-1"
            />
          </div>
        </div>

      </Dialog>

      {toast && <Toast message={toast.message} tone={toast.tone} onClose={() => setToast(null)} />}
    </>
  );
}
