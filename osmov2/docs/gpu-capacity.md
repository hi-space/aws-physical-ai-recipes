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
