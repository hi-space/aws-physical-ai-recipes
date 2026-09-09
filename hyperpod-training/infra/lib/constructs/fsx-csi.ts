import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface FsxCsiProps {
  eksCluster: eks.Cluster;
  /** Pod Identity Agent 애드온 — CSI 컨트롤러 SA 의 pod identity 연동이 이에 의존한다. */
  podIdentityAgent: eks.CfnAddon;
}

/** 파드에서 참조할 StorageClass 이름. k8s-templates/fsx-pvc.yaml 과 일치. */
export const FSX_STORAGE_CLASS = 'fsx-sc';

/**
 * FSx for Lustre CSI 드라이버(EKS 애드온) + StorageClass.
 *
 * Slurm 경로의 lifecycle 스크립트가 /fsx 를 노드에 마운트하는 것과 달리, EKS 에서는 CSI 드라이버가
 * PVC 를 요청한 파드에만 Lustre 를 마운트한다. 정적 PV 는 PVC 하나에만 바인딩되므로 팀 네임스페이스마다
 * PV+PVC 한 쌍을 만든다 (k8s-templates/fsx-pvc.yaml — render.sh 가 FSx ID/DNS/mount name 을 채운다).
 */
export class FsxCsiConstruct extends Construct {
  constructor(scope: Construct, id: string, props: FsxCsiProps) {
    super(scope, id);

    const csiRole = new iam.Role(this, 'CsiControllerRole', {
      assumedBy: new iam.ServicePrincipal('pods.eks.amazonaws.com').withSessionTags(),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonFSxFullAccess')],
    });

    const addon = new eks.CfnAddon(this, 'Addon', {
      clusterName: props.eksCluster.clusterName,
      addonName: 'aws-fsx-csi-driver',
      resolveConflicts: 'OVERWRITE',
      podIdentityAssociations: [{ roleArn: csiRole.roleArn, serviceAccount: 'fsx-csi-controller-sa' }],
    });
    addon.addDependency(props.podIdentityAgent);

    const sc = props.eksCluster.addManifest('FsxStorageClass', {
      apiVersion: 'storage.k8s.io/v1',
      kind: 'StorageClass',
      metadata: { name: FSX_STORAGE_CLASS },
      provisioner: 'fsx.csi.aws.com',
      mountOptions: ['flock'],
      reclaimPolicy: 'Retain',
      volumeBindingMode: 'Immediate',
    });
    sc.node.addDependency(addon);
  }
}
