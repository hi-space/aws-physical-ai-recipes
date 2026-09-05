"""Custom MDP observation and reward terms for SO-101 workshop tasks."""
from __future__ import annotations

import torch
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from isaaclab.envs import ManagerBasedEnv
    from isaaclab.managers import SceneEntityCfg


def object_position_in_robot_root_frame(
    env: ManagerBasedEnv,
    object_cfg: SceneEntityCfg,
    robot_cfg: SceneEntityCfg,
) -> torch.Tensor:
    """Object position expressed in the robot's root frame."""
    object_pos_w = torch.as_tensor(env.scene[object_cfg.name].data.root_pos_w, device=env.device)[:, :3]
    robot_pos_w = torch.as_tensor(env.scene[robot_cfg.name].data.root_pos_w, device=env.device)[:, :3]
    robot_quat_w = torch.as_tensor(env.scene[robot_cfg.name].data.root_quat_w, device=env.device)
    object_pos_rel = object_pos_w - robot_pos_w
    object_pos_b = _quat_rotate_inverse(robot_quat_w, object_pos_rel)
    return object_pos_b


def reward_reaching_target(
    env: ManagerBasedEnv,
    asset_cfg: SceneEntityCfg,
    command_name: str,
) -> torch.Tensor:
    """Negative L2 distance between the end-effector and the commanded target position.

    ``UniformPoseCommand`` expresses the target in the robot's *base* frame, while
    ``body_pos_w`` is in the *world* frame (it includes each environment's origin offset).
    The command therefore has to be transformed into the world frame with the robot's root
    pose before taking the distance — otherwise the distance is dominated by the env origin,
    is the same constant for every policy, and the task cannot be learned.
    """
    from isaaclab.utils.math import combine_frame_transforms

    asset = env.scene[asset_cfg.name]
    body_id = asset_cfg.body_ids[0] if isinstance(asset_cfg.body_ids, (list, tuple)) else asset_cfg.body_ids
    ee_pos_w = torch.as_tensor(asset.data.body_pos_w, device=env.device)[:, body_id, :3]
    target_pos_b = env.command_manager.get_command(command_name)[:, :3]
    target_pos_w, _ = combine_frame_transforms(
        torch.as_tensor(asset.data.root_pos_w, device=env.device),
        torch.as_tensor(asset.data.root_quat_w, device=env.device),
        target_pos_b,
    )
    distance = torch.norm(ee_pos_w - target_pos_w, dim=-1)
    return -distance


def reward_reaching_target_tanh(
    env: ManagerBasedEnv,
    asset_cfg: SceneEntityCfg,
    command_name: str,
    std: float = 0.1,
) -> torch.Tensor:
    """Fine-grained reaching reward ``1 - tanh(distance / std)`` (positive near the target).

    Complements :func:`reward_reaching_target`: the linear term drives the arm toward the
    target from far away, this term sharpens the last centimetres.
    """
    return 1.0 - torch.tanh(-reward_reaching_target(env, asset_cfg, command_name) / std)


def object_height_reward(
    env: ManagerBasedEnv,
    object_cfg: SceneEntityCfg,
    min_height: float,
) -> torch.Tensor:
    """Reward for lifting an object above min_height."""
    object_height = torch.as_tensor(env.scene[object_cfg.name].data.root_pos_w, device=env.device)[:, 2]
    return torch.clamp(object_height - min_height, min=0.0)


def _quat_rotate_inverse(quat: torch.Tensor, vec: torch.Tensor) -> torch.Tensor:
    """Rotate vector by the inverse of a quaternion (w, x, y, z)."""
    q_w, q_x, q_y, q_z = quat[:, 0:1], quat[:, 1:2], quat[:, 2:3], quat[:, 3:4]
    t = 2.0 * torch.cross(
        torch.cat([-q_x, -q_y, -q_z], dim=-1), vec, dim=-1
    )
    return vec + q_w * t + torch.cross(torch.cat([-q_x, -q_y, -q_z], dim=-1), t, dim=-1)
