"""Patch mujoco_warp io.py to fix compatibility with mujoco >= 3.7.0.

Two issues:
1. mujoco 3.7.0 removed sparse tendon Jacobian attributes (ten_J_rownnz etc).
   Add hasattr guards with dense fallback.
2. np.sum() returns numpy.float64 which wp.full(..., dtype=int) rejects.
   Wrap with int().
"""
import importlib
import re
import sys
from pathlib import Path


def _find_io_py() -> Path:
    spec = importlib.util.find_spec("mujoco_warp._src.io")
    if spec is None or spec.origin is None:
        print("  mujoco_warp not installed, skipping patch.")
        sys.exit(0)
    return Path(spec.origin)


MARKER = "# patched: mujoco_warp compat"


def _patch_sparse_tendon(src: str) -> str:
    """Guard ten_J_rownnz / flexedge_J_rownnz access with hasattr."""
    old_ten = (
        "    mujoco.mju_sparse2dense(ten_J, mjd.ten_J.reshape(-1),"
        " mjd.ten_J_rownnz, mjd.ten_J_rowadr, mjd.ten_J_colind.reshape(-1))"
    )
    new_ten = (
        "    if hasattr(mjd, 'ten_J_rownnz'):\n"
        "      mujoco.mju_sparse2dense(ten_J, mjd.ten_J.reshape(-1),"
        " mjd.ten_J_rownnz, mjd.ten_J_rowadr, mjd.ten_J_colind.reshape(-1))\n"
        "    elif mjm.ntendon > 0:\n"
        "      ten_J = mjd.ten_J.reshape((mjm.ntendon, mjm.nv))"
    )

    old_flex = (
        "    mujoco.mju_sparse2dense(\n"
        "      flexedge_J, mjd.flexedge_J.reshape(-1),"
        " mjd.flexedge_J_rownnz, mjd.flexedge_J_rowadr,"
        " mjd.flexedge_J_colind.reshape(-1)\n"
        "    )"
    )
    new_flex = (
        "    if hasattr(mjd, 'flexedge_J_rownnz'):\n"
        "      mujoco.mju_sparse2dense(\n"
        "        flexedge_J, mjd.flexedge_J.reshape(-1),"
        " mjd.flexedge_J_rownnz, mjd.flexedge_J_rowadr,"
        " mjd.flexedge_J_colind.reshape(-1)\n"
        "      )\n"
        "    elif mjm.nflexedge > 0:\n"
        "      flexedge_J = mjd.flexedge_J.reshape((mjm.nflexedge, mjm.nv))"
    )

    src = src.replace(old_ten, new_ten)
    src = src.replace(old_flex, new_flex)
    return src


def _patch_int_casts(src: str) -> str:
    """Wrap np.sum() results in int() for wp.full dtype=int calls."""
    patterns = [
        (
            r"wp\.full\(nworld, (3 \* np\.sum\([^)]+\))",
            r"wp.full(nworld, int(\1)",
        ),
        (
            r"wp\.full\(nworld, (6 \* np\.sum\([^)]+\))",
            r"wp.full(nworld, int(\1)",
        ),
        (
            r"wp\.full\(nworld, (np\.sum\(\(mjm\.eq_type == mujoco\.mjtEq\.mjEQ_JOINT\)[^)]+\))",
            r"wp.full(nworld, int(\1)",
        ),
    ]
    for pat, repl in patterns:
        src = re.sub(pat, repl, src)
    return src


def main():
    io_py = _find_io_py()
    src = io_py.read_text()

    if MARKER in src:
        print("  mujoco_warp io.py: already patched.")
        return

    patched = _patch_sparse_tendon(src)
    patched = _patch_int_casts(patched)

    if patched == src:
        print("  mujoco_warp io.py: no matching patterns (different version?), skipping.")
        return

    patched = patched.rstrip() + f"\n{MARKER}\n"
    io_py.write_text(patched)
    print(f"  mujoco_warp io.py: patched ({io_py})")


if __name__ == "__main__":
    main()
