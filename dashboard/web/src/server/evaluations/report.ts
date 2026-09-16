import { z } from 'zod';
import { badRequest } from '../errors';
import type { NormalizedEvaluation } from './types';

export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i).transform(s => s.toLowerCase());
const finite = z.number().finite();
const count = z.number().int().nonnegative().max(100_000);
const seed = z.number().int().nonnegative().max(0xffffffff);
export function safeRelativePath(value: string): string {
  if (!value || value.length > 2048 || /[\\\u0000-\u001f:]/.test(value) ||
      value.split('/').some(part => !part || part === '.' || part === '..')) throw badRequest('Artifact path must stay inside its published manifest');
  return value;
}
const relativePath = z.string().superRefine((value, ctx) => {
  try { safeRelativePath(value); } catch { ctx.addIssue({ code: 'custom', message: 'Unsafe relative artifact path' }); }
});
const episode = z.object({
  index: count, seed, steps: z.number().int().positive(),
  success: z.boolean(), timeout: z.boolean(), return: finite.optional(),
  finalDistance: finite.nonnegative().optional(), videoUri: relativePath,
});
const reportSchema = z.object({
  schemaVersion: z.literal(1), type: z.literal('closed_loop'),
  status: z.literal('completed').optional(),
  task: z.string().min(1).max(200), seed,
  episodeCount: count.min(1).max(10_000), requestedEpisodeCount: count.optional(),
  successCount: count, successRate: finite.min(0).max(1),
  timeoutCount: count.optional(), timeoutSeconds: finite.positive().optional(),
  latencyMs: z.object({ p50: finite.nonnegative().optional(), p95: finite.nonnegative().optional(), p99: finite.nonnegative().optional() }).nullable().optional(),
  checkpointDigest: sha256Schema, normalizationDigest: sha256Schema.optional(),
  simulator: z.record(z.string().max(100), z.string().max(1024))
    .refine(value => Boolean(value.name && value.version), 'Simulator name and version are required'),
  videoUri: relativePath, episodes: z.array(episode).min(1).max(10_000),
});

/** Parse bytes retrieved by the server, never a client-supplied metrics object. */
export function normalizeEvaluationReport(value: unknown): NormalizedEvaluation {
  const parsed = reportSchema.safeParse(value);
  if (!parsed.success) throw badRequest('Invalid or incomplete published evaluation report', { issues: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) });
  const r = parsed.data;
  const failures: string[] = [];
  if (r.episodes.length !== r.episodeCount) failures.push('Episode count differs from recorded rounds');
  if (r.requestedEpisodeCount !== undefined && r.requestedEpisodeCount !== r.episodeCount) failures.push('Evaluation did not finish every requested round');
  if (r.successCount > r.episodeCount || r.episodes.filter(e => e.success).length !== r.successCount) failures.push('Success count differs from recorded rounds');
  if (Math.abs(r.successRate - r.successCount / r.episodeCount) > 1e-9) failures.push('Success rate differs from counts');
  if (r.timeoutCount !== undefined && r.episodes.filter(e => e.timeout).length !== r.timeoutCount) failures.push('Timeout count differs from recorded rounds');
  if (r.episodes.some((e, i) => e.index !== i || e.seed !== r.seed + i)) failures.push('Episode indices/seeds must match the recorded sequence');
  if (r.videoUri !== r.episodes[0].videoUri) failures.push('Primary video does not match the first round');
  const quantiles = [r.latencyMs?.p50, r.latencyMs?.p95, r.latencyMs?.p99].filter((n): n is number => n !== undefined);
  if (quantiles.some((n, i) => i > 0 && n < quantiles[i - 1])) failures.push('Latency quantiles are not ordered');
  if (failures.length) throw badRequest('Inconsistent published evaluation evidence', { issues: failures });
  return {
    metrics: { kind: 'simulation', episodes: r.episodeCount, successes: r.successCount,
      ...(r.latencyMs?.p95 !== undefined ? { latencyP95Ms: r.latencyMs.p95 } : {}) },
    task: r.task, seed: r.seed, successRate: r.successRate,
    ...(r.timeoutCount !== undefined ? { timeoutCount: r.timeoutCount } : {}),
    ...(r.timeoutSeconds !== undefined ? { timeoutSeconds: r.timeoutSeconds } : {}),
    ...(r.latencyMs ? { latencyMs: r.latencyMs } : {}),
    checkpointDigest: r.checkpointDigest,
    ...(r.normalizationDigest ? { normalizationDigest: r.normalizationDigest } : {}),
    simulator: r.simulator, videoPaths: [...new Set(r.episodes.map(e => e.videoUri))],
  };
}
