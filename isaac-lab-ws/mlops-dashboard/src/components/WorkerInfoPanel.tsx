import type { Worker } from '../types/worker';
import StatusBadge from './StatusBadge';

function UtilBar({ label, value, color, suffix }: { label: string; value: number; color: string; suffix?: string }) {
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="text-gray-500">{label}</span>
        <span className="font-medium text-gray-700">{value}{suffix ?? '%'}</span>
      </div>
      <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(100, value)}%` }} />
      </div>
    </div>
  );
}

export default function WorkerInfoPanel({ worker }: { worker: Worker }) {
  const info = [
    { label: 'Instance ID', value: worker.instanceId },
    { label: 'Instance Type', value: worker.instanceType },
    { label: 'Region', value: worker.region },
    { label: 'Public IP', value: worker.publicIp },
    { label: 'Private IP', value: worker.privateIp },
    { label: 'Batch Job', value: worker.batchJobId },
    { label: 'Queue', value: worker.batchJobQueue },
    { label: 'Uptime', value: worker.uptime },
  ];

  const training = [
    { label: 'Task', value: worker.taskName },
    { label: 'Experiment', value: worker.experimentName },
    { label: 'DDP Rank', value: `${worker.ddpRank} / ${worker.ddpWorldSize}` },
    { label: 'Backend', value: worker.ddpBackend },
    { label: 'GPUs', value: `${worker.gpuCount}x` },
    { label: 'Progress', value: `${worker.currentStep} / ${worker.totalSteps} steps` },
    { label: 'Current Reward', value: worker.currentReward.toFixed(1) },
  ];

  const tempColor = worker.gpuTemperature >= 85 ? 'bg-red-500' : worker.gpuTemperature >= 75 ? 'bg-yellow-500' : 'bg-green-500';

  return (
    <div className="bg-white rounded-lg shadow-sm p-5 space-y-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-700">Worker Details</h3>
        <StatusBadge status={worker.status} />
      </div>

      {/* Instance Info */}
      <div>
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Instance</p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
          {info.map((item) => (
            <div key={item.label}>
              <dt className="text-xs text-gray-400">{item.label}</dt>
              <dd className="text-sm font-mono text-gray-800">{item.value}</dd>
            </div>
          ))}
        </dl>
      </div>

      {/* Training Info */}
      <div>
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Training</p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
          {training.map((item) => (
            <div key={item.label}>
              <dt className="text-xs text-gray-400">{item.label}</dt>
              <dd className="text-sm text-gray-800">{item.value}</dd>
            </div>
          ))}
        </dl>
      </div>

      {/* Utilization */}
      <div className="space-y-3">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Utilization</p>
        <UtilBar label="GPU" value={worker.gpuUtilization} color="bg-purple-500" />
        <UtilBar label="GPU Memory" value={worker.gpuMemoryUtilization} color="bg-indigo-500" />
        <UtilBar label="GPU Temp" value={worker.gpuTemperature} color={tempColor} suffix="°C" />
        <UtilBar label="CPU" value={worker.cpuUtilization} color="bg-blue-500" />
        <UtilBar label="Memory" value={worker.memoryUtilization} color="bg-teal-500" />
      </div>

      {/* Tags */}
      {Object.keys(worker.tags).length > 0 && (
        <div>
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Tags</p>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(worker.tags).map(([k, v]) => (
              <span key={k} className="inline-flex px-2 py-0.5 bg-gray-100 rounded text-xs text-gray-600">
                {k}: {v}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
