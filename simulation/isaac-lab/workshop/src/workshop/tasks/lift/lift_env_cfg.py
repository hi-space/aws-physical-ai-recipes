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
from workshop.tasks import mdp_terms

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
            func=mdp_terms.object_position_in_robot_root_frame,
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
        func=mdp_terms.reward_reaching_target,
        weight=1.0,
        params={"asset_cfg": SceneEntityCfg("robot", body_names=["gripper_frame_link"]), "command_name": "object_pose"},
    )
    lifting = RewTerm(
        func=mdp_terms.object_height_reward,
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
        body_name="gripper_frame_link",
        resampling_time_range=(6.0, 6.0),
        ranges=mdp.UniformPoseCommandCfg.Ranges(
            pos_x=(0.25, 0.35),
            pos_y=(-0.1, 0.1),
            pos_z=(0.35, 0.5),
            roll=(0.0, 0.0),
            pitch=(0.0, 0.0),
            yaw=(0.0, 0.0),
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
    scene = LiftSceneCfg(num_envs=4096, env_spacing=1.5, replicate_physics=False)
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
