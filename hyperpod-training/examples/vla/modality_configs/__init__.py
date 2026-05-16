"""Modality configuration registry for GR00T fine-tuning.

Each config file defines a MODALITY_CONFIG dict and calls register_modality_config().
Import a config module to register it before training.
"""

from importlib import import_module
from pathlib import Path

AVAILABLE_CONFIGS = {
    "aloha": "modality_configs.aloha",
    "so100": "modality_configs.so100",
}


def load_config(name: str) -> None:
    """Load and register a modality config by name or file path."""
    if name in AVAILABLE_CONFIGS:
        import_module(f".{name}", package=__package__)
    elif Path(name).is_file() and name.endswith(".py"):
        import importlib.util

        spec = importlib.util.spec_from_file_location("custom_modality", name)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
    else:
        raise ValueError(
            f"Unknown modality config: {name}. "
            f"Available: {list(AVAILABLE_CONFIGS.keys())} or provide a .py file path."
        )
