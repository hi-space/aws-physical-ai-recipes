'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge, Button, Card, Dialog, EmptyState, ErrorBox, Input, Spinner, StatusPill, Table, Toast } from '@/components/ui';
import { ago, fmtTime } from '@/lib/format';
import { api, useApi, useApiMutation, useMe, can } from '@/lib/api-client';

interface PipelineParameter {
  Name: string;
  DefaultValue?: string;
  Type?: string;
}

interface Pipeline {
  PipelineName: string;
  PipelineArn: string;
  PipelineStatus: string;
  CreationTime: string;
  LastModifiedTime: string;
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
  const me = useMe();
  const router = useRouter();
  const { data, isLoading, error } = useApi<PipelinesData>('/api/pipelines', { refetch: 10000 });
  const [showDialog, setShowDialog] = React.useState(false);
  const [formData, setFormData] = React.useState<Record<string, string>>({});
  const [displayName, setDisplayName] = React.useState('');
  const [requestId, setRequestId] = React.useState(() => crypto.randomUUID());
  const [toast, setToast] = React.useState<{ message: string; tone: 'ok' | 'err' } | null>(null);

  const mutation = useApiMutation(
    (params: { parameters: Record<string, string>; displayName?: string }) =>
      api<{ arn: string }>('/api/pipelines/executions', { method: 'POST', json: params, headers: { 'idempotency-key': requestId } }),
    ['/api/pipelines']
  );

  const handleStartExecution = async () => {
    try {
      const result = await mutation.mutateAsync({
        parameters: formData,
        displayName: displayName || undefined,
      });
      if (!result.arn) throw new Error('실행 ARN을 받지 못했습니다. 실행 목록을 확인하세요.');
      setShowDialog(false);
      setFormData({});
      setDisplayName('');
      setRequestId(crypto.randomUUID());
      setToast({ message: '실행 요청을 접수했습니다.', tone: 'ok' });
      // Navigate to execution page
      router.push(`/pipelines/${encodeURIComponent(result.arn)}`);
    } catch (e) {
      setToast({ message: (e as Error).message, tone: 'err' });
    }
  };

  if (isLoading && !data) return <Spinner label="파이프라인을 불러오는 중…" />;

  return (
    <>
      <PageHeader title="파이프라인" />

      {error && <ErrorBox error={error} />}
      {data?.pipeline.projectTrackingSupported === false && <p className="mb-4 rounded border border-border p-3 text-xs text-warn">
        현재 파이프라인 정의에는 프로젝트 실험 태그가 없습니다. 프로젝트 MLflow 비교를 사용하려면 새 정의를 적용해야 합니다. 기존 unscoped 실험은 관리자 전용입니다.
      </p>}

      <div className="space-y-4">
        {/* Start button */}
        {can(me.data, 'researcher') && data?.pipeline && (
          <div>
            <Button onClick={() => { setRequestId(crypto.randomUUID()); setShowDialog(true); }}>실행 시작</Button>
          </div>
        )}

        {/* Pipeline description */}
        {data?.pipeline && (
          <Card title={data.pipeline.PipelineName}>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-fg-muted">상태</span>
                  <div className="mt-1">
                    <StatusPill status={data.pipeline.PipelineStatus} />
                  </div>
                </div>
                <div>
                  <span className="text-fg-muted">생성 시각</span>
                  <div className="mt-1 font-mono text-xs">{fmtTime(data.pipeline.CreationTime)}</div>
                </div>
              </div>
              {data.pipeline.parameters.length > 0 && (
                <div>
                  <div className="text-sm font-medium">파라미터</div>
                  <div className="mt-2 space-y-2">
                    {data.pipeline.parameters.map((p) => (
                      <div key={p.Name} className="flex items-center gap-3 rounded bg-bg-elev-2 p-2">
                        <span className="text-sm font-mono text-fg-muted">{p.Name}</span>
                        {p.DefaultValue && (
                          <Badge tone="info">default: {p.DefaultValue}</Badge>
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
        <Card title="실행 목록" description={`${data?.executions.length ?? 0}개`}>
          {!data?.executions.length ? (
            !error && <EmptyState title="실행 이력이 없습니다." />
          ) : (
            <Table
              head={['실행 이름', '상태', '시작', '실패 사유']}
              dense
            >
              {data.executions.map((exec) => (
                <tr
                  key={exec.PipelineExecutionArn}
                  onClick={() => router.push(`/pipelines/${encodeURIComponent(exec.PipelineExecutionArn)}`)}
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
        <Card title="파이프라인 단계">
          <div className="space-y-2 text-sm text-fg-muted">
            <div className="flex items-start gap-2">
              <span className="text-accent">1.</span>
              <span>TransformDataset — 입력 데이터 전처리</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-accent">2.</span>
              <span>GR00TFinetune — GR00T 파인튜닝</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-accent">3.</span>
              <span>SmokeEval — 모델 로드·추론 동작 확인</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-accent">4.</span>
              <span>SmokeGate — smoke 결과 확인</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-accent">5.</span>
              <span>RegisterModel — 모델 아티팩트 등록</span>
            </div>
          </div>
        </Card>
      </div>

      {/* Start Execution Dialog */}
      <Dialog
        title="파이프라인 실행"
        open={showDialog}
        onClose={() => setShowDialog(false)}
        footer={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setShowDialog(false)}>
              취소
            </Button>
            <Button onClick={handleStartExecution} disabled={mutation.isPending || !can(me.data, 'researcher')}>
              실행
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="rounded-lg bg-bg-elev-2 p-3 text-sm">
            <p className="mb-2 text-fg-muted">Quick 검증은 짧은 학습과 모델 로드·추론 확인을 수행합니다. 로봇 동작 품질 평가는 별도입니다.</p>
            <Button variant="secondary" onClick={() => {
              const preset: Record<string, string> = { MaxSteps: '100', GlobalBatchSize: '4', SaveSteps: '50' };
              setFormData(Object.fromEntries(Object.entries(preset).filter(([name]) => data?.pipeline.parameters.some((parameter) => parameter.Name === name))));
            }}>Quick 검증 설정</Button>
          </div>
          <div>
            <label className="text-sm font-medium">실행 이름 (선택)</label>
            <Input
              aria-label="실행 이름"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. training-v1"
              className="mt-1"
            />
          </div>

          {data?.pipeline.parameters.map((p) => (
            <div key={p.Name}>
              <label className="text-sm font-medium">{p.Name}</label>
              {p.Type === 'Integer' ? (
                <Input
                  type="number"
                  value={formData[p.Name] || p.DefaultValue || ''}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, [p.Name]: e.target.value }))
                  }
                  placeholder={p.DefaultValue}
                  className="mt-1"
                />
              ) : (
                <Input
                  value={formData[p.Name] || p.DefaultValue || ''}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, [p.Name]: e.target.value }))
                  }
                  placeholder={p.DefaultValue}
                  className="mt-1"
                />
              )}
            </div>
          ))}
        </div>
      </Dialog>

      {toast && <Toast message={toast.message} tone={toast.tone} onClose={() => setToast(null)} />}
    </>
  );
}
