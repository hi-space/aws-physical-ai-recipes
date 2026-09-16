'use client';
import * as React from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge, Button, Card, CodeBlock, EmptyState, ErrorBox, KeyValue, Spinner, StatusPill, Table, Tabs } from '@/components/ui';
import { ago, classNames as cx, fmtDuration, fmtNum, fmtTime, fmtBytes } from '@/lib/format';
import { api, useApi } from '@/lib/api-client';

interface ExecutionData {
  canStop?: boolean;
  execution: {
    PipelineExecutionStatus: string;
    PipelineExecutionDisplayName: string;
    CreationTime: string;
    LastModifiedTime: string;
    FailureReason?: string;
  };
  steps: {
    StepName: string;
    StepStatus: string;
    StartTime?: string;
    EndTime?: string;
    FailureReason?: string;
    Metadata?: {
      TrainingJob?: { Arn: string };
      ProcessingJob?: { Arn: string };
      RegisterModel?: { Arn: string };
      Condition?: { Outcome: string };
      Fail?: { ErrorMessage: string };
    };
  }[];
  parameters: { Name: string; Value: string }[];
}

interface TrainingJobData {
  job: {
    TrainingJobStatus: string;
    SecondaryStatus?: string;
    ResourceConfig?: { InstanceType: string; InstanceCount: number };
    TrainingTimeInSeconds?: number;
    BillableTimeInSeconds?: number;
    FinalMetricDataList?: { MetricName: string; Value: number }[];
    FailureReason?: string;
    ModelArtifacts?: { S3ModelArtifacts: string };
    HyperParameters?: Record<string, string>;
  };
  logs: { ts: number; message: string }[];
}

export function PipelineExecutionPage({ arn }: { arn: string }) {
  const { data, isLoading, error } = useApi<ExecutionData>(
    `/api/pipelines/executions/${encodeURIComponent(arn)}`,
    { refetch: 10000 }
  );
  const [expandedStep, setExpandedStep] = React.useState<string | null>(null);
  const [expandedHyperparams, setExpandedHyperparams] = React.useState(false);
  const [stopPending, setStopPending] = React.useState(false);
  const [stopError, setStopError] = React.useState<Error>();
  const [stopAccepted, setStopAccepted] = React.useState(false);

  const trainingJobName = React.useMemo(() => {
    const step = data?.steps.find((s) => s.Metadata?.TrainingJob);
    if (!step?.Metadata?.TrainingJob?.Arn) return null;
    return step.Metadata.TrainingJob.Arn.split('/').pop();
  }, [data]);

  const { data: jobData, error: jobError } = useApi<TrainingJobData>(
    trainingJobName ? `/api/pipelines/training-jobs/${encodeURIComponent(trainingJobName)}` : null,
    { refetch: 10000 }
  );

  if (isLoading && !data) return <Spinner label="실행을 불러오는 중…" />;

  return (
    <>
      <PageHeader title={data?.execution.PipelineExecutionDisplayName || '파이프라인 실행'} />

      {error && <ErrorBox error={error} />}
      {jobError && <ErrorBox error={jobError} />}
      {stopError && <ErrorBox error={stopError} />}
      {data?.canStop && data.execution.PipelineExecutionStatus === 'Executing' && <div className="mb-4">
        <Button variant="danger" disabled={stopPending || stopAccepted} onClick={async () => {
          if (!window.confirm('이 파이프라인 실행과 실행 중인 단계를 중단할까요?')) return;
          setStopPending(true); setStopError(undefined);
          try { await api(`/api/pipelines/executions/${encodeURIComponent(arn)}`, { method: 'DELETE' }); setStopAccepted(true); }
          catch (failure) { setStopError(failure as Error); }
          finally { setStopPending(false); }
        }}>{stopAccepted ? '중단 요청 접수됨' : '실행 중단'}</Button>
      </div>}

      <div className="space-y-4">
        {/* Header */}
        {data?.execution && (
          <Card>
            <div className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
              <div>
                <span className="text-fg-muted">상태</span>
                <div className="mt-1">
                  <StatusPill status={data.execution.PipelineExecutionStatus} />
                </div>
              </div>
              <div>
                <span className="text-fg-muted">생성 시각</span>
                <div className="mt-1 font-mono text-xs">{fmtTime(data.execution.CreationTime)}</div>
              </div>
              <div>
                <span className="text-fg-muted">최근 변경</span>
                <div className="mt-1 font-mono text-xs">{ago(data.execution.LastModifiedTime)}</div>
              </div>
              {data.execution.FailureReason && (
                <div className="col-span-2 md:col-span-1">
                  <span className="text-fg-muted">실패 사유</span>
                  <div className="mt-1 text-xs text-err">{data.execution.FailureReason}</div>
                </div>
              )}
            </div>

            {/* Parameters */}
            {data.parameters.length > 0 && (
              <div className="mt-4 pt-4 border-t border-border">
                <div className="text-sm font-medium">파라미터</div>
                <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                  {data.parameters.map((p) => (
                    <div key={p.Name} className="flex items-center gap-2">
                      <span className="mono text-fg-muted">{p.Name}</span>
                      <span className="font-mono">{p.Value}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Card>
        )}

        {/* Steps Stepper */}
        {data?.steps && (
          <Card title="파이프라인 단계">
            <div className="space-y-2">
              {data.steps.map((step, idx) => (
                <div key={step.StepName} className="border-b border-border py-3 last:border-b-0">
                  <button
                    onClick={() =>
                      setExpandedStep(expandedStep === step.StepName ? null : step.StepName)
                    }
                    className="w-full text-left"
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-medium text-fg-muted">{idx + 1}.</span>
                      <span className="text-sm font-medium">{step.StepName}</span>
                      <StatusPill status={step.StepStatus} />
                      {step.StartTime && step.EndTime && (
                        <span className="ml-auto text-xs text-fg-muted">
                          {fmtDuration(
                            new Date(step.EndTime).getTime() -
                            new Date(step.StartTime).getTime()
                          )}
                        </span>
                      )}
                    </div>
                  </button>

                  {expandedStep === step.StepName && (
                    <div className="mt-3 ml-6 space-y-2 text-xs text-fg-muted">
                      {step.StartTime && (
                        <div>
                          <span>Started:</span> {fmtTime(step.StartTime)}
                        </div>
                      )}
                      {step.EndTime && (
                        <div>
                          <span>Ended:</span> {fmtTime(step.EndTime)}
                        </div>
                      )}
                      {step.FailureReason && (
                        <div className="text-err">
                          <span>Failure:</span> {step.FailureReason}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* Training Job Detail */}
        {jobData?.job && (
          <Card title="Training Job" description={trainingJobName}>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
                <div>
                  <span className="text-fg-muted">Status</span>
                  <div className="mt-1">
                    <StatusPill status={jobData.job.TrainingJobStatus} />
                  </div>
                </div>
                {jobData.job.SecondaryStatus && (
                  <div>
                    <span className="text-fg-muted">Secondary Status</span>
                    <div className="mt-1 text-xs font-mono">{jobData.job.SecondaryStatus}</div>
                  </div>
                )}
                {jobData.job.ResourceConfig && (
                  <>
                    <div>
                      <span className="text-fg-muted">Instance Type</span>
                      <div className="mt-1 text-xs font-mono">{jobData.job.ResourceConfig.InstanceType}</div>
                    </div>
                    <div>
                      <span className="text-fg-muted">Instance Count</span>
                      <div className="mt-1 text-xs font-mono">{jobData.job.ResourceConfig.InstanceCount}</div>
                    </div>
                  </>
                )}
                {jobData.job.BillableTimeInSeconds && (
                  <div>
                    <span className="text-fg-muted">Billable Time</span>
                    <div className="mt-1 text-xs">{fmtDuration(jobData.job.BillableTimeInSeconds * 1000)}</div>
                  </div>
                )}
              </div>

              {/* Final Metrics */}
              {jobData.job.FinalMetricDataList && jobData.job.FinalMetricDataList.length > 0 && (
                <div>
                  <div className="text-sm font-medium">Final Metrics</div>
                  <Table
                    head={['Metric', 'Value']}
                    dense
                    className="mt-2"
                  >
                    {jobData.job.FinalMetricDataList.map((m) => (
                      <tr key={m.MetricName}>
                        <td className="text-sm">{m.MetricName}</td>
                        <td className="num text-sm">{fmtNum(m.Value)}</td>
                      </tr>
                    ))}
                  </Table>
                </div>
              )}

              {/* Model Artifacts */}
              {jobData.job.ModelArtifacts?.S3ModelArtifacts && (
                <div>
                  <div className="text-sm font-medium">Model Artifacts</div>
                  <div className="mt-2 flex items-center gap-2">
                    <code className="mono bg-bg-elev-2 px-3 py-2 rounded text-xs flex-1 break-all">
                      {jobData.job.ModelArtifacts.S3ModelArtifacts}
                    </code>
                  </div>
                </div>
              )}

              {/* Hyperparameters */}
              {jobData.job.HyperParameters && Object.keys(jobData.job.HyperParameters).length > 0 && (
                <div>
                  <button
                    onClick={() => setExpandedHyperparams(!expandedHyperparams)}
                    className="text-sm font-medium text-accent hover:underline"
                  >
                    {expandedHyperparams ? '▼' : '▶'} Hyperparameters
                  </button>
                  {expandedHyperparams && (
                    <div className="mt-2 space-y-2">
                      {Object.entries(jobData.job.HyperParameters).map(([k, v]) => (
                        <div key={k} className="flex items-center gap-3 text-xs">
                          <span className="mono text-fg-muted">{k}</span>
                          <span className="font-mono">{v}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Logs */}
              {jobData.logs && jobData.logs.length > 0 && (
                <div>
                  <div className="text-sm font-medium">Logs (last 300 lines)</div>
                  <CodeBlock
                    code={jobData.logs
                      .map((l) => `[${fmtTime(l.ts)}] ${l.message}`)
                      .join('\n')}
                    lang="text"
                    className="mt-2"
                  />
                </div>
              )}
            </div>
          </Card>
        )}

        {/* Open MLflow Link */}
        <Card>
          <div className="flex gap-2">
            <Link href="/experiments">
              <Button variant="secondary">Open in MLflow</Button>
            </Link>
          </div>
        </Card>
      </div>
    </>
  );
}
