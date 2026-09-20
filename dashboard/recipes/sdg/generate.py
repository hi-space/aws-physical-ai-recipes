"""Headless Replicator RGB/depth/semantic images from a real USD scene."""
import argparse
import json
import os
import sys
import threading
import time
from pathlib import Path


def kit_portable_root() -> Path:
    """Writable Kit data/cache/logs root.

    Dashboard workloads run as uid 1000 while ``/isaac-sim/kit/cache`` is root-owned. Without a writable
    shader cache Kit logs ``Failed to initialize rtx::shaderdb::ContextManager`` and ``HydraEngine rtx failed
    creating scene renderer``; render products then never deliver frames and ``orchestrator.step()`` spins
    forever. Placing the portable root under the pod's cache directory keeps the RTX renderer alive.
    """
    root = Path(os.environ.get("XDG_CACHE_HOME") or "/tmp") / "isaac-kit-portable"
    root.mkdir(parents=True, exist_ok=True)
    return root


def assert_rgb_not_black(frame: Path, min_mean: float) -> float:
    """Fail loudly when the RGB pass came out black.

    Headless RTX renders RGB frames before MDL materials and textures finish compiling; depth and semantic
    passes are geometry-only and look fine, so a black RGB pass would otherwise be published silently (the
    first g6e run shipped 93 frames whose brightest pixel was 1/255). Returns the mean RGB value.
    """
    from PIL import Image
    import numpy as np
    pixels = np.asarray(Image.open(frame).convert("RGB"), dtype=np.float32)
    mean = float(pixels.mean())
    if min_mean > 0 and mean < min_mean:
        raise RuntimeError(f"RGB pass is black ({frame.name}: mean {mean:.2f} < {min_mean}); "
                           "increase --warmup-updates so materials finish loading before capture")
    return mean


def first_frame_watchdog(frames: Path, timeout: float):
    """Abort instead of hanging when the renderer never produces the first frame."""
    def run():
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if frames.exists() and any(frames.rglob("*.png")):
                return
            time.sleep(5)
        sys.stderr.write(f"Replicator produced no frame within {timeout:.0f}s; the RTX renderer is likely unavailable "
                         "(check for 'failed creating scene renderer' in the log)\n")
        sys.stderr.flush()
        os._exit(3)
    threading.Thread(target=run, name="first-frame-watchdog", daemon=True).start()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scene", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--frames", type=int, default=32)
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--height", type=int, default=480)
    parser.add_argument("--first-frame-timeout", type=float, default=float(os.environ.get("SDG_FIRST_FRAME_TIMEOUT", "900")),
                        help="seconds to wait for the first rendered frame before failing (0 disables)")
    parser.add_argument("--warmup-updates", type=int, default=int(os.environ.get("SDG_WARMUP_UPDATES", "200")),
                        help="app.update() calls after scene setup so RTX materials/textures load before capture")
    parser.add_argument("--min-rgb-mean", type=float, default=float(os.environ.get("SDG_MIN_RGB_MEAN", "2")),
                        help="fail when the first RGB frame's mean value is below this (0 disables the check)")
    args = parser.parse_args()
    if args.frames < 1:
        parser.error("frames must be positive")
    portable_root = kit_portable_root()
    # SimulationApp appends a bare --portable (root = /isaac-sim/kit) unless it sees --portable-root in argv.
    sys.argv += ["--portable-root", str(portable_root)]
    from isaacsim import SimulationApp
    app = SimulationApp({"headless": True, "extra_args": ["--portable-root", str(portable_root)]})
    try:
        render(app, args)
    except BaseException:  # noqa: BLE001 - SimulationApp.close() exits the process, so report before it runs
        # SimulationApp.close() shuts Kit down and terminates the interpreter with status 0, which would turn
        # any exception raised above into a "successful" task with no manifest (observed 2026-09-20).
        import traceback
        traceback.print_exc()
        sys.stderr.flush()
        sys.stdout.flush()
        os._exit(1)
    app.close()


def render(app, args):
    import omni.replicator.core as rep
    from isaacsim.core.utils.stage import open_stage, is_stage_loading, get_current_stage
    if not open_stage(args.scene):
        raise ValueError(f"Cannot open USD scene: {args.scene}")
    while is_stage_loading():
        app.update()
    scene_root = get_current_stage().GetDefaultPrim()
    if not scene_root.IsValid():
        raise ValueError("USD scene must declare a default prim for semantic labeling")
    output = Path(args.output_dir)
    output.mkdir(parents=True, exist_ok=True)
    rep.set_global_seed(args.seed)
    # Author lights/camera on the stage itself, not inside `rep.new_layer()`: prims created in that
    # sublayer never reached the headless RTX renderer here (dome light present, RGB pass black, depth and
    # segmentation fine). Measured 2026-09-20 on ml.g6e.4xlarge with Isaac Sim 5.1 / Replicator 1.12.27.
    rep.create.light(light_type="dome", intensity=1000)
    camera = rep.create.camera(position=(0.8, 0.8, 0.7), look_at=(0.2, 0, 0.15))
    # Tag the loaded scene so segmentation has a declared object class.
    with rep.get.prims(path_pattern=str(scene_root.GetPath())):
        rep.modify.semantics([("class", "robot_scene")])
    product = rep.create.render_product(camera, (args.width, args.height))
    writer = rep.WriterRegistry.get("BasicWriter")
    writer.initialize(output_dir=str(output / "frames"), rgb=True,
                      distance_to_camera=True, semantic_segmentation=True,
                      colorize_semantic_segmentation=True)
    # Let RTX finish loading MDL materials/textures for the new render product before capturing; the
    # first frames of a fresh headless session otherwise render black while depth/semantics look valid.
    for _ in range(max(args.warmup_updates, 0)):
        app.update()
    writer.attach([product])
    if args.first_frame_timeout > 0:
        first_frame_watchdog(output / "frames", args.first_frame_timeout)
    with rep.trigger.on_frame(num_frames=args.frames):
        with camera:
            rep.modify.pose(position=rep.distribution.uniform((0.6, 0.4, 0.5), (1.0, 0.9, 0.9)),
                            look_at=(0.2, 0, 0.15))
    for _ in range(args.frames):
        rep.orchestrator.step(rt_subframes=4)
    rep.orchestrator.wait_until_complete()
    writer.detach()
    patterns = {"rgb": "rgb_*.png", "depth": "distance_to_camera_*.npy", "segmentation": "semantic_segmentation_*.png"}
    files = {key: sorted(str(p.relative_to(output)) for p in (output / "frames").rglob(pattern))
             for key, pattern in patterns.items()}
    if any(len(paths) != args.frames for paths in files.values()):
        raise RuntimeError(f"Replicator produced incomplete modalities: { {k: len(v) for k,v in files.items()} }")
    rgb_mean = assert_rgb_not_black(output / files["rgb"][0], args.min_rgb_mean)
    (output / "dataset-manifest.json").write_text(json.dumps({
        "schemaVersion": 1, "generator": "Isaac Sim Replicator BasicWriter", "scene": args.scene,
        "seed": args.seed, "frames": args.frames, "width": args.width, "height": args.height,
        "modalities": files, "depthUnits": "metres",
        "warmupUpdates": args.warmup_updates, "firstRgbMean": round(rgb_mean, 2),
    }, indent=2))


if __name__ == "__main__":
    main()
