"""SO101 follower arm modality configuration for GR00T fine-tuning.

Used with --embodiment-tag new_embodiment --modality-config-path configs/so101_modality.py

SO101 has 6 joints: shoulder_pan, shoulder_lift, elbow_flex, wrist_flex, wrist_roll, gripper
Dataset: LightwheelAI/so101-place-orange (LeRobot v2 format)
"""

from gr00t.experiment.data_config import DataConfig

data_config = DataConfig(
    base_dataset_type="lerobot",
    dataset_type="lerobot",
    # State: 6-DOF joint positions from observation.state
    state_keys=["observation.state"],
    state_dims=[6],
    # Action: 6-DOF joint position targets
    action_keys=["action"],
    action_dims=[6],
    # Video: front and wrist cameras
    video_keys=["observation.images.front", "observation.images.wrist"],
    # Action prediction horizon
    action_horizon=16,
)
