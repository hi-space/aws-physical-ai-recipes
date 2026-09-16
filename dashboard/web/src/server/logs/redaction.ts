import { LIMITS } from './types';
/** Only exact trusted secret bytes are replaced. No URL, keyword, or line-content heuristics. */
export class SecretRedactor {
  private pending = Buffer.alloc(0);
  private readonly secrets: Buffer[];
  private readonly prefixes: Uint16Array[];
  constructor(values: string[]) {
    this.secrets = [...new Set(values.filter(Boolean))].map(v => Buffer.from(v)).sort((a, b) => b.length - a.length);
    if (this.secrets.length > 256 || this.secrets.some(v => v.length > LIMITS.chunk) || this.secrets.reduce((n, v) => n + v.length, 0) > 256 * 1024) throw new Error('Log redaction values exceed bounds');
    // Prefix fallback tables keep repeated-prefix suffix searches linear in secret length.
    this.prefixes = this.secrets.map(secret => {
      const prefix = new Uint16Array(secret.length);
      for (let i = 1, matched = 0; i < secret.length; i++) {
        while (matched && secret[i] !== secret[matched]) matched = prefix[matched - 1];
        if (secret[i] === secret[matched]) matched++;
        prefix[i] = matched;
      }
      return prefix;
    });
  }
  private retainedSuffix(data: Buffer): number {
    let keep = 0;
    for (let n = 0; n < this.secrets.length; n++) {
      const secret = this.secrets[n], prefix = this.prefixes[n];
      if (secret.length - 1 <= keep) continue;
      let matched = 0;
      // Only a proper prefix can need future bytes. Inspect at most length - 1 tail bytes.
      for (let i = Math.max(0, data.length - secret.length + 1); i < data.length; i++) {
        while (matched && data[i] !== secret[matched]) matched = prefix[matched - 1];
        if (data[i] === secret[matched]) matched++;
      }
      keep = Math.max(keep, matched);
    }
    return keep;
  }
  push(chunk: Uint8Array, final = false): Buffer {
    const data = Buffer.concat([this.pending, chunk]);
    const safeEnd = final ? data.length : data.length - this.retainedSuffix(data);
    const out: Buffer[] = []; let position = 0;
    while (position < safeEnd) {
      let first = -1, length = 0;
      for (const secret of this.secrets) {
        const at = data.indexOf(secret, position);
        if (at >= 0 && at < safeEnd && (first < 0 || at < first)) { first = at; length = secret.length; }
      }
      if (first < 0) { out.push(data.subarray(position, safeEnd)); position = safeEnd; break; }
      out.push(data.subarray(position, first), Buffer.from('[REDACTED]')); position = first + length;
    }
    this.pending = Buffer.from(data.subarray(position));
    return Buffer.concat(out);
  }
  finish() { return this.push(new Uint8Array(), true); }
}
