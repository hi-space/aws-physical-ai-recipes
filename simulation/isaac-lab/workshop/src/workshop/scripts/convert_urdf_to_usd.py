"""One-time URDF → USD conversion for SO-ARM 101.

Requires 'isaacsim.exp.full.kit' experience to enable the URDF importer
extension which is not loaded by default in Isaac Sim 5.1 pip install.

After conversion, flattens the USD (removes sublayer references) and fixes
zero-inertia links that would crash the Newton/MuJoCo solver.
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

    from pxr import Usd, UsdPhysics, Gf
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
    raw_usd = converter.usd_path
    print(f"Raw USD: {raw_usd}")

    flat_path = str(Path(output_dir) / "so_arm101_flat.usd")
    stage = Usd.Stage.Open(raw_usd)
    stage.Flatten().Export(flat_path)
    print(f"Flattened USD: {flat_path}")

    stage = Usd.Stage.Open(flat_path)
    min_mass = 0.001
    min_inertia = Gf.Vec3f(1e-6, 1e-6, 1e-6)
    fixed_count = 0
    for prim in stage.Traverse():
        mass_api = UsdPhysics.MassAPI(prim)
        if not mass_api:
            continue
        inertia_attr = mass_api.GetDiagonalInertiaAttr()
        mass_attr = mass_api.GetMassAttr()
        if inertia_attr.IsValid():
            val = inertia_attr.Get()
            if val is not None and (val[0] <= 0 or val[1] <= 0 or val[2] <= 0):
                inertia_attr.Set(min_inertia)
                if mass_attr.IsValid() and mass_attr.Get() < min_mass:
                    mass_attr.Set(min_mass)
                fixed_count += 1
                print(f"  Fixed zero inertia: {prim.GetPath()}")
    stage.GetRootLayer().Save()
    if fixed_count:
        print(f"Fixed {fixed_count} link(s) with zero inertia")

    print(f"\nUSD ready: {flat_path}")

    launcher.app.close()


if __name__ == "__main__":
    main()
