'use client';
import * as React from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge, Button, Card, CodeBlock, EmptyState, ErrorBox, Field, Input, Select, Spinner, StatusPill, Table } from '@/components/ui';
import { useT, useFormat } from '@/lib/i18n';
import { api, useApi, useMe, type Me } from '@/lib/api-client';
import type { PipelineArchiveRecord } from '@/server/evaluations/pipeline-types';
import type { RegisteredModel } from '@/server/evaluations/types';

interface ExecutionData {
  canStop?: boolean;
  canArchive?: boolean;
  projectRecorded?: boolean;
  execution: {
    PipelineArn?: string;
    PipelineExecutionArn?: string;
    PipelineVersionId?: number;
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

export function PipelineArchivePanel({ arn, data, projectId }: { arn: string; data: ExecutionData; projectId: string }) {
  const t = useT('pipelines');
  const tc = useT('common');
  const headers = { 'x-pai-project': projectId };
  const me = useApi<Me>('/api/me', { init: { headers } });
  const canManage = (record: PipelineArchiveRecord) => data.canArchive && (me.data?.role === 'admin' ||
    me.data?.subject === record.ownerSubject || me.data?.project?.role === 'project-admin');
  const path = `/api/pipelines/executions/${encodeURIComponent(arn)}/archives`;
  const archives = useApi<PipelineArchiveRecord[]>(path, { refetch: 5000, init: { headers } });
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
      await api(path, { method: 'POST', headers, json: { trainingStep: selected, reportSteps: reports.filter(step => step !== selected) } });
      await archives.refetch();
    } catch (failure) { setError(failure); } finally { setBusy(false); }
  }
  async function register(record: PipelineArchiveRecord) {
    if (!record.dataset || !record.checkpoint) return;
    setBusy(true); setError(undefined);
    try {
      setRegistered(await api<RegisteredModel>('/api/models', { method: 'POST', headers, json: {
        name: name.trim() || t('archiveDefaultModelName', { executionName: data.execution.PipelineExecutionDisplayName }).slice(0, 120),
        dataset: record.dataset.name, version: record.dataset.version, checkpointPath: record.checkpoint.path,
      } }));
    } catch (failure) { setError(failure); } finally { setBusy(false); }
  }
  async function operation(record: PipelineArchiveRecord, method: 'POST' | 'DELETE') {
    setBusy(true); setError(undefined);
    try { await api(`/api/pipelines/archives/${record.id}`, { method, headers }); await archives.refetch(); }
    catch (failure) { setError(failure); } finally { setBusy(false); }
  }
  return <Card title={t('archiveTitle')} description={t('archiveDesc')}>
    <ErrorBox error={error ?? archives.error} />
    {data.execution.PipelineExecutionStatus !== 'Succeeded' && <p className="mb-3 text-xs text-warn">{t('archiveWarning')}</p>}
    {data.canArchive && <div className="space-y-3">
      <Field label={t('archiveTrainingStep')}><Select value={selected} onChange={event => { setTraining(event.target.value); setReports([]); }}>
        {candidates.map(step => <option key={step.StepName}>{step.StepName}</option>)}
      </Select></Field>
      <fieldset className="space-y-2 text-xs"><legend className="mb-2 text-fg-muted">{t('archiveReports')}</legend>
        {data.steps.filter(step => step.StepStatus === 'Succeeded' && step.StepName !== selected &&
          (step.Metadata?.TrainingJob || step.Metadata?.ProcessingJob)).map(step => <label key={step.StepName} className="flex items-center gap-2">
          <input type="checkbox" checked={reports.includes(step.StepName)} onChange={event => setReports(current =>
            event.target.checked ? [...current, step.StepName] : current.filter(name => name !== step.StepName))} />
          {step.StepName}
        </label>)}
      </fieldset>
      <Button disabled={!selected || busy} loading={busy} onClick={() => void request()}>{t('archiveButton')}</Button>
      <p className="text-xs text-fg-faint">{t('archiveNote')}</p>
    </div>}
    {archives.isLoading && <Spinner label={t('archiveLoading')} />}
    {!archives.isLoading && !archives.data?.length && <EmptyState title={t('noArchives')} />}
    <div className="mt-4 space-y-3">{archives.data?.map(record => <div key={record.id} className="rounded border border-border p-3 text-xs">
      <div className="flex items-center gap-2"><Badge tone={record.status === 'READY' ? 'ok' : record.status === 'FAILED' ? 'err' : 'neutral'}>{record.status}</Badge>
        <span>{record.trainingStep}</span></div>
      {record.error && <p className="mt-2 text-err">{record.error}</p>}
      {record.status === 'READY' && record.dataset && <>
        <p className="mt-2"><Link className="text-accent" href={`/datasets/${record.dataset.name}`}>{t('archiveDataset', { name: record.dataset.name, version: record.dataset.version })}</Link></p>
        <p className="mt-1 break-all font-mono">{t('archiveManifest', { hash: record.dataset.manifestHash })}</p>
        <p className="mt-1 text-fg-muted">{t('archiveDirectory', { count: record.directory?.fileCount ?? 0 })}</p>
        {!!record.reports?.length && <p className="mt-1">{t('archiveReportsList', { reports: record.reports.map(report => report.step).join(', ') })}</p>}
        {data.canArchive && <div className="mt-3 flex flex-wrap gap-2">
          <Input aria-label={t('archiveModelInput')} value={name} onChange={event => setName(event.target.value)} placeholder={t('archiveModelInput')} maxLength={120} />
          <Button disabled={busy} onClick={() => void register(record)}>{t('archiveModelButton')}</Button>
        </div>}
      </>}
      {canManage(record) && record.status === 'FAILED' && <Button className="mt-2" disabled={busy} onClick={() => void operation(record, 'POST')}>{t('archiveRetry')}</Button>}
      {canManage(record) && ['PENDING', 'ARCHIVING'].includes(record.status) && <Button className="mt-2" disabled={busy} onClick={() => void operation(record, 'DELETE')}>{t('archiveCancel')}</Button>}
    </div>)}</div>
    {registered && <Link className="mt-3 inline-block text-sm text-accent" href={`/models?model_id=${registered.id}`}>{t('archiveLink')}</Link>}
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
  const t = useT('pipelines');
  const tc = useT('common');
  const { fmtTime, ago, fmtDuration, fmtNum } = useFormat();
  const defaultMe = useMe();
  const searchParams = useSearchParams();
  const scope = searchParams.get('project') || defaultMe.data?.project?.id;
  const headers = scope ? { 'x-pai-project': scope } : undefined;
  const me = useApi<Me>(scope ? '/api/me' : null, { init: { headers } });
  const { data, isLoading, error } = useApi<ExecutionData>(
    scope ? `/api/pipelines/executions/${encodeURIComponent(arn)}` : null,
    { refetch: 10000, init: { headers } }
  );
  const [expandedStep, setExpandedStep] = React.useState<string | null>(null);
  const [expandedHyperparams, setExpandedHyperparams] = React.useState(false);
  const [stopPending, setStopPending] = React.useState(false);
  const [stopError, setStopError] = React.useState<Error>();
  const [stopAccepted, setStopAccepted] = React.useState(false);
  const [selectedTraining, setSelectedTraining] = React.useState('');
  React.useEffect(() => {
    setSelectedTraining(''); setExpandedStep(null); setExpandedHyperparams(false);
    setStopAccepted(false); setStopError(undefined);
  }, [arn, scope]);

  // SageMaker's step order is not a statement about which job trained the model.
  // Keep known steps selectable before a job ARN exists; never show smoke as fine-tuning.
  const trainingSteps = data?.steps.filter(step => step.Metadata?.TrainingJob ||
    ['GR00TFinetune', 'SmokeEval'].includes(step.StepName)) ?? [];
  const trainingStep = trainingSteps.find(step => step.StepName === selectedTraining) ??
    trainingSteps.find(step => step.StepName === 'GR00TFinetune') ??
    (trainingSteps.length === 1 ? trainingSteps[0] : undefined);
  const trainingJobName = trainingStep?.Metadata?.TrainingJob?.Arn.split('/').pop();

  const { data: jobData, error: jobError } = useApi<TrainingJobData>(
    scope && trainingJobName ? `/api/pipelines/training-jobs/${encodeURIComponent(trainingJobName)}` : null,
    { refetch: 10000, init: { headers } }
  );

  if (isLoading && !data) return <Spinner label={t('loadingExecution')} />;

  return (
    <>
      <PageHeader title={data?.execution.PipelineExecutionDisplayName ? t('executionPageTitle', { name: data.execution.PipelineExecutionDisplayName }) : t('loadingPipelines')}
        description={scope ? t('executionPageDescription', { projectName: me.data?.project?.name ?? scope, projectId: scope }) : undefined} />

      <ErrorBox error={me.error ?? defaultMe.error} />
      {error && <ErrorBox error={error} />}
      {jobError && <ErrorBox error={jobError} />}
      {stopError && <ErrorBox error={stopError} />}
      {data?.canStop && data.execution.PipelineExecutionStatus === 'Executing' && <div className="mb-4">
        <Button variant="danger" disabled={stopPending || stopAccepted} onClick={async () => {
          if (!window.confirm(t('stopPipelineConfirm'))) return;
          setStopPending(true); setStopError(undefined);
          try { await api(`/api/pipelines/executions/${encodeURIComponent(arn)}`, { method: 'DELETE', headers }); setStopAccepted(true); }
          catch (failure) { setStopError(failure as Error); }
          finally { setStopPending(false); }
        }}>{stopAccepted ? t('stopPipelineAccepted') : t('stopPipelineButton')}</Button>
      </div>}

      <div className="space-y-4">
        {data?.projectRecorded && scope && <PipelineArchivePanel key={`${scope}:${arn}`} arn={arn} data={data} projectId={scope} />}
        {/* Header */}
        {data?.execution && (
          <Card>
            <div className="mb-4 space-y-2 break-all text-xs">
              <p>{t('executionNote')}</p>
              {data.execution.PipelineArn && <p className="font-mono">{t('executionPipelineArn', { arn: data.execution.PipelineArn })}</p>}
              <p className="font-mono">{t('executionExecutionArn', { arn: data.execution.PipelineExecutionArn ?? arn })}</p>
              {data.execution.PipelineVersionId != null && <p>{t('executionVersionId', { version: data.execution.PipelineVersionId.toString() })}</p>}
            </div>
            <div className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
              <div>
                <span className="text-fg-muted">{t('executionStatus')}</span>
                <div className="mt-1">
                  <StatusPill status={data.execution.PipelineExecutionStatus} />
                </div>
              </div>
              <div>
                <span className="text-fg-muted">{t('executionCreatedTime')}</span>
                <div className="mt-1 font-mono text-xs">{fmtTime(data.execution.CreationTime)}</div>
              </div>
              <div>
                <span className="text-fg-muted">{t('executionLastModified')}</span>
                <div className="mt-1 font-mono text-xs">{ago(data.execution.LastModifiedTime)}</div>
              </div>
              {data.execution.FailureReason && (
                <div className="col-span-2 md:col-span-1">
                  <span className="text-fg-muted">{t('executionFailureReason')}</span>
                  <div className="mt-1 text-xs text-err">{data.execution.FailureReason}</div>
                </div>
              )}
            </div>

            {/* Parameters */}
            {data.parameters.length > 0 && (
              <div className="mt-4 pt-4 border-t border-border">
                <div className="text-sm font-medium">{t('executionParameters')}</div>
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
          <Card title={t('executionStepsTitle')}>
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
                      <span className="text-sm font-medium text-fg-muted">{t('executionStepName', { index: (idx + 1).toString(), name: step.StepName })}</span>
                      <StatusPill status={step.StepStatus} />
                      {step.StartTime && step.EndTime && (
                        <span className="ml-auto text-xs text-fg-muted">
                          {t('executionStepDuration', { duration: fmtDuration(
                            new Date(step.EndTime).getTime() -
                            new Date(step.StartTime).getTime()
                          ) })}
                        </span>
                      )}
                    </div>
                  </button>

                  {expandedStep === step.StepName && (
                    <div className="mt-3 ml-6 space-y-2 text-xs text-fg-muted">
                      {step.StartTime && (
                        <div>
                          {t('executionStepStarted', { time: fmtTime(step.StartTime) })}
                        </div>
                      )}
                      {step.EndTime && (
                        <div>
                          {t('executionStepEnded', { time: fmtTime(step.EndTime) })}
                        </div>
                      )}
                      {step.FailureReason && (
                        <div className="text-err">
                          {t('executionStepFailure', { reason: step.FailureReason })}
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
        {trainingSteps.length > 0 && <Card title={t('trainingJobSelectionTitle')}>
          <Field label={t('trainingJobSelectionLabel')}>
            <Select aria-label={t('trainingJobSelectionLabel')} value={trainingStep?.StepName ?? ''} onChange={event => { setSelectedTraining(event.target.value); setExpandedHyperparams(false); }}>
              <option value="" disabled>{t('trainingJobSelectionEmpty')}</option>
              {trainingSteps.map(step => <option key={step.StepName} value={step.StepName}>
                {step.StepName}{step.StepName === 'GR00TFinetune' ? t('trainingJobSelectionFineTune') : step.StepName === 'SmokeEval' ? t('trainingJobSelectionSmoke') : ''}
              </option>)}
            </Select>
          </Field>
          {trainingStep && !trainingJobName && <p className="mt-2 text-xs text-fg-muted">{t('trainingJobSelectionNote', { name: trainingStep.StepName })}</p>}
        </Card>}
        {jobData?.job && (
          <Card title={t('trainingJobTitle', { step: trainingStep?.StepName ?? '' })} description={trainingJobName ? t('trainingJobName', { name: trainingJobName }) : undefined}>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
                <div>
                  <span className="text-fg-muted">{t('trainingJobStatus')}</span>
                  <div className="mt-1">
                    <StatusPill status={jobData.job.TrainingJobStatus} />
                  </div>
                </div>
                {jobData.job.SecondaryStatus && (
                  <div>
                    <span className="text-fg-muted">{t('trainingJobSecondaryStatus')}</span>
                    <div className="mt-1 text-xs font-mono">{jobData.job.SecondaryStatus}</div>
                  </div>
                )}
                {jobData.job.ResourceConfig && (
                  <>
                    <div>
                      <span className="text-fg-muted">{t('trainingJobInstanceType')}</span>
                      <div className="mt-1 text-xs font-mono">{jobData.job.ResourceConfig.InstanceType}</div>
                    </div>
                    <div>
                      <span className="text-fg-muted">{t('trainingJobInstanceCount')}</span>
                      <div className="mt-1 text-xs font-mono">{jobData.job.ResourceConfig.InstanceCount}</div>
                    </div>
                  </>
                )}
                {jobData.job.BillableTimeInSeconds && (
                  <div>
                    <span className="text-fg-muted">{t('trainingJobBillableTime')}</span>
                    <div className="mt-1 text-xs">{fmtDuration(jobData.job.BillableTimeInSeconds * 1000)}</div>
                  </div>
                )}
              </div>

              {/* Final Metrics */}
              {jobData.job.FinalMetricDataList && jobData.job.FinalMetricDataList.length > 0 && (
                <div>
                  <div className="text-sm font-medium">Final Metrics</div>
                  <Table
                    head={[tc('name'), tc('value')]}
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
                  <div className="text-sm font-medium">{t('trainingJobModelArtifacts')}</div>
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
                    {expandedHyperparams ? '▼' : '▶'} {t('trainingJobHyperparameters')}
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
                  <div className="text-sm font-medium">{t('trainingJobLogs')}</div>
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
              <Button variant="secondary">{t('openMlflowButton')}</Button>
            </Link>
          </div>
        </Card>
      </div>
    </>
  );
}
