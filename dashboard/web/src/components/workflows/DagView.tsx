'use client';
import React, { useCallback, useMemo } from 'react';
import { ReactFlow, ReactFlowProvider, Background, Controls, useReactFlow, useNodesState, useEdgesState, type Node, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { Task, TaskPhase } from '@/server/store/types';
import type { WorkflowSpec } from '@/server/workflow/schema';
import { PHASE_HEX } from './utils';

interface DagViewProps {
  spec: WorkflowSpec;
  tasks: Task[];
  selectedTask?: string;
  onSelectTask?: (name: string) => void;
}

/** React Flow hooks (useReactFlow) need a provider above the component that calls them. */
export function DagView(props: DagViewProps) {
  return (
    <ReactFlowProvider>
      <DagViewInner {...props} />
    </ReactFlowProvider>
  );
}

function DagViewInner({ spec, tasks, selectedTask, onSelectTask }: DagViewProps) {
  const taskMap = new Map(tasks.map((t) => [t.name, t]));
  const byName = new Map(spec.workflow.tasks.map((t) => [t.name, t]));

  // Build nodes and edges
  const { nodes: initialNodes, edges: initialEdges } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const positions = computeLayout(spec);

    // Task nodes
    for (const task of spec.workflow.tasks) {
      const pos = positions.get(task.name) || { x: 0, y: 0 };
      const runtimeTask = taskMap.get(task.name);
      const phaseColor = runtimeTask ? PHASE_HEX[runtimeTask.phase] : '#475569';

      nodes.push({
        id: task.name,
        data: { label: `${task.name}${runtimeTask?.phase ? ` · ${runtimeTask.phase.toLowerCase()}` : ''}`, phase: runtimeTask?.phase },
        position: pos,
        style: {
          background: phaseColor,
          border: selectedTask === task.name ? '2px solid #3b82f6' : '1px solid rgba(0,0,0,0.2)',
          borderRadius: '6px',
          padding: '8px 12px',
          fontSize: '12px',
          color: '#fff',
          fontWeight: 500,
          width: 120,
          textAlign: 'center',
          cursor: 'pointer',
        },
        draggable: false,
      });

      // Input edges from task dependencies
      for (const input of task.inputs) {
        if ('task' in input) {
          edges.push({
            id: `${input.task}-${task.name}`,
            source: input.task,
            target: task.name,
            style: { stroke: '#60a5fa', strokeWidth: 2 },
          });
        } else if ('dataset' in input) {
          const datasetId = `dataset-${input.dataset.name}`;
          if (!nodes.some((n) => n.id === datasetId)) {
            const dataPos = {
              x: (positions.get(task.name)?.x || 0) - 150,
              y: (positions.get(task.name)?.y || 0),
            };
            nodes.push({
              id: datasetId,
              data: { label: input.dataset.name },
              position: dataPos,
              style: {
                background: '#8b5cf6',
                borderRadius: '8px',
                padding: '4px 8px',
                fontSize: '11px',
                color: '#fff',
                width: 100,
                textAlign: 'center',
              },
              draggable: false,
            });
          }
          edges.push({
            id: `${datasetId}-${task.name}`,
            source: datasetId,
            target: task.name,
            style: { stroke: '#8b5cf6', strokeWidth: 1, strokeDasharray: '5,5' },
          });
        }
      }
    }

    return { nodes, edges };
  }, [spec, taskMap, selectedTask]);

  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [edges, , onEdgesChange] = useEdgesState(initialEdges);
  const { fitView } = useReactFlow();

  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (!node.id.startsWith('dataset-')) {
        onSelectTask?.(node.id);
      }
    },
    [onSelectTask]
  );

  React.useEffect(() => {
    fitView({ padding: 0.2, duration: 300 });
  }, [fitView]);

  return (
    <div style={{ width: '100%', height: '320px' }}>
      <ReactFlow nodes={nodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onNodeClick={onNodeClick} fitView>
        <Background color="#333" gap={16} size={1} />
        <Controls />
      </ReactFlow>
    </div>
  );
}

function computeLayout(spec: WorkflowSpec): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const byName = new Map(spec.workflow.tasks.map((t) => [t.name, t]));
  const depthMap = new Map<string, number>();
  const itemWidth = 200;
  const itemHeight = 100;

  const getDepth = (name: string): number => {
    if (depthMap.has(name)) return depthMap.get(name)!;
    const task = byName.get(name);
    if (!task) return 0;
    const inputs = task.inputs.filter((i) => 'task' in i).map((i) => (i as any).task);
    if (inputs.length === 0) {
      depthMap.set(name, 0);
      return 0;
    }
    const maxDepth = Math.max(...inputs.map(getDepth));
    depthMap.set(name, maxDepth + 1);
    return maxDepth + 1;
  };

  for (const task of spec.workflow.tasks) getDepth(task.name);

  const byDepth = new Map<number, string[]>();
  for (const task of spec.workflow.tasks) {
    const depth = getDepth(task.name);
    if (!byDepth.has(depth)) byDepth.set(depth, []);
    byDepth.get(depth)!.push(task.name);
  }

  for (const [depth, names] of byDepth.entries()) {
    names.forEach((name, idx) => {
      positions.set(name, {
        x: depth * itemWidth,
        y: idx * itemHeight,
      });
    });
  }

  return positions;
}
