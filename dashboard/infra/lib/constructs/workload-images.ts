import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as assets from 'aws-cdk-lib/aws-ecr-assets';
import { Construct } from 'constructs';
import { optionalImageDefinitions, type OptionalWorkloadImages } from './optional-workload-images';
export type { OptionalWorkloadImages } from './optional-workload-images';

/** Stage only workload source so a UI edit does not rebuild every model image. */
export function workloadContext(repositoryRoot: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-workload-context-'));
  const sources = [
    'dashboard/images', 'dashboard/recipes',
    'hyperpod-training/mujoco-workshop', 'hyperpod-training/isaac-lab-workshop',
    'hyperpod-training/examples/rl/play_isaaclab.py',
    'hyperpod-training/configs/so101_modality.py',
    'e2e-workshop/groot/training/data/convert_v3_to_v2.py',
  ];
  for (const source of sources) {
    const destination = path.join(directory, source);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(path.join(repositoryRoot, source), destination, {
      recursive: true,
      filter: (file) => !['__pycache__', '.pytest_cache', '.venv', '.git', 'node_modules'].includes(path.basename(file)) &&
        !file.endsWith('.egg-info') && !file.endsWith('.pyc'),
    });
  }
  const normalize = (entry: string) => {
    const stat = fs.lstatSync(entry);
    if (stat.isSymbolicLink()) return;
    fs.chmodSync(entry, stat.isDirectory() || (stat.mode & 0o111) !== 0 ? 0o755 : 0o644);
    if (stat.isDirectory()) for (const name of fs.readdirSync(entry)) normalize(path.join(entry, name));
  };
  normalize(directory);
  return directory;
}

export class WorkloadImages extends Construct {
  readonly environment: Record<string, string>;
  constructor(scope: Construct, id: string, props: { repositoryRoot: string; extended?: boolean; optionalImages?: OptionalWorkloadImages }) {
    super(scope, id);
    const optional = optionalImageDefinitions(props.optionalImages, cdk.Stack.of(this).account, cdk.Stack.of(this).region);
    const context = workloadContext(props.repositoryRoot);
    this.environment = {};
    const images: Record<string, string> = {
      MUJOCO_IMAGE_URI: 'mujoco', ISAACLAB_IMAGE_URI: 'isaaclab', ROS2_IMAGE_URI: 'ros2',
      ...(props.extended ? { GROOT_RUNTIME_IMAGE_URI: 'groot', OPENPI_IMAGE_URI: 'openpi' } : {}),
    };
    for (const [environmentName, name] of Object.entries(images)) {
      const image = new assets.DockerImageAsset(this, name, {
        directory: context, file: `dashboard/images/${name}/Dockerfile`,
        platform: assets.Platform.LINUX_AMD64,
      });
      this.environment[environmentName] = image.imageUri;
      new cdk.CfnOutput(this, `${name}Image`, { value: image.imageUri });
    }
    // Optional Dockerfiles never modify the context already hashed by default
    // assets. Adding an optional image must not rebuild all default model images.
    for (const definition of optional) {
      const optionalContext = workloadContext(props.repositoryRoot);
      if (definition.stagedDockerFile) {
        const destination = path.join(optionalContext, definition.dockerFile);
        fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
        fs.copyFileSync(definition.stagedDockerFile, destination);
        fs.chmodSync(destination, 0o644);
      }
      const image = new assets.DockerImageAsset(this, definition.name, {
        directory: optionalContext, file: definition.dockerFile,
        buildArgs: definition.buildArgs, platform: assets.Platform.LINUX_AMD64,
      });
      this.environment[definition.environment] = image.imageUri;
      new cdk.CfnOutput(this, `${definition.name}Image`, { value: image.imageUri });
    }
    const workspace = new assets.DockerImageAsset(this, 'workspace', {
      directory: path.join(props.repositoryRoot, 'dashboard/session-image'),
      platform: assets.Platform.LINUX_AMD64,
    });
    this.environment.WORKSPACE_IMAGE_URI = workspace.imageUri;
  }
}
