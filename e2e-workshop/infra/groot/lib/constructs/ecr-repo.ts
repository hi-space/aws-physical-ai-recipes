import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';

// GR00T 런타임 이미지 저장소. 모듈 3의 base 모델 추론(Policy Server)과
// 모듈 5의 fine-tuned 모델 서빙이 같은 이미지를 쓴다.
//
// 네이티브 AWS::ECR::Repository 를 사용한다. 커스텀 리소스(Lambda)를 거치지 않으므로
// 배포 시점에 IAM 정책 전파를 기다리는 구간이 없다.
const REPOSITORY_NAME = 'groot-runtime';
const KEEP_LAST_N_IMAGES = 10;

export class EcrRepo extends Construct {
  public readonly repository: ecr.IRepository;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.repository = new ecr.Repository(this, 'Repository', {
      repositoryName: REPOSITORY_NAME,
      imageScanOnPush: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
      lifecycleRules: [
        {
          maxImageCount: KEEP_LAST_N_IMAGES,
          description: `Keep last ${KEEP_LAST_N_IMAGES} images`,
        },
      ],
    });
  }
}
