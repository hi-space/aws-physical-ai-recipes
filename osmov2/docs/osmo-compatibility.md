# OSMO Compatibility

This repo tracks NVIDIA OSMO as an external dependency. It does not carry local OSMO patches or invoke upstream Kubernetes deployment scripts as the primary AWS path.

## NVIDIA/OSMO PR #894

[NVIDIA/OSMO PR #894](https://github.com/NVIDIA/OSMO/pull/894) addresses AWS-relevant deployment behavior in the upstream script path.

Until the fix is present in the pinned OSMO release, this repo avoids the problematic path by installing the Helm charts directly with AWS-owned values and explicit bootstrap steps:

- Do not invoke upstream `deploy-k8s.sh` as the primary deployment mechanism.
- Set `podMonitor.enabled=false` unless Prometheus Operator CRDs are present and `ENABLE_POD_MONITOR=true`.
- Create the `backend-operator` user before generating the backend token.
- Generate the backend token with `--user backend-operator`.
- Fail fast if user creation, token generation, Helm install, or rollout checks fail.

## Workflow Storage Credential

OSMO 6.2 workflow configuration accepts static data credentials for workflow data, logs, and apps. It does not yet propagate AWS SDK default credentials or session tokens into the workflow runtime. For a reproducible AWS smoke path, this repo creates a least-privilege IAM access key limited to the artifact bucket and KMS key, then configures OSMO workflow storage through the deploy wrapper.

When a pinned OSMO release supports keyless AWS workflow storage, replace this compatibility key with IRSA or pod identity for workflow pods.

## Workflow Callback URL

OSMO 6.2 uses `SERVICE.service_base_url` for `osmo-ctrl` workflow callbacks, including JWT refresh and workflow log websocket connections. The baseline deployment intentionally avoids public ingress. In that mode, `scripts/deploy-osmo.sh` sets the callback URL to the in-cluster `osmo-logger` service because the direct API service does not serve the logger websocket route.

If a later phase adds an authenticated ingress or supported Envoy routing path, update `OSMO_WORKFLOW_CALLBACK_URL` to that unified service URL and validate the CPU smoke workflow again.

## PodGroup CRD

OSMO 6.2 emits `scheduling.run.ai/v2alpha2` `PodGroup` objects from the KAI scheduler path even for the CPU-only smoke workflow. This repo installs the pinned KAI Scheduler chart by default before OSMO and sets the backend scheduler name to `kai-scheduler`.

KAI Scheduler is pinned to `v0.13.0` for OSMO 6.2 compatibility. `v0.13.0` is also the minimum version named in NVIDIA's April 2026 KAI security bulletin. Upgrade KAI only through an explicit PR that reruns the OSMO smoke workflow through real KAI scheduling.

The CPU baseline sets KAI `admission.gpuPodRuntimeClassName` to an empty string so CPU-only OSMO workflow pods are not mutated to `runtimeClassName: nvidia`. Set `KAI_GPU_POD_RUNTIME_CLASS_NAME` only after the target worker nodes have the matching container runtime handler.

For constrained local experiments, set `OSMO_INSTALL_KAI=false` before `scripts/deploy-osmo.sh` to use the Kubernetes `default-scheduler` path with the minimal PodGroup compatibility CRD. Do not use that fallback for the AWS reference validation path.

## Autoscaler-Aware GPU Capacity

OSMO 6.2 validates workflow resources against capacity already visible to the OSMO backend. Karpenter, by design, creates GPU nodes only after Kubernetes sees pending pods. That means an OSMO workflow that requires a large GPU node can be rejected before Karpenter has a chance to provision the node.

This reference works around that boundary by using `scripts/prewarm-gpu-node.sh` before OSMO-submitted GPU workflows. The prewarm pod is not part of the training pipeline; it only makes the target G7e platform visible so OSMO resource validation can pass. After the workflow completes, `scripts/wait-gpu-node-cleanup.sh` deletes the prewarm pod and verifies that Karpenter removes empty GPU nodes.

A useful upstream OSMO contribution would be an autoscaler-aware capacity provider or deferred resource validation mode. For Karpenter, OSMO could inspect `NodePool` and `EC2NodeClass` constraints, model provisionable instance capacity, and submit the Kubernetes workload so Karpenter can provision nodes from the resulting pending pods. That would remove the need for prewarm pods while preserving OSMO's resource validation model.

After PR #894 is included in a pinned OSMO release, keep this note for traceability but remove any temporary compatibility branching that is no longer needed.

## Port-Forward Relays Through the Public Router Address

`osmo workflow port-forward` does not tunnel through the Kubernetes API. It relays over a WebSocket to `BACKEND.router_address`, and both ends dial that address: the operator's CLI, and the `osmo-ctrl` sidecar inside the workload pod. In this reference that address is the CloudFront domain, so the pod's egress IP (the VPC NAT gateway) must be in the CloudFront WAF allow list alongside the operator's IP. `infra/cloudfront` takes those addresses in `cluster_nat_public_ips`, and `scripts/deploy-osmo-sso-bootstrap.sh` fills it from the `infra/core` output `nat_public_ips`.

Two distinct failure modes were observed on the `us-east-1` reference cluster on 2026-09-15, both of which look like a hung port-forward rather than an access denial:

- `router_address` still held the SSO bootstrap placeholder (`wss://placeholder.cloudfront.net`), so the CLI failed immediately with HTTP 500 and `Failed to resolve 'placeholder.cloudfront.net'`. The bootstrap's step 2 writes the placeholder and step 4 does not rewrite this field, so verify it after a bootstrap run with `osmo config show BACKEND`.
- With the address corrected but the NAT IP missing from the WAF, the CLI printed `Starting port forwarding ...` for every port and then looped `Reconnect to remote port <n> in <k> seconds...` forever while carrying no data. The cause is only visible pod-side: `kubectl -n <workload-namespace> logs <pod> -c osmo-ctrl` shows `userPortForwardTCP: error connecting to the router: websocket: bad handshake`, and an in-pod `curl` to the router returns 403 from CloudFront.

To tell a relay problem apart from a workload problem, compare the OSMO forward against `kubectl port-forward` to the same container port. If `kubectl` returns the application's response and OSMO times out, the workload is fine and the relay is blocked.

## CLI 6.3.1 `--udp` Port-Forward Is Broken

`osmo workflow port-forward --udp` exits as soon as it has opened its listeners. Reproduced with client `6.3.1.210ffea0`:

```
File "src/lib/utils/port_forward.py", line 303, in run_udp
File "asyncio/tasks.py", line 429, in wait
TypeError: Passing coroutines is forbidden, use tasks explicitly.
```

`asyncio.wait` stopped accepting bare coroutines in Python 3.11, and `run_udp` still passes them. The TCP path is unaffected. This blocks the UDP media channel that Isaac Sim WebRTC streaming needs, so only the TCP signalling port (`49100`) can be exercised with the shipped CLI. There is no server-side workaround; it needs an upstream CLI fix or a locally patched client.

Fixing it does not make WebRTC streaming work, for the reason in the next section.

## Port-Forward Cannot Carry WebRTC Media

`osmo workflow port-forward` cannot deliver an Isaac Sim WebRTC video stream to a client outside the cluster VPC, regardless of which ports are mapped. This is a property of how WebRTC negotiates addresses, not a defect in the OSMO relay.

Isaac Sim gathers host ICE candidates from the pod's own interface only, so the SDP it offers advertises the pod's VPC address. A port forwarder maps those ports onto the client's `localhost`, an address that appears nowhere in the SDP, so ICE has no valid candidate pair to check. Signalling succeeds and STUN binding requests cross the tunnel, then the connection fails.

Measured on the `us-east-1` reference cluster on 2026-09-15 from a macOS client against a fully loaded Isaac Sim 4.5.0 on `g6.2xlarge`, with both TCP and UDP tunnels up:

- signalling over TCP `49100` connected
- TCP ICE candidates offered: 0, so a TCP-only media path is not available either
- the UDP tunnel forwarded 100+ requests and 400+ responses, so it was not blocked
- payloads were STUN binding only (96B request, 64B response); no media
- ICE went `checking` -> `disconnected`, with `total_bps=0` and `framesDecoded=0`

Resolving this inside a forwarder would require rewriting the SDP and ICE candidates, which is an application-layer gateway role the relay does not fill. The fix is to make the pod IP reachable from the client instead: a VPN or subnet router into the cluster VPC, or a GUI desktop instance inside the VPC. In both cases allow the client source to reach TCP `49100` and UDP `47998` on the node security group, which `fixedHostPort` pins (see below).

A TURN relay is not an option. Isaac Sim exposes no ICE server setting at all: enumerating every `/app/livestream/*` key in the shipped `libcarb.livestream-rtc.plugin.so` returns 20 keys on 5.1.0 and 10 on 4.5.0, and neither set contains `iceServer`, `stunServer`, or `turnServer`. Standing up a TURN server in the VPC would not help because Isaac Sim never gathers relay candidates.

### 5.1.0 Can Pin the Advertised Address, and It Still Is Not Enough

Isaac Sim 5.1.0 accepts `--/app/livestream/publicEndpointAddress` and `--/app/livestream/publicEndpointPort`, which override the address carried in the SDP, plus `--/app/livestream/fixedHostPort` to pin the media port. The 4.5.0 image has none of these — it has no way to advertise anything but the pod's own address, which is the direct cause of the 4.5.0 failure above.

Measured on the `us-east-1` reference cluster on 2026-09-15 with 5.1.0 on `g6.2xlarge`, `publicEndpointAddress=127.0.0.1` and `fixedHostPort=47998`:

- both settings took effect: the pod listened on TCP `49100` and UDP `47998` while idle, and the SDP advertised `127.0.0.1:47998`
- streaming server came up in 63s, versus roughly 8m20s for 4.5.0
- the client still failed. ICE never completed, and the server logged repeated `NVST_CCE_DISCONNECTED` with `m_connectionCount` underflowing past zero
- reproduced with WebRTC Streaming Client 1.0.6 and 1.1.5

So pinning the advertised address is necessary but not sufficient. ICE only accepts a STUN response that returns on the exact 5-tuple the request left from, and wrapping UDP in a WebSocket relay does not preserve the source address and port. That is a property of tunnelling UDP over a stream transport, not of any one client platform — four combinations (4.5.0 and 5.1.0, clients 1.0.6 and 1.1.5) fail at the same point.

`publicEndpointAddress` is still worth setting when the client reaches the pod directly, since the pod IP is then a routable address and `fixedHostPort` reduces the security-group opening to a single UDP port.

Do not diagnose a blank stream as a client-install, resolution, or codec problem before checking the candidate addresses. See `examples/isaacsim-livestream/validation.md` for the full run.
