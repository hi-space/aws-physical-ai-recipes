import YAML from 'yaml';
import { z } from 'zod';
import { body, route } from '@/server/api';
import { getRepo } from '@/server/store/repo';
import { BUILTIN_TEMPLATES } from '@/server/workflow/builtin-templates';
import { requestProject } from '@/server/auth/projects';
import { forbidden } from '@/server/errors';
import { assertTemplateWrite, canReadTemplate, templateDefaults, validateTemplateContent } from './_shared';
import type { RecipeMetadata } from '@/lib/workflow/recipe-metadata';
import type { TemplateDto } from '@/lib/workflow/template-dto';
export const dynamic = 'force-dynamic';

export const GET = route('viewer', async ({ session, req }) => {
  const repo = getRepo();
  const selected = session.tokenProjectId || req.headers.get('x-pai-project') || /(?:^|;\s*)pai-project=([^;]+)/.exec(req.headers.get('cookie') ?? '')?.[1];
  const project = selected ? await requestProject(req, session) : undefined;
  for (const template of BUILTIN_TEMPLATES) await repo.putTemplate(template);
  const templates = await repo.listTemplates();
  const visible = await Promise.all(templates.map(template => canReadTemplate(session, template, repo, project?.id)));
  const dto: TemplateDto[] = templates
    .filter((_, index) => visible[index])
    .map(template => {
      let recipe: RecipeMetadata | null = null;
      try {
        const parsed = YAML.parse(template.yaml) as { ui?: { recipe?: RecipeMetadata } };
        recipe = parsed.ui?.recipe ?? null;
      } catch {
        // Custom templates may have malformed or recipe-less YAML; treat as no metadata.
      }
      return { ...template, recipe };
    });
  return dto;
});
const schema = z.object({
  id: z.string().regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/).max(40),
  title: z.string().min(1).max(80),
  description: z.string().max(400).default(''),
  category: z.enum(['simulation', 'training', 'evaluation', 'data', 'setup', 'custom']).default('custom'),
  yaml: z.string().min(1).max(240_000),
  params: z.array(z.object({ name: z.string().min(1).max(100), label: z.string().max(100), type: z.enum(['string', 'number', 'select', 'boolean', 'text', 'dataset', 'image']), default: z.string().max(4096).optional(), options: z.array(z.string().max(4096)).max(100).optional(), help: z.string().max(2000).optional(), versionParam: z.string().min(1).max(100).optional() }).strict()).max(100).optional(),
  requires: z.array(z.enum(['gpu', 'fsx', 'mlflow'])).optional(),
  baseVersion: z.number().int().min(0).max(999_999_999_999).optional(),
}).strict();
export const POST = route('researcher', async ({ req, session }) => {
  const input = await body(req, schema), repo = getRepo();
  if (BUILTIN_TEMPLATES.some(template => template.id === input.id)) throw forbidden('Built-in templates cannot be changed');
  const existing = await repo.getTemplate(input.id, undefined, { includeDeleted: true });
  const owningProject = existing ? await assertTemplateWrite(session, existing, repo) : undefined;
  // Legacy recipes keep their private ownership; authoring still requires a project writer.
  const project = owningProject ?? await requestProject(req, session, 'researcher');
  const defaults = templateDefaults(input.yaml);
  const params = input.params ?? Object.entries(defaults).map(([name, value]) => ({ name, label: name, type: 'string' as const, default: value }));
  validateTemplateContent(input.yaml, params);
  return repo.putTemplate({
    id: input.id, title: input.title, description: input.description, category: input.category,
    yaml: input.yaml, params, requires: input.requires, builtin: false,
    projectId: existing ? existing.projectId : project.id,
    ownerSubject: existing ? existing.ownerSubject : session.subject ?? session.user,
    createdBy: existing ? existing.createdBy : session.user,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  }, { expectedVersion: input.baseVersion ?? existing?.templateVersion ?? 0, actor: session.user, actorSubject: session.subject ?? session.user });
}, { audit: 'template.save' });
