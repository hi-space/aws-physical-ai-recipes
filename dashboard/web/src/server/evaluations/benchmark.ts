/** Workshop N1.6 benchmark JSON, including failed/skipped TensorRT modes.
 * Source: e2e-workshop/edge/workshop-components/N1.6/com.workshop.benchmark/recipe.yaml.
 * No performance value is synthesized or inferred from a failure.
 */
export interface BenchmarkMeasurement {
  mode: string;
  status: 'measured' | 'failed' | 'skipped';
  avg_ms?: number; p50_ms?: number; p95_ms?: number; p99_ms?: number; std_ms?: number;
  hz?: number; iterations?: number; error?: string; reason?: string;
}
export interface ParsedBenchmark {
  results: BenchmarkMeasurement[];
  envelope?: Record<string, unknown>;
}
const fields = ['avg_ms', 'p50_ms', 'p95_ms', 'p99_ms', 'std_ms', 'hz', 'iterations'] as const;
function measurements(input: unknown): BenchmarkMeasurement[] {
  if (!Array.isArray(input) || !input.length || input.length > 20) throw new Error('Expected 1–20 benchmark modes');
  const modes = new Set<string>();
  return input.map(value => {
    if (!value || typeof value !== 'object' || typeof value.mode !== 'string' || !/^[a-zA-Z0-9_.-]{1,80}$/.test(value.mode) || modes.has(value.mode)) throw new Error('Invalid or duplicate benchmark mode');
    modes.add(value.mode);
    if (value.status === 'failed' || value.status === 'skipped') {
      if (fields.some(field => field in value)) throw new Error('Failed/skipped mode cannot claim measured statistics');
      return { mode: value.mode, status: value.status,
        ...(typeof value.error === 'string' ? { error: value.error.slice(0, 2000) } : {}),
        ...(typeof value.reason === 'string' ? { reason: value.reason.slice(0, 2000) } : {}) };
    }
    for (const field of fields) if (typeof value[field] !== 'number' || !Number.isFinite(value[field]) || value[field] < 0) throw new Error(`Invalid benchmark ${field}`);
    if (value.avg_ms <= 0 || value.hz <= 0 || !Number.isSafeInteger(value.iterations) || value.iterations < 1 || value.iterations > 1_000_000 ||
        value.p50_ms > value.p95_ms || value.p95_ms > value.p99_ms) throw new Error('Inconsistent benchmark quantiles/iterations');
    // Workshop values are rounded to two decimals. Do not demand exact reciprocal equality.
    if (Math.abs(value.avg_ms * value.hz - 1000) > Math.max(25, 0.011 * value.hz)) throw new Error('Frequency does not agree with measured average latency');
    return { mode: value.mode, status: 'measured', ...Object.fromEntries(fields.map(field => [field, value[field]])) };
  });
}
export function parseBenchmark(input: unknown): ParsedBenchmark {
  let value = input;
  if (typeof value === 'string') {
    if (value.length > 4 * 1024 * 1024) throw new Error('Benchmark payload is too large');
    try { value = JSON.parse(value); }
    catch {
      // The original workshop prints prose before its final JSON array.
      const text = value as string;
      const spans: [number, number][] = [];
      let start = 0, depth = 0, quoted = false, escaped = false, completed = 0;
      for (let i = 0; i < text.length; i++) {
        const character = text[i];
        if (!depth) { if (character === '[') { start = i; depth = 1; quoted = false; } continue; }
        if (quoted) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === '"') quoted = false;
        } else if (character === '"') quoted = true;
        else if (character === '[') depth++;
        else if (character === ']' && --depth === 0) spans[completed++ % 128] = [start, i + 1];
      }
      for (const [start, end] of spans.sort((a, b) => b[1] - a[1])) {
        try { return { results: measurements(JSON.parse(text.slice(start, end))) }; } catch { /* skip prose arrays */ }
      }
      throw new Error('No valid workshop benchmark JSON array was found');
    }
  }
  if (Array.isArray(value)) return { results: measurements(value) };
  if (value && typeof value === 'object' && 'results' in value) {
    return { results: measurements(value.results), envelope: value as Record<string, unknown> };
  }
  throw new Error('Expected workshop result array or versioned benchmark envelope');
}
