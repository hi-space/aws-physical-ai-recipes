'use client';
import * as React from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge, Button, Card, CodeBlock, EmptyState, ErrorBox, Field, Input, Select, Spinner, StatusPill, Table } from '@/components/ui';
import { ago, classNames as cx, fmtDuration, fmtNum, fmtTime, fmtBytes } from '@/lib/format';
import { api, useApi, useMe } from '@/lib/api-client';
import type { PipelineArchiveRecord } from '@/server/evaluations/pipeline-types';
import type { RegisteredModel } from '@/server/evaluations/types';

interface ExecutionData {
  canStop?: boolean;
  canArchive?: boolean;
  projectRecorded?: boolean;
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

export function PipelineArchivePanel({ arn, data }: { arn: string; data: ExecutionData }) {
  const me = useMe();
  const canManage = (record: PipelineArchiveRecord) => data.canArchive && (me.data?.role === 'admin' ||
    me.data?.subject === record.ownerSubject || me.data?.project?.role === 'project-admin');
  const path = `/api/pipelines/executions/${encodeURIComponent(arn)}/archives`;
  const archives = useApi<PipelineArchiveRecord[]>(path, { refetch: 5000 });
  const candidates = data.steps.filter(step => step.Metadata?.TrainingJob && step.StepStatus === 'Succeeded');
  const [training, setTraining] = React.useState('');
  const selected = candidates.find(step => step.StepName === training)?.StepName ??
    candidates.find(step => step.StepName === 'GR00TFinetune')?.StepName ?? candidates[0]?.StepName ?? '';
  const [reports, setReports] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<unknown>();
  const [name, setName] = React.useState('');
  const [registered, setRegistered] = React.useState<RegisteredModel>();
  async function request() {
    setBusy(true); setError(undefined);
    try {
      await api(path, { method: 'POST', json: { trainingStep: selected, reportSteps: reports.filter(step => step !== selected) } });
      await archives.refetch();
    } catch (failure) { setError(failure); } finally { setBusy(false); }
  }
  async function register(record: PipelineArchiveRecord) {
    if (!record.dataset || !record.checkpoint) return;
    setBusy(true); setError(undefined);
    try {
      setRegistered(await api<RegisteredModel>('/api/models', { method: 'POST', json: {
        name: name.trim() || `${data.execution.PipelineExecutionDisplayName} 모델`.slice(0, 120),
        dataset: record.dataset.name, version: record.dataset.version, checkpointPath: record.checkpoint.path,
      } }));
    } catch (failure) { setError(failure); } finally { setBusy(false); }
  }
  async function operation(record: PipelineArchiveRecord, method: 'POST' | 'DELETE') {
    setBusy(true); setError(undefined);
    try { await api(`/api/pipelines/archives/${record.id}`, { method }); await archives.refetch(); }
    catch (failure) { setError(failure); } finally { setBusy(false); }
  }
  return <Card title="프로젝트 모델 보관" description="완료된 SageMaker 출력의 실제 파일·버전·체크섬을 프로젝트 보관소에 고정합니다. 학습을 다시 실행하지 않습니다.">
    <ErrorBox error={error ?? archives.error} />
    {data.execution.PipelineExecutionStatus !== 'Succeeded' && <p className="mb-3 text-xs text-warn">성공적으로 완료된 실행만 보관할 수 있습니다. OOM·용량 부족·중단 결과는 성공한 GR00T 학습으로 취급하지 않습니다.</p>}
    {data.canArchive && <div className="space-y-3">
      <Field label="모델을 생성한 학습 단계"><Select value={selected} onChange={event => { setTraining(event.target.value); setReports([]); }}>
        {candidates.map(step => <option key={step.StepName}>{step.StepName}</option>)}
      </Select></Field>
      <fieldset className="space-y-2 text-xs"><legend className="mb-2 text-fg-muted">함께 보관할 평가 보고서</legend>
        {data.steps.filter(step => step.StepStatus === 'Succeeded' && step.StepName !== selected &&
          (step.Metadata?.TrainingJob || step.Metadata?.ProcessingJob)).map(step => <label key={step.StepName} className="flex items-center gap-2">
          <input type="checkbox" checked={reports.includes(step.StepName)} onChange={event => setReports(current =>
            event.target.checked ? [...current, step.StepName] : current.filter(name => name !== step.StepName))} />
          {step.StepName}
        </label>)}
      </fieldset>
      <Button disabled={!selected || busy} loading={busy} onClick={() => void request()}>완료 출력 검증·보관</Button>
      <p className="text-xs text-fg-faint">보고서는 이 모델을 입력으로 사용한 완료 단계에서만 가져옵니다. Smoke 통과나 기존 Registry Approved 상태로 품질 승인을 만들지 않습니다.</p>
    </div>}
    {archives.isLoading && <Spinner label="보관 상태 확인 중…" />}
    {!archives.isLoading && !archives.data?.length && <EmptyState title="보관된 프로젝트 모델 출력이 없습니다." />}
    <div className="mt-4 space-y-3">{archives.data?.map(record => <div key={record.id} className="rounded border border-border p-3 text-xs">
      <div className="flex items-center gap-2"><Badge tone={record.status === 'READY' ? 'ok' : record.status === 'FAILED' ? 'err' : 'neutral'}>{record.status}</Badge>
        <span>{record.trainingStep}</span></div>
      {record.error && <p className="mt-2 text-err">{record.error}</p>}
      {record.status === 'READY' && record.dataset && <>
        <p className="mt-2"><Link className="text-accent" href={`/datasets/${record.dataset.name}`}>{record.dataset.name} · v{record.dataset.version}</Link></p>
        <p className="mt-1 break-all font-mono">Manifest SHA-256: {record.dataset.manifestHash}</p>
        <p className="mt-1 text-fg-muted">{record.directory?.fileCount}개 모델 파일의 묶음 digest와 tar.gz 전체 파일 digest를 따로 고정했습니다.</p>
        {!!record.reports?.length && <p className="mt-1">보관 보고서: {record.reports.map(report => report.step).join(', ')}</p>}
        {data.canArchive && <div className="mt-3 flex flex-wrap gap-2">
          <Input aria-label="등록할 모델 이름" value={name} onChange={event => setName(event.target.value)} placeholder="모델 이름" maxLength={120} />
          <Button disabled={busy} onClick={() => void register(record)}>보관 출력에서 모델 등록</Button>
        </div>}
      </>}
      {canManage(record) && record.status === 'FAILED' && <Button className="mt-2" disabled={busy} onClick={() => void operation(record, 'POST')}>보관 재시도</Button>}
      {canManage(record) && ['PENDING', 'ARCHIVING'].includes(record.status) && <Button className="mt-2" disabled={busy} onClick={() => void operation(record, 'DELETE')}>보관 취소</Button>}
    </div>)}</div>
    {registered && <Link className="mt-3 inline-block text-sm text-accent" href={`/models?model_id=${registered.id}`}>등록 모델·평가 이력 열기</Link>}
  </Card>;
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
        {data?.projectRecorded && <PipelineArchivePanel arn={arn} data={data} />}
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
