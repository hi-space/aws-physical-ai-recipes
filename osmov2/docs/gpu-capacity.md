# GPU Capacity and Region Fallback

The default GPU pool is `g7e-rtx-pro-6000` (RTX PRO 6000, ~96 GB VRAM). G7e is a
new instance family, so its per-region / per-AZ availability is uneven. When G7e
capacity is short, this repo can fall back to `g6e-l40s` (NVIDIA L40S, 48 GB) —
the preferred fallback because L40S has broad availability across the four target
regions and enough VRAM for GR00T VLA fine-tuning and closed-loop eval. Behind
that sits a third tier, `g6-l4` (NVIDIA L4, 24 GB), which is the easiest capacity
to obtain but too small for VLA fine-tuning.

This is an operational guide: the fallback path already exists in the deploy
scripts (`DEPLOY_G6E_NODEPOOL` / `OSMO_CONFIGURE_G6E_PLATFORM`, and
`DEPLOY_G6_NODEPOOL` / `OSMO_CONFIGURE_G6_PLATFORM` for the L4 tier). Nothing
here requires code changes — it records how to turn the fallbacks on per region
and the capacity facts behind that choice.

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

## Capacity tiers: g7e, g6e, g6

There are three GPU pools, and they form a ladder from most VRAM to most
available capacity. Pick by what the workload needs, then descend when capacity
forces you to.

```
tier   platform             GPU                VRAM     use
g7e    g7e-rtx-pro-6000     RTX PRO 6000       ~96 GB   default for everything
g6e    g6e-l40s             L40S               ~45 GB   VLA fine-tune, RL, eval
g6     g6-l4                L4                  24 GB   Isaac Sim streaming, eval
```

g6 is the deepest tier — the one most likely to have stock. Observed 2026-09-15
on the `us-east-1` reference cluster: every g7e size (2xl through 48xl) and every
g6e size (2xl through 24xl) returned `InsufficientInstanceCapacity` in both
reachable AZs, while `g6.2xlarge` launched on the first attempt. When both upper
tiers are short across all AZs, g6 is the option that is left before changing
region.

That depth comes with a real ceiling. L4 has 24 GB of VRAM, which covers Isaac Sim
livestream and closed-loop eval but not GR00T VLA fine-tuning. Treat g6 as a
streaming/eval tier, not a training one. Either Isaac Sim version runs there: idle
GPU memory measured on L4 on 2026-09-15 was 577 MiB on 4.5.0 and 2032 MiB on
5.1.0, so the scene, not the sim, is what sets the requirement. See "Enabling g6
as the last-resort tier" below.

## g6e availability (measured 2026-07-28)

In the table, "g6e AZs" is the list of AZs where you can actually buy g6e in that
region, and "quota" is the ceiling on total G-family GPU vCPUs you can run at once.

| Region | g6e AZs (where you can buy g6e) | On-Demand G/VT vCPU quota | g6e fallback |
| --- | --- | --- | --- |
| `us-west-2` | a, b, c, d | 768 | Ready |
| `us-east-1` | a, b, c, d | 768 | Ready |
| `ap-northeast-2` | a, b | 768 | Ready |
| `us-east-2` | a, b, c | 64 | Quota increase required |

Sizes, from `describe-instance-types` (verified 2026-09-15). Both families offer
every size in every AZ listed above, `48xlarge` included, and g7e has no
`16xlarge`:

| Size | g6e vCPU / RAM / GPU count | g7e vCPU / RAM / GPU count |
| --- | --- | --- |
| `2xlarge` | 8 / 64 GB / 1 L40S | 8 / 64 GB / 1 RTX PRO 6000 |
| `4xlarge` | 16 / 128 GB / 1 L40S | 16 / 128 GB / 1 RTX PRO 6000 |
| `8xlarge` | 32 / 256 GB / 1 L40S | 32 / 256 GB / 1 RTX PRO 6000 |
| `12xlarge` | 48 / 384 GB / 4 L40S | 48 / 512 GB / 2 RTX PRO 6000 |
| `16xlarge` | 64 / 512 GB / 1 L40S | not offered |
| `24xlarge` | 96 / 768 GB / 4 L40S | 96 / 1024 GB / 4 RTX PRO 6000 |
| `48xlarge` | 192 / 1536 GB / 8 L40S | 192 / 2048 GB / 8 RTX PRO 6000 |

GPU count is not monotonically increasing in vCPU count. `g6e.16xlarge` has 64 vCPU
and 1 GPU; the smaller `g6e.12xlarge` has 48 vCPU and 4 GPUs. Select the instance
size by GPU count rather than vCPU count when the workload is GPU-bound: a
single-GPU stage gets the highest vCPU-per-GPU ratio from `16xlarge`, and
multi-GPU distributed training requires `12xlarge` or wider. VRAM per GPU is fixed
within a family (about 45 GB on L40S, 96 GB on RTX PRO 6000) and is independent of
instance size.

A 768-vCPU quota covers roughly 16× `g6e.12xlarge` or 4× `g6e.48xlarge` — ample
for parallel training. The 64-vCPU quota in `us-east-2` only covers a single
`g6e.16xlarge`, so that region needs a Service Quotas increase (code
`L-DB2E81BA`, "Running On-Demand G and VT instances") before g6e is a usable
fallback there. The quota values in the table were re-measured 2026-09-15 and are
unchanged.

### The NodePool limit also gates which sizes are reachable

A size has to clear two separate ceilings:

- the account's G/VT vCPU quota (the table above), and
- the g6e NodePool's own `spec.limits` (`KARPENTER_G6E_NODEPOOL_CPU_LIMIT` and
  `KARPENTER_G6E_NODEPOOL_MEMORY_LIMIT` in `scripts/deploy-karpenter.sh`).

The NodePool limit is easy to miss because it raises no capacity error — a size
above the limit is simply never provisioned, even though it is listed in
`KARPENTER_G6E_INSTANCE_TYPES`. Before 2026-09-15 the defaults were 96 vCPU /
768Gi, which silently excluded `g6e.48xlarge` (192 vCPU, 1536GB) even on an
account with 768 vCPU of quota. The defaults are now 192 vCPU / 1536Gi so the
widest size is reachable; lower them to cap g6e spend.

The same ceiling applies to the g7e pool, and there it is still binding.
`KARPENTER_NODEPOOL_CPU_LIMIT` / `KARPENTER_NODEPOOL_MEMORY_LIMIT` default to
120 vCPU / 1200Gi. `g7e.24xlarge` (96 vCPU, 1024GB) fits; `g7e.48xlarge`
(192 vCPU, 2048GB) does not, so the widest g7e size is out of reach on the
defaults even where quota allows it. Raise both to 192 / 2048Gi to use it as an
extra ICE escape hatch. The defaults stay lower because g7e is the primary pool
and the limit doubles as a spend cap.

When a size never launches, check the allowed types and the limits before
assuming a stock-out:

```bash
kubectl get nodepool aws-osmo-g6e -o jsonpath='{.spec.template.spec.requirements}'
kubectl get nodepool aws-osmo-g6e -o jsonpath='{.spec.limits}'
```

A size missing from the requirements list, or larger than `spec.limits`, is a
configuration issue — not an `InsufficientInstanceCapacity` (ICE) issue. Widening
the size list is also the cheapest way to raise the odds of landing *a* node when
ICE is the real cause, since ICE is per size and per AZ.

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

### Adding g6e to a cluster that is already deployed

`scripts/deploy-all.sh` is the greenfield path. On a running cluster you do not
need to re-run everything — the two scripts that matter are idempotent and can be
run on their own, in this order:

```bash
# 1. Create the g6e NodePool (Karpenter). Reuses the existing g7e EC2NodeClass,
#    so no AMI/subnet/security-group changes are involved.
DEPLOY_G6E_NODEPOOL=true scripts/deploy-karpenter.sh

# 2. Register the g6e-l40s platform in OSMO (pod template + pool config).
OSMO_CONFIGURE_G6E_PLATFORM=true scripts/deploy-osmo.sh
```

Order matters: step 2 registers a platform whose `nodeSelector` targets
`karpenter.sh/nodepool=aws-osmo-g6e`, so the NodePool has to exist first or the
platform points at nothing.

Both steps are additive. Step 1 leaves the g7e NodePool untouched, and step 2
leaves the `g7e-rtx-pro-6000` platform untouched — `g6e-l40s` is registered
alongside it, and the default platform does not change. Nothing that currently
runs on g7e is affected.

Verify each step before moving on:

```bash
# after step 1 — NodePool exists, and check which AZ it was pinned to
kubectl get nodepool aws-osmo-g6e
kubectl get nodepool aws-osmo-g6e \
  -o jsonpath='{.spec.template.spec.requirements[?(@.key=="topology.kubernetes.io/zone")].values}'

# after step 2 — platform is registered
osmo pool list
```

Note that `osmo resource list --pool default` shows an empty g6e platform until a
node actually exists. That is expected: Karpenter provisions on demand, so the
platform is registered but unbacked until the first g6e pod is scheduled. The
consequence is covered below — OSMO refuses a submit against a platform with no
registered node, so a node has to be secured before submitting.

### Choosing a platform per workflow

There are three ways to send a workload to g6e, and which one applies depends on
how the workflow file was written.

```bash
# 1. Workflow with a templated platform: override at submit time
osmo workflow submit e2e-pipeline-examples/03-vla-finetune/workflow.yaml \
  --set platform=g6e-l40s

# 2. Workflow with a hardcoded platform: submit the g6e variant of the file
osmo workflow submit examples/isaacsim-livestream/workflow-g6e.yaml
```

The third way is to edit `platform:` in the workflow's `resources` block
directly. Check which case you are in before submitting:

```bash
grep -n 'platform:' <workflow.yaml>
```

A literal value such as `platform: g7e-rtx-pro-6000` is hardcoded and `--set
platform=` will not change it. `examples/isaacsim-livestream/` ships
`workflow-g6e.yaml` for exactly this reason. Also note the g6e variant raises
`memory` and `storage`, because switching GPU family is not only a platform
rename — L40S has ~45 GB of VRAM against ~96 GB on RTX PRO 6000, so a model that
fit on one g7e GPU may need a multi-GPU size on g6e (see the size table above,
and remember `12xlarge` is the smallest g6e size with more than one GPU).

### What g6e does and does not solve

g6e widens the set of size/AZ combinations you can attempt. It does not
guarantee capacity, and it is not a fix for a region-wide shortage. Both pools
draw from the same regional EC2 capacity, and both can be short at the same time.

Observed 2026-09-15 12:10–12:15 UTC on the `us-east-1` reference cluster: a GPU
probe against `aws-osmo-g7e` and then against `aws-osmo-g6e` both stayed
`Pending`. Every size in both pools returned `InsufficientInstanceCapacity` in
both reachable AZs (`us-east-1b`, `us-east-1d`) — g7e across 2xl/4xl/8xl/12xl/24xl
and g6e across 2xl/4xl/8xl/12xl/16xl/24xl. Falling back from g7e to g6e changed
nothing, because the shortage was not family-specific.

Two details from that run are worth carrying into an escalation plan.

First, the AWS remediation text is not actionable when both AZs are short. The
error for a `us-east-1d` request said to choose `us-east-1b`, and the error for a
`us-east-1b` request said to choose `us-east-1d`, in the same `CreateFleet`
response. Do not move a zone pin on the strength of that message alone; confirm
with a probe.

Second, `g7e.48xlarge` was never attempted even though it is listed in
`g7e_nut_pouring_instance_types`. Karpenter's own log named the candidates it
considered:

```
instance-types: "g7e.12xlarge, g7e.24xlarge, g7e.2xlarge, g7e.4xlarge, g7e.8xlarge"
```

The widest size is absent because 192 vCPU exceeds the pool's default 120 vCPU
limit. This is the NodePool-limit trap described above, visible in a real log:
adding a size to `versions.yaml` does not make it reachable unless the limit
admits it.

So the escalation order under a shortage is:

1. Probe by NodePool, not by instance type, so Karpenter may vary the size
   (`prewarm-gpu-node.sh` pins one type and cannot substitute).
2. Probe g7e before g6e. The g7e pool has no zone requirement, so it can vary
   the AZ as well as the size; g6e is pinned to one AZ and can only vary size.
3. Raise `KARPENTER_NODEPOOL_CPU_LIMIT` / `KARPENTER_NODEPOOL_MEMORY_LIMIT` to
   192 / 2048Gi to actually admit `g7e.48xlarge`, then re-run
   `scripts/deploy-karpenter.sh`. This adds one more size to try.
4. Move the g6e zone pin with `KARPENTER_G6E_ZONE` and re-run
   `scripts/deploy-karpenter.sh` — but only to an AZ that has a private subnet.
5. If every size in both pools is short in every reachable AZ, no amount of
   pool or size switching helps. The remaining options are to wait (ICE is
   transient), add subnets in the AZs AWS names and widen the zone requirement,
   secure an On-Demand Capacity Reservation for the specific AZ and type, or run
   in another region.

Once a node is secured, hold it. Karpenter consolidates underutilized nodes, so a
node obtained after a long wait can disappear while the session is being set up.
Lock the pool's disruption budget for the duration and restore it afterwards:

```bash
kubectl patch nodepool aws-osmo-g6e --type merge \
  -p '{"spec":{"disruption":{"budgets":[{"nodes":"0"}]}}}'

# restore when the session is over
kubectl patch nodepool aws-osmo-g6e --type merge \
  -p '{"spec":{"disruption":{"budgets":[{"nodes":"10%"}]}}}'
```

## Enabling g6 as the last-resort tier

Same two-flag shape as g6e — a Karpenter NodePool plus an OSMO platform. On a
greenfield deploy:

```bash
# deploy-karpenter.sh: create the g6 NodePool alongside g7e
DEPLOY_G6_NODEPOOL=true \
# deploy-osmo.sh: register the g6-l4 OSMO platform
OSMO_CONFIGURE_G6_PLATFORM=true \
  scripts/deploy-all.sh
```

On a cluster that is already running, the same two scripts standalone, in this
order (step 2's `nodeSelector` targets `karpenter.sh/nodepool=aws-osmo-g6`, so the
NodePool must exist first):

```bash
DEPLOY_G6_NODEPOOL=true scripts/deploy-karpenter.sh
OSMO_CONFIGURE_G6_PLATFORM=true scripts/deploy-osmo.sh
```

Both steps are additive; g7e and g6e platforms and the default platform are
untouched. Verify the same way as g6e:

```bash
kubectl get nodepool aws-osmo-g6
kubectl get nodepool aws-osmo-g6 \
  -o jsonpath='{.spec.template.spec.requirements[?(@.key=="topology.kubernetes.io/zone")].values}'
osmo pool list
```

### Submitting a workload to the g6 pool

Workloads target it with `platform: g6-l4`. Which mechanism to use depends on the
workflow file, exactly as with g6e — check with `grep -n 'platform:' <workflow.yaml>`
first:

```bash
# templated platform: override at submit time
osmo workflow submit e2e-pipeline-examples/04-closeloop/workflow.yaml \
  --set platform=g6-l4

# hardcoded platform: submit the g6 variant of the file
osmo workflow submit examples/isaacsim-livestream/workflow-g6.yaml
```

Do not point VLA fine-tuning (`03-vla-finetune`) at `g6-l4`; 24 GB of VRAM is not
enough and the stage will OOM on the GPU rather than fail at submit. The g6 tier is
for Isaac Sim streaming and closed-loop eval. As with g6e, OSMO refuses a submit
against a platform with no registered node, so secure a node first — probe by
NodePool (`karpenter.sh/nodepool: aws-osmo-g6`) as shown under "When the size you
asked for is sold out (ICE)".

### The shipped g6 defaults are narrower than what worked

`deploy-karpenter.sh` pins the g6 NodePool to one AZ (`KARPENTER_G6_ZONE`,
defaulting to the alphabetically first AZ with a private subnet) and caps the pool
at 96 vCPU / 768Gi. That cap admits every size in `g6_instance_types` — the widest
listed, `g6.24xlarge`, is 96 vCPU — so the limit is not the constraint here. The
zone pin is. The NodePool that actually produced a node on 2026-09-15 in
`us-east-1` had no zone requirement, which let Karpenter try both `us-east-1b` and
`us-east-1d`. Under a zone-local shortage, widen the pin:

```bash
KARPENTER_G6_ZONE=us-east-1d DEPLOY_G6_NODEPOOL=true scripts/deploy-karpenter.sh
```

or drop the zone requirement from the live NodePool for the duration of a capacity
hunt, accepting that GPU nodes may then land in an AZ away from the rest of the
workload (cross-AZ transfer cost, and EBS volumes cannot follow):

```bash
kubectl patch nodepool aws-osmo-g6 --type json \
  -p '[{"op":"remove","path":"/spec/template/spec/requirements/3"}]'
kubectl get nodepool aws-osmo-g6 -o jsonpath='{.spec.template.spec.requirements[*].key}'
```

Check the index before removing — the zone requirement is the fourth entry as the
script emits it, but confirm with the `jsonpath` above rather than assuming.

## Which AZ g6e lands in, per region

g6e nodes are pinned to a single AZ. `KARPENTER_G6E_ZONE` chooses which one. When
it is unset, `deploy-karpenter.sh` reads `private_subnet_ids` from `infra/core`
and pins to the alphabetically first AZ that actually has a private subnet.

The AZ has to have a subnet, not merely sell g6e. A NodePool pinned to a
subnet-less AZ provisions nothing, and it fails quietly: Karpenter logs
`skipping, nodepool requirements filtered out all instance types`, the pod stays
`Pending`, and no capacity error names the cause. Reproduced 2026-09-15 on the
`us-east-1` reference cluster with a NodePool pinned to `us-east-1a` — a zone that
offers all seven g6e sizes but has no subnet in this VPC. Zero NodeClaims were
created.

| Region | Private subnet AZs (from `infra/core`) | Derived default | Alternates with a subnet |
| --- | --- | --- | --- |
| `us-west-2` | a, b, c, d | `us-west-2a` | b, c, d |
| `us-east-1` | b, d | `us-east-1b` | d |
| `us-east-2` | a, b | `us-east-2a` | b |
| `ap-northeast-2` | a, b | `ap-northeast-2a` | b |

The subnet AZs come from `g7e_azs_by_region` in `infra/core/main.tf`, sliced by
`az_count` / `karpenter_az_count`. `us-east-1` has no subnet in AZ `a`, so the
former `${AWS_REGION}a` default was unusable in that region — that is the failure
the subnet-derived default removes. Pinning outside the subnet AZs requires adding
subnets first (see "When the flexible probe does not help either").

```bash
# Example: put g6e in a different AZ when the default AZ (a) has no stock
KARPENTER_G6E_ZONE=us-west-2c DEPLOY_G6E_NODEPOOL=true \
OSMO_CONFIGURE_G6E_PLATFORM=true scripts/deploy-all.sh
```

`ap-northeast-2` (Seoul) sells g6e in only two AZs (a, b), so it has the least
room of the four — if both run out, there is no third AZ to fall back to within
the region.

An earlier revision of this doc said that keeping the g6e default in `us-east-1`
puts g6e in a different AZ than G7e but "nodes still launch fine because both AZs
sell g6e." That is wrong, and the 2026-09-15 reproduction above is the correction:
the AZ `a` default had no subnet, so nothing launched at all. Selling the instance
type is necessary but not sufficient — reachability is decided by the subnet.

Because the default is now derived from the subnets, g6e and G7e land in the same
AZ set by construction, and no `KARPENTER_G6E_ZONE` override is needed for
co-location.

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

The two pools are not symmetric here, which is worth knowing before you choose
which one to probe. The g7e NodePool carries no `topology.kubernetes.io/zone`
requirement at all, so Karpenter may use any subnet AZ; only g6e and g6 are pinned
to one zone. Confirmed 2026-09-15 on the `us-east-1` reference cluster:

```
g7e requirements: arch, os, capacity-type, instance-type          (no zone)
g6e requirements: arch, os, capacity-type, instance-type, zone    (b and d)
```

So under a zone-local stock-out the fallback pool is the *narrower* one. Probing
g7e first lets Karpenter move across AZs, whereas g6e can only change size. That
inverts the usual "g7e short, so try g6e" reflex: try g7e across AZs before
concluding the region is out of capacity.

### Telling a stock-out apart from a misconfigured pool

Both leave the pod `Pending`, so read the Karpenter log line before concluding
anything about capacity. The two cases say different things:

```bash
kubectl -n kube-system logs -l app.kubernetes.io/name=karpenter --tail=100 \
  | grep -E 'InsufficientCapacity|UnfulfillableCapacity|filtered out all instance types'
```

| Log line | Meaning | Fix |
| --- | --- | --- |
| `skipping, nodepool requirements filtered out all instance types` | No instance type satisfies the pool's own requirements. Nothing was ever requested from EC2. | Configuration. Check the zone pin against the subnet AZs, then `spec.limits` against the size list. |
| `InsufficientCapacityError` / `UnfulfillableCapacity` from `CreateFleet` | EC2 was asked and declined. | Real stock-out. Widen sizes, change AZ, wait, or change region. |

The first line is the one that misleads, because it looks like a scheduling hiccup
and never mentions capacity. It is what a subnet-less zone pin produces, and also
what an over-limit size list produces. Neither is an ICE.

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
