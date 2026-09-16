"""Headless Replicator RGB/depth/semantic images from a real USD scene."""
import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scene", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--frames", type=int, default=32)
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--height", type=int, default=480)
    args = parser.parse_args()
    if args.frames < 1:
        parser.error("frames must be positive")
    from isaacsim import SimulationApp
    app = SimulationApp({"headless": True})
    try:
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
        with rep.new_layer():
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
            writer.attach([product])
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
        (output / "dataset-manifest.json").write_text(json.dumps({
            "schemaVersion": 1, "generator": "Isaac Sim Replicator BasicWriter", "scene": args.scene,
            "seed": args.seed, "frames": args.frames, "width": args.width, "height": args.height,
            "modalities": files, "depthUnits": "metres",
        }, indent=2))
    finally:
        app.close()


if __name__ == "__main__":
    main()
