import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/**
 * Workflow artifacts bucket (checkpoints, verified publications, presigned browser uploads).
 * Construct id 'Orchestration' and child id 'Artifacts' are frozen: the bucket's logical id derives from them.
 */
export class ArtifactsConstruct extends Construct {
  readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string) {
    super(scope, id);
    this.bucket = new s3.Bucket(this, 'Artifacts', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          // Checkpoint access patterns are unknown; Intelligent-Tiering has no retrieval fee, unlike IA.
          transitions: [{ storageClass: s3.StorageClass.INTELLIGENT_TIERING, transitionAfter: cdk.Duration.days(30) }],
          noncurrentVersionExpiration: cdk.Duration.days(90),
        },
        { abortIncompleteMultipartUploadAfter: cdk.Duration.days(2) },
      ],
    });
  }
}
