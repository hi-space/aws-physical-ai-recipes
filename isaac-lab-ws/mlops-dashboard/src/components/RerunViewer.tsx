'use client';

import { useState, useEffect, useCallback } from 'react';
import type { Worker } from '@/types/worker';

type ConnectionState = 'loading' | 'connected' | 'timeout';
const TIMEOUT_MS = 30000;

export default function RerunViewer({ worker }: { worker: Worker }) {
  const [connState, setConnState] = useState<ConnectionState>('loading');
  const [isHttps, setIsHttps] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  const rerunUrl = `http://${worker.publicIp}:${worker.rerunPort}/?url=${encodeURIComponent(`rerun+http://${worker.publicIp}:${worker.rerunDataPort}/proxy`)}`;
  const isAvailable = worker.status === 'RUNNING' && worker.publicIp !== '-';

  useEffect(() => {
    setIsHttps(window.location.protocol === 'https:');
  }, []);

  useEffect(() => {
    if (!isAvailable) return;
    setConnState('loading');
    const timer = setTimeout(() => {
      setConnState((prev) => (prev === 'loading' ? 'timeout' : prev));
    }, TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [isAvailable, retryKey]);

  const handleRetry = useCallback(() => {
    setRetryKey((k) => k + 1);
  }, []);

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
        ) : connState === 'timeout' ? (
          <div className="flex items-center justify-center h-[400px] bg-gray-50">
            <div className="text-center max-w-sm">
              <div className="text-3xl mb-3">&#x26A0;</div>
              <p className="text-sm font-medium text-gray-700 mb-1">Connection timed out</p>
              <p className="text-xs text-gray-400 mb-4">
                Could not connect to Rerun viewer at {worker.publicIp}:{worker.rerunPort}.
                Ensure the EC2 security group allows inbound on ports {worker.rerunPort} and {worker.rerunDataPort}.
              </p>
              {isHttps && (
                <p className="text-xs text-amber-600 bg-amber-50 rounded p-2 mb-4">
                  This dashboard is served over HTTPS but Rerun uses HTTP. Your browser may block mixed content.
                  Try opening the viewer directly in a new tab.
                </p>
              )}
              <div className="flex items-center justify-center gap-3">
                <button onClick={handleRetry} className="px-4 py-2 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-700">
                  Retry
                </button>
                <a href={rerunUrl} target="_blank" rel="noopener noreferrer" className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">
                  Open in new tab
                </a>
              </div>
            </div>
          </div>
        ) : (
          <>
            {connState === 'loading' && (
              <div className="absolute inset-0 flex items-center justify-center bg-gray-50 z-10">
                <div className="text-center">
                  <div className="w-8 h-8 border-2 border-gray-300 border-t-aws-orange rounded-full animate-spin mx-auto mb-3" />
                  <p className="text-sm text-gray-400">Connecting to Rerun viewer...</p>
                  <p className="text-xs text-gray-300 mt-1">Ensure EC2 ports {worker.rerunPort}/{worker.rerunDataPort} are open</p>
                  {isHttps && (
                    <p className="text-xs text-amber-500 mt-2">
                      Mixed-content warning: HTTPS &#x2192; HTTP embed may be blocked
                    </p>
                  )}
                </div>
              </div>
            )}
            <iframe
              key={retryKey}
              src={rerunUrl}
              title={`Rerun Viewer - ${worker.taskName}`}
              className="w-full h-[400px]"
              sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
              onLoad={() => setConnState('connected')}
            />
          </>
        )}
      </div>
    </div>
  );
}
