'use client';
import * as React from 'react';
import { Background, Controls, MarkerType, Panel, ReactFlow, ReactFlowProvider, useReactFlow, type Node, type NodeMouseHandler } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { statusLabel } from '@/components/ui';
import { useFormat, useT } from '@/lib/i18n';
import type { Task, TaskPhase } from '@/server/store/types';
import type { WorkflowSpec } from '@/server/workflow/schema';
import { DAG_EDGE_TYPES, EDGE_COLORS, type DagEdgeType } from './DagEdge';
import { DAG_NODE_TYPES, type DatasetNode, type TaskNode } from './DagNode';
import { TaskDetailPanel } from './TaskDetailPanel';
import { layoutDag, relatedNodes } from './dag-layout';
import { PHASE_HEX } from './utils';

export interface DagViewProps {
  spec: WorkflowSpec;
  tasks: Task[];
  selectedTask?: string;
  onSelectTask?: (name: string) => void;
  /** Lets the detail panel jump to the logs or artifacts tab for the selected step. */
  onOpenTab?: (tab: 'logs' | 'outputs') => void;
}

const ACTIVE_PHASES = new Set<TaskPhase>(['LAUNCHING', 'INITIALIZING', 'RUNNING', 'FINALIZING', 'CANCELLING']);
const LEGEND_PHASES: TaskPhase[] = ['WAITING', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED'];

/** React Flow hooks (useReactFlow) need a provider above the component that calls them. */
export function DagView(props: DagViewProps) {
  return (
    <ReactFlowProvider>
      <DagViewInner {...props} />
    </ReactFlowProvider>
  );
}

function DagViewInner({ spec, tasks, selectedTask, onSelectTask, onOpenTab }: DagViewProps) {
  const t = useT('dag');
  const tc = useT('common');
  const { fmtDuration } = useFormat();
  const { fitView } = useReactFlow();

  const layout = React.useMemo(() => layoutDag(spec), [spec]);
  const runtime = React.useMemo(() => new Map(tasks.map((task) => [task.name, task])), [tasks]);
  const specs = React.useMemo(() => new Map(spec.workflow.tasks.map((task) => [task.name, task])), [spec]);
  const related = React.useMemo(() => relatedNodes(layout, selectedTask), [layout, selectedTask]);
  const phaseLabel = React.useCallback((phase?: TaskPhase) => (phase ? statusLabel(tc, phase) : t('notStarted')), [t, tc]);

  const nodes = React.useMemo<Array<TaskNode | DatasetNode>>(() => layout.nodes.map((n) => {
    const dimmed = related.size > 0 && !related.has(n.id);
    if (n.kind === 'dataset') {
      return {
        id: n.id, type: 'dataset', position: { x: n.x, y: n.y - n.height / 2 }, width: n.width, height: n.height, draggable: false, selectable: false,
        data: { name: n.label, version: n.datasetVersion, dimmed, related: related.has(n.id) },
      } satisfies DatasetNode;
    }
    const task = runtime.get(n.id);
    const taskSpec = specs.get(n.id);
    const resource = taskSpec ? spec.workflow.resources[taskSpec.resource] : undefined;
    const started = task?.startedAt ? new Date(task.startedAt).getTime() : undefined;
    const finished = task?.finishedAt ? new Date(task.finishedAt).getTime() : Date.now();
    return {
      id: n.id, type: 'task', position: { x: n.x, y: n.y - n.height / 2 }, width: n.width, height: n.height, draggable: false, selectable: false,
      data: {
        name: n.label, index: layout.steps.indexOf(n.id), phase: task?.phase, phaseLabel: phaseLabel(task?.phase),
        duration: started ? fmtDuration(finished - started) : undefined, attempts: task?.attempts, parallelism: taskSpec?.parallelism ?? 1,
        gpu: resource?.gpu, cpu: resource?.cpu, selected: selectedTask === n.id, dimmed, active: task ? ACTIVE_PHASES.has(task.phase) : false,
      },
    } satisfies TaskNode;
  }), [layout, related, runtime, specs, spec, selectedTask, phaseLabel, fmtDuration]);

  const edges = React.useMemo<DagEdgeType[]>(() => layout.edges.map((e) => {
    const highlighted = e.source === selectedTask || e.target === selectedTask;
    const target = runtime.get(e.target);
    return {
      id: e.id, source: e.source, target: e.target, type: 'dag',
      data: { kind: e.kind, arcY: e.arcY, highlighted, dimmed: related.size > 0 && !highlighted, active: target ? ACTIVE_PHASES.has(target.phase) : false },
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: highlighted ? EDGE_COLORS.highlight : EDGE_COLORS[e.kind] },
    };
  }), [layout, related, runtime, selectedTask]);

  React.useEffect(() => {
    const id = window.setTimeout(() => fitView({ padding: 0.2, duration: 250 }), 30);
    return () => window.clearTimeout(id);
  }, [layout, fitView]);

  const onNodeClick = React.useCallback<NodeMouseHandler<Node>>((_event, node) => {
    if (node.type === 'task') onSelectTask?.(node.id);
  }, [onSelectTask]);

  const stepIndex = selectedTask ? layout.steps.indexOf(selectedTask) : -1;
  const move = React.useCallback((delta: number) => {
    if (!layout.steps.length) return;
    const next = stepIndex < 0 ? (delta > 0 ? 0 : layout.steps.length - 1) : Math.min(layout.steps.length - 1, Math.max(0, stepIndex + delta));
    onSelectTask?.(layout.steps[next]);
  }, [layout.steps, stepIndex, onSelectTask]);
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowRight') { event.preventDefault(); move(1); }
    if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1); }
  };

  if (layout.steps.length === 0) return <p className="text-sm text-fg-muted">{t('noTasks')}</p>;

  const selectedSpec = selectedTask ? specs.get(selectedTask) : undefined;
  const selectedRuntime = selectedTask ? runtime.get(selectedTask) : undefined;

  return (
    <div className="space-y-3">
      <nav aria-label={t('stepsLabel')} className="flex items-center gap-2">
        <button type="button" onClick={() => move(-1)} disabled={stepIndex <= 0} aria-label={t('prevStep')} className="rounded-md border border-border p-1 text-fg-muted hover:border-border-strong hover:text-fg disabled:opacity-40">
          <ChevronLeft size={16} />
        </button>
        <ol className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1">
          {layout.steps.map((name, index) => {
            const task = runtime.get(name);
            const color = task ? PHASE_HEX[task.phase] : PHASE_HEX.WAITING;
            const selected = selectedTask === name;
            return (
              <li key={name} className="flex items-center">
                {index > 0 && <span className="mx-1 h-px w-4 shrink-0 bg-border-strong" aria-hidden />}
                <button type="button" onClick={() => onSelectTask?.(name)} aria-current={selected ? 'step' : undefined}
                  className={`flex items-center gap-2 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs transition-colors ${selected ? 'border-accent bg-accent/10 text-fg' : 'border-border text-fg-muted hover:border-border-strong hover:text-fg'}`}>
                  <span className="flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-semibold text-white" style={{ background: color }}>{index + 1}</span>
                  <span className="font-medium">{name}</span>
                  <span className={`h-1.5 w-1.5 rounded-full ${task && ACTIVE_PHASES.has(task.phase) ? 'pulse' : ''}`} style={{ background: color }} aria-label={phaseLabel(task?.phase)} />
                </button>
              </li>
            );
          })}
        </ol>
        <button type="button" onClick={() => move(1)} disabled={stepIndex >= layout.steps.length - 1} aria-label={t('nextStep')} className="rounded-md border border-border p-1 text-fg-muted hover:border-border-strong hover:text-fg disabled:opacity-40">
          <ChevronRight size={16} />
        </button>
      </nav>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div role="group" aria-label={t('graphLabel')} tabIndex={0} onKeyDown={onKeyDown} className="h-full min-h-[380px] overflow-hidden rounded-lg border border-border bg-bg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={DAG_NODE_TYPES}
            edgeTypes={DAG_EDGE_TYPES}
            onNodeClick={onNodeClick}
            colorMode="dark"
            fitView
            fitViewOptions={{ padding: 0.2 }}
            minZoom={0.3}
            maxZoom={1.6}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            panOnScroll
            zoomOnDoubleClick={false}
            proOptions={{ hideAttribution: false }}
          >
            <Background color="#232b3b" gap={20} size={1} />
            <Controls showInteractive={false} position="top-right" />
            <Panel position="bottom-left" className="!m-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-bg-elev/90 px-2 py-1 text-[10px] text-fg-muted" aria-label={t('legendTitle')}>
              {LEGEND_PHASES.map((phase) => (
                <span key={phase} className="inline-flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full" style={{ background: PHASE_HEX[phase] }} />{phaseLabel(phase)}</span>
              ))}
              <span className="inline-flex items-center gap-1"><span className="inline-block h-0.5 w-4" style={{ background: EDGE_COLORS.task }} />{t('legendTaskEdge')}</span>
              <span className="inline-flex items-center gap-1"><span className="inline-block h-0 w-4 border-t border-dashed" style={{ borderColor: EDGE_COLORS.dataset }} />{t('legendDatasetEdge')}</span>
            </Panel>
          </ReactFlow>
        </div>
        <TaskDetailPanel
          taskSpec={selectedSpec}
          task={selectedRuntime}
          resource={selectedSpec ? spec.workflow.resources[selectedSpec.resource] : undefined}
          stepIndex={stepIndex}
          stepCount={layout.steps.length}
          onSelectTask={onSelectTask}
          onOpenTab={onOpenTab}
        />
      </div>
    </div>
  );
}
