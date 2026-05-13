import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface ArtifactsBucketProps {
  bucketName: string;
}

/**
 * GR00T 아티팩트 저장용 S3 버킷.
 *   - 버전 관리 + AES256 암호화 + 퍼블릭 액세스 차단.
 *   - checkpoints/ 30일 후 자동 삭제, noncurrent 버전 90일 후 GLACIER, 365일 후 만료.
 */
export class ArtifactsBucket extends Construct {
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: ArtifactsBucketProps) {
    super(scope, id);

    this.bucket = new s3.Bucket(this, 'Bucket', {
      bucketName: props.bucketName,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        {
          id: 'ArchiveOldVersions',
          enabled: true,
          noncurrentVersionTransitions: [
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
          noncurrentVersionExpiration: cdk.Duration.days(365),
        },
        {
          id: 'CleanupCheckpoints',
          enabled: true,
          prefix: 'checkpoints/',
          expiration: cdk.Duration.days(30),
        },
      ],
    });
  }
}
