import gymnasium as gym

gym.register(
    id="Workshop-SO101-Lift-v0",
    entry_point="isaaclab.envs:ManagerBasedRLEnv",
    kwargs={
        "env_cfg_entry_point": f"{__name__}.lift_env_cfg:SoArm101LiftEnvCfg",
        "rsl_rl_cfg_entry_point": f"{__name__}.agents.rsl_rl_ppo_cfg:LiftPPORunnerCfg",
    },
    disable_env_checker=True,
)

gym.register(
    id="Workshop-SO101-Lift-Play-v0",
    entry_point="isaaclab.envs:ManagerBasedRLEnv",
    kwargs={
        "env_cfg_entry_point": f"{__name__}.lift_env_cfg:SoArm101LiftEnvCfg_PLAY",
        "rsl_rl_cfg_entry_point": f"{__name__}.agents.rsl_rl_ppo_cfg:LiftPPORunnerCfg",
    },
    disable_env_checker=True,
)
