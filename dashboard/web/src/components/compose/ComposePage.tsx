'use client';
import * as React from 'react';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  Background,
  Controls,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type IsValidConnection,
  type NodeChange,
  type NodeMouseHandler,
  type OnConnectEnd,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useRouter } from 'next/navigation';
import { AlertCircle, CheckCircle2, Loader2, Play } from 'lucide-react';
import { Button, ErrorBox, Spinner, Toast } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useT } from '@/lib/i18n';
import { api, useApi } from '@/lib/api-client';
import { composeWorkflow, slugify } from '@/lib/workflow/compose';
import type { TemplateDto } from '@/lib/workflow/template-dto';
import {
  composerReducer,
  connectionReason,
  initialComposerState,
  paramsForNode,
  toComposeGraph,
  type ComposerState,
  type ConnectionRejectReason,
} from './composer-state';
import { RecipeNode, RECIPE_NODE_WIDTH, type RecipeFlowNode } from './RecipeNode';
import { DatasetSourceNode, type DatasetFlowNode } from './DatasetSourceNode';
import { Palette, PALETTE_MIME, type PaletteDrag } from './Palette';
import { Inspector } from './Inspector';
import { PortLegend } from './PortLegend';
import { SaveRecipeDialog } from './SaveRecipeDialog';
import { portColor } from './ports-ui';

const NODE_TYPES = { recipe: RecipeNode, dataset: DatasetSourceNode };
const DRAFT_KEY = 'pai-compose-draft';
interface ValidationState { status: 'idle' | 'validating' | 'ok' | 'error'; error?: string }

function newId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `id-${Math.random().toString(36).slice(2)}`;
}

/** A handle recovered from a pointer position (React Flow tags every handle with these attributes). */
interface DropHandle { nodeId: string; id?: string | null; type: 'source' | 'target' }

/**
 * The React Flow handle directly under a pointer, or null. React Flow only fills `connectionState.toHandle`
 * when its own closest-handle lookup snapped within `connectionRadius` on the last pointermove, so a real
 * drop that lands just off that radius reports no target even though the cursor is over a handle. Reading
 * the element under the release point recovers the true drop target so the rejection reason still toasts.
 */
function handleFromPoint(event: MouseEvent | TouchEvent): DropHandle | null {
  const point = 'changedTouches' in event ? event.changedTouches[0] : event;
  if (!point) return null;
  const el = document.elementFromPoint(point.clientX, point.clientY)?.closest('.react-flow__handle');
  const nodeId = el?.getAttribute('data-nodeid');
  if (!el || !nodeId) return null;
  return { nodeId, id: el.getAttribute('data-handleid'), type: el.classList.contains('target') ? 'target' : 'source' };
}

function ComposePageInner() {
  const t = useT('compose');
  const { screenToFlowPosition } = useReactFlow();
  const { data: templates, isLoading, error } = useApi<TemplateDto[]>('/api/templates');

  const router = useRouter();
  const [state, dispatch] = useReducer(composerReducer, initialComposerState);
  const [toast, setToast] = useState<{ message: string; tone: 'ok' | 'err' } | null>(null);
  const [showSave, setShowSave] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [server, setServer] = useState<ValidationState>({ status: 'idle' });

  // Latest state/templates for event handlers so their identity stays stable across renders.
  const stateRef = useRef(state); stateRef.current = state;
  const templatesRef = useRef<TemplateDto[]>(templates ?? []); templatesRef.current = templates ?? [];

  const templateById = useMemo(() => new Map((templates ?? []).map((tpl) => [tpl.id, tpl])), [templates]);

  const composed = useMemo(() => composeWorkflow(toComposeGraph(state), templates ?? []), [state, templates]);

  // ---- Server validation (debounced) ----
  useEffect(() => {
    if (state.nodes.length === 0 || composed.errors.length > 0) { setServer({ status: 'idle' }); return; }
    setServer({ status: 'validating' });
    const abort = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const result = await api<{ ok: boolean; error?: string }>('/api/workflows/validate', { method: 'POST', json: { yaml: composed.yaml }, signal: abort.signal });
        if (!abort.signal.aborted) setServer(result.ok ? { status: 'ok' } : { status: 'error', error: result.error });
      } catch (e) {
        if (!abort.signal.aborted) setServer({ status: 'error', error: e instanceof Error ? e.message : String(e) });
      }
    }, 500);
    return () => { abort.abort(); window.clearTimeout(timer); };
  }, [composed.yaml, composed.errors.length, state.nodes.length]);

  // ---- Stable node action handlers ----
  const onDeleteNode = useCallback((nodeId: string) => dispatch({ type: 'REMOVE_NODE', nodeId }), []);
  const onDeleteDataset = useCallback((datasetId: string) => dispatch({ type: 'REMOVE_DATASET', datasetId }), []);

  // ---- Derived React Flow graph ----
  const rfNodes = useMemo<(RecipeFlowNode | DatasetFlowNode)[]>(() => [
    ...state.nodes.map((n): RecipeFlowNode => {
      const tpl = templateById.get(n.templateId);
      const boundParams = state.edges.filter((e) => e.to.nodeId === n.id).map((e) => e.to.paramName);
      return {
        id: n.id, type: 'recipe', position: n.position,
        data: { title: n.title, category: tpl?.category ?? '', recipe: tpl?.recipe, boundParams, selected: state.selectedNodeId === n.id, onDelete: onDeleteNode },
      };
    }),
    ...state.datasets.map((d): DatasetFlowNode => ({
      id: d.id, type: 'dataset', position: d.position,
      data: { name: d.name, version: d.version, kind: d.kind, selected: state.selectedNodeId === d.id, onDelete: onDeleteDataset },
    })),
  ], [state.nodes, state.datasets, state.edges, state.selectedNodeId, templateById, onDeleteNode, onDeleteDataset]);

  const rfEdges = useMemo<Edge[]>(() => state.edges.map((e) => {
    const targetNode = state.nodes.find((n) => n.id === e.to.nodeId);
    const kind = templateById.get(targetNode?.templateId ?? '')?.recipe?.ports?.inputs.find((p) => p.param === e.to.paramName)?.kind;
    const color = kind ? portColor(kind) : 'var(--color-border-strong)';
    return {
      id: e.id,
      source: 'datasetId' in e.from ? e.from.datasetId : e.from.nodeId,
      sourceHandle: 'datasetId' in e.from ? 'dataset' : e.from.portName,
      target: e.to.nodeId,
      targetHandle: e.to.paramName,
      style: { stroke: color, strokeWidth: 2 },
    };
  }), [state.edges, state.nodes, templateById]);

  // ---- React Flow change handlers ----
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    for (const c of changes) {
      if (c.type === 'position' && c.position) {
        if (stateRef.current.datasets.some((d) => d.id === c.id)) dispatch({ type: 'MOVE_DATASET', datasetId: c.id, x: c.position.x, y: c.position.y });
        else dispatch({ type: 'MOVE_NODE', nodeId: c.id, x: c.position.x, y: c.position.y });
      } else if (c.type === 'remove') {
        if (stateRef.current.datasets.some((d) => d.id === c.id)) dispatch({ type: 'REMOVE_DATASET', datasetId: c.id });
        else dispatch({ type: 'REMOVE_NODE', nodeId: c.id });
      }
    }
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    for (const c of changes) if (c.type === 'remove') dispatch({ type: 'DISCONNECT', edgeId: c.id });
  }, []);

  const reasonMessage = useCallback((reason: ConnectionRejectReason): string => {
    const map: Record<ConnectionRejectReason, string> = {
      self: t('rejectSelf'), incomplete: t('rejectIncomplete'), unknown_port: t('rejectUnknownPort'),
      kind_mismatch: t('rejectKindMismatch'), input_bound: t('rejectInputBound'),
    };
    return map[reason];
  }, [t]);

  const isValidConnection = useCallback<IsValidConnection>((c) => {
    const s = stateRef.current;
    return connectionReason({ source: c.source, sourceHandle: c.sourceHandle, target: c.target, targetHandle: c.targetHandle }, s.nodes, s.datasets, templatesRef.current, s.edges) === null;
  }, []);

  const onConnect = useCallback((c: Connection) => {
    const s = stateRef.current;
    const reason = connectionReason({ source: c.source, sourceHandle: c.sourceHandle, target: c.target, targetHandle: c.targetHandle }, s.nodes, s.datasets, templatesRef.current, s.edges);
    if (reason) { setToast({ message: reasonMessage(reason), tone: 'err' }); return; }
    const isDataset = s.datasets.some((d) => d.id === c.source);
    dispatch({
      type: 'CONNECT', edgeId: newId(),
      from: isDataset ? { datasetId: c.source! } : { nodeId: c.source!, portName: c.sourceHandle! },
      to: { nodeId: c.target!, paramName: c.targetHandle! },
    });
  }, [reasonMessage]);

  // `isValidConnection` hard-blocks an invalid drag before `onConnect` fires, so the rejection toast can
  // only be surfaced here. `onConnectEnd` always fires; an accepted connection (`isValid`) already went
  // through `onConnect`, so we skip it. Otherwise we find the drop target — preferring React Flow's
  // `toHandle`, falling back to the handle under the release point when React Flow reports none (see
  // `handleFromPoint`) — and recompute the reason from the two handles. A drop on empty canvas resolves
  // to no target and stays silent. Handles are normalised by type so a target→source drag reads the same.
  const onConnectEnd = useCallback<OnConnectEnd>((event, connectionState) => {
    const { fromHandle, toHandle, isValid } = connectionState;
    if (!fromHandle || isValid) return;
    const target: DropHandle | null = toHandle ?? handleFromPoint(event);
    if (!target) return;
    const outHandle = fromHandle.type === 'source' ? fromHandle : target;
    const inHandle = fromHandle.type === 'source' ? target : fromHandle;
    const s = stateRef.current;
    const reason = connectionReason(
      { source: outHandle.nodeId, sourceHandle: outHandle.id, target: inHandle.nodeId, targetHandle: inHandle.id },
      s.nodes, s.datasets, templatesRef.current, s.edges,
    );
    if (reason) setToast({ message: reasonMessage(reason), tone: 'err' });
  }, [reasonMessage]);

  const onNodeClick = useCallback<NodeMouseHandler>((_e, node) => {
    dispatch({ type: 'SELECT_NODE', nodeId: node.id });
  }, []);

  // Test-only introspection: exposes the real onConnect/onConnectEnd handlers plus the current node/dataset
  // ids so the browser contract test can drive both an accepted connection and a rejected drag through
  // production logic (React Flow's handle drag is not reliably reproducible headless). `connectEnd`
  // reconstructs the FinalConnectionState React Flow hands a rejected real drop where its closest-handle
  // lookup did NOT snap: `isValid` false and `toHandle` null. The reject reason must then be recovered from
  // the pointer position over the target handle — so the mouseup carries that handle's centre coordinates.
  // Compiled out of any non-test build, so it never affects production.
  useEffect(() => {
    if (process.env.NODE_ENV !== 'test') return;
    const w = window as unknown as { __composeTest?: unknown };
    w.__composeTest = {
      connect: (c: Connection) => onConnect(c),
      connectEnd: (c: Connection) => {
        const el = document.querySelector(`.react-flow__handle[data-nodeid="${c.target}"][data-handleid="${c.targetHandle}"]`);
        const rect = el?.getBoundingClientRect();
        const point = rect ? { clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 } : {};
        onConnectEnd(
          new MouseEvent('mouseup', point),
          {
            isValid: false,
            fromHandle: { nodeId: c.source, id: c.sourceHandle, type: 'source' },
            toHandle: null,
          } as unknown as Parameters<OnConnectEnd>[1],
        );
      },
      nodes: () => stateRef.current.nodes.map((n) => ({ id: n.id, templateId: n.templateId, title: n.title })),
      datasets: () => stateRef.current.datasets.map((d) => ({ id: d.id, name: d.name })),
    };
    return () => { delete w.__composeTest; };
  }, [onConnect, onConnectEnd]);

  // ---- Palette add (click) & drop ----
  const nextPosition = () => {
    const count = stateRef.current.nodes.length + stateRef.current.datasets.length;
    return { x: 80 + (count % 4) * (RECIPE_NODE_WIDTH + 40), y: 80 + Math.floor(count / 4) * 140 };
  };
  const addTemplate = useCallback((tpl: TemplateDto, at?: { x: number; y: number }) => {
    const p = at ?? nextPosition();
    dispatch({ type: 'ADD_NODE', nodeId: newId(), templateId: tpl.id, title: tpl.title, x: p.x, y: p.y });
  }, []);
  const addDataset = useCallback((at?: { x: number; y: number }) => {
    const p = at ?? nextPosition();
    // Created unset; the user binds it to a registered dataset in the inspector (version 0 = unset).
    dispatch({ type: 'ADD_DATASET', datasetId: newId(), name: '', version: 0, x: p.x, y: p.y });
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }, []);
  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const raw = e.dataTransfer.getData(PALETTE_MIME);
    if (!raw) return;
    let payload: PaletteDrag;
    try { payload = JSON.parse(raw) as PaletteDrag; } catch { return; }
    const at = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    if (payload.kind === 'dataset') addDataset(at);
    else { const tpl = templatesRef.current.find((x) => x.id === payload.templateId); if (tpl) addTemplate(tpl, at); }
  }, [screenToFlowPosition, addDataset, addTemplate]);

  // ---- Save & run ----
  const canAct = state.nodes.length > 0 && composed.errors.length === 0 && server.status === 'ok';

  const handleSave = async (title: string, description: string) => {
    setSaving(true);
    try {
      const slug = (slugify(title).slice(0, 30) || 'composed').replace(/-+$/g, '');
      const id = `${slug}-${Date.now().toString(36).slice(-5)}`;
      await api('/api/templates', { method: 'POST', json: { id, title, description, category: 'custom', yaml: composed.yaml, params: composed.params } });
      setShowSave(false);
      setToast({ message: t('saved'), tone: 'ok' });
    } catch (e) {
      setToast({ message: e instanceof Error ? e.message : String(e), tone: 'err' });
    } finally {
      setSaving(false);
    }
  };

  const handleRun = () => {
    setRunning(true);
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ yaml: composed.yaml, params: composed.params, title: state.nodes[0]?.title ?? t('pageTitle') }));
      router.push('/workflows/new?draft=1');
    } finally {
      setRunning(false);
    }
  };

  // ---- Inspector wiring ----
  const selectedNode = state.nodes.find((n) => n.id === state.selectedNodeId);
  const selectedDataset = state.datasets.find((d) => d.id === state.selectedNodeId);
  const selectedTemplate = selectedNode ? templateById.get(selectedNode.templateId) : undefined;
  const selectedValues = selectedNode ? paramsForNode(state.params, selectedNode.id) : {};
  const bindings = useMemo<Record<string, string>>(() => {
    if (!selectedNode) return {};
    const out: Record<string, string> = {};
    for (const e of state.edges) {
      if (e.to.nodeId !== selectedNode.id) continue;
      const from = e.from;
      if ('datasetId' in from) {
        const ds = state.datasets.find((d) => d.id === from.datasetId);
        out[e.to.paramName] = t('boundFromDataset', { name: ds?.name ?? '' });
      } else {
        const src = state.nodes.find((n) => n.id === from.nodeId);
        out[e.to.paramName] = t('boundFromNode', { title: src?.title ?? '' });
      }
    }
    return out;
  }, [selectedNode, state.edges, state.datasets, state.nodes, t]);

  if (isLoading) return <div className="p-6"><Spinner /></div>;
  if (error) return <div className="p-6"><ErrorBox error={error} /></div>;

  const statusNode = composed.errors.length > 0
    ? <span className="inline-flex items-center gap-1.5 text-err"><AlertCircle size={15} />{t('errorCount', { count: composed.errors.length })}</span>
    : server.status === 'validating' ? <span className="inline-flex items-center gap-1.5 text-fg-muted"><Loader2 size={15} className="animate-spin" />{t('validating')}</span>
    : server.status === 'error' ? <span className="inline-flex items-center gap-1.5 text-err"><AlertCircle size={15} />{server.error || t('serverInvalid')}</span>
    : server.status === 'ok' ? <span className="inline-flex items-center gap-1.5 text-ok"><CheckCircle2 size={15} />{t('serverValid')}</span>
    : <span className="text-fg-faint">{t('ready')}</span>;

  return (
    <div className="flex h-[calc(100vh-7rem)] min-h-[560px] flex-col">
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />

      <div className="flex min-h-0 flex-1 overflow-hidden rounded-lg border border-border">
        <Palette templates={templates ?? []} onAddTemplate={addTemplate} onAddDataset={() => addDataset()} />

        <div className="relative min-w-0 flex-1" onDragOver={onDragOver} onDrop={onDrop} data-testid="compose-canvas">
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={NODE_TYPES}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onConnectEnd={onConnectEnd}
            isValidConnection={isValidConnection}
            onNodeClick={onNodeClick}
            onPaneClick={() => dispatch({ type: 'SELECT_NODE', nodeId: undefined })}
            colorMode="dark"
            fitView
            minZoom={0.3}
            maxZoom={1.6}
            proOptions={{ hideAttribution: false }}
          >
            <Background color="#232b3b" gap={20} size={1} />
            <Controls showInteractive={false} position="bottom-right" />
            <Panel position="bottom-left"><PortLegend /></Panel>
          </ReactFlow>
          {state.nodes.length === 0 && state.datasets.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-fg-faint">{t('canvasEmpty')}</div>
          )}
        </div>

        <aside className="w-80 shrink-0 overflow-hidden border-l border-border bg-bg-elev">
          <Inspector
            node={selectedNode}
            template={selectedTemplate}
            dataset={selectedDataset}
            values={selectedValues}
            bindings={bindings}
            onSetParam={(paramName, value) => selectedNode && dispatch({ type: 'SET_PARAM', nodeId: selectedNode.id, paramName, value })}
            onRenameNode={(newTitle) => selectedNode && dispatch({ type: 'RENAME_NODE', nodeId: selectedNode.id, newTitle })}
            onSetDataset={(name, version, kind) => selectedDataset && dispatch({ type: 'SET_DATASET', datasetId: selectedDataset.id, name, version, kind, templates: templatesRef.current })}
          />
        </aside>
      </div>

      <footer className="mt-3 flex items-center justify-between gap-3">
        <div className="min-w-0 truncate text-[13px]">{statusNode}</div>
        <div className="flex shrink-0 gap-2">
          <Button variant="secondary" onClick={() => setShowSave(true)} disabled={!canAct || saving}>{t('saveRecipe')}</Button>
          <Button variant="primary" onClick={handleRun} disabled={!canAct || running} loading={running}><Play size={14} />{t('runComposed')}</Button>
        </div>
      </footer>

      {composed.errors.length > 0 && (
        <div className="mt-2 space-y-1">
          {composed.errors.map((e, i) => (
            <div key={i} className="flex items-start gap-1.5 text-[12px] text-err"><AlertCircle size={13} className="mt-0.5 shrink-0" />{e.message}</div>
          ))}
        </div>
      )}

      <SaveRecipeDialog open={showSave} saving={saving} onSave={handleSave} onCancel={() => setShowSave(false)} />
      {toast && <Toast message={toast.message} tone={toast.tone} onClose={() => setToast(null)} />}
    </div>
  );
}

export function ComposePage() {
  return (
    <ReactFlowProvider>
      <ComposePageInner />
    </ReactFlowProvider>
  );
}
