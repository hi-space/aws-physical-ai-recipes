import YAML from 'yaml';
import { badRequest } from '../errors';
import { validateSpec, workflowSchema, type WorkflowSpec } from './schema';

/** Placeholders resolved by the compiler, not by the user. */
const RESERVED = new Set(['output', 'workflow_id', 'task_name', 'replica_index']);
// Two alternatives: a placeholder that is the *entire* quoted scalar (opening and closing quote
// both consumed by the match, via the `\1` backreference) vs. a bare placeholder with no quote
// consumption. This distinction matters: only the former is safe to re-quote or de-quote, since
// only then do we know nothing else shares the scalar. A placeholder followed by trailing text
// inside the same quoted scalar (e.g. `"{{ foo }}-bar"`) must fall through to the second
// alternative, leaving the surrounding quotes untouched as literal text.
const VAR_RE = /(["'])\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)(?::(\d+))?\s*\}\}\1|\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)(?::(\d+))?\s*\}\}/g;

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
  const out = text.replace(VAR_RE, (
    m,
    quote: string | undefined,
    quotedName: string | undefined,
    quotedIdx: string | undefined,
    bareName: string | undefined,
    bareIdx: string | undefined,
  ) => {
    const name = quote !== undefined ? quotedName! : bareName!;
    const idx = quote !== undefined ? quotedIdx : bareIdx;
    if (RESERVED.has(name) || name === 'input') return m; // left for the compiler
    if (idx !== undefined) return m;
    if (!(name in vars)) {
      missing.add(name);
      return m;
    }
    const value = vars[name];
    // A whole-scalar `"{{ foo_version }}"` placeholder holding a plain integer is a version field
    // serialized as a string by YAML.stringify; drop the quotes so YAML parses it as a number.
    if (quote !== undefined && name.endsWith('_version') && /^\d+$/.test(value)) {
      return value;
    }
    // Whole-scalar quoted placeholder: reproduce the same quoting around the substituted value.
    if (quote !== undefined) return `${quote}${value}${quote}`;
    // Bare or partially-quoted placeholder (trailing text shares the scalar): substitute the
    // placeholder text only, leaving any surrounding quote characters as untouched literal text.
    return value;
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
