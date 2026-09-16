/** Browser replay position is a sequence, never inferred by comparing arbitrary line text. */
export class LogReplay {
  text = '';
  cursor?: string;
  streamId?: string;
  sequence?: number;
  gaps: string[] = [];
  truncated = false;
  private decoder = new TextDecoder();
  apply(raw: unknown) {
    const page = raw as { source?: string; stream?: { id?: string; sequence?: number }; records?: { sequence: number; kind: string; data?: string; reason?: string }[]; cursor?: string };
    if (page.source === 'none' && Array.isArray(page.records) && !page.records.length) return;
    if (!page.stream?.id || !/^[a-f0-9]{64}$/.test(page.stream.id) || !page.cursor || !/^[A-Za-z0-9_-]{43}$/.test(page.cursor) ||
      this.streamId && this.streamId !== page.stream.id || !Array.isArray(page.records) || page.records.length > 64) throw new Error('Invalid log replay page');
    let sequence = this.sequence;
    const additions: { bytes?: Uint8Array; reason?: string }[] = [];
    for (const r of page.records) {
      if (!Number.isSafeInteger(r.sequence) || r.sequence < 1) throw new Error('Invalid log sequence');
      if (sequence !== undefined && r.sequence <= sequence) continue;
      if (sequence !== undefined && r.sequence !== sequence + 1) throw new Error('Log replay skipped a committed record');
      if (r.kind === 'data') {
        if (typeof r.data !== 'string' || r.data.length > 21848) throw new Error('Log chunk exceeds bounds');
        const binary = atob(r.data);
        if (binary.length > 16384) throw new Error('Log chunk exceeds bounds');
        additions.push({ bytes: Uint8Array.from(binary, c => c.charCodeAt(0)) });
      } else if (r.kind === 'gap' && typeof r.reason === 'string' && r.reason.length < 64) additions.push({ reason: r.reason });
      else throw new Error('Invalid log record');
      sequence = r.sequence;
    }
    for (const a of additions) {
      if (a.bytes) this.text += this.decoder.decode(a.bytes, { stream: true });
      else this.gaps = [...this.gaps, a.reason!].slice(-100);
    }
    const lines = this.text.split('\n');
    if (lines.length > 10_000) { this.text = lines.slice(-10_000).join('\n'); this.truncated = true; }
    if (this.text.length > 1024 * 1024) { this.text = this.text.slice(-1024 * 1024); this.truncated = true; }
    this.sequence = sequence ?? page.stream.sequence;
    this.streamId = page.stream.id; this.cursor = page.cursor;
  }
}
