"""Open-loop evaluation of a fine-tuned GR00T model.

Compares predicted actions against ground truth on the evaluation dataset.
This runs on a GPU node without requiring Isaac Sim.

Usage:
  python verify_in_sim.py --model-path /fsx/checkpoints/vla/groot-demo_data/checkpoint-5
  python verify_in_sim.py --model-path /fsx/checkpoints/vla/groot-demo_data/checkpoint-5 --dataset-path /fsx/datasets/groot/demo_data
"""

import argparse
from copy import deepcopy

import numpy as np


def parse_args():
    parser = argparse.ArgumentParser(description="Open-loop GR00T model evaluation")
    parser.add_argument("--model-path", type=str, required=True,
                        help="Path to fine-tuned checkpoint or HF model ID")
    parser.add_argument("--dataset-path", type=str, default=None,
                        help="Dataset path for evaluation (default: demo_data from repo)")
    parser.add_argument("--embodiment-tag", type=str,
                        default="OXE_DROID_RELATIVE_EEF_RELATIVE_JOINT")
    parser.add_argument("--traj-ids", type=int, nargs="+", default=[0, 1],
                        help="Trajectory IDs to evaluate")
    parser.add_argument("--steps-per-traj", type=int, default=100,
                        help="Max steps per trajectory")
    parser.add_argument("--action-horizon", type=int, default=16,
                        help="Action horizon (steps between inference calls)")
    parser.add_argument("--device", type=str, default="cuda:0")
    return parser.parse_args()


def main():
    args = parse_args()

    from gr00t.data.dataset.lerobot_episode_loader import LeRobotEpisodeLoader
    from gr00t.data.dataset.sharded_single_step_dataset import extract_step_data
    from gr00t.data.embodiment_tags import EmbodimentTag
    from gr00t.policy.gr00t_policy import Gr00tPolicy

    dataset_path = args.dataset_path
    if dataset_path is None:
        import gr00t
        from pathlib import Path
        repo_root = Path(gr00t.__file__).parent.parent
        dataset_path = str(repo_root / "demo_data" / "droid_sample")

    embodiment_tag = EmbodimentTag.resolve(args.embodiment_tag)

    print(f"Model: {args.model_path}")
    print(f"Dataset: {dataset_path}")
    print(f"Embodiment: {embodiment_tag.name}")
    print(f"Trajectories: {args.traj_ids}")
    print(f"Action horizon: {args.action_horizon}")
    print()

    print("Loading model...")
    policy = Gr00tPolicy(
        embodiment_tag=embodiment_tag,
        model_path=args.model_path,
        device=args.device,
    )

    modality_configs = policy.get_modality_config()

    print("Loading dataset...")
    loader = LeRobotEpisodeLoader(
        dataset_path=dataset_path,
        modality_configs=modality_configs,
    )

    state_keys = modality_configs["state"].modality_keys
    action_keys = modality_configs["action"].modality_keys
    obs_modality_configs = deepcopy(modality_configs)
    obs_modality_configs.pop("action")

    all_mse = []

    for traj_id in args.traj_ids:
        print(f"\n  Trajectory {traj_id}:")
        traj = loader[traj_id]
        traj_length = len(traj)
        actual_steps = min(args.steps_per_traj, traj_length)

        pred_actions = []
        gt_actions = []

        step_counts = list(range(0, actual_steps, args.action_horizon))

        for step_count in step_counts:
            data_point = extract_step_data(traj, step_count, obs_modality_configs, embodiment_tag)

            obs = {}
            for k, v in data_point.states.items():
                obs[f"state.{k}"] = v
            for k, v in data_point.images.items():
                obs[f"video.{k}"] = np.array(v)
            for language_key in modality_configs["language"].modality_keys:
                obs[language_key] = data_point.text

            parsed_obs = {}
            for modality in ["video", "state", "language"]:
                parsed_obs[modality] = {}
                for key in obs_modality_configs[modality].modality_keys:
                    if modality == "language":
                        parsed_key = key
                    else:
                        parsed_key = f"{modality}.{key}"
                    arr = obs[parsed_key]
                    if isinstance(arr, str):
                        parsed_obs[modality][key] = [[arr]]
                    else:
                        parsed_obs[modality][key] = arr[None, :]

            action_chunk, _ = policy.get_action(parsed_obs)

            pred_concat = np.concatenate(
                [np.array(action_chunk[key])[0, 0, :]
                 for key in action_chunk],
                axis=0,
            )
            pred_actions.append(pred_concat)

            gt_action_arrays = []
            for key in action_keys:
                gt_val = traj.iloc[step_count].get(f"action.{key}", None)
                if gt_val is not None:
                    gt_action_arrays.append(np.atleast_1d(np.array(gt_val)))
            if gt_action_arrays:
                gt_actions.append(np.concatenate(gt_action_arrays, axis=0))

        if pred_actions and gt_actions:
            min_len = min(len(pred_actions), len(gt_actions))
            pred_arr = np.array(pred_actions[:min_len])
            gt_arr = np.array(gt_actions[:min_len])
            min_dim = min(pred_arr.shape[-1], gt_arr.shape[-1])
            mse = np.mean((pred_arr[:, :min_dim] - gt_arr[:, :min_dim]) ** 2)
            all_mse.append(mse)
            print(f"    Steps evaluated: {len(step_counts)}, MSE: {mse:.6f}")
        else:
            print(f"    Steps evaluated: {len(step_counts)}, No GT action for comparison")

    if all_mse:
        print(f"\nOverall MSE: {np.mean(all_mse):.6f} (+/- {np.std(all_mse):.6f})")

    print("\nEvaluation complete.")


if __name__ == "__main__":
    main()
