import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

// GR00T 런타임 이미지 저장소. 모듈 3의 base 모델 추론(Policy Server)과
// 모듈 5의 fine-tuned 모델 서빙이 같은 이미지를 쓴다.
const REPOSITORY_NAME = 'groot-runtime';
const KEEP_LAST_N_IMAGES = 10;

export class EcrRepo extends Construct {
  public readonly repository: ecr.IRepository;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    const ensureRepo = new cr.AwsCustomResource(this, 'EnsureRepo', {
      onCreate: this.createRepoCall(),
      onUpdate: this.createRepoCall(),
      onDelete: {
        service: 'ECR',
        action: 'deleteRepository',
        parameters: {
          repositoryName: REPOSITORY_NAME,
          force: true,
        },
        ignoreErrorCodesMatching: 'RepositoryNotFoundException',
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: [
            'ecr:CreateRepository',
            'ecr:DescribeRepositories',
            'ecr:DeleteRepository',
            'ecr:BatchDeleteImage',
            'ecr:ListImages',
          ],
          resources: ['*'],
        }),
      ]),
      installLatestAwsSdk: false,
    });

    const ensureLifecycle = new cr.AwsCustomResource(this, 'EnsureLifecycle', {
      onCreate: this.lifecycleCall(),
      onUpdate: this.lifecycleCall(),
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['ecr:PutLifecyclePolicy'],
          resources: ['*'],
        }),
      ]),
      installLatestAwsSdk: false,
    });
    ensureLifecycle.node.addDependency(ensureRepo);

    this.repository = ecr.Repository.fromRepositoryName(this, 'Imported', REPOSITORY_NAME);
  }

  private createRepoCall(): cr.AwsSdkCall {
    return {
      service: 'ECR',
      action: 'createRepository',
      parameters: {
        repositoryName: REPOSITORY_NAME,
        imageScanningConfiguration: { scanOnPush: true },
      },
      physicalResourceId: cr.PhysicalResourceId.of(REPOSITORY_NAME),
      ignoreErrorCodesMatching: 'RepositoryAlreadyExistsException',
    };
  }

  private lifecycleCall(): cr.AwsSdkCall {
    return {
      service: 'ECR',
      action: 'putLifecyclePolicy',
      parameters: {
        repositoryName: REPOSITORY_NAME,
        lifecyclePolicyText: JSON.stringify({
          rules: [
            {
              rulePriority: 1,
              description: `Keep last ${KEEP_LAST_N_IMAGES} images`,
              selection: {
                tagStatus: 'any',
                countType: 'imageCountMoreThan',
                countNumber: KEEP_LAST_N_IMAGES,
              },
              action: { type: 'expire' },
            },
          ],
        }),
      },
      physicalResourceId: cr.PhysicalResourceId.of(`${REPOSITORY_NAME}-lifecycle`),
    };
  }
}
