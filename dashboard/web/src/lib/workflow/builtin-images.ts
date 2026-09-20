// Builtin recipe image slots: profile short-name → deployment environment variable. The server seeds an
// image profile `builtin-<name>` from each variable that is set (services/image-profiles.ts); builtin
// templates default their image params to the same variable, or to `required://<VARIABLE>` when it is
// unset (workflow/builtin-templates.ts). Shared here so the image picker can map a `required://` default
// back to the profile an administrator may have approved for it. Lives in lib/ so client code can import it.

export const BUILTIN_IMAGE_ENV: Record<string, string> = {
  mujoco: 'MUJOCO_IMAGE_URI', isaaclab: 'ISAACLAB_IMAGE_URI', ros2: 'ROS2_IMAGE_URI',
  groot: 'GROOT_RUNTIME_IMAGE_URI', openpi: 'OPENPI_IMAGE_URI', cosmos: 'COSMOS_IMAGE_URI', cosmos3: 'COSMOS3_IMAGE_URI',
  leisaac: 'LEISAAC_IMAGE_URI', workspace: 'WORKSPACE_IMAGE_URI', runtime: 'TASK_RUNTIME_IMAGE',
};

export const REQUIRED_IMAGE_PREFIX = 'required://';

/** The environment variable named by a `required://<VARIABLE>` image placeholder, or undefined. */
export function requiredImageEnv(value: string | undefined): string | undefined {
  return value?.startsWith(REQUIRED_IMAGE_PREFIX) ? value.slice(REQUIRED_IMAGE_PREFIX.length) : undefined;
}

/** The seeded image profile id (`builtin-<name>`) for a deployment image variable, or undefined. */
export function profileIdForImageEnv(env: string): string | undefined {
  const name = Object.entries(BUILTIN_IMAGE_ENV).find(([, variable]) => variable === env)?.[0];
  return name ? `builtin-${name}` : undefined;
}
