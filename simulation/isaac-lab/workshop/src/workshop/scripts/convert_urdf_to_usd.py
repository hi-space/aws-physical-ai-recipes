"""One-time URDF → USD conversion for SO-ARM 101.

Requires 'isaacsim.exp.full.kit' experience to enable the URDF importer
extension which is not loaded by default in Isaac Sim 5.1 pip install.
"""
import argparse
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description="Convert SO-ARM 101 URDF to USD")
    parser.add_argument("--urdf", default=None, help="URDF file path")
    parser.add_argument("--output_dir", default=None, help="Output directory for USD")

    from isaaclab.app import AppLauncher
    AppLauncher.add_app_launcher_args(parser)
    args = parser.parse_args()
    args.experience = "isaacsim.exp.full.kit"
    launcher = AppLauncher(args)

    from isaaclab.sim.converters.urdf_converter import UrdfConverter
    from isaaclab.sim.converters.urdf_converter_cfg import UrdfConverterCfg

    workshop_dir = Path(__file__).resolve().parents[1]
    urdf_path = args.urdf or str(workshop_dir / "robots" / "urdf" / "so_arm101.urdf")
    output_dir = args.output_dir or str(workshop_dir / "robots" / "usd")

    if not Path(urdf_path).exists():
        print(f"ERROR: URDF not found at {urdf_path}")
        print("Run setup.sh first to download the SO-ARM 101 URDF.")
        sys.exit(1)

    cfg = UrdfConverterCfg(
        asset_path=urdf_path,
        usd_dir=output_dir,
        usd_file_name="so_arm101.usd",
        fix_base=True,
        self_collision=True,
        replace_cylinders_with_capsules=True,
        joint_drive=UrdfConverterCfg.JointDriveCfg(
            gains=UrdfConverterCfg.JointDriveCfg.PDGainsCfg(
                stiffness=0, damping=0
            )
        ),
    )

    converter = UrdfConverter(cfg)
    usd_path = converter.usd_path
    print(f"\nUSD file created: {usd_path}")

    launcher.app.close()


if __name__ == "__main__":
    main()
