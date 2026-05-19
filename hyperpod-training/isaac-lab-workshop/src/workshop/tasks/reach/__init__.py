import gymnasium as gym

gym.register(
    id="Workshop-SO101-Reach-v0",
    entry_point="isaaclab.envs:ManagerBasedRLEnv",
    kwargs={
        "env_cfg_entry_point": f"{__name__}.reach_env_cfg:SoArm101ReachEnvCfg",
        "rsl_rl_cfg_entry_point": f"{__name__}.agents.rsl_rl_ppo_cfg:ReachPPORunnerCfg",
    },
    disable_env_checker=True,
)

gym.register(
    id="Workshop-SO101-Reach-Play-v0",
    entry_point="isaaclab.envs:ManagerBasedRLEnv",
    kwargs={
        "env_cfg_entry_point": f"{__name__}.reach_env_cfg:SoArm101ReachEnvCfg_PLAY",
        "rsl_rl_cfg_entry_point": f"{__name__}.agents.rsl_rl_ppo_cfg:ReachPPORunnerCfg",
    },
    disable_env_checker=True,
)
