"""π0 Fine-tuning 최소 예시.

Usage:
  torchrun --nproc_per_node=4 train_pi0.py \
    --dataset-path /fsx/datasets/pi0/bridge_v2 \
    --output-dir /fsx/checkpoints/vla/pi0-bridge \
    --epochs 100
"""
import argparse
import os

import mlflow
import torch
import torch.distributed as dist
from torch.nn.parallel import DistributedDataParallel as DDP
from torch.utils.data import DataLoader
from torch.utils.data.distributed import DistributedSampler


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset-path", type=str, required=True)
    parser.add_argument("--output-dir", type=str, required=True)
    parser.add_argument("--epochs", type=int, default=100)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--lr", type=float, default=5e-5)
    parser.add_argument("--experiment", type=str, default="pi0-finetune")
    return parser.parse_args()


def setup_distributed():
    dist.init_process_group(backend="nccl")
    local_rank = int(os.environ["LOCAL_RANK"])
    torch.cuda.set_device(local_rank)
    return local_rank


def main():
    args = parse_args()
    local_rank = setup_distributed()
    rank = dist.get_rank()

    if rank == 0:
        mlflow.set_experiment(args.experiment)
        mlflow.start_run()
        mlflow.log_params(vars(args))

    # NOTE: 실제 사용 시 openpi 패키지의 모델 로딩 코드로 교체
    from openpi.model import Pi0Model
    model = Pi0Model.from_pretrained("physical-intelligence/pi0")
    model = model.to(local_rank)
    model = DDP(model, device_ids=[local_rank])

    from openpi.data import ActionDataset
    dataset = ActionDataset(args.dataset_path)
    sampler = DistributedSampler(dataset)
    dataloader = DataLoader(dataset, batch_size=args.batch_size, sampler=sampler)

    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr)

    for epoch in range(args.epochs):
        sampler.set_epoch(epoch)
        epoch_loss = 0.0
        correct = 0
        total = 0

        for batch in dataloader:
            batch = {k: v.to(local_rank) for k, v in batch.items()}
            outputs = model(batch)
            loss = outputs["loss"]
            loss.backward()
            optimizer.step()
            optimizer.zero_grad()

            epoch_loss += loss.item()
            correct += outputs.get("correct", 0)
            total += batch["actions"].shape[0]

        avg_loss = epoch_loss / len(dataloader)
        accuracy = correct / total if total > 0 else 0.0

        if rank == 0:
            mlflow.log_metrics({"loss": avg_loss, "accuracy": accuracy}, step=epoch)
            print(f"Epoch {epoch}/{args.epochs} - Loss: {avg_loss:.4f}, Acc: {accuracy:.3f}")

            if (epoch + 1) % 20 == 0:
                ckpt_path = os.path.join(args.output_dir, f"checkpoint-{epoch+1}.pt")
                torch.save(model.module.state_dict(), ckpt_path)
                mlflow.log_artifact(ckpt_path)

    if rank == 0:
        final_path = os.path.join(args.output_dir, "model_final.pt")
        torch.save(model.module.state_dict(), final_path)
        mlflow.log_artifact(final_path)
        mlflow.end_run()

    dist.destroy_process_group()


if __name__ == "__main__":
    main()
