'use client';

import { useState } from 'react';
import type { Worker } from '@/types/worker';

export default function RerunViewer({ worker }: { worker: Worker }) {
  const [loaded, setLoaded] = useState(false);
  const rerunUrl = `http://${worker.publicIp}:${worker.rerunPort}/?url=${encodeURIComponent(`rerun+http://${worker.publicIp}:${worker.rerunDataPort}/proxy`)}`;
  const isAvailable = worker.status === 'RUNNING' && worker.publicIp !== '-';

  return (
    <div className="bg-white rounded-lg shadow-sm overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
        <h3 className="text-sm font-semibold text-gray-700">Simulation Viewer (Rerun)</h3>
        {isAvailable && (
          <a href={rerunUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:text-blue-800">
            Open in new tab &rarr;
          </a>
        )}
      </div>
      <div className="relative">
        {!isAvailable ? (
          <div className="flex items-center justify-center h-[400px] bg-gray-50 text-gray-400 text-sm">
            Worker is not running &mdash; Rerun viewer unavailable
          </div>
        ) : (
          <>
            {!loaded && (
              <div className="absolute inset-0 flex items-center justify-center bg-gray-50 z-10">
                <div className="text-center">
                  <div className="w-8 h-8 border-2 border-gray-300 border-t-aws-orange rounded-full animate-spin mx-auto mb-3" />
                  <p className="text-sm text-gray-400">Connecting to Rerun viewer...</p>
                  <p className="text-xs text-gray-300 mt-1">Ensure EC2 ports 9090/9876 are open</p>
                </div>
              </div>
            )}
            <iframe
              src={rerunUrl}
              title={`Rerun Viewer - ${worker.taskName}`}
              className="w-full h-[400px]"
              sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
              onLoad={() => setLoaded(true)}
            />
          </>
        )}
      </div>
    </div>
  );
}
