# Administrator-approved execution profiles

Execution profiles provide an explicit trusted-administrator path for device mounts, host networking, root and privileged containers. Ordinary project submissions still reject raw `volumes`, arbitrary Pod security fields and unapproved images.

This is a different trust boundary from ordinary researcher Pods. A privileged process can inspect its worker host and the host's accessible data or credentials. Dedicated nodes and approval checks reduce accidental placement; they do not turn host privilege into a sandbox. Only a currently enabled Cognito browser administrator may approve or submit these profiles. Project-admin membership and API tokens cannot grant this authority.

## Approval and execution

Use **Images / execution environments → Administrator-approved special execution**:

1. Prepare a dedicated worker outside the ordinary researcher pool. The form derives a project/profile-specific protected node label and `NoSchedule` taint. The application only reads these attributes; it never labels, taints, drains or scales nodes during approval.
2. Approve the image in the existing ECR image registry. Paste the exact workflow and choose the task. Dataset inputs must use numeric versions.
3. Select the required host mounts and privilege settings, review the trust acknowledgement and save an immutable revision.
4. In **New workflow → YAML and execution**, select that revision for the matching task. The server compares the approved image digest, command, arguments, environment, files, inputs, outputs and resources.

The schema accepts only `executionProfile: { id, version }` in user YAML. The server supplies the complete policy pin. Raw user-provided host volumes remain invalid.

The stored approval includes node names and Kubernetes UIDs. Every matching node must be Ready, schedulable, carry the protected label and dedicated taint, satisfy the compiler's HyperPod `node-health-status=Schedulable` selector, and contain only matching trusted project workloads or system DaemonSets. Unknown occupancy, a regular project Pod, an unready node or replacement UID blocks approval/launch. This inspection does not reserve CPU/GPU capacity; normal governed queue admission still applies.

Approval is checked at submission, before Kubernetes creation, after admission at runtime barrier release and before the first application `RUNNING` report. Task preparation and inline-file copying happen behind the runtime barrier for trusted tasks. A queued request cannot retain authority after profile revocation, administrator demotion, project rebinding or node replacement. Revocation stops future application starts; operators use the existing workflow cancel action for processes already running.

Host-network tasks disable the runtime's fixed loopback file server. Per-Pod HTTP/file session isolation cannot be asserted on a shared host network. Terminal execution remains a separately authorized actual-Pod operation.

## API

- `GET /api/execution-profiles`: project registry; `?id=<profile>` also returns required node label/taint.
- `POST /api/execution-profiles`: browser administrator approval; requires `acknowledgeTrustBoundary: true`, exact workflow/task and policy. `expectedVersion` is required when replacing an existing head.
- `GET /api/execution-profiles/<id>?version=N`: immutable revision.
- `DELETE /api/execution-profiles/<id>` with `expectedVersion`: revoke using a conditional write; revision history remains.

Node configuration is an administrator prerequisite. No trusted worker has been provisioned or approved by this implementation test. Unit/contract tests cover identity substitution, occupancy, revocation, command mutation, mount boundaries and delayed application start; they do not establish actual privileged device execution.

AWS documentation consulted on 2026-09-16:

```text
https://docs.aws.amazon.com/eks/latest/best-practices/pod-security.html
```

The AWS guidance documents EKS NodeRestriction and the residual host-access risk. The protected label uses `pai.aws.node-restriction.kubernetes.io/execution-profile`; the separate taint uses `pai.aws/execution-profile`.
