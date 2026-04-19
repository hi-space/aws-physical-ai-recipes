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
