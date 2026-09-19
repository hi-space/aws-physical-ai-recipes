'use client';
import * as React from 'react';
import { ArrowRight, Package } from 'lucide-react';
import { Badge, Button, EmptyState, StatusPill, TechnicalDetails } from '@/components/ui';
import { useFormat, useT } from '@/lib/i18n';
import type { Task } from '@/server/store/types';
import type { ResourceSpec, TaskSpec } from '@/server/workflow/schema';

export interface TaskDetailPanelProps {
  taskSpec?: TaskSpec;
  task?: Task;
  resource?: ResourceSpec;
  stepIndex: number;
  stepCount: number;
  onSelectTask?: (name: string) => void;
  onOpenTab?: (tab: 'logs' | 'outputs') => void;
}

function Section({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-fg-faint">{title}</h4>
      {children}
    </section>
  );
}

function Row({ k, v, mono }: { k: React.ReactNode; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="shrink-0 text-fg-muted">{k}</span>
      <span className={`min-w-0 truncate text-right text-fg ${mono ? 'mono' : ''}`} title={typeof v === 'string' ? v : undefined}>{v}</span>
    </div>
  );
}

/** Everything the dashboard knows about one step, laid out for scanning: status first, then time, run, resource, data. */
export function TaskDetailPanel({ taskSpec, task, resource, stepIndex, stepCount, onSelectTask, onOpenTab }: TaskDetailPanelProps) {
  const t = useT('dag');
  const { fmtTime, fmtDuration } = useFormat();

  if (!taskSpec) {
    return (
      <div className="flex h-full min-h-48 items-center justify-center rounded-lg border border-dashed border-border p-4">
        <EmptyState title={t('panelEmptyTitle')} hint={t('panelEmptyHint')} />
      </div>
    );
  }

  const started = task?.startedAt ? new Date(task.startedAt) : undefined;
  const finished = task?.finishedAt ? new Date(task.finishedAt) : undefined;
  const duration = started ? fmtDuration((finished ?? new Date()).getTime() - started.getTime()) : undefined;
  const dash = t('empty');
  const published = task?.publishedVersions ?? [];
  const plannedDatasets = taskSpec.outputs.flatMap((o) => ('dataset' in o ? [o.dataset] : []));
  const logOutputs = taskSpec.outputs.flatMap((o) => ('logs' in o ? [o.logs] : []));

  return (
    <div className="flex h-full flex-col gap-4 rounded-lg border border-border bg-bg-elev p-4" aria-live="polite">
      <header className="space-y-1">
        <div className="text-[11px] text-fg-faint">{t('stepOf', { index: stepIndex + 1, total: stepCount })}</div>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base font-semibold text-fg">{taskSpec.name}</h3>
          <StatusPill status={task?.phase ?? 'WAITING'} />
          {taskSpec.group && <Badge tone="neutral">{t('group')} · {taskSpec.group}</Badge>}
        </div>
        {task?.message && <p className="text-xs leading-relaxed text-fg-muted">{task.message}</p>}
      </header>

      {(task?.failureReason || (task?.exitCode !== undefined && task.exitCode !== 0)) && (
        <div className="rounded-md border border-err/40 bg-err/10 p-2 text-xs">
          {task.failureReason && <Row k={t('failureReason')} v={task.failureReason} />}
          {task.exitCode !== undefined && task.exitCode !== 0 && <Row k={t('exitCode')} v={String(task.exitCode)} mono />}
        </div>
      )}

      <Section title={t('sectionTiming')}>
        <Row k={t('queued')} v={task?.queuedAt ? fmtTime(new Date(task.queuedAt)) : dash} />
        <Row k={t('started')} v={started ? fmtTime(started) : t('notStarted')} />
        <Row k={t('finished')} v={finished ? fmtTime(finished) : dash} />
        <Row k={t('duration')} v={duration ?? dash} />
      </Section>

      <Section title={t('sectionRun')}>
        <Row k={t('attempts')} v={String(task?.attempts ?? 0)} />
        <Row k={t('replicas')} v={String(task?.replicas ?? taskSpec.parallelism)} />
        {task?.exitCode === 0 && <Row k={t('exitCode')} v="0" mono />}
      </Section>

      <Section title={t('sectionResource')}>
        <div className="flex flex-wrap gap-1">
          <Badge tone="neutral">{taskSpec.resource}</Badge>
          {resource?.gpu ? <Badge tone="accent">{t('nodeGpu', { count: resource.gpu })}</Badge> : null}
          {resource?.cpu ? <Badge tone="neutral">{t('nodeCpu', { count: resource.cpu })}</Badge> : null}
          {resource?.memory && <Badge tone="neutral">{t('memory')} {resource.memory}</Badge>}
          {resource?.platform && <Badge tone="neutral">{resource.platform}</Badge>}
        </div>
      </Section>

      <Section title={t('sectionInputs')}>
        {taskSpec.inputs.length === 0 ? (
          <p className="text-xs text-fg-faint">{t('noInputs')}</p>
        ) : (
          <ul className="space-y-1">
            {taskSpec.inputs.map((input, i) =>
              'task' in input ? (
                <li key={i}>
                  <button type="button" onClick={() => onSelectTask?.(input.task)} aria-label={t('selectUpstream', { name: input.task })}
                    className="flex w-full items-center gap-2 rounded-md border border-border px-2 py-1 text-left text-xs hover:border-accent">
                    <ArrowRight size={12} className="shrink-0 text-accent" aria-hidden />
                    <span className="text-fg-muted">{t('upstreamTask')}</span>
                    <span className="font-medium text-fg">{input.task}</span>
                  </button>
                </li>
              ) : (
                <li key={i} className="flex items-center gap-2 rounded-md border border-dashed border-border px-2 py-1 text-xs">
                  <Package size={12} className="shrink-0 text-[#a78bfa]" aria-hidden />
                  <span className="text-fg-muted">{t('datasetInput')}</span>
                  <a className="truncate font-medium text-accent hover:underline" href={`/datasets/${encodeURIComponent(input.dataset.name)}`}>{input.dataset.name}</a>
                  <span className="ml-auto text-fg-faint">{input.dataset.version === 'latest' || input.dataset.version === undefined ? t('datasetLatest') : t('datasetVersion', { version: input.dataset.version })}</span>
                </li>
              ),
            )}
          </ul>
        )}
      </Section>

      <Section title={t('sectionOutputs')}>
        {published.length === 0 && plannedDatasets.length === 0 ? (
          <p className="text-xs text-fg-faint">{t('noOutputs')}</p>
        ) : (
          <ul className="space-y-1">
            {published.map((v) => (
              <li key={`${v.dataset}-${v.version}`} className="flex items-center gap-2 rounded-md border border-border px-2 py-1 text-xs">
                <Package size={12} className="shrink-0 text-ok" aria-hidden />
                <a className="truncate font-medium text-accent hover:underline" href={`/datasets/${encodeURIComponent(v.dataset)}`}>{v.dataset}</a>
                <span className="ml-auto shrink-0 text-fg-faint">{t('datasetVersion', { version: v.version })} · {t('publishedVersion')}</span>
              </li>
            ))}
            {published.length === 0 && plannedDatasets.map((d, i) => (
              <li key={i} className="flex items-center gap-2 rounded-md border border-dashed border-border px-2 py-1 text-xs">
                <Package size={12} className="shrink-0 text-fg-faint" aria-hidden />
                <span className="truncate font-medium text-fg" title={d.path}>{d.name}</span>
                <span className="ml-auto shrink-0 text-fg-faint">{t('plannedOutput')}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <TechnicalDetails
        rows={[
          { label: t('jobName'), value: task?.jobName, copy: true, mono: true },
          { label: t('image'), value: taskSpec.image, copy: true, mono: true },
          ...logOutputs.map((path) => ({ label: t('logsOutput'), value: path, mono: true })),
          { label: t('outputPath'), value: task?.outputPath, copy: true, mono: true },
        ]}
        defaultOpen={false}
      />

      {onOpenTab && (
        <div className="mt-auto flex gap-2 pt-1">
          <Button size="sm" onClick={() => onOpenTab('logs')}>{t('openLogs')}</Button>
          <Button size="sm" variant="ghost" onClick={() => onOpenTab('outputs')}>{t('openArtifacts')}</Button>
        </div>
      )}
    </div>
  );
}
