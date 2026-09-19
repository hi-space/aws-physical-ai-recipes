/**
 * Live view (stage 2 of "see the simulation in the dashboard"): a task opts in with `live: true`,
 * the compiler adds a trusted MJPEG sidecar that serves whatever JPEG the recipe drops at
 * `$PAI_LIVE_DIR/frame.jpg` (atomic rename). The browser reaches it through a normal port-forward
 * session on the reserved `pai-live` port, so RBAC, ownership and lifetime rules are unchanged.
 *
 * The sidecar is a Kubernetes native sidecar (init container with restartPolicy Always): it starts
 * before `main` and the kubelet stops it once `main` exits, so Jobs still complete.
 */
import { workloadSecurity } from './storage-layout';

export const LIVE_PORT = 8090;
export const LIVE_PORT_NAME = 'pai-live';
export const LIVE_DIR = '/pai/live';
export const LIVE_VOLUME = 'pai-live';
export const LIVE_CONTAINER = 'pai-live';

/** Python 3 stdlib only; runs with `python -I -B -c` in the trusted inventory image. Never sourced from YAML. */
export const LIVE_SERVER_PY = String.raw`
import json, os, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
root, port = sys.argv[1], int(sys.argv[2])
FRAME = os.path.join(root, "frame.jpg")
MAX_FPS, IDLE_RESEND, MAX_BYTES = 15.0, 5.0, 8 * 1024 * 1024
PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>Live view</title>
<style>html,body{margin:0;height:100%;background:#0b0f17;color:#cbd5e1;font:13px system-ui,sans-serif}
#wrap{display:flex;flex-direction:column;height:100%}#v{flex:1;min-height:0;object-fit:contain;background:#000;display:none}
#s{padding:6px 10px;display:flex;gap:12px;align-items:center;border-top:1px solid #1f2937}#w{flex:1;display:flex;align-items:center;justify-content:center;color:#64748b}
.dot{width:8px;height:8px;border-radius:50%;background:#64748b}.dot.on{background:#22c55e}</style></head>
<body><div id="wrap"><div id="w">simulation frames not published yet</div><img id="v" alt="live simulation frames">
<div id="s"><span class="dot" id="d"></span><span id="t">waiting for frames</span><span id="f"></span></div></div>
<script>
const v=document.getElementById('v'),w=document.getElementById('w'),d=document.getElementById('d'),t=document.getElementById('t'),f=document.getElementById('f');
let live=false;function start(){v.src='stream?'+Date.now();}
v.onload=()=>{};v.onerror=()=>{live=false;setTimeout(start,1500);};
async function poll(){try{const r=await fetch('status.json',{cache:'no-store'});const s=await r.json();
if(s.frames>0){if(!live){live=true;start();}v.style.display='block';w.style.display='none';d.className='dot on';
t.textContent='live · frame '+s.frames+' · '+s.width+'x'+s.height;f.textContent=s.age_seconds>10?('last frame '+Math.round(s.age_seconds)+'s ago'):'';}
else{t.textContent='waiting for frames';}}catch(e){d.className='dot';t.textContent='stream unavailable';}setTimeout(poll,2000);}poll();
</script></body></html>""".encode("utf-8")
lock = threading.Lock()
state = {"frames": 0, "mtime": 0.0, "data": b"", "width": 0, "height": 0}

def jpeg_size(data):
    # SOF0/SOF2 markers carry height, width; return (0, 0) if not found.
    i = 2
    while i + 9 < len(data):
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker in (0xC0, 0xC1, 0xC2):
            return int.from_bytes(data[i + 7:i + 9], "big"), int.from_bytes(data[i + 5:i + 7], "big")
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        i += 2 + int.from_bytes(data[i + 2:i + 4], "big")
    return 0, 0

def refresh():
    try:
        st = os.stat(FRAME)
    except OSError:
        return
    if st.st_mtime_ns == state["mtime"] or st.st_size <= 0 or st.st_size > MAX_BYTES:
        return
    try:
        with open(FRAME, "rb") as handle:
            data = handle.read()
    except OSError:
        return
    if len(data) < 4 or data[:2] != b"\xff\xd8":
        return
    with lock:
        state["mtime"], state["data"], state["frames"] = st.st_mtime_ns, data, state["frames"] + 1
        state["width"], state["height"] = jpeg_size(data)

def watcher():
    while True:
        refresh()
        time.sleep(1.0 / (MAX_FPS * 2))

class Handler(BaseHTTPRequestHandler):
    server_version, sys_version = "pai-live", ""
    def log_message(self, *_args):
        pass
    def head(self, status, ctype, extra=()):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for key, value in extra:
            self.send_header(key, value)
        self.end_headers()
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/healthz":
            self.head(200, "text/plain"); self.wfile.write(b"ok"); return
        if path == "/status.json":
            with lock:
                body = json.dumps({"frames": state["frames"], "age_seconds": (time.time_ns() - state["mtime"]) / 1e9 if state["mtime"] else None,
                                   "bytes": len(state["data"]), "width": state["width"], "height": state["height"]}).encode()
            self.head(200, "application/json", [("Content-Length", str(len(body)))]); self.wfile.write(body); return
        if path == "/frame.jpg":
            with lock:
                data = state["data"]
            if not data:
                self.head(404, "text/plain"); self.wfile.write(b"no frame yet"); return
            self.head(200, "image/jpeg", [("Content-Length", str(len(data)))]); self.wfile.write(data); return
        if path == "/stream":
            self.head(200, "multipart/x-mixed-replace; boundary=frame", [("Connection", "close")])
            sent, last_sent_at = 0, 0.0
            while True:
                with lock:
                    mtime, data = state["mtime"], state["data"]
                now = time.time()
                if data and (mtime != sent or now - last_sent_at >= IDLE_RESEND):
                    try:
                        self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " + str(len(data)).encode() + b"\r\n\r\n" + data + b"\r\n")
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError, OSError):
                        return
                    sent, last_sent_at = mtime, now
                time.sleep(1.0 / MAX_FPS)
        if path == "/":
            self.head(200, "text/html; charset=utf-8", [("Content-Length", str(len(PAGE))),
                ("Content-Security-Policy", "default-src 'none'; img-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'")])
            self.wfile.write(PAGE); return
        self.head(404, "text/plain"); self.wfile.write(b"not found")

threading.Thread(target=watcher, daemon=True).start()
server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
server.daemon_threads = True
print(f"pai-live serving {root} on :{port}", flush=True)
server.serve_forever()
`;

/** Native sidecar spec (goes in initContainers). `image` must be a trusted dashboard image, never task YAML. */
export function liveSidecar(image: string) {
  if (!image || image.startsWith('required://') || /[\s{}]/.test(image)) throw new Error('Live view requires the trusted MUJOCO_IMAGE_URI Python image');
  return {
    name: LIVE_CONTAINER,
    image,
    imagePullPolicy: 'IfNotPresent',
    restartPolicy: 'Always',
    command: ['python', '-I', '-B', '-c', LIVE_SERVER_PY, LIVE_DIR, String(LIVE_PORT)],
    securityContext: { ...workloadSecurity, readOnlyRootFilesystem: true },
    resources: { requests: { cpu: '100m', memory: '64Mi' }, limits: { cpu: '500m', memory: '256Mi' } },
    volumeMounts: [{ name: LIVE_VOLUME, mountPath: LIVE_DIR, readOnly: true }],
    startupProbe: { httpGet: { path: '/healthz', port: LIVE_PORT }, periodSeconds: 2, failureThreshold: 30 },
  };
}

export const liveVolume = () => ({ name: LIVE_VOLUME, emptyDir: { sizeLimit: '256Mi' } });
export const liveMainMount = () => ({ name: LIVE_VOLUME, mountPath: LIVE_DIR });
export const livePort = () => ({ name: LIVE_PORT_NAME, containerPort: LIVE_PORT, protocol: 'TCP' });
