import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { LIVE_SERVER_PY, liveSidecar } from './live-view';

const python = ['python3', 'python'].find((bin) => spawnSync(bin, ['-c', 'import http.server'], { stdio: 'ignore' }).status === 0);
// 1x1 white JPEG (baseline) — enough for the SOF parser and a real browser.
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z', 'base64');
const freePort = () => new Promise<number>((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const port = (s.address() as { port: number }).port; s.close(() => resolve(port)); }); });
const get = async (url: string) => { const res = await fetch(url); return { status: res.status, type: res.headers.get('content-type') ?? '', body: Buffer.from(await res.arrayBuffer()) }; };
const until = async (check: () => Promise<boolean>, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check().catch(() => false)) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error('condition not met'); };

describe.skipIf(!python)('live view sidecar server', () => {
  let dir: string, port: number, child: ChildProcess, base: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pai-live-')); port = await freePort(); base = `http://127.0.0.1:${port}`;
    child = spawn(python!, ['-I', '-B', '-c', LIVE_SERVER_PY, dir, String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr!.on('data', (d) => { stderr += d; });
    await until(async () => (await get(`${base}/healthz`)).status === 200).catch((e) => { throw new Error(`${e}: ${stderr}`); });
  }, 15_000);
  afterAll(() => { child?.kill(); rmSync(dir, { recursive: true, force: true }); });

  it('serves the viewer page and reports no frames until the recipe publishes one', async () => {
    const page = await get(`${base}/`);
    expect(page.status).toBe(200); expect(page.type).toContain('text/html'); expect(page.body.toString()).toContain('/stream');
    expect(JSON.parse((await get(`${base}/status.json`)).body.toString())).toMatchObject({ frames: 0, age_seconds: null });
    expect((await get(`${base}/frame.jpg`)).status).toBe(404);
  });
  it('picks up atomically renamed frames, exposes dimensions and streams them as multipart JPEG parts', async () => {
    writeFileSync(join(dir, 'frame.tmp.jpg'), JPEG); renameSync(join(dir, 'frame.tmp.jpg'), join(dir, 'frame.jpg'));
    await until(async () => JSON.parse((await get(`${base}/status.json`)).body.toString()).frames === 1);
    expect(JSON.parse((await get(`${base}/status.json`)).body.toString())).toMatchObject({ frames: 1, width: 1, height: 1, bytes: JPEG.length });
    const frame = await get(`${base}/frame.jpg`); expect(frame.status).toBe(200); expect(frame.type).toBe('image/jpeg'); expect(frame.body.equals(JPEG)).toBe(true);
    const controller = new AbortController();
    const res = await fetch(`${base}/stream`, { signal: controller.signal });
    expect(res.headers.get('content-type')).toBe('multipart/x-mixed-replace; boundary=frame');
    const reader = res.body!.getReader(); let received = Buffer.alloc(0);
    while (received.length < JPEG.length + 60) { const { value, done } = await reader.read(); if (done) break; received = Buffer.concat([received, Buffer.from(value)]); }
    controller.abort();
    expect(received.toString('latin1')).toMatch(/^--frame\r\nContent-Type: image\/jpeg\r\nContent-Length: \d+\r\n\r\n/);
    expect(received.subarray(received.indexOf('\r\n\r\n') + 4, received.indexOf('\r\n\r\n') + 4 + JPEG.length).equals(JPEG)).toBe(true);
  });
  it('rejects non-JPEG or oversized files and builds a hardened native sidecar spec', async () => {
    writeFileSync(join(dir, 'frame.tmp.jpg'), Buffer.from('not a jpeg')); renameSync(join(dir, 'frame.tmp.jpg'), join(dir, 'frame.jpg'));
    await new Promise((r) => setTimeout(r, 300));
    expect(JSON.parse((await get(`${base}/status.json`)).body.toString()).frames).toBe(1);
    expect(liveSidecar('trusted/mujoco:fixed')).toMatchObject({ name: 'pai-live', restartPolicy: 'Always', securityContext: { readOnlyRootFilesystem: true, runAsNonRoot: true } });
    expect(() => liveSidecar('required://MUJOCO_IMAGE_URI')).toThrow(/trusted/);
    expect(LIVE_SERVER_PY).not.toMatch(/b"""[^"]*[^\x00-\x7f]/);
  });
});
