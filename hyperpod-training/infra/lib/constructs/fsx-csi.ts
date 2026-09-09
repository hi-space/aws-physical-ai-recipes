import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface FsxCsiProps {
  eksCluster: eks.Cluster;
  /** Pod Identity Agent 애드온 — CSI 컨트롤러 SA 의 pod identity 연동이 이에 의존한다. */
  podIdentityAgent: eks.CfnAddon;
  fsxFileSystemId: string;
  fsxDnsName: string;
  fsxMountName: string;
  capacityGiB: number;
}

/** 파드에서 참조할 StorageClass / PersistentVolume 이름. k8s-templates/fsx-pvc.yaml 과 일치. */
export const FSX_STORAGE_CLASS = 'fsx-sc';
export const FSX_PV_NAME = 'fsx-pv';

/**
 * FSx for Lustre CSI 드라이버(EKS 애드온) + 정적 프로비저닝 PV.
 *
 * Slurm 경로의 lifecycle 스크립트가 /fsx 를 노드에 마운트하는 것과 달리, EKS 에서는 CSI 드라이버가
 * PVC 를 요청한 파드에만 Lustre 를 마운트한다. PV 는 클러스터 범위라 여기서 한 번 만들고, PVC 는
 * 네임스페이스마다(팀마다) 참가자가 만든다 (k8s-templates/fsx-pvc.yaml).
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
    const pv = props.eksCluster.addManifest('FsxPersistentVolume', {
      apiVersion: 'v1',
      kind: 'PersistentVolume',
      metadata: { name: FSX_PV_NAME },
      spec: {
        capacity: { storage: `${props.capacityGiB}Gi` },
        volumeMode: 'Filesystem',
        accessModes: ['ReadWriteMany'],
        persistentVolumeReclaimPolicy: 'Retain',
        storageClassName: FSX_STORAGE_CLASS,
        mountOptions: ['flock'],
        csi: {
          driver: 'fsx.csi.aws.com',
          volumeHandle: props.fsxFileSystemId,
          volumeAttributes: {
            dnsname: props.fsxDnsName,
            mountname: props.fsxMountName,
          },
        },
      },
    });
    pv.node.addDependency(sc);
    pv.node.addDependency(addon);
  }
}
