# HyperPod EKS integration: control-plane reachability, access entries for the three service roles and
# the operations builder, and the (legacy) workflow pod identity.

resource "aws_vpc_security_group_ingress_rule" "eks_control_plane" {
  count                        = local.has_eks ? 1 : 0
  security_group_id            = local.eks_cluster_security_group_id
  description                  = "Physical AI Dashboard to EKS API private endpoint"
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  referenced_security_group_id = aws_security_group.service.id
}

resource "aws_eks_access_entry" "services" {
  for_each = local.has_eks ? {
    web        = { arn = aws_iam_role.web.arn, group = "physical-ai:web" }
    controller = { arn = aws_iam_role.controller.arn, group = "physical-ai:controller" }
    gateway    = { arn = aws_iam_role.gateway.arn, group = "physical-ai:gateway" }
  } : {}
  cluster_name      = local.eks_cluster_name
  principal_arn     = each.value.arn
  type              = "STANDARD"
  kubernetes_groups = [each.value.group]
}

resource "aws_eks_access_entry" "operations" {
  count         = local.has_eks ? 1 : 0
  cluster_name  = local.eks_cluster_name
  principal_arn = aws_iam_role.operations[0].arn
  type          = "STANDARD"
}

resource "aws_eks_access_policy_association" "operations" {
  count         = local.has_eks ? 1 : 0
  cluster_name  = local.eks_cluster_name
  principal_arn = aws_iam_role.operations[0].arn
  policy_arn    = "arn:${data.aws_partition.current.partition}:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy"
  access_scope {
    type = "cluster"
  }
  depends_on = [aws_eks_access_entry.operations]
}

# Workflow pods that need ambient AWS credentials (legacy pai-workflow identity). Scoped workloads
# run as pai-workload without credentials; the association is per namespace/service account.
data "aws_iam_policy_document" "pod_assume" {
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "Service"
      identifiers = ["pods.eks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "workflow_pods" {
  count              = local.has_eks ? 1 : 0
  name               = "${local.prefix}-workflow-pods"
  description        = "Physical AI Dashboard workflow pods (EKS Pod Identity): dataset/model S3 export, MLflow logging, SSM credentials"
  assume_role_policy = data.aws_iam_policy_document.pod_assume.json
}

data "aws_iam_policy_document" "workflow_pods" {
  statement {
    sid       = "MlflowTracking"
    actions   = ["sagemaker-mlflow:*"]
    resources = length(local.mlflow_tracking_server_arns) > 0 ? local.mlflow_tracking_server_arns : ["arn:${data.aws_partition.current.partition}:sagemaker:${var.region}:${local.account}:mlflow-tracking-server/*"]
  }
  dynamic "statement" {
    for_each = length(local.buckets) > 0 ? [1] : []
    content {
      sid       = "S3Buckets"
      actions   = ["s3:ListBucket", "s3:GetBucketLocation"]
      resources = [for b in local.buckets : "arn:${data.aws_partition.current.partition}:s3:::${b}"]
    }
  }
  dynamic "statement" {
    for_each = length(local.buckets) > 0 ? [1] : []
    content {
      sid       = "S3Objects"
      actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"]
      resources = [for b in local.buckets : "arn:${data.aws_partition.current.partition}:s3:::${b}/*"]
    }
  }
  statement {
    sid       = "SsmCredentialParameters"
    actions   = ["ssm:GetParameter"]
    resources = local.ssm_parameter_arns
  }
  statement {
    sid       = "KmsForSecureStrings"
    actions   = ["kms:Decrypt"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "workflow_pods" {
  count  = local.has_eks ? 1 : 0
  role   = aws_iam_role.workflow_pods[0].id
  policy = data.aws_iam_policy_document.workflow_pods.json
}

resource "aws_eks_pod_identity_association" "workflow" {
  for_each        = local.has_eks ? toset(var.workflow_namespaces) : toset([])
  cluster_name    = local.eks_cluster_name
  namespace       = each.value
  service_account = var.workflow_pod_identity_service_account
  role_arn        = aws_iam_role.workflow_pods[0].arn
}
