# Kubernetes integration

`python apply_addons.py --cluster <cluster> --region us-east-1` is the reproducible
deployment step for dashboard-owned access bindings, workload service accounts,
network policies and JobSet. `--render-only` emits the owned Kubernetes objects
without AWS or Kubernetes calls.

The script preserves existing CNI configuration and changes only the documented
network-policy switches. Policies select `app.kubernetes.io/managed-by=physical-ai-dashboard`;
ordinary workshop workloads and AWS-managed Kueue resources are not selected.
The runtime initialization gate verifies metadata endpoints are unreachable
before user code starts in CNI standard mode.

JobSet v0.12.0 is downloaded from its official release and its SHA-256 digest is
checked against the GitHub release asset digest. Existing JobSet CRDs are reused.
The controller deployment must become ready before this step succeeds.

References:

- `https://docs.aws.amazon.com/eks/latest/userguide/cni-network-policy-configure.html`
- `https://github.com/kubernetes-sigs/jobset/releases/tag/v0.12.0`
