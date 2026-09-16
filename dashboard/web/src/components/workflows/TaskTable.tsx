'use client';
import { StatusPill, Badge } from '@/components/ui';
import { fmtDuration, ago } from '@/lib/format';
import type { Task, TaskPhase } from '@/server/store/types';
import type { ResourceSpec } from '@/server/workflow/schema';

interface TaskTableProps {
  tasks: Task[];
  resources: Record<string, ResourceSpec>;
  selectedTask?: string;
  onSelectTask?: (name: string) => void;
  taskSpecs?: Map<string, { resource: string; image: string; inputs: any[]; outputs: any[]; parallelism: number }>;
}

export function TaskTable({ tasks, resources, selectedTask, onSelectTask, taskSpecs }: TaskTableProps) {
  const rows = tasks.map((task) => {
    const spec = taskSpecs?.get(task.name);
    const resource = spec ? resources[spec.resource] : undefined;
    const duration = task.startedAt && task.finishedAt ? fmtDuration(new Date(task.finishedAt).getTime() - new Date(task.startedAt).getTime()) : task.startedAt ? fmtDuration(Date.now() - new Date(task.startedAt).getTime()) : '-';

    return (
      <tr key={task.name} onClick={() => onSelectTask?.(task.name)} className={`cursor-pointer ${selectedTask === task.name ? 'bg-blue-900/30' : ''}`}>
        <td className="font-medium">{task.name}</td>
        <td>
          <StatusPill status={task.phase as TaskPhase} />
        </td>
        <td className="mono text-xs">{task.jobName}</td>
        <td className="num">{task.attempts}</td>
        <td className="num">{task.replicas}</td>
        <td className="num">{task.queuedAt ? ago(new Date(task.queuedAt)) : '-'}</td>
        <td className="num">{task.startedAt ? ago(new Date(task.startedAt)) : '-'}</td>
        <td className="num">{duration}</td>
        <td className="max-w-xs truncate text-xs" title={task.message}>
          {task.message}
        </td>
        <td>
          {resource && (
            <div className="flex gap-1 flex-wrap">
              {resource.cpu && <Badge tone="neutral">{typeof resource.cpu === 'number' ? `${resource.cpu}c` : resource.cpu}</Badge>}
              {resource.gpu && <Badge tone="neutral">{resource.gpu}x GPU</Badge>}
              {resource.memory && <Badge tone="neutral">{formatMemory(resource.memory)}</Badge>}
              {resource.platform && <Badge tone="neutral" className="text-xs">{resource.platform}</Badge>}
            </div>
          )}
        </td>
        <td className="mono text-xs max-w-xs truncate">{spec?.image}</td>
      </tr>
    );
  });

  const headers = ['Name', 'Phase', 'Job', 'Attempts', 'Replicas', 'Queued', 'Started', 'Duration', 'Message', 'Resources', 'Image'];

  return (
    <table className="tbl w-full">
      <thead>
        <tr>
          {headers.map((h) => (
            <th key={h}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>{rows}</tbody>
    </table>
  );
}

function formatMemory(mem: string): string {
  if (mem.includes('G')) return mem;
  if (mem.includes('M')) return mem;
  if (mem.includes('i')) return mem;
  return mem;
}
