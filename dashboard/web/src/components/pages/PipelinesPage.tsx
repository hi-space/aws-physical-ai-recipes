'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { PageHeader } from '@/components/layout/PageHeader';
import { ResourceStrip } from '@/components/layout/ResourceStrip';
import { Badge, Button, Card, Dialog, EmptyState, ErrorBox, Input, Spinner, StatusPill, Table, Toast } from '@/components/ui';
import { useT, useFormat } from '@/lib/i18n';
import { api, ApiError, useApi, useMe, can, type Me } from '@/lib/api-client';
import {
  clearPipelineDraft, createPipelineDraft, invalidPipelineNumbers, isPersistableParameter,
  pipelineExecutionHref, readPipelineDraft, releaseRejectedPipelineDraft, savePipelineDraft, type PipelineDraft, type PipelineParameter,
} from './pipeline-draft';

interface Pipeline {
  PipelineName: string;
  PipelineArn: string;
  PipelineStatus: string;
  CreationTime: string;
  LastModifiedTime: string;
  RoleArn?: string;
  PipelineVersionDisplayName?: string;
  PipelineVersionDescription?: string;
  parameters: PipelineParameter[];
  projectTrackingSupported?: boolean;
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
  const t = useT('pipelines');
  const tr = useT('resources');
  const tc = useT('common');
  const { fmtTime, ago } = useFormat();
  const defaultMe = useMe();
  const router = useRouter();
  const [draft, setDraft] = React.useState<PipelineDraft>();
  const [restored, setRestored] = React.useState(false);
  const [restoreError, setRestoreError] = React.useState<Error>();
  const [draftError, setDraftError] = React.useState<Error>();
  React.useEffect(() => {
    try { setDraft(readPipelineDraft()); } catch (failure) { setRestoreError(failure as Error); }
    setRestored(true);
  }, []);
  const project = draft?.project ?? defaultMe.data?.project;
  const scope = restored ? project?.id : undefined;
  const headers = scope ? { 'x-pai-project': scope } : undefined;
  const me = useApi<Me>(scope ? '/api/me' : null, { init: { headers } });
  const { data, isLoading, error, refetch } = useApi<PipelinesData>(scope ? '/api/pipelines' : null, { refetch: 10000, init: { headers } });
  const [showDialog, setShowDialog] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const inFlight = React.useRef(false);
  const [toast, setToast] = React.useState<{ message: string; tone: 'ok' | 'err' } | null>(null);
  const unsupported = data?.pipeline.parameters.some(parameter => !isPersistableParameter(parameter));
  const invalidNumbers = draft ? invalidPipelineNumbers(draft) : [];
  const owner = me.data?.subject ?? me.data?.user;
  const ownerMatches = !draft || draft.owner === owner;
  const canStart = can(me.data, 'researcher') && me.data?.project?.id === scope &&
    ['researcher', 'project-admin'].includes(me.data?.project?.role ?? '');
  const locked = Boolean(draft?.requestId);

  function openDialog() {
    if (!draft && data && project && owner && !unsupported && !restoreError) {
      const initial = createPipelineDraft(owner, project, data.pipeline.PipelineArn, data.pipeline.parameters);
      setDraft(initial);
      try { savePipelineDraft(initial); setDraftError(undefined); }
      catch (failure) { setDraftError(failure as Error); }
    }
    setShowDialog(true);
  }
  function editDraft(payload: PipelineDraft['payload']) {
    if (!draft || locked || !ownerMatches) return;
    const updated = { ...draft, payload };
    setDraft(updated);
    try { savePipelineDraft(updated); setDraftError(undefined); }
    catch (failure) { setDraftError(failure as Error); }
  }
  function discardDraft() {
    if (locked || inFlight.current) return;
    try {
      if (!clearPipelineDraft()) return;
      setDraft(undefined); setShowDialog(false); setDraftError(undefined);
    } catch (failure) { setDraftError(failure as Error); setShowDialog(true); }
  }

  const handleStartExecution = async () => {
    if (!draft || inFlight.current || !canStart || !ownerMatches || restoreError || invalidNumbers.length ||
      (!locked && (unsupported || draft.pipelineArn !== data?.pipeline.PipelineArn))) return;
    inFlight.current = true; setPending(true); setDraftError(undefined);
    let attempted: PipelineDraft | undefined;
    try {
      // Write before POST, including on retry. Close/reload must never lose an in-flight identity.
      attempted = draft.requestId ? draft : { ...draft, requestId: crypto.randomUUID() };
      savePipelineDraft(attempted);
      setDraft(attempted);
      const result = await api<{ arn?: string }>('/api/pipelines/executions', {
        method: 'POST', json: { ...attempted.payload, expectedPipelineArn: attempted.pipelineArn, expectedOwnerSubject: attempted.owner },
        headers: { 'x-pai-project': attempted.project.id, 'idempotency-key': attempted.requestId! },
      });
      if (typeof result?.arn !== 'string' || !result.arn.startsWith(`${attempted.pipelineArn}/execution/`) ||
        !/\/execution\/[A-Za-z0-9-]+$/.test(result.arn)) {
        throw new Error(t('executionArnInvalid'));
      }
      if (!clearPipelineDraft(attempted.requestId!)) return;
      setShowDialog(false);
      setDraft(undefined);
      setToast({ message: t('toastSubmitted'), tone: 'ok' });
      void refetch();
      router.push(pipelineExecutionHref(result.arn, attempted.project.id));
    } catch (e) {
      const details = e instanceof ApiError ? e.details as {
        submissionState?: string; requestId?: string; projectId?: string; ownerSubject?: string;
      } | undefined : undefined;
      if (attempted && e instanceof ApiError && e.status === 400 && e.code === 'pipeline_not_submitted' &&
        details?.submissionState === 'not_submitted' && details.requestId === attempted.requestId &&
        details.projectId === attempted.project.id && details.ownerSubject === attempted.owner) {
        try {
          const editable = releaseRejectedPipelineDraft(attempted);
          if (editable) {
            setDraft(editable);
            setDraftError(new Error(`${e.message} ${t('executionDraftRejected')}`));
          }
        } catch (failure) { setDraftError(failure as Error); }
        return;
      }
      setDraftError(e as Error);
    } finally { inFlight.current = false; setPending(false); }
  };

  if (!restored || defaultMe.isLoading || (isLoading && !data)) return <Spinner label={t('loadingPipelines')} />;

  const res = me.data?.resources ?? defaultMe.data?.resources;
  return (
    <>
      <PageHeader title={t('title')} description={project ? t('description', { projectName: project.name, projectId: project.id }) : undefined} />
      <ResourceStrip
        source={t('resourceSource')}
        items={[
          { label: tr('pipeline'), value: res?.pipeline?.name },
          { label: tr('pipelineRole'), value: res?.pipeline?.roleArn },
          { label: tr('trainingLogGroup'), value: res?.pipeline?.trainingLogGroup, console: res?.pipeline?.trainingLogGroup ? { kind: 'log-group', name: res.pipeline.trainingLogGroup } : undefined },
          { label: tr('trainingImage'), value: res?.pipeline?.trainingImageUri },
        ]}
      />
      <ErrorBox error={restoreError ?? error ?? me.error ?? defaultMe.error} />
      {!project && <EmptyState title={t('selectProject')} />}
      {data?.pipeline.projectTrackingSupported === false && <p className="mb-4 rounded border border-border p-3 text-xs text-warn">
        {t('noProjectTracking')}
      </p>}

      <div className="space-y-4">
        {/* Start button */}
        {can(me.data, 'researcher') && (data?.pipeline || draft) && (
          <div>
            <Button disabled={!!restoreError} onClick={openDialog}>{t('startExecution')}</Button>
          </div>
        )}
        {draft && !locked && <div>
          <Button variant="secondary" disabled={pending} onClick={discardDraft}>{t('discardDraft')}</Button>
          <p className="mt-1 text-xs text-fg-muted">{t('discardDraftNote')}</p>
        </div>}

        {/* Pipeline description */}
        {data?.pipeline && (
          <Card title={data.pipeline.PipelineName}>
            <div className="space-y-3">
              <p className="text-sm text-fg-muted">{t('pipelineDesc')}</p>
              <dl className="space-y-1 break-all text-xs">
                <dt className="text-fg-muted">{t('pipelineArn')}</dt><dd className="font-mono">{data.pipeline.PipelineArn}</dd>
                {data.pipeline.RoleArn && <><dt className="text-fg-muted">{t('executionRole')}</dt><dd className="font-mono">{data.pipeline.RoleArn}</dd></>}
                {data.pipeline.PipelineVersionDisplayName && <><dt className="text-fg-muted">{t('versionName')}</dt><dd>{data.pipeline.PipelineVersionDisplayName}</dd></>}
                {data.pipeline.PipelineVersionDescription && <><dt className="text-fg-muted">{t('versionDesc')}</dt><dd>{data.pipeline.PipelineVersionDescription}</dd></>}
                <dt className="text-fg-muted">{t('lastModified')}</dt><dd>{fmtTime(data.pipeline.LastModifiedTime)}</dd>
              </dl>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-fg-muted">{t('status')}</span>
                  <div className="mt-1">
                    <StatusPill status={data.pipeline.PipelineStatus} />
                  </div>
                </div>
                <div>
                  <span className="text-fg-muted">{t('created')}</span>
                  <div className="mt-1 font-mono text-xs">{fmtTime(data.pipeline.CreationTime)}</div>
                </div>
              </div>
              {data.pipeline.parameters.length > 0 && (
                <div>
                  <div className="text-sm font-medium">{t('parametersSection')}</div>
                  <div className="mt-2 space-y-2">
                    {data.pipeline.parameters.map((p) => (
                      <div key={p.Name} className="flex items-center gap-3 rounded bg-bg-elev-2 p-2">
                        <span className="text-sm font-mono text-fg-muted">{p.Name}</span>
                        {isPersistableParameter(p) && p.DefaultValue != null && (
                          <Badge tone="info">{t('defaultValue', { value: String(p.DefaultValue) })}</Badge>
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
        <Card title={t('executionList')} description={t('executionCount', { count: data?.executions.length ?? 0 })}>
          {!data?.executions.length ? (
            !error && <EmptyState title={t('noExecutions')} />
          ) : (
            <Table
              head={[tc('name'), tc('status'), tc('started'), tc('reason')]}
              dense
            >
              {data.executions.map((exec) => (
                <tr
                  key={exec.PipelineExecutionArn}
                  onClick={() => scope && router.push(pipelineExecutionHref(exec.PipelineExecutionArn, scope))}
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
        <Card title={t('stepsTitle')}>
          <div className="space-y-2 text-sm text-fg-muted">
            <div className="flex items-start gap-2">
              <span className="text-accent">1.</span>
              <span>{t('step1')}</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-accent">2.</span>
              <span>{t('step2')}</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-accent">3.</span>
              <span>{t('step3')}</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-accent">4.</span>
              <span>{t('step4')}</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-accent">5.</span>
              <span>{t('step5')}</span>
            </div>
          </div>
        </Card>
      </div>

      {/* Start Execution Dialog */}
      <Dialog
        title={t('dialogTitle')}
        open={showDialog}
        onClose={() => setShowDialog(false)}
        footer={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setShowDialog(false)}>
              {t('dialogCancelButton')}
            </Button>
            <Button onClick={handleStartExecution} disabled={pending || !draft || !canStart || !ownerMatches || !!restoreError ||
              invalidNumbers.length > 0 || (!locked && (!!unsupported || draft?.pipelineArn !== data?.pipeline.PipelineArn))}>
              {locked ? t('dialogRetryButton') : t('dialogSubmitButton')}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <p className="text-sm">{t('dialogProject', { projectName: project?.name ?? '', projectId: scope ?? '' })}</p>
          <ErrorBox error={draftError} />
          {!ownerMatches && <p role="alert" className="text-sm text-warn">{t('dialogOwnerMismatch')}</p>}
          {unsupported && !locked && <p role="alert" className="text-sm text-warn">{t('dialogUnsupportedParameters')}</p>}
          {draft && !locked && data && draft.pipelineArn !== data.pipeline.PipelineArn &&
            <p role="alert" className="text-sm text-warn">{t('dialogPipelineChanged')}</p>}
          {locked && <p role="status" className="text-sm text-warn">{t('dialogLocked')}</p>}
          {invalidNumbers.length > 0 && <p role="alert" className="text-sm text-err">{t('dialogInvalidNumbers', { params: invalidNumbers.join(', ') })}</p>}
          <div className="rounded-lg bg-bg-elev-2 p-3 text-sm">
            <p className="mb-2 text-fg-muted">{t('dialogQuickValidation')}</p>
            <Button variant="secondary" disabled={!draft || locked || !ownerMatches} onClick={() => {
              if (!draft) return;
              const preset: Record<string, string> = { MaxSteps: '100', GlobalBatchSize: '4', SaveSteps: '50' };
              editDraft({ ...draft.payload, parameters: { ...draft.payload.parameters,
                ...Object.fromEntries(Object.entries(preset).filter(([name]) => draft.fields.some(parameter => parameter.Name === name))),
              } });
            }}>{t('dialogQuickButton')}</Button>
          </div>
          <div>
            <label className="text-sm font-medium">{t('dialogDisplayName')}</label>
            <Input
              aria-label={t('dialogDisplayNameAriaLabel')}
              disabled={!draft || locked || !ownerMatches}
              value={draft?.payload.displayName ?? ''}
              onChange={(e) => draft && editDraft({ ...draft.payload, displayName: e.target.value || undefined })}
              placeholder={t('dialogDisplayNamePlaceholder')}
              className="mt-1"
            />
          </div>

          {draft?.fields.map((p) => (
            <div key={p.Name}>
              <label htmlFor={`pipeline-${p.Name}`} className="text-sm font-medium">{p.Name}</label>
              <Input
                id={`pipeline-${p.Name}`}
                type={p.Type === 'Integer' || p.Type === 'Float' ? 'number' : 'text'}
                step={p.Type === 'Float' ? 'any' : undefined}
                value={draft.payload.parameters[p.Name]}
                disabled={locked || !ownerMatches}
                aria-invalid={invalidNumbers.includes(p.Name)}
                onChange={(e) => editDraft({ ...draft.payload, parameters: { ...draft.payload.parameters, [p.Name]: e.target.value } })}
                className="mt-1"
              />
            </div>
          ))}
        </div>
      </Dialog>

      {toast && <Toast message={toast.message} tone={toast.tone} onClose={() => setToast(null)} />}
    </>
  );
}
