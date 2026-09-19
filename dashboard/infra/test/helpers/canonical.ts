/**
 * Canonicalise a synthesized CloudFormation template for parity comparison.
 *
 * - Recursively **sorts object keys**. The `Resources` block is a map, so
 *   CloudFormation ignores key order; the construct-creation order changed in the
 *   ingress/web/controller/gateway split, and sorting neutralises that harmless
 *   relocation.
 * - **Preserves array order.** Container `Environment` arrays are order-sensitive
 *   (a reorder mints a new task-definition revision and forces a redeploy), so a
 *   reordering here MUST surface as a diff. That is the property this gate protects.
 * - Strips volatile asset identity so the committed fixture survives unrelated
 *   source edits: 64-hex asset hashes → `<HASH>`, and `aws:cdk:path` / `aws:asset:*`
 *   metadata keys are removed.
 */
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (key === 'aws:cdk:path' || key.startsWith('aws:asset:')) continue;
      out[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  if (typeof value === 'string') return value.replace(/[0-9a-f]{64}/g, '<HASH>');
  return value;
}
