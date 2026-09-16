'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge, Button, Card, Dialog, EmptyState, ErrorBox, Input, KeyValue, Spinner, StatusPill, Table, Toast, Textarea, Select, Field } from '@/components/ui';
import { ago, classNames as cx, fmtNum, fmtTime } from '@/lib/format';
import { useApi, useApiMutation, useMe, can } from '@/lib/api-client';

interface PipelineParameter {
  Name: string;
  DefaultValue?: string;
  Type?: string;
}

interface Pipeline {
  PipelineName: string;
  PipelineArn: string;
  PipelineStatus: string;
  CreationTime: string;
  LastModifiedTime: string;
  parameters: PipelineParameter[];
}

interface ExecutionSummary {
  PipelineExecutionArn: string;
  PipelineExecutionDisplayName: string;
  PipelineExecutionStatus: string;
  StartTime: string;
  PipelineExecutionDescription?: string;
  PipelineExecutionFailureReason?: string;
}

interface PipelinesData {
  pipeline: Pipeline;
  executions: ExecutionSummary[];
}

export function PipelinesPage() {
  const me = useMe() as any;
  const router = useRouter();
  const { data, isLoading, error } = useApi<PipelinesData>('/api/pipelines', { refetch: 10000 });
  const [showDialog, setShowDialog] = React.useState(false);
  const [formData, setFormData] = React.useState<Record<string, string>>({});
  const [displayName, setDisplayName] = React.useState('');
  const [toast, setToast] = React.useState<{ message: string; tone: 'ok' | 'err' } | null>(null);

  const mutation = useApiMutation(
    async (params: { parameters: Record<string, string>; displayName?: string }) => {
      const res = await fetch('/api/pipelines/executions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      if (!res.ok) throw new Error(`Failed to start execution: ${res.statusText}`);
      return res.json() as Promise<{ arn: string }>;
    },
    ['/api/pipelines']
  );

  const handleStartExecution = async () => {
    try {
      const result = await mutation.mutateAsync({
        parameters: formData,
        displayName: displayName || undefined,
      });
      setShowDialog(false);
      setFormData({});
      setDisplayName('');
      setToast({ message: 'Execution started', tone: 'ok' });
      // Navigate to execution page
      router.push(`/pipelines/${encodeURIComponent(result.arn)}`);
    } catch (e) {
      setToast({ message: (e as Error).message, tone: 'err' });
    }
  };

  if (isLoading && !data) return <Spinner label="Loading pipelines…" />;

  return (
    <>
      <PageHeader title="Pipelines" />

      {error && <ErrorBox error={error} />}

      <div className="space-y-4">
        {/* Start button */}
        {can(me, 'researcher') && (
          <div>
            <Button onClick={() => setShowDialog(true)}>Start Execution</Button>
          </div>
        )}

        {/* Pipeline description */}
        {data?.pipeline && (
          <Card title={data.pipeline.PipelineName}>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-fg-muted">Status</span>
                  <div className="mt-1">
                    <StatusPill status={data.pipeline.PipelineStatus} />
                  </div>
                </div>
                <div>
                  <span className="text-fg-muted">Created</span>
                  <div className="mt-1 font-mono text-xs">{fmtTime(data.pipeline.CreationTime)}</div>
                </div>
              </div>
              {data.pipeline.parameters.length > 0 && (
                <div>
                  <div className="text-sm font-medium">Parameters</div>
                  <div className="mt-2 space-y-2">
                    {data.pipeline.parameters.map((p) => (
                      <div key={p.Name} className="flex items-center gap-3 rounded bg-bg-elev-2 p-2">
                        <span className="text-sm font-mono text-fg-muted">{p.Name}</span>
                        {p.DefaultValue && (
                          <Badge tone="info">default: {p.DefaultValue}</Badge>
                        )}
                        {p.Type && <Badge tone="accent">{p.Type}</Badge>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </Card>
        )}

        {/* Executions table */}
        <Card title="Executions" description={`${data?.executions.length ?? 0} total`}>
          {!data?.executions.length ? (
            <EmptyState title="No executions yet" />
          ) : (
            <Table
              head={['Display Name', 'Status', 'Started', 'Failure Reason']}
              dense
            >
              {data.executions.map((exec) => (
                <tr
                  key={exec.PipelineExecutionArn}
                  onClick={() => router.push(`/pipelines/${encodeURIComponent(exec.PipelineExecutionArn)}`)}
                  className="cursor-pointer hover:bg-bg-elev-2"
                >
                  <td className="font-mono text-sm">{exec.PipelineExecutionDisplayName}</td>
                  <td>
                    <StatusPill status={exec.PipelineExecutionStatus} />
                  </td>
                  <td className="text-fg-muted text-xs">{ago(exec.StartTime)}</td>
                  <td className="text-fg-muted text-xs">
                    {exec.PipelineExecutionFailureReason || '—'}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        {/* Explanation */}
        <Card title="Pipeline Steps">
          <div className="space-y-2 text-sm text-fg-muted">
            <div className="flex items-start gap-2">
              <span className="text-accent">1.</span>
              <span>TransformDataset — Preprocess input data</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-accent">2.</span>
              <span>GR00TFinetune — Fine-tune GR00T model</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-accent">3.</span>
              <span>SmokeEval — Run basic evaluation</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-accent">4.</span>
              <span>SmokeGate — Check quality metrics</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-accent">5.</span>
              <span>RegisterModel — Register model artifact</span>
            </div>
          </div>
        </Card>
      </div>

      {/* Start Execution Dialog */}
      <Dialog
        title="Start Pipeline Execution"
        open={showDialog}
        onClose={() => setShowDialog(false)}
        footer={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setShowDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleStartExecution} disabled={mutation.isPending}>
              Start
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium">Display Name (optional)</label>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. training-v1"
              className="mt-1"
            />
          </div>

          {data?.pipeline.parameters.map((p) => (
            <div key={p.Name}>
              <label className="text-sm font-medium">{p.Name}</label>
              {p.Type === 'Integer' ? (
                <Input
                  type="number"
                  value={formData[p.Name] || p.DefaultValue || ''}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, [p.Name]: e.target.value }))
                  }
                  placeholder={p.DefaultValue}
                  className="mt-1"
                />
              ) : (
                <Input
                  value={formData[p.Name] || p.DefaultValue || ''}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, [p.Name]: e.target.value }))
                  }
                  placeholder={p.DefaultValue}
                  className="mt-1"
                />
              )}
            </div>
          ))}
        </div>
      </Dialog>

      {toast && <Toast message={toast.message} tone={toast.tone} onClose={() => setToast(null)} />}
    </>
  );
}
