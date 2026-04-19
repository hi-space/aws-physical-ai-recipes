"""Print all registered workshop gym environments."""
import gymnasium as gym

import workshop  # noqa: F401 — triggers task registration


def main():
    envs = [eid for eid in gym.registry.keys() if eid.startswith("Workshop-")]
    print(f"\nRegistered workshop environments ({len(envs)}):\n")
    for eid in sorted(envs):
        print(f"  {eid}")
    print()


if __name__ == "__main__":
    main()
