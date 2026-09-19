import * as path from 'node:path';

export interface OptionalWorkloadImages {
  cosmos?: { baseImage: string; uvImage: string };
  cosmos3?: { baseImage: string; uvImage: string };
  leisaac?: { isaaclabRecipeImage: string; assetsImage: string; sceneRevision: string };
}
export interface OptionalImageDefinition {
  name: 'cosmos' | 'cosmos3' | 'leisaac';
  environment: string;
  dockerFile: string;
  buildArgs: Record<string, string>;
  stagedDockerFile?: string;
}
const sha = /^sha256:[a-f0-9]{64}$/;
export function optionalImageDefinitions(options: OptionalWorkloadImages | undefined, account: string, region: string): OptionalImageDefinition[] {
  if (!options || !Object.keys(options).length) return [];
  if (!/^\d{12}$/.test(account) || region !== 'us-east-1') throw new Error('Optional images require an explicit current account and us-east-1 stack environment');
  if (Object.keys(options).some(key => !['cosmos', 'cosmos3', 'leisaac'].includes(key))) throw new Error('Unknown optional image');
  const ecr = `${account}.dkr.ecr.us-east-1.amazonaws.com/`;
  const pinned = (value: string, label: string, publicPrefix?: string) => {
    if (typeof value !== 'string' || !/^[a-z0-9.-]+\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(value) ||
        !(value.startsWith(ecr) || publicPrefix && value.startsWith(publicPrefix))) {
      throw new Error(`${label} must be an explicit digest-pinned approved registry image`);
    }
    return value;
  };
  const definitions: OptionalImageDefinition[] = [];
  if (options.cosmos) definitions.push({
    name: 'cosmos', environment: 'COSMOS_IMAGE_URI', dockerFile: 'optional/cosmos.Dockerfile',
    stagedDockerFile: path.resolve(__dirname, '../../optional-images/cosmos.Dockerfile'),
    buildArgs: {
      COSMOS_BASE_IMAGE: pinned(options.cosmos.baseImage, 'COSMOS_BASE_IMAGE', 'nvcr.io/nvidia/cosmos/'),
      UV_IMAGE: pinned(options.cosmos.uvImage, 'UV_IMAGE', 'ghcr.io/astral-sh/uv@'),
    },
  });
  // Cosmos 3 rides on cosmos-framework (NGC PyTorch/CUDA base), independent of the Transfer2.5 image above.
  if (options.cosmos3) definitions.push({
    name: 'cosmos3', environment: 'COSMOS3_IMAGE_URI', dockerFile: 'optional/cosmos3.Dockerfile',
    stagedDockerFile: path.resolve(__dirname, '../../optional-images/cosmos3.Dockerfile'),
    buildArgs: {
      COSMOS3_BASE_IMAGE: pinned(options.cosmos3.baseImage, 'COSMOS3_BASE_IMAGE', 'nvcr.io/nvidia/'),
      UV_IMAGE: pinned(options.cosmos3.uvImage, 'UV_IMAGE', 'ghcr.io/astral-sh/uv@'),
    },
  });
  if (options.leisaac) {
    const { isaaclabRecipeImage, assetsImage, sceneRevision } = options.leisaac;
    pinned(isaaclabRecipeImage, 'ISAACLAB_RECIPE_IMAGE');
    pinned(assetsImage, 'LEISAAC_ASSETS_IMAGE');
    if (!sha.test(sceneRevision) || assetsImage.split('@')[1] !== sceneRevision) {
      throw new Error('LEISAAC_SCENE_REVISION must equal the supplied assets-image digest');
    }
    definitions.push({
      name: 'leisaac', environment: 'LEISAAC_IMAGE_URI', dockerFile: 'dashboard/images/leisaac/Dockerfile',
      buildArgs: { ISAACLAB_RECIPE_IMAGE: isaaclabRecipeImage, LEISAAC_ASSETS_IMAGE: assetsImage, LEISAAC_SCENE_REVISION: sceneRevision },
    });
  }
  return definitions;
}
