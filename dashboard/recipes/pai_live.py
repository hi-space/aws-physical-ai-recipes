"""Live frame publishing for workflow sidecars. Stdlib + imageio only.

Kept free of isaac/mujoco imports so every recipe (mujoco, isaaclab, …) can
``from pai_live import LiveFrames`` regardless of its simulator dependencies.
"""
import os
import time
from pathlib import Path


def _write_jpeg(target, frame):
    """Default encoder: imported lazily so imageio is only needed when publishing."""
    import imageio.v2 as imageio
    imageio.imwrite(target, frame, quality=80)


class LiveFrames:
    """Dashboard live view: publish JPEG frames to $PAI_LIVE_DIR/frame.jpg (atomic rename, rate limited).

    A no-op when the workflow task was not compiled with `live: true` (PAI_LIVE_DIR unset).
    The JPEG encoder can be overridden via ``writer=`` for testing without imageio.
    """

    def __init__(self, max_fps=10.0, writer=None):
        self.dir = os.environ.get("PAI_LIVE_DIR") or None
        self.interval = 1.0 / max_fps
        self.last = 0.0
        self.count = 0
        self._writer = writer or _write_jpeg
        if self.dir:
            Path(self.dir).mkdir(parents=True, exist_ok=True)

    @property
    def enabled(self):
        return self.dir is not None

    def due(self):
        return self.enabled and time.monotonic() - self.last >= self.interval

    def publish(self, frame):
        if not self.due():
            return False
        target = Path(self.dir) / "frame.jpg"
        temporary = target.with_name("frame.tmp.jpg")
        self._writer(temporary, frame)
        os.replace(temporary, target)
        self.last = time.monotonic()
        self.count += 1
        return True
