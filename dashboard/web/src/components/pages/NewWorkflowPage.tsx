'use client';
import { useState, useEffect, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button, Card, Badge, Input, Select, Field, Textarea, Dialog, Toast, EmptyState, Spinner } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useApi, useApiMutation, can, useMe, api } from '@/lib/api-client';
import type { Template } from '@/server/store/types';

function substituteParams(template: string, params: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(params)) {
    result = result.replace(new RegExp(`{{\\s*${key}\\s*}}`, 'g'), value);
  }
  return result;
}

function injectNamespaceAndPriority(yaml: string, namespace: string, priority: string): string {
  let result = yaml;
  if (namespace) {
    if (result.includes('  namespace:')) {
      result = result.replace(/^(\s+namespace:).*/m, `$1 ${namespace}`);
    } else if (result.includes('workflow:')) {
      const lines = result.split('\n');
      const workflowIdx = lines.findIndex((l) => l.includes('workflow:'));
      if (workflowIdx >= 0) {
        lines.splice(workflowIdx + 2, 0, `  namespace: ${namespace}`);
        result = lines.join('\n');
      }
    }
  }
  if (priority) {
    if (result.includes('  priority:')) {
      result = result.replace(/^(\s+priority:).*/m, `$1 ${priority}`);
    } else if (result.includes('workflow:')) {
      const lines = result.split('\n');
      const workflowIdx = lines.findIndex((l) => l.includes('workflow:'));
      if (workflowIdx >= 0) {
        let insertIdx = workflowIdx + 2;
        for (let i = workflowIdx + 1; i < lines.length; i++) {
          if (lines[i].match(/^\s+\w+:/)) insertIdx = i;
          else if (!lines[i].match(/^\s/)) break;
        }
        lines.splice(insertIdx + 1, 0, `  priority: ${priority}`);
        result = lines.join('\n');
      }
    }
  }
  return result;
}

interface ValidationResult {
  ok: boolean;
  vars?: Record<string, string>;
  order?: string[];
  tasks?: Array<{ name: string; resource: any; image: string; inputs: any[]; outputs: any[]; parallelism: number }>;
  manifests?: any[];
  error?: string;
  details?: { issues: string[] };
}

export function NewWorkflowPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const me = useMe();

  const [step, setStep] = useState(1);
  const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(null);
  const [params, setParams] = useState<Record<string, string>>({});
  const [yaml, setYaml] = useState('');
  const [namespace, setNamespace] = useState(me.data?.defaultNamespace || '');
  const [priority, setPriority] = useState('');
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [showSaveTemplate, setShowSaveTemplate] = useState(false);
  const [templateId, setTemplateId] = useState('');
  const [templateTitle, setTemplateTitle] = useState('');
  const [templateDesc, setTemplateDesc] = useState('');
  const [templateCat, setTemplateCat] = useState<'custom' | 'data' | 'setup' | 'training' | 'evaluation' | 'simulation'>('custom');

  const { data: templates = [] } = useApi<Template[]>('/api/templates');
  const { data: namespaces = [] } = useApi<string[]>('/api/k8s/namespaces');
  const { data: queues } = useApi('/api/queues');

  const submitMut = useApiMutation(async (yamlText: string) => {
    const res = await api<{ id: string }>('/api/workflows', {
      method: 'POST',
      json: {
        yaml: yamlText,
        templateId: selectedTemplate?.id,
        namespace,
      },
    });
    return res;
  });

  const saveMut = useApiMutation(async () => {
    await api('/api/templates', {
      method: 'POST',
      json: {
        id: templateId,
        title: templateTitle,
        description: templateDesc,
        category: templateCat,
        yaml,
        params: selectedTemplate?.params || [],
      },
    });
  });

  const priorityClasses = (queues as any)?.priorityClasses || [];

  useEffect(() => {
    const cloneYaml = sessionStorage.getItem('pai.cloneYaml');
    if (cloneYaml) {
      setYaml(cloneYaml);
      setStep(3);
      sessionStorage.removeItem('pai.cloneYaml');
    }
  }, []);

  useEffect(() => {
    const templateParam = searchParams.get('template');
    if (templateParam && templates.length > 0) {
      const t = templates.find((x) => x.id === templateParam);
      if (t) {
        selectTemplate(t);
      }
    }
  }, [searchParams, templates]);

  const selectTemplate = (t: Template) => {
    setSelectedTemplate(t);
    const defaults = t.params.reduce((acc, p) => ({ ...acc, [p.name]: p.default || '' }), {});
    setParams(defaults);
    const templated = substituteParams(t.yaml, defaults);
    setYaml(templated);
  };

  const updateParam = (name: string, value: string) => {
    const newParams = { ...params, [name]: value };
    setParams(newParams);
    if (selectedTemplate) {
      const templated = substituteParams(selectedTemplate.yaml, newParams);
      setYaml(templated);
    }
  };

  useEffect(() => {
    const timer = setTimeout(async () => {
      if (yaml) {
        try {
          const injectedYaml = injectNamespaceAndPriority(yaml, namespace, priority);
          const result = await api<ValidationResult>('/api/workflows/validate', {
            method: 'POST',
            json: { yaml: injectedYaml },
          });
          setValidation(result);
        } catch (err: any) {
          setValidation({ ok: false, error: err.message, details: { issues: err.details?.issues || [] } });
        }
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [yaml, namespace, priority]);

  const handleSubmit = async () => {
    if (!validation?.ok) return;
    try {
      const injectedYaml = injectNamespaceAndPriority(yaml, namespace, priority);
      const res = await submitMut.mutateAsync(injectedYaml);
      router.push(`/workflows/${res.id}`);
    } catch (err) {
      console.error('Failed to submit workflow:', err);
    }
  };

  const handleSaveTemplate = async () => {
    try {
      await saveMut.mutateAsync();
      setShowSaveTemplate(false);
    } catch (err) {
      console.error('Failed to save template:', err);
    }
  };

  const downloadYaml = () => {
    const blob = new Blob([yaml], { type: 'text/yaml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `workflow-${Date.now()}.yaml`;
    a.click();
  };

  const templatesByCategory = useMemo(() => {
    const grouped: Record<string, Template[]> = {};
    templates.forEach((t) => {
      if (!grouped[t.category]) grouped[t.category] = [];
      grouped[t.category].push(t);
    });
    return grouped;
  }, [templates]);

  const categories = ['setup', 'data', 'training', 'evaluation', 'simulation', 'custom'];

  return (
    <div className="space-y-6">
      <PageHeader title="New Workflow" />

      <div className="grid grid-cols-3 gap-4">
        {[1, 2, 3].map((s) => (
          <div key={s} className={`p-3 rounded border-2 cursor-pointer transition ${step === s ? 'border-blue-500 bg-blue-900/20' : 'border-gray-700 hover:border-gray-600'}`} onClick={() => setStep(s)}>
            <div className="text-xs font-semibold">Step {s}</div>
            <div className="text-sm">{['Template', 'Parameters', 'YAML'][s - 1]}</div>
          </div>
        ))}
      </div>

      {step === 1 && (
        <div className="space-y-4">
          {categories.map((cat) => {
            const catTemplates = templatesByCategory[cat] || [];
            if (catTemplates.length === 0) return null;
            return (
              <div key={cat}>
                <h3 className="text-sm font-semibold mb-2 capitalize">{cat}</h3>
                <div className="grid grid-cols-2 gap-4">
                  {catTemplates.map((t) => (
                    <div
                      key={t.id}
                      onClick={() => {
                        selectTemplate(t);
                        setStep(2);
                      }}
                      style={{ borderColor: selectedTemplate?.id === t.id ? '#3b82f6' : '' }}
                      className="p-4 border-2 rounded-lg cursor-pointer hover:bg-gray-800/80 transition"
                    >
                      <h4 className="font-medium text-sm mb-1">{t.title}</h4>
                      <p className="text-xs text-gray-400 mb-2">{t.description}</p>
                      {t.requires && t.requires.length > 0 && (
                        <div className="flex gap-1 flex-wrap">
                          {t.requires.map((r) => (
                            <Badge key={r} tone={r === 'gpu' ? 'warn' : 'neutral'}>
                              {r}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          {selectedTemplate && (
            <>
              <Card title={selectedTemplate.title} description={selectedTemplate.description}>
                <div />
              </Card>

              <div className="space-y-3">
                {selectedTemplate.params.map((p) => (
                  <Field key={p.name} label={p.label} help={p.help}>
                    {p.type === 'select' ? (
                      <Select value={params[p.name] || ''} onChange={(e) => updateParam(p.name, e.target.value)}>
                        {p.options?.map((o) => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                      </Select>
                    ) : p.type === 'text' ? (
                      <Textarea value={params[p.name] || ''} onChange={(e) => updateParam(p.name, e.target.value)} rows={3} />
                    ) : p.type === 'number' ? (
                      <Input type="number" value={params[p.name] || ''} onChange={(e) => updateParam(p.name, e.target.value)} />
                    ) : (
                      <Input type={p.type} value={params[p.name] || ''} onChange={(e) => updateParam(p.name, e.target.value)} />
                    )}
                  </Field>
                ))}
              </div>
            </>
          )}

          <Field label="Namespace" help="hyperpod-ns-* namespaces get Kueue queue automatically">
            <Select value={namespace} onChange={(e) => setNamespace(e.target.value)}>
              {namespaces.map((ns) => (
                <option key={ns} value={ns}>
                  {ns}
                </option>
              ))}
            </Select>
          </Field>

          {priorityClasses && priorityClasses.length > 0 && (
            <Field label="Priority (optional)">
              <Select value={priority} onChange={(e) => setPriority(e.target.value)}>
                <option value="">Default</option>
                {priorityClasses.map((p: any) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <div className="flex gap-2">
            <Button onClick={() => setStep(3)}>Continue</Button>
            <Button variant="ghost" onClick={() => setStep(1)}>
              Back
            </Button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4">
          <Textarea value={yaml} onChange={(e) => setYaml(e.target.value)} rows={28} className="font-mono text-xs" placeholder="Paste or edit workflow YAML..." />

          {validation ? (
            validation.ok ? (
              <div className="bg-green-900/30 border border-green-700 rounded p-3">
                <div className="text-sm font-medium text-green-300">
                  Valid — {validation.tasks?.length || 0} tasks, order: {validation.order?.join(' → ')}
                </div>
                {validation.tasks && (
                  <div className="mt-3 overflow-x-auto text-xs">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-green-700">
                          <th className="text-left py-1 px-2">Name</th>
                          <th className="text-left py-1 px-2">Resource</th>
                          <th className="text-left py-1 px-2">Image</th>
                          <th className="text-left py-1 px-2">Parallelism</th>
                        </tr>
                      </thead>
                      <tbody>
                        {validation.tasks.map((t) => (
                          <tr key={t.name} className="border-b border-green-900">
                            <td className="py-1 px-2">{t.name}</td>
                            <td className="py-1 px-2">
                              {t.resource.cpu && <span>{t.resource.cpu}c </span>}
                              {t.resource.gpu && <span>{t.resource.gpu}x GPU </span>}
                              {t.resource.memory && <span>{t.resource.memory}</span>}
                            </td>
                            <td className="py-1 px-2 font-mono text-xs truncate">{t.image}</td>
                            <td className="py-1 px-2">{t.parallelism}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ) : (
              <div className="bg-red-900/30 border border-red-700 rounded p-3 space-y-2">
                <div className="text-sm font-medium text-red-300">{validation.error}</div>
                {validation.details?.issues && (
                  <ul className="list-disc pl-4 text-xs text-red-200">
                    {validation.details.issues.map((issue, i) => (
                      <li key={i}>{issue}</li>
                    ))}
                  </ul>
                )}
              </div>
            )
          ) : (
            <div className="text-xs text-gray-400">Validating...</div>
          )}

          <div className="flex gap-2 flex-wrap">
            <Button onClick={handleSubmit} disabled={!validation?.ok || submitMut.isPending || !can(me.data, 'researcher')}>
              {submitMut.isPending ? <Spinner /> : 'Submit'}
            </Button>
            <Button variant="ghost" onClick={() => setShowSaveTemplate(true)}>
              Save as template
            </Button>
            <Button variant="ghost" onClick={downloadYaml}>
              Download YAML
            </Button>
            <Button variant="ghost" onClick={() => setStep(2)}>
              Back
            </Button>
          </div>
        </div>
      )}

      <Dialog open={showSaveTemplate} onClose={() => setShowSaveTemplate(false)} title="Save as Template" footer={
        <>
          <Button variant="ghost" onClick={() => setShowSaveTemplate(false)}>
            Cancel
          </Button>
          <Button onClick={handleSaveTemplate} disabled={saveMut.isPending || !templateId || !templateTitle}>
            Save
          </Button>
        </>
      }>
        <div className="space-y-3">
          <Field label="Template ID">
            <Input value={templateId} onChange={(e) => setTemplateId(e.target.value)} placeholder="my-template" />
          </Field>
          <Field label="Title">
            <Input value={templateTitle} onChange={(e) => setTemplateTitle(e.target.value)} />
          </Field>
          <Field label="Description">
            <Textarea value={templateDesc} onChange={(e) => setTemplateDesc(e.target.value)} rows={3} />
          </Field>
          <Field label="Category">
            <Select value={templateCat} onChange={(e) => setTemplateCat(e.target.value as any)}>
              <option value="custom">Custom</option>
              <option value="data">Data</option>
              <option value="setup">Setup</option>
              <option value="training">Training</option>
              <option value="evaluation">Evaluation</option>
              <option value="simulation">Simulation</option>
            </Select>
          </Field>
        </div>
      </Dialog>
    </div>
  );
}
