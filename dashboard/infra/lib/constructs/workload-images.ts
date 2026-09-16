import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as assets from 'aws-cdk-lib/aws-ecr-assets';
import { Construct } from 'constructs';

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
  constructor(scope: Construct, id: string, props: { repositoryRoot: string; extended?: boolean }) {
    super(scope, id);
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
    const workspace = new assets.DockerImageAsset(this, 'workspace', {
      directory: path.join(props.repositoryRoot, 'dashboard/session-image'),
      platform: assets.Platform.LINUX_AMD64,
    });
    this.environment.WORKSPACE_IMAGE_URI = workspace.imageUri;
  }
}
