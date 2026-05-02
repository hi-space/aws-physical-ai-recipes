"""GR00T-N1.6-3B Fine-tuning 최소 예시.

Usage:
  torchrun --nproc_per_node=4 train_groot.py \
    --dataset-path /fsx/datasets/groot/aloha \
    --output-dir /fsx/checkpoints/vla/groot-aloha \
    --epochs 50
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
    parser.add_argument("--epochs", type=int, default=50)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--lr", type=float, default=1e-4)
    parser.add_argument("--experiment", type=str, default="groot-finetune")
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

    # NOTE: 실제 사용 시 gr00t 패키지의 모델 로딩 코드로 교체
    from gr00t.model import GR00TModel
    model = GR00TModel.from_pretrained("nvidia/GR00T-N1.6-3B")
    model = model.to(local_rank)
    model = DDP(model, device_ids=[local_rank])

    from gr00t.data import LeRobotDataset
    dataset = LeRobotDataset(args.dataset_path)
    sampler = DistributedSampler(dataset)
    dataloader = DataLoader(dataset, batch_size=args.batch_size, sampler=sampler)

    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr)

    for epoch in range(args.epochs):
        sampler.set_epoch(epoch)
        epoch_loss = 0.0

        for batch in dataloader:
            batch = {k: v.to(local_rank) for k, v in batch.items()}
            loss = model(batch)
            loss.backward()
            optimizer.step()
            optimizer.zero_grad()
            epoch_loss += loss.item()

        avg_loss = epoch_loss / len(dataloader)

        if rank == 0:
            mlflow.log_metric("loss", avg_loss, step=epoch)
            print(f"Epoch {epoch}/{args.epochs} - Loss: {avg_loss:.4f}")

            if (epoch + 1) % 10 == 0:
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
