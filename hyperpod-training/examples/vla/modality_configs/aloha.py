"""ALOHA bimanual robot modality configuration for GR00T fine-tuning.

ALOHA uses two 6-DOF arms + grippers with a front camera.
Dataset keys must match the fields in meta/modality.json.
"""

from gr00t.configs.data.embodiment_configs import register_modality_config
from gr00t.data.embodiment_tags import EmbodimentTag
from gr00t.data.types import (
    ActionConfig,
    ActionFormat,
    ActionRepresentation,
    ActionType,
    ModalityConfig,
)

MODALITY_CONFIG = {
    "video": ModalityConfig(
        delta_indices=[0],
        modality_keys=["front_camera"],
    ),
    "state": ModalityConfig(
        delta_indices=[0],
        modality_keys=["joint_positions"],
        sin_cos_embedding_keys=["joint_positions"],
    ),
    "action": ModalityConfig(
        delta_indices=list(range(0, 16)),
        modality_keys=["joint_positions_action", "gripper_action"],
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
        modality_keys=["language_instruction"],
    ),
}

register_modality_config(MODALITY_CONFIG, embodiment_tag=EmbodimentTag.NEW_EMBODIMENT)
