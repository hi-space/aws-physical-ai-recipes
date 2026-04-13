'use client';

import { useState, useEffect, useCallback, Component, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import type { Worker } from '@/types/worker';

type ConnectionState = 'loading' | 'connected' | 'error' | 'timeout';
type ViewerMode = 'direct' | 'hosted_fallback';
const TIMEOUT_MS = 30000;

const RerunWebViewer = dynamic(() => import('@rerun-io/web-viewer-react'), {
  ssr: false,
  loading: () => <div style={{ width: '100%', height: '400px' }} />,
});

class ViewerErrorBoundary extends Component<
  { children: ReactNode; onError: () => void },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode; onError: () => void }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}

export default function RerunViewer({ worker }: { worker: Worker }) {
  const [connState, setConnState] = useState<ConnectionState>('loading');
  const [mode, setMode] = useState<ViewerMode>('direct');
  const [isHttps, setIsHttps] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  const dataUrl = `rerun+http://${worker.publicIp}:${worker.rerunDataPort}/proxy`;
  const hostedUrl = `http://${worker.publicIp}:${worker.rerunPort}/?url=${encodeURIComponent(dataUrl)}`;
  const directOpenUrl = `http://${worker.publicIp}:${worker.rerunPort}/?url=${encodeURIComponent(dataUrl)}`;
  const isAvailable = worker.status === 'RUNNING' && worker.publicIp !== '-';

  useEffect(() => {
    const https = window.location.protocol === 'https:';
    setIsHttps(https);
    if (https) setMode('hosted_fallback');
  }, []);

  useEffect(() => {
    if (!isAvailable) return;
    setConnState('loading');
    const timer = setTimeout(() => {
      setConnState((prev) => (prev === 'loading' ? 'timeout' : prev));
    }, TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [isAvailable, mode, retryKey]);

  const handleRetry = useCallback(() => {
    setRetryKey((k) => k + 1);
  }, []);

  const toggleMode = useCallback(() => {
    setMode((m) => (m === 'direct' ? 'hosted_fallback' : 'direct'));
  }, []);

  const handleReady = useCallback(() => {
    setConnState('connected');
  }, []);

  const handleError = useCallback(() => {
    setConnState('error');
  }, []);

  const isFailed = connState === 'timeout' || connState === 'error';

  return (
    <div className="bg-white rounded-lg shadow-sm overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold text-gray-700">Simulation Viewer (Rerun)</h3>
          {isAvailable && (
            <span className={`text-xs px-2 py-0.5 rounded-full ${
              mode === 'direct' ? 'bg-blue-50 text-blue-600' : 'bg-purple-50 text-purple-600'
            }`}>
              {mode === 'direct' ? 'Direct' : 'Hosted'}
            </span>
          )}
        </div>
        {isAvailable && (
          <div className="flex items-center gap-3">
            <button onClick={toggleMode} className="text-xs text-gray-500 hover:text-gray-700">
              Switch to {mode === 'direct' ? 'Hosted' : 'Direct'}
            </button>
            <a href={directOpenUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:text-blue-800">
              Open in new tab &rarr;
            </a>
          </div>
        )}
      </div>

      <div className="relative">
        {!isAvailable ? (
          <div className="flex items-center justify-center h-[400px] bg-gray-50 text-gray-400 text-sm">
            Worker is not running &mdash; Rerun viewer unavailable
          </div>
        ) : isFailed ? (
          <div className="flex items-center justify-center h-[400px] bg-gray-50">
            <div className="text-center max-w-sm">
              <div className="text-3xl mb-3">{connState === 'error' ? '\u274C' : '\u26A0\uFE0F'}</div>
              <p className="text-sm font-medium text-gray-700 mb-1">
                {connState === 'error' ? 'Viewer failed to load' : 'Connection timed out'}
              </p>
              <p className="text-xs text-gray-400 mb-4">
                {mode === 'direct'
                  ? `Could not connect to Rerun SDK at ${worker.publicIp}:${worker.rerunDataPort}. Ensure the EC2 security group allows inbound on port ${worker.rerunDataPort}.`
                  : `Could not load the Rerun viewer from ${worker.publicIp}:${worker.rerunPort}. Ensure the EC2 security group allows inbound on port ${worker.rerunPort}.`}
              </p>
              {isHttps && mode === 'direct' && (
                <p className="text-xs text-amber-600 bg-amber-50 rounded p-2 mb-4">
                  This dashboard is served over HTTPS but Rerun uses HTTP. Your browser may block mixed content.
                  Try switching to Hosted mode.
                </p>
              )}
              <div className="flex items-center justify-center gap-3">
                <button onClick={handleRetry} className="px-4 py-2 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-700">
                  Retry
                </button>
                <button onClick={toggleMode} className="px-4 py-2 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-700">
                  Try {mode === 'direct' ? 'Hosted' : 'Direct'}
                </button>
                <a href={directOpenUrl} target="_blank" rel="noopener noreferrer" className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">
                  Open in new tab
                </a>
              </div>
            </div>
          </div>
        ) : mode === 'direct' ? (
          <>
            {connState === 'loading' && (
              <div className="absolute inset-0 flex items-center justify-center bg-gray-50 z-10">
                <div className="text-center">
                  <div className="w-8 h-8 border-2 border-gray-300 border-t-aws-orange rounded-full animate-spin mx-auto mb-3" />
                  <p className="text-sm text-gray-400">Connecting via Rerun SDK...</p>
                  <p className="text-xs text-gray-300 mt-1">{worker.publicIp}:{worker.rerunDataPort}</p>
                  {isHttps && (
                    <p className="text-xs text-amber-500 mt-2">
                      Mixed-content warning: HTTPS &rarr; HTTP may be blocked
                    </p>
                  )}
                </div>
              </div>
            )}
            <ViewerErrorBoundary key={retryKey} onError={handleError}>
              <RerunWebViewer
                key={retryKey}
                rrd={dataUrl}
                width="100%"
                height="400px"
                hide_welcome_screen
                theme="light"
                onReady={handleReady}
              />
            </ViewerErrorBoundary>
          </>
        ) : (
          <>
            {connState === 'loading' && (
              <div className="absolute inset-0 flex items-center justify-center bg-gray-50 z-10">
                <div className="text-center">
                  <div className="w-8 h-8 border-2 border-gray-300 border-t-aws-orange rounded-full animate-spin mx-auto mb-3" />
                  <p className="text-sm text-gray-400">Loading worker Rerun viewer...</p>
                  <p className="text-xs text-gray-300 mt-1">{worker.publicIp}:{worker.rerunPort}</p>
                </div>
              </div>
            )}
            <iframe
              key={retryKey}
              src={hostedUrl}
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
