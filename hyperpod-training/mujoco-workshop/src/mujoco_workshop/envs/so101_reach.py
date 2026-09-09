"""``Workshop-SO101-Reach-MuJoCo-v0`` — SO-101 arm reaches a random 3-D target (MuJoCo, CPU).

This is the CPU counterpart of module 9's Isaac Lab task ``Workshop-SO101-Reach-v0``.
The MDP is kept deliberately close to the Isaac Lab version so the two can be compared:

* **Observation (21)** — 5 joint positions (rad, relative to the home pose), 5 joint velocities,
  3-D target position, 3-D vector from end-effector to target, previous action (5).
* **Action (5)** — one value in ``[-1, 1]`` per arm joint (gripper is not controlled).
  Like Isaac Lab's ``JointPositionAction(use_default_offset=True)`` it is an *absolute* joint
  position target relative to the home pose: ``target = home + action_scale * action`` (rad),
  clipped to the joint limits and handed to MuJoCo's position servos (the STS3215 gains from
  the menagerie model). Targets are sampled only from poses the policy can express this way.
* **Reward** — the same four terms as the Isaac Lab task and the same weights:
  ``reaching`` (−distance, w=1.0), ``reaching_tanh`` (1 − tanh(d/0.1), w=0.5),
  ``action_rate`` (−‖a_t − a_{t−1}‖², w=0.01), ``joint_vel`` (−‖q̇‖², w=0.001).
  Every term is exposed in ``info["reward_terms"]`` so TensorBoard can show them separately.
* **Episode** — 200 control steps (10 s); a new target is sampled at every reset.
  ``info["is_success"]`` is true when the end-effector ends the episode within 3 cm.

Physics: MuJoCo ``robotstudio_so101/scene.xml`` (timestep 5 ms) with ``frame_skip=10``
→ 20 Hz control, matching the servo update rate a real SO-101 sees from LeRobot.
"""

from __future__ import annotations

from typing import Any

import gymnasium as gym
import mujoco
import numpy as np
from gymnasium import spaces

from mujoco_workshop.assets import so101_scene_xml

# The five arm joints. The sixth joint ("gripper") is held at a constant opening.
ARM_JOINTS = ("shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll")
GRIPPER_JOINT = "gripper"
EE_SITE = "gripperframe"  # frame between the jaws, see so101.xml

# Target box in the robot base frame (metres). Same ranges as the Isaac Lab Reach command
# (reach_env_cfg.py CommandsCfg). Targets are additionally rejection-sampled from random
# joint configurations so every target is guaranteed to be reachable.
TARGET_RANGE_X = (0.15, 0.45)
TARGET_RANGE_Y = (-0.25, 0.25)
TARGET_RANGE_Z = (0.10, 0.40)

REWARD_WEIGHTS = {
    "reaching": 1.0,        # -||ee - target||
    "reaching_tanh": 0.5,   # 1 - tanh(||ee - target|| / 0.1)
    "action_rate": -0.01,   # ||a_t - a_{t-1}||^2
    "joint_vel": -0.001,    # ||qdot||^2
}


class So101ReachEnv(gym.Env):
    metadata = {"render_modes": ["rgb_array"], "render_fps": 20}

    def __init__(
        self,
        frame_skip: int = 10,
        action_scale: float = 1.25,
        success_threshold: float = 0.03,
        render_mode: str | None = None,
        camera_distance: float = 0.85,
        width: int = 640,
        height: int = 480,
    ):
        super().__init__()
        self.model = mujoco.MjModel.from_xml_path(str(so101_scene_xml()))
        self.data = mujoco.MjData(self.model)
        self.frame_skip = frame_skip
        self.action_scale = action_scale
        self.success_threshold = success_threshold
        self.render_mode = render_mode
        self._camera_distance = camera_distance
        self._width, self._height = width, height
        self._renderer: mujoco.Renderer | None = None

        self._arm_qpos_idx = np.array([self.model.joint(j).qposadr[0] for j in ARM_JOINTS])
        self._arm_qvel_idx = np.array([self.model.joint(j).dofadr[0] for j in ARM_JOINTS])
        self._arm_act_idx = np.array([self.model.actuator(j).id for j in ARM_JOINTS])
        self._gripper_act_idx = self.model.actuator(GRIPPER_JOINT).id
        self._ee_site = self.model.site(EE_SITE).id
        self._ctrl_range = self.model.actuator_ctrlrange[self._arm_act_idx].copy()
        self._joint_range = self.model.jnt_range[[self.model.joint(j).id for j in ARM_JOINTS]].copy()
        self._home_qpos = np.zeros(len(ARM_JOINTS))

        self.action_space = spaces.Box(-1.0, 1.0, shape=(len(ARM_JOINTS),), dtype=np.float32)
        obs_dim = 5 + 5 + 3 + 3 + 5
        self.observation_space = spaces.Box(-np.inf, np.inf, shape=(obs_dim,), dtype=np.float32)

        self.target = np.zeros(3)
        self._prev_action = np.zeros(len(ARM_JOINTS), dtype=np.float32)

    # ------------------------------------------------------------------ helpers
    @property
    def dt(self) -> float:
        return self.model.opt.timestep * self.frame_skip

    def _ee_pos(self) -> np.ndarray:
        return self.data.site_xpos[self._ee_site].copy()

    def _sample_target(self) -> np.ndarray:
        """Rejection-sample a reachable target: random joint config → forward kinematics → keep if inside the box.

        Joint configs are drawn from the same set the action space can command
        (``home ± action_scale``, clipped to joint limits), so every target is reachable by the policy.
        """
        lo = np.array([TARGET_RANGE_X[0], TARGET_RANGE_Y[0], TARGET_RANGE_Z[0]])
        hi = np.array([TARGET_RANGE_X[1], TARGET_RANGE_Y[1], TARGET_RANGE_Z[1]])
        q_lo = np.maximum(self._joint_range[:, 0], self._home_qpos - self.action_scale)
        q_hi = np.minimum(self._joint_range[:, 1], self._home_qpos + self.action_scale)
        scratch = mujoco.MjData(self.model)
        for _ in range(1000):
            q = self.np_random.uniform(q_lo, q_hi)
            scratch.qpos[:] = 0.0
            scratch.qpos[self._arm_qpos_idx] = q
            mujoco.mj_kinematics(self.model, scratch)
            p = scratch.site_xpos[self._ee_site]
            if np.all(p >= lo) and np.all(p <= hi):
                return p.copy()
        # The box is well inside the workspace; falling through here means the model changed.
        raise RuntimeError("Could not sample a reachable target inside the target box")

    def _get_obs(self) -> np.ndarray:
        qpos = self.data.qpos[self._arm_qpos_idx] - self._home_qpos
        qvel = self.data.qvel[self._arm_qvel_idx]
        ee = self._ee_pos()
        return np.concatenate([qpos, qvel, self.target, self.target - ee, self._prev_action]).astype(np.float32)

    # ------------------------------------------------------------------ gym API
    def reset(self, *, seed: int | None = None, options: dict[str, Any] | None = None):
        super().reset(seed=seed)
        mujoco.mj_resetData(self.model, self.data)
        # Small random perturbation around the home pose so the policy does not overfit one start.
        noise = self.np_random.uniform(-0.1, 0.1, size=len(ARM_JOINTS))
        self.data.qpos[self._arm_qpos_idx] = self._home_qpos + noise
        self.data.ctrl[self._arm_act_idx] = self.data.qpos[self._arm_qpos_idx]
        self.data.ctrl[self._gripper_act_idx] = 0.0
        mujoco.mj_forward(self.model, self.data)
        self.target = self._sample_target()
        self._prev_action[:] = 0.0
        return self._get_obs(), {"target": self.target.copy()}

    def step(self, action: np.ndarray):
        action = np.clip(np.asarray(action, dtype=np.float32), -1.0, 1.0)
        # Absolute position target around the home pose, clipped to the actuator range (= joint limits).
        ctrl = self._home_qpos + self.action_scale * action
        self.data.ctrl[self._arm_act_idx] = np.clip(ctrl, self._ctrl_range[:, 0], self._ctrl_range[:, 1])
        for _ in range(self.frame_skip):
            mujoco.mj_step(self.model, self.data)

        ee = self._ee_pos()
        dist = float(np.linalg.norm(ee - self.target))
        qvel = self.data.qvel[self._arm_qvel_idx]
        terms = {
            "reaching": -dist,
            "reaching_tanh": 1.0 - np.tanh(dist / 0.1),
            "action_rate": float(np.sum((action - self._prev_action) ** 2)),
            "joint_vel": float(np.sum(qvel**2)),
        }
        reward = float(sum(REWARD_WEIGHTS[k] * v for k, v in terms.items()))
        self._prev_action = action

        info = {
            "distance": dist,
            "is_success": dist < self.success_threshold,
            "reward_terms": {k: REWARD_WEIGHTS[k] * v for k, v in terms.items()},
        }
        # No early termination: like the Isaac Lab task, episodes end by time limit only
        # (TimeLimit wrapper from gym.register(max_episode_steps=200)).
        return self._get_obs(), reward, False, False, info

    # ------------------------------------------------------------------ rendering
    def render(self):
        if self.render_mode != "rgb_array":
            return None
        if self._renderer is None:
            self._renderer = mujoco.Renderer(self.model, height=self._height, width=self._width)
            self._cam = mujoco.MjvCamera()
            self._cam.type = mujoco.mjtCamera.mjCAMERA_FREE
            self._cam.lookat[:] = (0.22, 0.0, 0.18)
            self._cam.distance = self._camera_distance
            self._cam.azimuth, self._cam.elevation = 150.0, -20.0
        self._renderer.update_scene(self.data, camera=self._cam)
        # Draw the target as a small green sphere so the viewer can see what the arm is reaching for.
        scn = self._renderer.scene
        if scn.ngeom < scn.maxgeom:
            g = scn.geoms[scn.ngeom]
            mujoco.mjv_initGeom(
                g, mujoco.mjtGeom.mjGEOM_SPHERE, np.array([0.015, 0, 0]),
                self.target.astype(np.float64), np.eye(3).flatten(), np.array([0.1, 0.9, 0.1, 0.8], dtype=np.float32),
            )
            scn.ngeom += 1
        return self._renderer.render()

    def close(self):
        if self._renderer is not None:
            self._renderer.close()
            self._renderer = None
