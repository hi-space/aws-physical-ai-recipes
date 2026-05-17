import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';

export interface TrainingInferenceEcrProps {
  trainingRepoName: string;
  inferenceRepoName: string;
}

/**
 * 학습/추론 컨테이너용 ECR 리포지토리 2개.
 *   - 최근 5개 이미지만 유지하는 lifecycle.
 *   - ScanOnPush 활성화.
 */
export class TrainingInferenceEcr extends Construct {
  public readonly trainingRepository: ecr.Repository;
  public readonly inferenceRepository: ecr.Repository;

  constructor(scope: Construct, id: string, props: TrainingInferenceEcrProps) {
    super(scope, id);

    const lifecycleRules = [{ maxImageCount: 5, description: '최근 5개 이미지만 유지' }];

    this.trainingRepository = new ecr.Repository(this, 'TrainingRepo', {
      repositoryName: props.trainingRepoName,
      imageScanOnPush: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
      lifecycleRules,
    });

    this.inferenceRepository = new ecr.Repository(this, 'InferenceRepo', {
      repositoryName: props.inferenceRepoName,
      imageScanOnPush: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
      lifecycleRules,
    });
  }
}
