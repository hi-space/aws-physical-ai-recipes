# GPU Capacity and Region Fallback

The default GPU pool is `g7e-rtx-pro-6000` (RTX PRO 6000, ~96 GB VRAM). G7e is a
new instance family, so its per-region / per-AZ availability is uneven. When G7e
capacity is short, this repo can fall back to `g6e-l40s` (NVIDIA L40S, 48 GB) —
the preferred fallback because L40S has broad availability across the four target
regions and enough VRAM for GR00T VLA fine-tuning and closed-loop eval.

This is an operational guide: the fallback path already exists in the deploy
scripts (`DEPLOY_G6E_NODEPOOL` / `OSMO_CONFIGURE_G6E_PLATFORM`). Nothing here
requires code changes — it records how to turn g6e on per region and the
capacity facts behind that choice.

## Terms used here

Three concepts show up throughout this doc:

- Region: a large, geographically separate AWS area, e.g. Oregon (`us-west-2`)
  or Seoul (`ap-northeast-2`).
- Availability Zone (AZ): a physically isolated datacenter group inside a region.
  Seoul, for example, has `ap-northeast-2a` and `ap-northeast-2b`; the trailing
  `a`/`b`/`c`/`d` names each AZ.
- Pinning to an AZ: forcing "this GPU node must launch only in this AZ." By
  default Karpenter (the component that auto-creates GPU nodes) may pick any AZ
  in the region, but this repo pins g6e nodes to one AZ — spreading one
  workload's nodes across AZs adds cross-AZ transfer cost and EBS volumes cannot
  cross an AZ boundary.

## Target regions

The reference is deployed across four regions: `us-west-2`, `us-east-1`,
`us-east-2`, `ap-northeast-2`. `infra/core` pins G7e AZ maps for all four
(`g7e_azs_by_region` in `infra/core/main.tf`).

## g6e availability (measured 2026-07-28)

In the table, "g6e AZs" is the list of AZs where you can actually buy g6e in that
region, and "quota" is the ceiling on total G-family GPU vCPUs you can run at once.

| Region | g6e AZs (where you can buy g6e) | On-Demand G/VT vCPU quota | g6e fallback |
| --- | --- | --- | --- |
| `us-west-2` | a, b, c, d | 768 | Ready |
| `us-east-1` | a, b, c, d | 768 | Ready |
| `ap-northeast-2` | a, b | 768 | Ready |
| `us-east-2` | a, b, c | 64 | Quota increase required |

g6e vCPU per size: `2xlarge`=8, `4xlarge`=16, `8xlarge`=32, `12xlarge`=48,
`16xlarge`=64, `24xlarge`=96, `48xlarge`=192. A 768-vCPU quota covers roughly
16× `g6e.12xlarge` or 4× `g6e.48xlarge` — ample for parallel training. The
64-vCPU quota in `us-east-2` only covers a single `g6e.16xlarge`, so that region
needs a Service Quotas increase (code `L-DB2E81BA`, "Running On-Demand G and VT
instances") before g6e is a usable fallback there.

The e2e pipeline stages map onto these sizes by their `cpu`/`memory` request:
`g6e.4xlarge` for RL (02-sim-rl) and closed-loop eval (04), `g6e.8xlarge` for the
VLA fine-tune (03), and `g6e.12xlarge` for Cosmos augmentation (06). The largest
single stage is `g6e.12xlarge` (48 vCPU), so even the `us-east-2` 64-vCPU quota
runs the pipeline sequentially — only parallel/concurrent runs need the increase.
See [e2e-pipeline-examples/README.md](../e2e-pipeline-examples/README.md) for the
per-stage recommendation table.

The instance-type offerings themselves are fine in all four regions; only
`us-east-2` is quota-limited.

## Enabling g6e as the fallback

Set both flags on deploy — the Karpenter NodePool and the OSMO platform must both
be created:

```bash
# deploy-karpenter.sh: create the g6e NodePool alongside g7e
DEPLOY_G6E_NODEPOOL=true \
# deploy-osmo.sh: register the g6e-l40s OSMO platform
OSMO_CONFIGURE_G6E_PLATFORM=true \
  scripts/deploy-all.sh
```

Workloads then target it with `platform: g6e-l40s` (vs the `g7e-rtx-pro-6000`
default). Stage workflows can override per submit, e.g.:

```bash
osmo workflow submit e2e-pipeline-examples/03-vla-finetune/workflow.yaml \
  --set platform=g6e-l40s
```

## Which AZ g6e lands in, per region

g6e nodes are pinned to a single AZ. `KARPENTER_G6E_ZONE` chooses which one, and
if you leave it unset it defaults to the region's first AZ (`${AWS_REGION}a` —
the AZ whose name ends in `a`). That default works everywhere because g6e is sold
in AZ `a` in all four regions (see the table above). Only override it when AZ `a`
has no g6e stock:

| Region | Default pinned AZ | Alternate AZs you can use |
| --- | --- | --- |
| `us-west-2` | `us-west-2a` | b, c, d |
| `us-east-1` | `us-east-1a` | b, c, d |
| `us-east-2` | `us-east-2a` | b, c |
| `ap-northeast-2` | `ap-northeast-2a` | b only |

```bash
# Example: put g6e in a different AZ when the default AZ (a) has no stock
KARPENTER_G6E_ZONE=us-west-2c DEPLOY_G6E_NODEPOOL=true \
OSMO_CONFIGURE_G6E_PLATFORM=true scripts/deploy-all.sh
```

`ap-northeast-2` (Seoul) sells g6e in only two AZs (a, b), so it has the least
room of the four — if both run out, there is no third AZ to fall back to within
the region.

One more note: `infra/core` places us-east-1's G7e in `us-east-1b`/`us-east-1d`
(AZ `a` is an older zone where newer instance families are often unavailable, so
it was excluded). This means that if you keep the g6e default (`us-east-1a`), g6e
lands in a different AZ than G7e in that region. Nodes still launch fine because
both AZs sell g6e, but if you want g6e in the same AZ as G7e, set
`KARPENTER_G6E_ZONE=us-east-1b`.

## Verifying capacity before a deploy

```bash
# g6e AZ offerings in the target region
aws ec2 describe-instance-type-offerings --region "$AWS_REGION" \
  --location-type availability-zone \
  --filters "Name=instance-type,Values=g6e.2xlarge,g6e.4xlarge,g6e.8xlarge,g6e.12xlarge" \
  --query 'InstanceTypeOfferings[].[InstanceType,Location]' --output table

# On-Demand G/VT vCPU quota
aws service-quotas get-service-quota --region "$AWS_REGION" \
  --service-code ec2 --quota-code L-DB2E81BA --query 'Quota.Value' --output text
```

Live G7e capacity should still be pre-warmed before OSMO validation with
`scripts/prewarm-gpu-node.sh` (see the e2e pipeline README). The g6e fallback is
for when that pre-warm cannot place G7e nodes in the region.

Neither query above detects a stock-out, though — see the next section.

## When the size you asked for is sold out (ICE)

The two checks above answer "is this instance type sold in this AZ" and "is my
quota high enough". Both can pass while the launch still fails, because AWS has
no free capacity of that exact size in that AZ right now
(`InsufficientInstanceCapacity`, usually shortened to ICE). ICE is transient and
per size + per AZ: `g6e.8xlarge` can be unavailable while `g6e.16xlarge` in the
same AZ launches fine.

Observed 2026-08-11 on the `us-east-1` cluster, running the prewarm the stage
READMEs recommend:

```bash
GPU_PREWARM_INSTANCE_TYPE=g6e.8xlarge KARPENTER_NODEPOOL_NAME=aws-osmo-g6e \
  scripts/prewarm-gpu-node.sh
```

The pod stayed `Pending` and Karpenter logged `InsufficientCapacityError` three
times: "We currently do not have sufficient g6e.8xlarge capacity in the
Availability Zone you requested (us-east-1b)". Offerings listed g6e in all four
us-east-1 AZs and the G/VT quota was 768 vCPU with zero G instances running, so
neither pre-deploy check predicted it. `aws ec2 run-instances --dry-run` does not
predict it either — it returned success for all six size/AZ combinations tried,
including the one that was actually short.

`prewarm-gpu-node.sh` cannot ride this out on its own. It puts
`node.kubernetes.io/instance-type` in the prewarm pod's `nodeSelector` and then
asserts the node it landed on is exactly that type, so Karpenter is not allowed
to substitute another size from the NodePool's list. The pin is deliberate — the
script exists to prove one specific type can launch — but it means an ICE on that
one size blocks the prewarm entirely.

To get *a* GPU node instead of a specific one, ask only for the NodePool and a
GPU and let Karpenter choose the size:

```bash
NS="$(cd infra/core && terraform output -raw osmo_workload_namespace)"

kubectl -n "$NS" apply -f - <<'YAML'
apiVersion: v1
kind: Pod
metadata:
  name: aws-osmo-gpu-probe
spec:
  restartPolicy: Never
  nodeSelector:
    karpenter.sh/nodepool: aws-osmo-g6e
  tolerations:
    - key: nvidia.com/gpu
      operator: Exists
      effect: NoSchedule
  containers:
    - name: hold
      image: public.ecr.aws/docker/library/busybox:1.36
      command: ["sh", "-c", "sleep 86400"]
      resources:
        limits:
          nvidia.com/gpu: "1"
YAML

kubectl -n "$NS" wait --for=condition=Ready pod/aws-osmo-gpu-probe --timeout=20m
```

In the run above Karpenter picked `g6e.16xlarge` in `us-east-1d`, and
`osmo resource list --pool default` then showed that node under platform
`g6e-l40s` with `1/1` GPU — enough for OSMO to admit a GPU workflow. Delete the
probe pod once the workflow has been submitted; Karpenter consolidates the node
away after it and the workflow pods are gone.

One limit on this trick: `deploy-karpenter.sh` pins the g6e NodePool to a single
AZ (`KARPENTER_G6E_ZONE`, see above), so Karpenter can normally vary the instance
size but not the AZ. It reached `us-east-1d` only because that cluster's live
NodePool allowed two AZs (`["us-east-1b", "us-east-1d"]`, matching the region's
G7e AZ map) rather than the single AZ the script emits. On a NodePool straight
from the script, expect the size to vary within one AZ. Check what you actually
have with `kubectl get nodepool aws-osmo-g6e -o yaml`. If every g6e size in the
pinned AZ is short, re-run
`scripts/deploy-karpenter.sh` with a different `KARPENTER_G6E_ZONE`, or fall back
to the g7e NodePool.

### When the flexible probe does not help either

Later the same day (2026-08-11, from ~13:25 UTC) the probe stopped working on
that cluster: *every* size in both NodePools was short in both AZs the cluster
can reach. Karpenter kept creating a NodeClaim, getting `UnfulfillableCapacity`
from `CreateFleet`, and deleting it — a ~3 min loop with the probe pod stuck
`Pending` for 45+ min. Falling back from g6e to g7e did not help; the g7e pool
returned the same error for all five of its sizes.

The AWS error text names the AZs that *do* have capacity, and that is the useful
part:

```
InsufficientInstanceCapacity: We currently do not have sufficient g6e.8xlarge
capacity in the Availability Zone you requested (us-east-1d). ... You can
currently get g6e.8xlarge capacity by ... choosing us-east-1a, us-east-1b,
us-east-1c.
```

Those suggested AZs were unreachable because the VPC only has subnets in
`us-east-1b` and `us-east-1d`:

```bash
VPC="$(cd infra/core && terraform output -raw vpc_id)"
aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC" \
  --query 'Subnets[].{Id:SubnetId,AZ:AvailabilityZone}' --output table
```

So when both NodePools are short in all reachable AZs, no amount of size or
NodePool switching helps — the choices are to wait out the ICE (it is transient),
add subnets in the AZs AWS names and widen the NodePool's zone requirement, or
run in another region.

Adding the subnets is a small Terraform change but not a free one. Extending
`availability_zones` and raising `karpenter_az_count` to 4 in the workspace's
tfvars (the pattern `terraform.usw2.tfvars` already uses) plans as pure addition
— four subnets plus four route-table associations, `0 to destroy`, no new NAT
gateway while `single_nat_gateway = true`, and the new private subnets inherit
`karpenter.sh/discovery` from the module's `private_subnet_tags` automatically.
Keep the g7e-capable AZs first in the list: `az_count` slices from the front, so
reordering would move the EKS and RDS/Redis subnets.

The catch is that `terraform apply` also picks up whatever drift has accumulated
since the last apply. On the 2026-08-11 cluster the same plan wanted to take the
RDS instance from `engine_version` 16.13 back to 16.9 (AWS had auto-applied a
minor upgrade) and to touch three EKS addons and two Karpenter IAM objects.
Check the full change list before applying, and scope it if you only want the
subnets:

```bash
terraform plan -out=/tmp/az.tfplan
terraform show /tmp/az.tfplan | grep '^  # '   # read every line
terraform apply -target=module.vpc             # subnets only
```

Note `terraform.tfvars` is gitignored (it holds per-deploy values), so
`git checkout` will not undo an edit to it — revert by hand.

Confirm the type is even offered in the target AZ first:

```bash
aws ec2 describe-instance-type-offerings --location-type availability-zone \
  --filters "Name=instance-type,Values=g6e.8xlarge,g6e.12xlarge,g7e.8xlarge" \
  --query 'InstanceTypeOfferings[].{Type:InstanceType,AZ:Location}' --output table
```

To wait it out without babysitting, poll for any GPU node and submit only once
one appears — OSMO rejects the submit outright (`There are no resources in
platform g6e-l40s and pool default!`) while no GPU node is registered, so the
submit has to come after the node, not before.
