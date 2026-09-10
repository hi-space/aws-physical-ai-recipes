"""SO-101 MuJoCo tasks for the Physical AI on AWS workshop (RL track, module 8 and appendix A4).

Importing this package registers the Gymnasium task IDs below, so a trainer only needs
``import mujoco_workshop`` followed by ``gymnasium.make("Workshop-SO101-Reach-MuJoCo-v0")``.
The IDs mirror the Isaac Lab tasks of appendix A3 (``Workshop-SO101-Reach-v0``) with a
``-MuJoCo`` suffix so checkpoints from the two simulators are never mixed up.
"""

from gymnasium.envs.registration import register

register(
    id="Workshop-SO101-Reach-MuJoCo-v0",
    entry_point="mujoco_workshop.envs.so101_reach:So101ReachEnv",
    # 200 control steps x 0.05 s = 10 s per episode, then the target is re-sampled.
    max_episode_steps=200,
)

__all__ = ["envs"]
