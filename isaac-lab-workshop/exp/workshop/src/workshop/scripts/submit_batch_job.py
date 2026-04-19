"""Submit AWS Batch jobs for RL training or GR00T finetuning."""
import argparse
import time

import boto3


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Submit AWS Batch job")
    parser.add_argument("--job_type", required=True, choices=["rl", "groot"], help="Job type")
    parser.add_argument("--job_name", required=True, help="Job name")
    parser.add_argument("--job_queue", required=True, help="Batch Job Queue name")
    parser.add_argument("--job_definition", required=True, help="Batch Job Definition name")
    parser.add_argument("--num_nodes", type=int, default=1, help="Number of nodes (multi-node)")
    parser.add_argument("--region", default="us-east-1", help="AWS region")

    parser.add_argument("--task", help="Isaac Lab task ID (for RL)")
    parser.add_argument("--max_iterations", type=int, default=1000, help="RL max iterations")

    parser.add_argument("--dataset_s3_uri", help="S3 URI for dataset (for GR00T)")
    parser.add_argument("--max_steps", type=int, default=10000, help="GR00T max training steps")
    parser.add_argument("--batch_size", type=int, default=32, help="Global batch size")
    parser.add_argument("--save_steps", type=int, default=2000, help="Checkpoint save interval")

    parser.add_argument("--follow", action="store_true", help="Follow job status until completion")
    return parser.parse_args()


def build_rl_command(args: argparse.Namespace) -> list[str]:
    return [
        "./distributed_run.bash",
        "torchrun",
        "--nnodes=${AWS_BATCH_JOB_NUM_NODES}",
        "--nproc_per_node=4",
        "--rdzv_backend=c10d",
        "--rdzv_endpoint=${AWS_BATCH_JOB_MAIN_NODE_PRIVATE_IPV4_ADDRESS}:5555",
        "scripts/reinforcement_learning/rsl_rl/train.py",
        f"--task={args.task}",
        "--headless",
        f"--max_iterations={args.max_iterations}",
    ]


def build_groot_command(args: argparse.Namespace) -> list[str]:
    return [
        "/bin/bash", "-c",
        f"aws s3 cp {args.dataset_s3_uri} /tmp/dataset --recursive && "
        f"NUM_GPUS=4 bash examples/finetune.sh "
        f"--base-model-path nvidia/GR00T-N1.7-3B "
        f"--dataset-path /tmp/dataset "
        f"--modality-config-path /efs/workshop/configs/so101_modality_config.py "
        f"--embodiment-tag NEW_EMBODIMENT "
        f"--output-dir /efs/checkpoints/groot "
        f"--max-steps {args.max_steps} "
        f"--global-batch-size {args.batch_size} "
        f"--save-steps {args.save_steps}",
    ]


def main():
    args = parse_args()
    batch = boto3.client("batch", region_name=args.region)

    if args.job_type == "rl":
        command = build_rl_command(args)
    else:
        command = build_groot_command(args)

    submit_params = {
        "jobName": args.job_name,
        "jobQueue": args.job_queue,
        "jobDefinition": args.job_definition,
        "containerOverrides": {
            "command": command,
        },
    }

    if args.num_nodes > 1:
        submit_params["nodeOverrides"] = {
            "numNodes": args.num_nodes,
        }

    response = batch.submit_job(**submit_params)
    job_id = response["jobId"]
    print(f"Submitted Batch job: {args.job_name} (ID: {job_id})")

    if args.follow:
        print("Following job status (Ctrl+C to stop)...")
        while True:
            desc = batch.describe_jobs(jobs=[job_id])["jobs"][0]
            status = desc["status"]
            print(f"  [{time.strftime('%H:%M:%S')}] {status}")
            if status in ("SUCCEEDED", "FAILED"):
                break
            time.sleep(30)

        if status == "FAILED":
            reason = desc.get("statusReason", "unknown")
            print(f"Job failed: {reason}")
            raise SystemExit(1)
        print("Job completed successfully!")


if __name__ == "__main__":
    main()
