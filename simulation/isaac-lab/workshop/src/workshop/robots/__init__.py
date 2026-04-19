__all__ = ["SO_ARM101_CFG"]


def __getattr__(name):
    if name == "SO_ARM101_CFG":
        from .so_arm101 import SO_ARM101_CFG
        return SO_ARM101_CFG
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
