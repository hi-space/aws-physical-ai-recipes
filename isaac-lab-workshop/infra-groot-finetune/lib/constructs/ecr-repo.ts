import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';

export interface EcrRepoProps {
  userId?: string;
}

export class EcrRepo extends Construct {
  public readonly repository: ecr.Repository;

  constructor(scope: Construct, id: string, props: EcrRepoProps) {
    super(scope, id);

    const repoName = props.userId
      ? `gr00t-finetune-${props.userId}`
      : 'gr00t-finetune';

    this.repository = new ecr.Repository(this, 'Repo', {
      repositoryName: repoName,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      imageScanOnPush: true,
      lifecycleRules: [
        {
          maxImageCount: 10,
          description: 'Keep last 10 images',
        },
      ],
    });
  }
}
