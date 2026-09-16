export function fmtBytes(n?: number): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function fmtDuration(ms?: number): string {
  if (ms === undefined || ms < 0 || Number.isNaN(ms)) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function ago(iso?: string | number | Date): string {
  if (!iso) return '—';
  const t = typeof iso === 'number' ? iso : new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diff = Date.now() - t;
  if (diff < 0) return 'now';
  return `${fmtDuration(diff)} ago`;
}

export function fmtTime(iso?: string | number | Date): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function fmtNum(n?: number, digits = 1): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return n.toFixed(Number.isInteger(n) ? 0 : digits);
}

export function fmtUsd(n?: number): string {
  if (n === undefined || Number.isNaN(n)) return '—';
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

export function elapsed(start?: string, end?: string): string {
  if (!start) return '—';
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  return fmtDuration(e - s);
}

/** Kubernetes quantity ("12", "500m", "16Gi") → number in base units (cores / bytes). */
export function parseQuantity(q?: string): number {
  if (!q) return 0;
  const m = /^([0-9.]+)([a-zA-Z]*)$/.exec(q);
  if (!m) return Number(q) || 0;
  const n = Number(m[1]);
  const mult: Record<string, number> = { '': 1, m: 1e-3, k: 1e3, M: 1e6, G: 1e9, T: 1e12, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 };
  return n * (mult[m[2]] ?? 1);
}

export function shortId(s?: string, n = 8): string {
  return s ? s.slice(0, n) : '—';
}

export function classNames(...xs: (string | false | null | undefined)[]): string {
  return xs.filter(Boolean).join(' ');
}
