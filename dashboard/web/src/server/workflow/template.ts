import YAML from 'yaml';
import { badRequest } from '../errors';
import { validateSpec, workflowSchema, type WorkflowSpec } from './schema';

/** Placeholders resolved by the compiler, not by the user. */
const RESERVED = new Set(['output', 'workflow_id', 'task_name', 'replica_index']);
const VAR_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)(?::(\d+))?\s*\}\}/g;

export interface ParsedWorkflow {
  spec: WorkflowSpec;
  vars: Record<string, string>;
  yaml: string;
}

/** Extract `default-values` from raw YAML without substituting anything. */
export function readDefaults(text: string): Record<string, string> {
  const doc = YAML.parse(text) as { 'default-values'?: Record<string, unknown> } | null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(doc?.['default-values'] ?? {})) out[k] = String(v);
  return out;
}

export function substitute(text: string, vars: Record<string, string>): string {
  const missing = new Set<string>();
  const out = text.replace(VAR_RE, (m, name: string, idx?: string) => {
    if (RESERVED.has(name) || name === 'input') return m; // left for the compiler
    if (idx !== undefined) return m;
    if (!(name in vars)) {
      missing.add(name);
      return m;
    }
    return vars[name];
  });
  if (missing.size) throw badRequest(`Missing template variables: ${[...missing].join(', ')}`, { missing: [...missing] });
  return out;
}

/** Parse YAML, substitute variables, validate schema + semantics. */
export function parseWorkflowYaml(text: string, overrides: Record<string, string> = {}): ParsedWorkflow {
  let defaults: Record<string, string>;
  try {
    defaults = readDefaults(text);
  } catch (e) {
    throw badRequest(`YAML parse error: ${(e as Error).message}`);
  }
  const vars = { ...defaults, ...overrides };
  const substituted = substitute(text, vars);
  let raw: unknown;
  try {
    raw = YAML.parse(substituted);
  } catch (e) {
    throw badRequest(`YAML parse error after substitution: ${(e as Error).message}`);
  }
  const parsed = workflowSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`);
    throw badRequest(`Invalid workflow spec: ${issues.join('; ')}`, { issues });
  }
  const errors = validateSpec(parsed.data);
  if (errors.length) throw badRequest(`Invalid workflow spec: ${errors.join('; ')}`, { issues: errors });
  return { spec: parsed.data, vars, yaml: substituted };
}

export function specToYaml(spec: WorkflowSpec): string {
  return YAML.stringify(spec, { lineWidth: 0 });
}
