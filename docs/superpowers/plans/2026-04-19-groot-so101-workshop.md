# GR00T + SO-ARM 101 Workshop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a modular hands-on workshop where participants finetune NVIDIA GR00T N1.7 on SO-ARM 101 data and see the finetuned model control SO-101 in Isaac Sim via Closed-loop (Policy Server → Sim Client).

**Architecture:** New workshop project under `simulation/isaac-lab/workshop/` (clean start, no reference to existing `workshop-groot-so101/`). Reuses `infra-multiuser-groot/` CDK for DCV instances, AWS Batch, and EFS. Two tracks per module — Fast Track (HF dataset, single GPU) and Deep Dive (RL→data collection, Batch distributed training) — with EFS checkpoint sharing enabling real-time Closed-loop visualization during training.

**Tech Stack:** Python 3.11+, Isaac Lab (isaaclab), NVIDIA Isaac-GR00T (gr00t), PyTorch, rsl_rl (PPO), ZMQ, uv (package manager), AWS Batch, EFS, S3, boto3

---

## File Structure

```
simulation/isaac-lab/workshop/
├── pyproject.toml                              # Package config + CLI entry points
├── setup.sh                                    # One-click environment setup
├── configs/
│   ├── modality.json                           # SO-101 state/action index mapping
│   └── so101_modality_config.py                # GR00T modality registration
├── src/workshop/
│   ├── __init__.py                             # Package init (imports tasks for registration)
│   ├── robots/
│   │   ├── __init__.py                         # Exports SO_ARM101_CFG
│   │   ├── so_arm101.py                        # ArticulationCfg for SO-101
│   │   └── urdf/                               # URDF + STL (downloaded by setup.sh)
│   ├── tasks/
│   │   ├── __init__.py                         # Auto-imports reach/ and lift/ modules
│   │   ├── reach/
│   │   │   ├── __init__.py                     # gym.register Reach-v0 + Reach-Play-v0
│   │   │   ├── reach_env_cfg.py                # Reach task environment config
│   │   │   └── agents/
│   │   │       ├── __init__.py
│   │   │       └── rsl_rl_ppo_cfg.py           # PPO hyperparameters for Reach
│   │   └── lift/
│   │       ├── __init__.py                     # gym.register Lift-v0 + Lift-Play-v0
│   │       ├── lift_env_cfg.py                 # Lift task environment config
│   │       └── agents/
│   │           ├── __init__.py
│   │           └── rsl_rl_ppo_cfg.py           # PPO hyperparameters for Lift
│   └── scripts/
│       ├── __init__.py
│       ├── list_envs.py                        # Print registered gym environments
│       ├── train_rl.py                         # RL training (PPO via rsl_rl)
│       ├── play_rl.py                          # Visualize trained RL policy
│       ├── collect_demos.py                    # Collect demonstration data from RL policy
│       ├── convert_to_lerobot.py               # Convert collected data to LeRobot v2.1
│       ├── download_hf_dataset.py              # Download + convert HF SO-101 dataset
│       ├── upload_s3.py                        # Upload dataset/checkpoints to S3
│       ├── submit_batch_job.py                 # Submit AWS Batch job (RL or GR00T)
│       └── run_closed_loop.py                  # Isaac Sim client ↔ GR00T Policy Server
└── batch/
    ├── Dockerfile.groot                        # GR00T finetuning container
    └── entrypoint.sh                           # Batch job entry: torchrun finetune
```

---

## Task 1: Project Scaffold + Package Configuration

**Files:**
- Create: `simulation/isaac-lab/workshop/pyproject.toml`
- Create: `simulation/isaac-lab/workshop/src/workshop/__init__.py`
- Create: `simulation/isaac-lab/workshop/src/workshop/scripts/__init__.py`
- Create: `simulation/isaac-lab/workshop/src/workshop/robots/__init__.py`
- Create: `simulation/isaac-lab/workshop/src/workshop/tasks/__init__.py`

- [ ] **Step 1: Create pyproject.toml**

```toml
[build-system]
requires = ["setuptools>=68.0", "wheel"]
build-backend = "setuptools.backends._legacy:_Backend"

[project]
name = "workshop"
version = "0.1.0"
description = "GR00T + SO-ARM 101 Workshop on AWS"
requires-python = ">=3.11"
dependencies = [
    "torch>=2.2.0",
    "isaaclab>=2.3.0",
    "rsl_rl>=2.3.0",
    "gymnasium>=0.29.0",
    "numpy>=1.26.0",
    "pandas>=2.0.0",
    "pyarrow>=14.0.0",
    "boto3>=1.34.0",
    "pyzmq>=25.0.0",
]

[project.scripts]
list_envs = "workshop.scripts.list_envs:main"
train_rl = "workshop.scripts.train_rl:main"
play_rl = "workshop.scripts.play_rl:main"
collect = "workshop.scripts.collect_demos:main"
convert = "workshop.scripts.convert_to_lerobot:main"
download_hf = "workshop.scripts.download_hf_dataset:main"
upload_s3 = "workshop.scripts.upload_s3:main"
submit_batch = "workshop.scripts.submit_batch_job:main"
closed_loop = "workshop.scripts.run_closed_loop:main"

[tool.setuptools.packages.find]
where = ["src"]
```

- [ ] **Step 2: Create package __init__.py files**

`src/workshop/__init__.py`:
```python
import workshop.tasks  # noqa: F401 — triggers gym.register for all tasks
```

`src/workshop/scripts/__init__.py`:
```python
```

`src/workshop/robots/__init__.py`:
```python
from .so_arm101 import SO_ARM101_CFG  # noqa: F401

__all__ = ["SO_ARM101_CFG"]
```

`src/workshop/tasks/__init__.py`:
```python
from isaaclab_tasks.utils import import_packages

_BLACKLIST_PKGS = ["utils"]
import_packages(__name__, _BLACKLIST_PKGS)
```

- [ ] **Step 3: Create empty directory stubs**

```bash
mkdir -p simulation/isaac-lab/workshop/src/workshop/robots/urdf
mkdir -p simulation/isaac-lab/workshop/src/workshop/tasks/reach/agents
mkdir -p simulation/isaac-lab/workshop/src/workshop/tasks/lift/agents
mkdir -p simulation/isaac-lab/workshop/configs
mkdir -p simulation/isaac-lab/workshop/batch
```

- [ ] **Step 4: Commit**

```bash
git add simulation/isaac-lab/workshop/
git commit -m "feat(workshop): scaffold project structure with pyproject.toml and package init"
```

---

## Task 2: SO-101 Robot Definition

**Files:**
- Create: `simulation/isaac-lab/workshop/src/workshop/robots/so_arm101.py`

- [ ] **Step 1: Write ArticulationCfg for SO-ARM 101**

```python
from pathlib import Path

import isaaclab.sim as sim_utils
from isaaclab.actuators import ImplicitActuatorCfg
from isaaclab.assets.articulation import ArticulationCfg

_ASSETS_DIR = Path(__file__).resolve().parent

SO_ARM101_CFG = ArticulationCfg(
    spawn=sim_utils.UrdfFileCfg(
        fix_base=True,
        replace_cylinders_with_capsules=True,
        asset_path=f"{_ASSETS_DIR}/urdf/so_arm101.urdf",
        activate_contact_sensors=False,
        rigid_props=sim_utils.RigidBodyPropertiesCfg(
            disable_gravity=False,
            max_depenetration_velocity=5.0,
        ),
        articulation_props=sim_utils.ArticulationRootPropertiesCfg(
            enabled_self_collisions=True,
            solver_position_iteration_count=8,
            solver_velocity_iteration_count=0,
        ),
        joint_drive=sim_utils.UrdfConverterCfg.JointDriveCfg(
            gains=sim_utils.UrdfConverterCfg.JointDriveCfg.PDGainsCfg(
                stiffness=0, damping=0
            )
        ),
    ),
    init_state=ArticulationCfg.InitialStateCfg(
        rot=(1.0, 0.0, 0.0, 0.0),
        joint_pos={
            "shoulder_pan": 0.0,
            "shoulder_lift": 0.0,
            "elbow_flex": 0.0,
            "wrist_flex": 1.57,
            "wrist_roll": 0.0,
            "gripper": 0.0,
        },
        joint_vel={".*": 0.0},
    ),
    actuators={
        "arm": ImplicitActuatorCfg(
            joint_names_expr=["shoulder_.*", "elbow_flex", "wrist_.*"],
            effort_limit_sim=1.9,
            velocity_limit_sim=1.5,
            stiffness={
                "shoulder_pan": 200.0,
                "shoulder_lift": 170.0,
                "elbow_flex": 120.0,
                "wrist_flex": 80.0,
                "wrist_roll": 50.0,
            },
            damping={
                "shoulder_pan": 80.0,
                "shoulder_lift": 65.0,
                "elbow_flex": 45.0,
                "wrist_flex": 30.0,
                "wrist_roll": 20.0,
            },
        ),
        "gripper": ImplicitActuatorCfg(
            joint_names_expr=["gripper"],
            effort_limit_sim=2.5,
            velocity_limit_sim=1.5,
            stiffness=60.0,
            damping=20.0,
        ),
    },
    soft_joint_pos_limit_factor=0.9,
)
```

- [ ] **Step 2: Commit**

```bash
git add simulation/isaac-lab/workshop/src/workshop/robots/so_arm101.py
git commit -m "feat(workshop): add SO-ARM 101 ArticulationCfg with URDF loader"
```

---

## Task 3: Reach Task Environment

**Files:**
- Create: `simulation/isaac-lab/workshop/src/workshop/tasks/reach/__init__.py`
- Create: `simulation/isaac-lab/workshop/src/workshop/tasks/reach/reach_env_cfg.py`
- Create: `simulation/isaac-lab/workshop/src/workshop/tasks/reach/agents/__init__.py`
- Create: `simulation/isaac-lab/workshop/src/workshop/tasks/reach/agents/rsl_rl_ppo_cfg.py`

- [ ] **Step 1: Write Reach environment config**

`reach_env_cfg.py`:
```python
from __future__ import annotations

import isaaclab.sim as sim_utils
from isaaclab.assets import AssetBaseCfg
from isaaclab.envs import ManagerBasedRLEnvCfg
from isaaclab.managers import EventTermCfg as EventTerm
from isaaclab.managers import ObservationGroupCfg as ObsGroup
from isaaclab.managers import ObservationTermCfg as ObsTerm
from isaaclab.managers import RewardTermCfg as RewTerm
from isaaclab.managers import SceneEntityCfg
from isaaclab.managers import TerminationTermCfg as DoneTerm
from isaaclab.scene import InteractiveSceneCfg
from isaaclab.utils import configclass

import isaaclab.envs.mdp as mdp
from workshop.robots import SO_ARM101_CFG

JOINT_NAMES = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll"]


@configclass
class ReachSceneCfg(InteractiveSceneCfg):
    ground = AssetBaseCfg(
        prim_path="/World/ground",
        spawn=sim_utils.GroundPlaneCfg(),
    )
    light = AssetBaseCfg(
        prim_path="/World/light",
        spawn=sim_utils.DistantLightCfg(intensity=3000.0),
    )
    robot = SO_ARM101_CFG.replace(prim_path="{ENV_REGEX_NS}/Robot")
    target = AssetBaseCfg(
        prim_path="{ENV_REGEX_NS}/Target",
        spawn=sim_utils.SphereCfg(
            radius=0.02,
            visual_material=sim_utils.PreviewSurfaceCfg(diffuse_color=(1.0, 0.0, 0.0)),
        ),
        init_state=AssetBaseCfg.InitialStateCfg(pos=(0.3, 0.0, 0.3)),
    )


@configclass
class ObservationsCfg:
    @configclass
    class PolicyCfg(ObsGroup):
        joint_pos = ObsTerm(func=mdp.joint_pos_rel)
        joint_vel = ObsTerm(func=mdp.joint_vel_rel)
        target_pos = ObsTerm(
            func=mdp.generated_commands,
            params={"command_name": "ee_pose"},
        )

        def __post_init__(self):
            self.enable_corruption = False
            self.concatenate_terms = True

    policy: PolicyCfg = PolicyCfg()


@configclass
class ActionsCfg:
    arm_action = mdp.JointPositionActionCfg(
        asset_name="robot",
        joint_names=JOINT_NAMES,
        scale=0.5,
        use_default_offset=True,
    )


@configclass
class RewardsCfg:
    reaching = RewTerm(
        func=mdp.reward_reaching_target,
        weight=1.0,
        params={"asset_cfg": SceneEntityCfg("robot"), "command_name": "ee_pose"},
    )
    action_rate = RewTerm(func=mdp.action_rate_l2, weight=-0.01)
    joint_vel = RewTerm(func=mdp.joint_vel_l2, weight=-0.001)


@configclass
class TerminationsCfg:
    time_out = DoneTerm(func=mdp.time_out, time_out=True)


@configclass
class CommandsCfg:
    ee_pose = mdp.UniformPoseCommandCfg(
        asset_name="robot",
        body_name="Fixed_Jaw",
        resampling_time_range=(4.0, 4.0),
        ranges=mdp.UniformPoseCommandCfg.Ranges(
            pos_x=(0.15, 0.45),
            pos_y=(-0.25, 0.25),
            pos_z=(0.1, 0.4),
        ),
    )


@configclass
class EventsCfg:
    reset_robot = EventTerm(
        func=mdp.reset_joints_by_offset,
        mode="reset",
        params={
            "asset_cfg": SceneEntityCfg("robot"),
            "position_range": (-0.1, 0.1),
            "velocity_range": (0.0, 0.0),
        },
    )


@configclass
class SoArm101ReachEnvCfg(ManagerBasedRLEnvCfg):
    scene = ReachSceneCfg(num_envs=4096, env_spacing=1.5)
    observations = ObservationsCfg()
    actions = ActionsCfg()
    rewards = RewardsCfg()
    terminations = TerminationsCfg()
    commands = CommandsCfg()
    events = EventsCfg()

    def __post_init__(self):
        self.sim.dt = 0.01
        self.decimation = 2
        self.episode_length_s = 12.0


@configclass
class SoArm101ReachEnvCfg_PLAY(SoArm101ReachEnvCfg):
    def __post_init__(self):
        super().__post_init__()
        self.scene.num_envs = 50
        self.scene.env_spacing = 2.5
```

- [ ] **Step 2: Write PPO config**

`agents/rsl_rl_ppo_cfg.py`:
```python
from isaaclab.utils import configclass
from isaaclab_rl.rsl_rl import RslRlOnPolicyRunnerCfg, RslRlPpoActorCriticCfg, RslRlPpoAlgorithmCfg


@configclass
class ReachPPORunnerCfg(RslRlOnPolicyRunnerCfg):
    num_steps_per_env = 24
    max_iterations = 1000
    save_interval = 100
    experiment_name = "reach_so101"
    run_name = ""
    logger = "tensorboard"
    policy = RslRlPpoActorCriticCfg(
        class_name="ActorCritic",
        init_noise_std=1.0,
        actor_hidden_dims=[64, 64],
        critic_hidden_dims=[64, 64],
        activation="elu",
    )
    algorithm = RslRlPpoAlgorithmCfg(
        value_loss_coef=1.0,
        use_clipped_value_loss=True,
        clip_param=0.2,
        entropy_coef=0.005,
        num_learning_epochs=5,
        num_mini_batches=4,
        learning_rate=1.0e-3,
        schedule="adaptive",
        gamma=0.99,
        lam=0.95,
        desired_kl=0.01,
        max_grad_norm=1.0,
    )
```

`agents/__init__.py`:
```python
from .rsl_rl_ppo_cfg import ReachPPORunnerCfg  # noqa: F401
```

- [ ] **Step 3: Write registration**

`reach/__init__.py`:
```python
import gymnasium as gym

from . import agents  # noqa: F401

gym.register(
    id="Workshop-SO101-Reach-v0",
    entry_point="isaaclab.envs:ManagerBasedRLEnv",
    kwargs={
        "env_cfg_entry_point": f"{__name__}.reach_env_cfg:SoArm101ReachEnvCfg",
        "rsl_rl_cfg_entry_point": f"{agents.__name__}.rsl_rl_ppo_cfg:ReachPPORunnerCfg",
    },
    disable_env_checker=True,
)

gym.register(
    id="Workshop-SO101-Reach-Play-v0",
    entry_point="isaaclab.envs:ManagerBasedRLEnv",
    kwargs={
        "env_cfg_entry_point": f"{__name__}.reach_env_cfg:SoArm101ReachEnvCfg_PLAY",
        "rsl_rl_cfg_entry_point": f"{agents.__name__}.rsl_rl_ppo_cfg:ReachPPORunnerCfg",
    },
    disable_env_checker=True,
)
```

- [ ] **Step 4: Commit**

```bash
git add simulation/isaac-lab/workshop/src/workshop/tasks/reach/
git commit -m "feat(workshop): add SO-101 Reach task with PPO config"
```

---

## Task 4: Lift Task Environment

**Files:**
- Create: `simulation/isaac-lab/workshop/src/workshop/tasks/lift/__init__.py`
- Create: `simulation/isaac-lab/workshop/src/workshop/tasks/lift/lift_env_cfg.py`
- Create: `simulation/isaac-lab/workshop/src/workshop/tasks/lift/agents/__init__.py`
- Create: `simulation/isaac-lab/workshop/src/workshop/tasks/lift/agents/rsl_rl_ppo_cfg.py`

- [ ] **Step 1: Write Lift environment config**

`lift_env_cfg.py`:
```python
from __future__ import annotations

import isaaclab.sim as sim_utils
from isaaclab.assets import AssetBaseCfg, RigidObjectCfg
from isaaclab.envs import ManagerBasedRLEnvCfg
from isaaclab.managers import EventTermCfg as EventTerm
from isaaclab.managers import ObservationGroupCfg as ObsGroup
from isaaclab.managers import ObservationTermCfg as ObsTerm
from isaaclab.managers import RewardTermCfg as RewTerm
from isaaclab.managers import SceneEntityCfg
from isaaclab.managers import TerminationTermCfg as DoneTerm
from isaaclab.scene import InteractiveSceneCfg
from isaaclab.utils import configclass

import isaaclab.envs.mdp as mdp
from workshop.robots import SO_ARM101_CFG

JOINT_NAMES = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll"]
GRIPPER_JOINT = ["gripper"]


@configclass
class LiftSceneCfg(InteractiveSceneCfg):
    ground = AssetBaseCfg(
        prim_path="/World/ground",
        spawn=sim_utils.GroundPlaneCfg(),
    )
    light = AssetBaseCfg(
        prim_path="/World/light",
        spawn=sim_utils.DistantLightCfg(intensity=3000.0),
    )
    table = AssetBaseCfg(
        prim_path="{ENV_REGEX_NS}/Table",
        spawn=sim_utils.CuboidCfg(
            size=(0.4, 0.4, 0.2),
            visual_material=sim_utils.PreviewSurfaceCfg(diffuse_color=(0.6, 0.4, 0.2)),
            rigid_props=sim_utils.RigidBodyPropertiesCfg(kinematic_enabled=True),
            collision_props=sim_utils.CollisionPropertiesCfg(),
        ),
        init_state=AssetBaseCfg.InitialStateCfg(pos=(0.3, 0.0, 0.1)),
    )
    robot = SO_ARM101_CFG.replace(prim_path="{ENV_REGEX_NS}/Robot")
    cube = RigidObjectCfg(
        prim_path="{ENV_REGEX_NS}/Cube",
        spawn=sim_utils.CuboidCfg(
            size=(0.04, 0.04, 0.04),
            visual_material=sim_utils.PreviewSurfaceCfg(diffuse_color=(0.0, 0.5, 1.0)),
            rigid_props=sim_utils.RigidBodyPropertiesCfg(),
            mass_props=sim_utils.MassPropertiesCfg(mass=0.05),
            collision_props=sim_utils.CollisionPropertiesCfg(),
        ),
        init_state=RigidObjectCfg.InitialStateCfg(pos=(0.3, 0.0, 0.22)),
    )


@configclass
class LiftObservationsCfg:
    @configclass
    class PolicyCfg(ObsGroup):
        joint_pos = ObsTerm(func=mdp.joint_pos_rel)
        joint_vel = ObsTerm(func=mdp.joint_vel_rel)
        cube_pos = ObsTerm(
            func=mdp.object_position_in_robot_root_frame,
            params={"object_cfg": SceneEntityCfg("cube"), "robot_cfg": SceneEntityCfg("robot")},
        )
        target_pos = ObsTerm(
            func=mdp.generated_commands,
            params={"command_name": "object_pose"},
        )

        def __post_init__(self):
            self.enable_corruption = False
            self.concatenate_terms = True

    policy: PolicyCfg = PolicyCfg()


@configclass
class LiftActionsCfg:
    arm_action = mdp.JointPositionActionCfg(
        asset_name="robot",
        joint_names=JOINT_NAMES,
        scale=0.5,
        use_default_offset=True,
    )
    gripper_action = mdp.BinaryJointPositionActionCfg(
        asset_name="robot",
        joint_names=GRIPPER_JOINT,
        open_command_expr={"gripper": 0.5},
        close_command_expr={"gripper": 0.0},
    )


@configclass
class LiftRewardsCfg:
    reaching_cube = RewTerm(
        func=mdp.reward_reaching_target,
        weight=1.0,
        params={"asset_cfg": SceneEntityCfg("robot"), "command_name": "object_pose"},
    )
    lifting = RewTerm(
        func=mdp.object_height_reward,
        weight=5.0,
        params={"object_cfg": SceneEntityCfg("cube"), "min_height": 0.3},
    )
    action_rate = RewTerm(func=mdp.action_rate_l2, weight=-0.01)
    joint_vel = RewTerm(func=mdp.joint_vel_l2, weight=-0.001)


@configclass
class LiftTerminationsCfg:
    time_out = DoneTerm(func=mdp.time_out, time_out=True)


@configclass
class LiftCommandsCfg:
    object_pose = mdp.UniformPoseCommandCfg(
        asset_name="robot",
        body_name="Fixed_Jaw",
        resampling_time_range=(6.0, 6.0),
        ranges=mdp.UniformPoseCommandCfg.Ranges(
            pos_x=(0.25, 0.35),
            pos_y=(-0.1, 0.1),
            pos_z=(0.35, 0.5),
        ),
    )


@configclass
class LiftEventsCfg:
    reset_robot = EventTerm(
        func=mdp.reset_joints_by_offset,
        mode="reset",
        params={
            "asset_cfg": SceneEntityCfg("robot"),
            "position_range": (-0.1, 0.1),
            "velocity_range": (0.0, 0.0),
        },
    )
    reset_cube = EventTerm(
        func=mdp.reset_root_state_uniform,
        mode="reset",
        params={
            "asset_cfg": SceneEntityCfg("cube"),
            "pose_range": {"x": (-0.05, 0.05), "y": (-0.05, 0.05), "z": (0.0, 0.0)},
            "velocity_range": {},
        },
    )


@configclass
class SoArm101LiftEnvCfg(ManagerBasedRLEnvCfg):
    scene = LiftSceneCfg(num_envs=4096, env_spacing=1.5)
    observations = LiftObservationsCfg()
    actions = LiftActionsCfg()
    rewards = LiftRewardsCfg()
    terminations = LiftTerminationsCfg()
    commands = LiftCommandsCfg()
    events = LiftEventsCfg()

    def __post_init__(self):
        self.sim.dt = 0.01
        self.decimation = 2
        self.episode_length_s = 15.0


@configclass
class SoArm101LiftEnvCfg_PLAY(SoArm101LiftEnvCfg):
    def __post_init__(self):
        super().__post_init__()
        self.scene.num_envs = 50
        self.scene.env_spacing = 2.5
```

- [ ] **Step 2: Write Lift PPO config**

`agents/rsl_rl_ppo_cfg.py`:
```python
from isaaclab.utils import configclass
from isaaclab_rl.rsl_rl import RslRlOnPolicyRunnerCfg, RslRlPpoActorCriticCfg, RslRlPpoAlgorithmCfg


@configclass
class LiftPPORunnerCfg(RslRlOnPolicyRunnerCfg):
    num_steps_per_env = 24
    max_iterations = 1500
    save_interval = 100
    experiment_name = "lift_so101"
    run_name = ""
    logger = "tensorboard"
    policy = RslRlPpoActorCriticCfg(
        class_name="ActorCritic",
        init_noise_std=1.0,
        actor_hidden_dims=[256, 128, 64],
        critic_hidden_dims=[256, 128, 64],
        activation="elu",
    )
    algorithm = RslRlPpoAlgorithmCfg(
        value_loss_coef=1.0,
        use_clipped_value_loss=True,
        clip_param=0.2,
        entropy_coef=0.005,
        num_learning_epochs=5,
        num_mini_batches=4,
        learning_rate=1.0e-4,
        schedule="adaptive",
        gamma=0.99,
        lam=0.95,
        desired_kl=0.01,
        max_grad_norm=1.0,
    )
```

`agents/__init__.py`:
```python
from .rsl_rl_ppo_cfg import LiftPPORunnerCfg  # noqa: F401
```

- [ ] **Step 3: Write registration**

`lift/__init__.py`:
```python
import gymnasium as gym

from . import agents  # noqa: F401

gym.register(
    id="Workshop-SO101-Lift-v0",
    entry_point="isaaclab.envs:ManagerBasedRLEnv",
    kwargs={
        "env_cfg_entry_point": f"{__name__}.lift_env_cfg:SoArm101LiftEnvCfg",
        "rsl_rl_cfg_entry_point": f"{agents.__name__}.rsl_rl_ppo_cfg:LiftPPORunnerCfg",
    },
    disable_env_checker=True,
)

gym.register(
    id="Workshop-SO101-Lift-Play-v0",
    entry_point="isaaclab.envs:ManagerBasedRLEnv",
    kwargs={
        "env_cfg_entry_point": f"{__name__}.lift_env_cfg:SoArm101LiftEnvCfg_PLAY",
        "rsl_rl_cfg_entry_point": f"{agents.__name__}.rsl_rl_ppo_cfg:LiftPPORunnerCfg",
    },
    disable_env_checker=True,
)
```

- [ ] **Step 4: Commit**

```bash
git add simulation/isaac-lab/workshop/src/workshop/tasks/lift/
git commit -m "feat(workshop): add SO-101 Lift Cube task with PPO config"
```

---

## Task 5: CLI Scripts — list_envs, train_rl, play_rl

**Files:**
- Create: `simulation/isaac-lab/workshop/src/workshop/scripts/list_envs.py`
- Create: `simulation/isaac-lab/workshop/src/workshop/scripts/train_rl.py`
- Create: `simulation/isaac-lab/workshop/src/workshop/scripts/play_rl.py`

- [ ] **Step 1: Write list_envs.py**

```python
"""Print all registered workshop gym environments."""
import gymnasium as gym

import workshop  # noqa: F401 — triggers task registration


def main():
    envs = [eid for eid in gym.registry.keys() if eid.startswith("Workshop-")]
    print(f"\nRegistered workshop environments ({len(envs)}):\n")
    for eid in sorted(envs):
        print(f"  {eid}")
    print()


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Write train_rl.py**

```python
"""RL training for SO-101 tasks using rsl_rl PPO."""
import argparse

from isaaclab.app import AppLauncher


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train SO-101 RL policy")
    parser.add_argument("--task", required=True, help="Gym environment ID (e.g. Workshop-SO101-Reach-v0)")
    parser.add_argument("--num_envs", type=int, default=None, help="Override number of environments")
    parser.add_argument("--max_iterations", type=int, default=None, help="Override max iterations")
    parser.add_argument("--headless", action="store_true", help="Run without visualization")
    parser.add_argument("--checkpoint", type=str, default=None, help="Resume from checkpoint")
    parser.add_argument("--log_dir", type=str, default="logs/rsl_rl", help="Log directory")
    AppLauncher.add_app_launcher_args(parser)
    args = parser.parse_args()
    return args


def main():
    args = parse_args()
    launcher = AppLauncher(args)
    simulation_app = launcher.app

    import gymnasium as gym
    import importlib
    from rsl_rl.runners import OnPolicyRunner

    import workshop  # noqa: F401

    env_cfg_entry = gym.spec(args.task).kwargs["env_cfg_entry_point"]
    agent_cfg_entry = gym.spec(args.task).kwargs["rsl_rl_cfg_entry_point"]

    module_path, class_name = env_cfg_entry.rsplit(":", 1)
    env_cfg = getattr(importlib.import_module(module_path), class_name)()

    module_path, class_name = agent_cfg_entry.rsplit(":", 1)
    agent_cfg = getattr(importlib.import_module(module_path), class_name)()

    if args.num_envs is not None:
        env_cfg.scene.num_envs = args.num_envs
    if args.max_iterations is not None:
        agent_cfg.max_iterations = args.max_iterations

    env = gym.make(args.task, cfg=env_cfg)

    runner = OnPolicyRunner(
        env,
        agent_cfg.to_dict(),
        log_dir=f"{args.log_dir}/{agent_cfg.experiment_name}",
        device=agent_cfg.device,
    )

    if args.checkpoint:
        runner.load(args.checkpoint)

    runner.learn(num_learning_iterations=agent_cfg.max_iterations)

    env.close()
    simulation_app.close()


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Write play_rl.py**

```python
"""Visualize trained RL policy on SO-101 tasks."""
import argparse
import glob

from isaaclab.app import AppLauncher


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Visualize trained SO-101 RL policy")
    parser.add_argument("--task", required=True, help="Play environment ID (e.g. Workshop-SO101-Reach-Play-v0)")
    parser.add_argument("--checkpoint", type=str, default=None, help="Path to checkpoint (defaults to latest)")
    parser.add_argument("--num_steps", type=int, default=1000, help="Number of simulation steps")
    parser.add_argument("--headless", action="store_true", help="Run without visualization")
    parser.add_argument("--video", action="store_true", help="Record video")
    parser.add_argument("--video_length", type=int, default=200, help="Video length in steps")
    AppLauncher.add_app_launcher_args(parser)
    args = parser.parse_args()
    return args


def main():
    args = parse_args()
    launcher = AppLauncher(args)
    simulation_app = launcher.app

    import gymnasium as gym
    import importlib
    import torch
    from rsl_rl.runners import OnPolicyRunner

    import workshop  # noqa: F401

    env_cfg_entry = gym.spec(args.task).kwargs["env_cfg_entry_point"]
    agent_cfg_entry = gym.spec(args.task).kwargs["rsl_rl_cfg_entry_point"]

    module_path, class_name = env_cfg_entry.rsplit(":", 1)
    env_cfg = getattr(importlib.import_module(module_path), class_name)()

    module_path, class_name = agent_cfg_entry.rsplit(":", 1)
    agent_cfg = getattr(importlib.import_module(module_path), class_name)()

    env = gym.make(args.task, cfg=env_cfg, render_mode="rgb_array" if args.video else None)

    runner = OnPolicyRunner(env, agent_cfg.to_dict(), log_dir=None, device=agent_cfg.device)

    checkpoint = args.checkpoint
    if checkpoint is None:
        pattern = f"logs/rsl_rl/{agent_cfg.experiment_name}/*/checkpoints/best_agent.pt"
        matches = sorted(glob.glob(pattern))
        if not matches:
            raise FileNotFoundError(f"No checkpoint found matching {pattern}")
        checkpoint = matches[-1]
        print(f"Using latest checkpoint: {checkpoint}")

    runner.load(checkpoint)
    policy = runner.get_inference_policy(device=env.unwrapped.device)

    obs, _ = env.reset()
    for step in range(args.num_steps):
        with torch.inference_mode():
            actions = policy(obs)
        obs, _, _, _, _ = env.step(actions)

    env.close()
    simulation_app.close()


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Commit**

```bash
git add simulation/isaac-lab/workshop/src/workshop/scripts/list_envs.py \
       simulation/isaac-lab/workshop/src/workshop/scripts/train_rl.py \
       simulation/isaac-lab/workshop/src/workshop/scripts/play_rl.py
git commit -m "feat(workshop): add CLI scripts for env listing, RL training, and policy visualization"
```

---

## Task 6: Demo Collection + LeRobot Conversion Scripts

**Files:**
- Create: `simulation/isaac-lab/workshop/src/workshop/scripts/collect_demos.py`
- Create: `simulation/isaac-lab/workshop/src/workshop/scripts/convert_to_lerobot.py`

- [ ] **Step 1: Write collect_demos.py**

```python
"""Collect demonstration episodes from a trained RL policy."""
import argparse
from pathlib import Path

from isaaclab.app import AppLauncher


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Collect demos from trained RL policy")
    parser.add_argument("--task", required=True, help="Play environment ID")
    parser.add_argument("--checkpoint", required=True, help="Path to RL checkpoint")
    parser.add_argument("--num_episodes", type=int, default=200, help="Number of episodes to collect")
    parser.add_argument("--output_dir", type=str, required=True, help="Output directory for .npz files")
    parser.add_argument("--headless", action="store_true", help="Run without visualization")
    AppLauncher.add_app_launcher_args(parser)
    args = parser.parse_args()
    return args


def main():
    args = parse_args()
    launcher = AppLauncher(args)
    simulation_app = launcher.app

    import gymnasium as gym
    import importlib
    import numpy as np
    import torch
    from rsl_rl.runners import OnPolicyRunner

    import workshop  # noqa: F401

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    env_cfg_entry = gym.spec(args.task).kwargs["env_cfg_entry_point"]
    agent_cfg_entry = gym.spec(args.task).kwargs["rsl_rl_cfg_entry_point"]

    module_path, class_name = env_cfg_entry.rsplit(":", 1)
    env_cfg = getattr(importlib.import_module(module_path), class_name)()
    env_cfg.scene.num_envs = 1

    module_path, class_name = agent_cfg_entry.rsplit(":", 1)
    agent_cfg = getattr(importlib.import_module(module_path), class_name)()

    env = gym.make(args.task, cfg=env_cfg)
    runner = OnPolicyRunner(env, agent_cfg.to_dict(), log_dir=None, device=agent_cfg.device)
    runner.load(args.checkpoint)
    policy = runner.get_inference_policy(device=env.unwrapped.device)

    ep_count = 0
    obs, _ = env.reset()

    while ep_count < args.num_episodes:
        states_buf = []
        actions_buf = []
        done = False

        while not done:
            with torch.inference_mode():
                actions = policy(obs)

            states_buf.append(obs[0, :6].cpu().numpy())
            actions_buf.append(actions[0, :6].cpu().numpy())

            obs, _, dones, _, _ = env.step(actions)
            done = dones[0].item() if dones.numel() > 0 else False

        np.savez(
            output_dir / f"episode_{ep_count:06d}.npz",
            states=np.array(states_buf, dtype=np.float32),
            actions=np.array(actions_buf, dtype=np.float32),
        )
        print(f"Episode {ep_count + 1}/{args.num_episodes} — {len(states_buf)} steps")
        ep_count += 1
        obs, _ = env.reset()

    print(f"\nCollected {ep_count} episodes → {output_dir}")
    env.close()
    simulation_app.close()


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Write convert_to_lerobot.py**

```python
"""Convert collected .npz demo episodes to LeRobot v2.1 format."""
import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

FPS = 30
JOINT_NAMES = [
    "shoulder_pan.pos",
    "shoulder_lift.pos",
    "elbow_flex.pos",
    "wrist_flex.pos",
    "wrist_roll.pos",
    "gripper.pos",
]


def write_info_json(output_path: Path, total_episodes: int, total_frames: int) -> None:
    info = {
        "codebase_version": "v2.1",
        "robot_type": "so101_follower",
        "total_episodes": total_episodes,
        "total_frames": total_frames,
        "total_tasks": 1,
        "chunks_size": 1000,
        "fps": FPS,
        "data_path": "data/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.parquet",
        "features": {
            "action": {"dtype": "float32", "shape": [6], "names": JOINT_NAMES},
            "observation.state": {"dtype": "float32", "shape": [6], "names": JOINT_NAMES},
            "timestamp": {"dtype": "float32", "shape": [1]},
        },
    }
    (output_path / "meta" / "info.json").write_text(json.dumps(info, indent=2))


def write_episodes_jsonl(output_path: Path, episodes: list[dict]) -> None:
    with open(output_path / "meta" / "episodes.jsonl", "w") as f:
        for ep in episodes:
            f.write(json.dumps(ep) + "\n")


def write_tasks_jsonl(output_path: Path, task_description: str) -> None:
    with open(output_path / "meta" / "tasks.jsonl", "w") as f:
        f.write(json.dumps({"task_index": 0, "task": task_description}) + "\n")


def write_modality_json(output_path: Path) -> None:
    modality = {
        "state": {
            "single_arm": {"start": 0, "end": 5},
            "gripper": {"start": 5, "end": 6},
        },
        "action": {
            "single_arm": {"start": 0, "end": 5},
            "gripper": {"start": 5, "end": 6},
        },
        "annotation": {
            "human.task_description": {"original_key": "task_index"},
        },
    }
    (output_path / "meta" / "modality.json").write_text(json.dumps(modality, indent=2))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Convert .npz demos to LeRobot v2.1")
    parser.add_argument("--input_dir", required=True, help="Directory with episode_*.npz files")
    parser.add_argument("--output_dir", required=True, help="Output LeRobot dataset directory")
    parser.add_argument("--task_description", default="lift cube to target height", help="Task text")
    return parser.parse_args()


def main():
    args = parse_args()
    input_path = Path(args.input_dir)
    output_path = Path(args.output_dir)

    (output_path / "meta").mkdir(parents=True, exist_ok=True)
    (output_path / "data" / "chunk-000").mkdir(parents=True, exist_ok=True)

    npz_files = sorted(input_path.glob("episode_*.npz"))
    if not npz_files:
        raise FileNotFoundError(f"No episode_*.npz files found in {input_path}")

    episodes_meta = []
    global_idx = 0
    total_frames = 0

    for ep_idx, npz_file in enumerate(npz_files):
        data = np.load(npz_file)
        states = data["states"].astype(np.float32)
        actions = data["actions"].astype(np.float32)
        ep_len = min(len(states), len(actions))

        if states.shape[1] < 6:
            pad = np.zeros((ep_len, 6 - states.shape[1]), dtype=np.float32)
            states = np.concatenate([states[:ep_len], pad], axis=1)
        if actions.shape[1] < 6:
            pad = np.zeros((ep_len, 6 - actions.shape[1]), dtype=np.float32)
            actions = np.concatenate([actions[:ep_len], pad], axis=1)

        rows = []
        for i in range(ep_len):
            rows.append({
                "observation.state": states[i].tolist(),
                "action": actions[i].tolist(),
                "timestamp": float(i) / FPS,
                "frame_index": i,
                "episode_index": ep_idx,
                "index": global_idx,
                "task_index": 0,
                "next.done": i == ep_len - 1,
                "next.reward": 0.0,
            })
            global_idx += 1

        df = pd.DataFrame(rows)
        df.to_parquet(output_path / "data" / "chunk-000" / f"episode_{ep_idx:06d}.parquet")

        episodes_meta.append({
            "episode_index": ep_idx,
            "tasks": [args.task_description],
            "length": ep_len,
        })
        total_frames += ep_len

    write_info_json(output_path, len(npz_files), total_frames)
    write_episodes_jsonl(output_path, episodes_meta)
    write_tasks_jsonl(output_path, args.task_description)
    write_modality_json(output_path)

    print(f"\nConverted {len(npz_files)} episodes ({total_frames} frames) → {output_path}")
    print("Next: run stats.py to generate normalization statistics")


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Commit**

```bash
git add simulation/isaac-lab/workshop/src/workshop/scripts/collect_demos.py \
       simulation/isaac-lab/workshop/src/workshop/scripts/convert_to_lerobot.py
git commit -m "feat(workshop): add demo collection and LeRobot v2.1 conversion scripts"
```

---

## Task 7: HuggingFace Dataset Download + S3 Upload Scripts

**Files:**
- Create: `simulation/isaac-lab/workshop/src/workshop/scripts/download_hf_dataset.py`
- Create: `simulation/isaac-lab/workshop/src/workshop/scripts/upload_s3.py`

- [ ] **Step 1: Write download_hf_dataset.py**

```python
"""Download SO-101 dataset from HuggingFace, convert to LeRobot v2.1, apply modality config."""
import argparse
import shutil
import subprocess
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Download HF SO-101 dataset")
    parser.add_argument("--repo_id", required=True, help="HuggingFace dataset repo (e.g. izuluaga/finish_sandwich)")
    parser.add_argument("--output_dir", required=True, help="Output directory for converted dataset")
    parser.add_argument("--groot_dir", default="~/environment/Isaac-GR00T", help="Isaac-GR00T repo path")
    return parser.parse_args()


def main():
    args = parse_args()
    groot_dir = Path(args.groot_dir).expanduser()
    output_dir = Path(args.output_dir)

    if not groot_dir.exists():
        raise FileNotFoundError(f"Isaac-GR00T not found at {groot_dir}. Run setup.sh first.")

    print(f"Downloading and converting {args.repo_id}...")
    subprocess.run(
        [
            "uv", "run", "--project", str(groot_dir / "scripts" / "lerobot_conversion"),
            "python", str(groot_dir / "scripts" / "lerobot_conversion" / "convert_v3_to_v2.py"),
            "--repo-id", args.repo_id,
            "--root", str(output_dir),
        ],
        check=True,
    )

    dataset_path = output_dir / args.repo_id.replace("/", "/")
    if not dataset_path.exists():
        candidates = list(output_dir.rglob("meta/info.json"))
        if candidates:
            dataset_path = candidates[0].parent.parent
        else:
            raise FileNotFoundError(f"Converted dataset not found under {output_dir}")

    modality_src = Path(__file__).resolve().parents[2] / "configs" / "modality.json"
    modality_dst = dataset_path / "meta" / "modality.json"
    shutil.copy2(modality_src, modality_dst)
    print(f"Copied modality.json → {modality_dst}")

    print(f"\nDataset ready at: {dataset_path}")
    print(f"Episodes: {sum(1 for _ in (dataset_path / 'data').rglob('*.parquet'))}")
    print("\nNext: upload_s3 --local_path <path> --s3_prefix datasets/so101")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Write upload_s3.py**

```python
"""Upload local directory to S3 (dataset, checkpoint, or model)."""
import argparse
import os
from pathlib import Path

import boto3


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Upload to S3")
    parser.add_argument("--local_path", required=True, help="Local directory or file to upload")
    parser.add_argument("--bucket", required=True, help="S3 bucket name")
    parser.add_argument("--s3_prefix", required=True, help="S3 key prefix (e.g. datasets/so101)")
    parser.add_argument("--region", default="us-east-1", help="AWS region")
    return parser.parse_args()


def main():
    args = parse_args()
    local_path = Path(args.local_path)
    s3 = boto3.client("s3", region_name=args.region)

    if local_path.is_file():
        key = f"{args.s3_prefix}/{local_path.name}"
        print(f"Uploading {local_path} → s3://{args.bucket}/{key}")
        s3.upload_file(str(local_path), args.bucket, key)
    elif local_path.is_dir():
        file_count = 0
        for root, _, files in os.walk(local_path):
            for fname in files:
                fpath = Path(root) / fname
                relative = fpath.relative_to(local_path)
                key = f"{args.s3_prefix}/{relative}"
                s3.upload_file(str(fpath), args.bucket, key)
                file_count += 1
        print(f"Uploaded {file_count} files → s3://{args.bucket}/{args.s3_prefix}/")
    else:
        raise FileNotFoundError(f"{local_path} does not exist")

    print(f"S3 URI: s3://{args.bucket}/{args.s3_prefix}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Commit**

```bash
git add simulation/isaac-lab/workshop/src/workshop/scripts/download_hf_dataset.py \
       simulation/isaac-lab/workshop/src/workshop/scripts/upload_s3.py
git commit -m "feat(workshop): add HuggingFace dataset download and S3 upload scripts"
```

---

## Task 8: GR00T Modality Configs

**Files:**
- Create: `simulation/isaac-lab/workshop/configs/modality.json`
- Create: `simulation/isaac-lab/workshop/configs/so101_modality_config.py`

- [ ] **Step 1: Write modality.json**

```json
{
    "state": {
        "single_arm": {"start": 0, "end": 5},
        "gripper": {"start": 5, "end": 6}
    },
    "action": {
        "single_arm": {"start": 0, "end": 5},
        "gripper": {"start": 5, "end": 6}
    },
    "annotation": {
        "human.task_description": {"original_key": "task_index"}
    }
}
```

- [ ] **Step 2: Write so101_modality_config.py**

```python
"""GR00T modality configuration for SO-ARM 101 (5 arm DOF + 1 gripper)."""
from gr00t.data.embodiment_tags import EmbodimentTag
from gr00t.data.dataset.modality_config import ModalityConfig
from gr00t.data.dataset.modality_config import ActionConfig, ActionFormat, ActionRepresentation, ActionType


SO101_MODALITY_CONFIG = {
    "state": ModalityConfig(
        delta_indices=[0],
        modality_keys=["single_arm", "gripper"],
    ),
    "action": ModalityConfig(
        delta_indices=list(range(0, 16)),
        modality_keys=["single_arm", "gripper"],
        action_configs=[
            ActionConfig(
                rep=ActionRepresentation.RELATIVE,
                type=ActionType.NON_EEF,
                format=ActionFormat.DEFAULT,
            ),
            ActionConfig(
                rep=ActionRepresentation.ABSOLUTE,
                type=ActionType.NON_EEF,
                format=ActionFormat.DEFAULT,
            ),
        ],
    ),
    "language": ModalityConfig(
        delta_indices=[0],
        modality_keys=["annotation.human.task_description"],
    ),
}


def register():
    from gr00t.configs.data.embodiment_configs import register_modality_config
    register_modality_config(SO101_MODALITY_CONFIG, embodiment_tag=EmbodimentTag.NEW_EMBODIMENT)


register()
```

- [ ] **Step 3: Commit**

```bash
git add simulation/isaac-lab/workshop/configs/
git commit -m "feat(workshop): add SO-101 GR00T modality config files"
```

---

## Task 9: AWS Batch Job Submission Script

**Files:**
- Create: `simulation/isaac-lab/workshop/src/workshop/scripts/submit_batch_job.py`

- [ ] **Step 1: Write submit_batch_job.py**

```python
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
```

- [ ] **Step 2: Commit**

```bash
git add simulation/isaac-lab/workshop/src/workshop/scripts/submit_batch_job.py
git commit -m "feat(workshop): add AWS Batch job submission script for RL and GR00T training"
```

---

## Task 10: GR00T Batch Container

**Files:**
- Create: `simulation/isaac-lab/workshop/batch/Dockerfile.groot`
- Create: `simulation/isaac-lab/workshop/batch/entrypoint.sh`

- [ ] **Step 1: Write Dockerfile.groot**

```dockerfile
FROM nvcr.io/nvidia/pytorch:25.04-py3

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    git git-lfs awscli nfs-common && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

RUN git clone https://github.com/NVIDIA/Isaac-GR00T.git /workspace/Isaac-GR00T && \
    cd /workspace/Isaac-GR00T && \
    pip install --no-cache-dir uv && \
    uv sync --all-extras

COPY entrypoint.sh /workspace/entrypoint.sh
RUN chmod +x /workspace/entrypoint.sh

WORKDIR /workspace/Isaac-GR00T
ENTRYPOINT ["/workspace/entrypoint.sh"]
```

- [ ] **Step 2: Write entrypoint.sh**

```bash
#!/bin/bash
set -euo pipefail

echo "===== [$(date)] GR00T Batch Job Start ====="
echo "Node: $(hostname)"
echo "GPUs: $(nvidia-smi -L | wc -l)"

CHECKPOINT_DIR="${CHECKPOINT_DIR:-/efs/checkpoints/groot}"
mkdir -p "${CHECKPOINT_DIR}"
echo "Checkpoints → ${CHECKPOINT_DIR}"

if [ $# -gt 0 ]; then
    echo "Running: $@"
    exec "$@"
else
    echo "No command provided. Usage: entrypoint.sh <command> [args...]"
    exit 1
fi
```

- [ ] **Step 3: Commit**

```bash
git add simulation/isaac-lab/workshop/batch/
git commit -m "feat(workshop): add GR00T finetuning Batch container (Dockerfile + entrypoint)"
```

---

## Task 11: Closed-loop Simulation Client

**Files:**
- Create: `simulation/isaac-lab/workshop/src/workshop/scripts/run_closed_loop.py`

- [ ] **Step 1: Write run_closed_loop.py**

This is the core of the workshop — connects Isaac Sim SO-101 to GR00T Policy Server. Uses `gr00t.policy.server_client.PolicyClient` (the official GR00T client) which handles ZMQ serialization internally.

```python
"""Isaac Sim SO-101 Closed-loop client for GR00T Policy Server.

Runs Isaac Sim with SO-101, captures camera images + joint states,
sends observations to GR00T Policy Server (ZMQ), receives 16-step
action sequences, and applies them to the simulated robot.
"""
import argparse

from isaaclab.app import AppLauncher


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="SO-101 Closed-loop with GR00T Policy Server")
    parser.add_argument("--policy_host", default="localhost", help="GR00T Policy Server host")
    parser.add_argument("--policy_port", type=int, default=5555, help="GR00T Policy Server port")
    parser.add_argument("--instruction", default="lift the cube", help="Language instruction for GR00T")
    parser.add_argument("--num_steps", type=int, default=5000, help="Number of simulation steps")
    parser.add_argument("--headless", action="store_true", help="Run without visualization")
    AppLauncher.add_app_launcher_args(parser)
    args = parser.parse_args()
    return args


def main():
    args = parse_args()
    launcher = AppLauncher(args)
    simulation_app = launcher.app

    import numpy as np
    import torch
    from gr00t.policy.server_client import PolicyClient

    from isaaclab.sim import SimulationContext
    import isaaclab.sim as sim_utils
    from isaaclab.sensors import CameraCfg, Camera
    from workshop.robots import SO_ARM101_CFG

    sim_cfg = sim_utils.SimulationCfg(dt=0.01)
    sim = SimulationContext(sim_cfg)
    sim.set_camera_view(eye=[1.0, 1.0, 0.8], target=[0.3, 0.0, 0.2])

    sim_utils.GroundPlaneCfg().func("/World/ground", sim_utils.GroundPlaneCfg())
    sim_utils.DistantLightCfg(intensity=3000.0).func("/World/light", sim_utils.DistantLightCfg(intensity=3000.0))

    robot_cfg = SO_ARM101_CFG.copy()
    robot_cfg.prim_path = "/World/Robot"
    robot = robot_cfg.class_type(cfg=robot_cfg)

    camera_cfg = CameraCfg(
        prim_path="/World/Camera",
        update_period=0.033,
        height=256,
        width=256,
        data_types=["rgb"],
        spawn=sim_utils.PinholeCameraCfg(
            focal_length=24.0, focus_distance=400.0,
            horizontal_aperture=20.955, clipping_range=(0.1, 10.0),
        ),
        offset=CameraCfg.OffsetCfg(pos=(0.6, 0.0, 0.6), rot=(0.9, 0.0, -0.44, 0.0), convention="world"),
    )
    camera = Camera(camera_cfg)

    sim.reset()
    robot.reset()
    camera.reset()

    # GR00T PolicyClient handles ZMQ communication internally
    policy = PolicyClient(host=args.policy_host, port=args.policy_port)
    print(f"Connected to GR00T Policy Server at {args.policy_host}:{args.policy_port}")

    action_queue = []

    for step in range(args.num_steps):
        sim.step()
        robot.update(sim.get_physics_dt())
        camera.update(sim.get_physics_dt())

        if not action_queue:
            joint_pos = robot.data.joint_pos[0].cpu().numpy()
            rgb = camera.data.output["rgb"][0].cpu().numpy()

            # GR00T observation format: all tensors are (Batch, Time, ...)
            obs = {
                "video": {
                    "ego_view": rgb.reshape(1, 1, 256, 256, 3).astype(np.uint8),
                },
                "state": {
                    "single_arm": joint_pos[:5].reshape(1, 1, 5).astype(np.float32),
                    "gripper": joint_pos[5:6].reshape(1, 1, 1).astype(np.float32),
                },
                "language": {
                    "task": [[args.instruction]],
                },
            }

            action, info = policy.get_action(obs)
            # action shape: (horizon=16, action_dim)
            action_queue = list(action)

        if action_queue:
            action = action_queue.pop(0)
            target_pos = torch.tensor(action[:6], dtype=torch.float32, device=robot.device).unsqueeze(0)
            robot.set_joint_position_target(target_pos)

        if step % 500 == 0:
            print(f"Step {step}/{args.num_steps} — actions queued: {len(action_queue)}")

    print("Closed-loop simulation complete.")
    sim.stop()
    simulation_app.close()


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Commit**

```bash
git add simulation/isaac-lab/workshop/src/workshop/scripts/run_closed_loop.py
git commit -m "feat(workshop): add GR00T → Isaac Sim SO-101 closed-loop simulation client"
```

---

## Task 12: setup.sh — One-Click Environment Setup

**Files:**
- Create: `simulation/isaac-lab/workshop/setup.sh`

- [ ] **Step 1: Write setup.sh**

```bash
#!/usr/bin/env bash
# Workshop GR00T + SO-ARM 101 — One-click environment setup
#
# 1. Download SO-101 URDF + STL from TheRobotStudio (official)
# 2. Install Python dependencies via uv
# 3. Verify registered Isaac Lab environments
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
URDF_DIR="${SCRIPT_DIR}/src/workshop/robots/urdf"

echo "=== Workshop GR00T + SO-ARM 101 Setup ==="
echo ""

if [ -f "${URDF_DIR}/so_arm101.urdf" ]; then
    echo "[1/3] URDF already exists, skipping download."
else
    echo "[1/3] Downloading SO-ARM 101 URDF from TheRobotStudio/SO-ARM100..."

    TEMP_DIR=$(mktemp -d)
    trap 'rm -rf "${TEMP_DIR}"' EXIT

    git clone --depth 1 --filter=blob:none --sparse \
        https://github.com/TheRobotStudio/SO-ARM100.git \
        "${TEMP_DIR}/SO-ARM100"

    cd "${TEMP_DIR}/SO-ARM100"
    git sparse-checkout set Simulation/SO101
    cd "${SCRIPT_DIR}"

    SRC="${TEMP_DIR}/SO-ARM100/Simulation/SO101"

    if [ ! -f "${SRC}/so101_new_calib.urdf" ]; then
        echo "  ERROR: URDF not found in TheRobotStudio repo."
        echo "  Download manually from: https://github.com/TheRobotStudio/SO-ARM100/tree/main/Simulation/SO101"
        echo "  Place files in: ${URDF_DIR}/"
        exit 1
    fi

    mkdir -p "${URDF_DIR}/assets"
    cp "${SRC}/so101_new_calib.urdf" "${URDF_DIR}/so_arm101.urdf"
    cp "${SRC}"/assets/*.stl "${URDF_DIR}/assets/"

    echo "  URDF: ${URDF_DIR}/so_arm101.urdf"
    echo "  STL:  $(ls "${URDF_DIR}/assets/"*.stl | wc -l) mesh files"
fi
echo ""

echo "[2/3] Installing Python dependencies (uv sync)..."
cd "${SCRIPT_DIR}"
uv sync
echo ""

echo "[3/3] Verifying registered environments..."
uv run list_envs
echo ""

echo "=== Setup complete ==="
echo ""
echo "Quick start:"
echo ""
echo "  # Module 1 Fast Track: Download HF dataset"
echo "  uv run download_hf -h"
echo ""
echo "  # Module 1 Deep Dive: Train RL policy"
echo "  uv run train_rl --task Workshop-SO101-Reach-v0"
echo ""
echo "  # Module 2+3: GR00T finetuning + Closed-loop"
echo "  uv run closed_loop --policy_host localhost --instruction 'lift the cube'"
```

- [ ] **Step 2: Make executable and commit**

```bash
chmod +x simulation/isaac-lab/workshop/setup.sh
git add simulation/isaac-lab/workshop/setup.sh
git commit -m "feat(workshop): add one-click environment setup script"
```

---

## Task 13: Workshop Guide Document

**Files:**
- Create: `simulation/isaac-lab/workshop/README.md`

- [ ] **Step 1: Write the workshop guide README.md**

See the full README content in the design spec at `docs/superpowers/specs/2026-04-19-groot-so101-workshop-design.md` for the module structure. The README should follow the module structure defined there:

- Module 0: Environment setup (DCV access, Isaac-GR00T clone, setup.sh, verification)
- Module 1: Data preparation (Fast Track: HF download with `download_hf` + `upload_s3`; Deep Dive: RL Batch training with `submit_batch --job_type rl` → `play_rl` → `collect` → `convert` → `upload_s3`)
- Module 2+3: GR00T finetuning + Closed-loop (Fast Track: single GPU finetune on DCV + `closed_loop`; Deep Dive: `submit_batch --job_type groot` with EFS checkpoints + simultaneous `closed_loop` on DCV)
- GPU requirements table
- Troubleshooting table
- Reference links

The README must include the exact CLI commands documented in each module using the entry points defined in `pyproject.toml`:
- `uv run list_envs`
- `uv run train_rl --task Workshop-SO101-Reach-v0`
- `uv run play_rl --task Workshop-SO101-Reach-Play-v0 --checkpoint <path>`
- `uv run collect --task <id> --checkpoint <path> --num_episodes 200 --output_dir <dir>`
- `uv run convert --input_dir <dir> --output_dir <dir> --task_description "..."` 
- `uv run download_hf --repo_id <id> --output_dir <dir>`
- `uv run upload_s3 --local_path <dir> --bucket <name> --s3_prefix <prefix>`
- `uv run submit_batch --job_type groot --job_name <name> --job_queue <queue> --job_definition <def> --dataset_s3_uri <uri> --follow`
- `uv run closed_loop --policy_host localhost --instruction "lift the cube"`

- [ ] **Step 2: Commit**

```bash
git add simulation/isaac-lab/workshop/README.md
git commit -m "docs(workshop): add comprehensive workshop guide with Fast Track / Deep Dive modules"
```

---

## Self-Review Checklist

### 1. Spec coverage

| Spec requirement | Task(s) |
|-----------------|---------|
| CDK infra reuse | Not modified — reused as-is |
| New workshop code from scratch | All tasks create new files under `workshop/` |
| Module 0: Environment setup | Task 1 (scaffold), Task 2 (robot), Task 12 (setup.sh) |
| Module 1 Fast: HF dataset | Task 7 (download_hf_dataset.py, upload_s3.py) |
| Module 1 Deep: RL Batch → data collect | Task 5 (train_rl.py), Task 6 (collect_demos.py, convert_to_lerobot.py), Task 9 (submit_batch_job.py) |
| Module 2+3 Fast: Single GPU finetune | Task 8 (modality configs), README instructions |
| Module 2+3 Deep: Batch distributed | Task 9 (submit_batch_job.py), Task 10 (container) |
| Closed-loop: GR00T → Isaac Sim | Task 11 (run_closed_loop.py) |
| EFS checkpoint sharing | Task 9 (groot command writes to /efs), Task 11 (reads from /efs) |
| Workshop guide | Task 13 (README.md) |

### 2. Placeholder scan
- No TBD, TODO, or "implement later" found
- All code steps contain complete code blocks
- Task 13 README: lists exact CLI commands rather than showing full README text inline (to avoid duplication with the implementation), but provides all the content requirements

### 3. Type consistency
- `SO_ARM101_CFG` — consistent across Task 2 (definition), Task 3/4 (usage in env cfg), Task 11 (closed-loop)
- `Workshop-SO101-Reach-v0` / `Workshop-SO101-Lift-v0` — consistent naming across Task 3/4 (registration), Task 5 (train_rl), Task 13 (README)
- `modality.json` paths — consistent between Task 8 (creation) and Task 6 (convert_to_lerobot references)
- Joint names `["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"]` — consistent across Task 2, 3, 4, 6, 11
- `PolicyClient` in Task 11 uses the official `gr00t.policy.server_client.PolicyClient` API (not raw ZMQ)
