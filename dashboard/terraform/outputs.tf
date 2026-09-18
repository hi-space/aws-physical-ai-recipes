output "dashboard_url" {
  value       = "${local.origin}/"
  description = "Dashboard (Cognito login)"
}

output "alb_dns_name" {
  value = aws_lb.alb.dns_name
}

output "admin_credentials_secret" {
  value       = aws_secretsmanager_secret.admin.name
  description = "Secrets Manager secret with the bootstrap admin username/password"
}

output "admin_credentials_command" {
  value = "aws secretsmanager get-secret-value --secret-id ${aws_secretsmanager_secret.admin.name} --region ${var.region} --query SecretString --output text"
}

output "user_pool_id" {
  value = aws_cognito_user_pool.pool.id
}

output "user_pool_client_id" {
  value = aws_cognito_user_pool_client.alb.id
}

output "cognito_domain" {
  value = local.cognito_domain
}

output "table_name" {
  value = aws_dynamodb_table.store.name
}

output "task_role_arn" {
  value = aws_iam_role.web.arn
}

output "controller_role_arn" {
  value = aws_iam_role.controller.arn
}

output "gateway_role_arn" {
  value = aws_iam_role.gateway.arn
}

output "workflow_pod_role_arn" {
  value = local.has_eks ? aws_iam_role.workflow_pods[0].arn : null
}

output "log_group_name" {
  value = aws_cloudwatch_log_group.ecs.name
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.cluster.name
}

output "ecs_service_names" {
  value = { web = aws_ecs_service.web.name, controller = aws_ecs_service.controller.name, gateway = local.has_domain ? aws_ecs_service.gateway[0].name : null }
}

output "notifications_topic_arn" {
  value = aws_sns_topic.notifications.arn
}

output "workflow_state_machine_arn" {
  value = aws_sfn_state_machine.workflow.arn
}

output "artifact_bucket_name" {
  value = aws_s3_bucket.artifacts.bucket
}

output "assets_bucket_name" {
  value = aws_s3_bucket.assets.bucket
}

output "operations_project" {
  value = local.has_eks ? aws_codebuild_project.operations[0].name : null
}

output "image_uris" {
  value = local.image_uris
}

output "image_digests" {
  value = { for name, image in data.aws_ecr_image.built : name => image.image_digest }
}

output "discovered_stacks" {
  value = keys(local.discovered_stacks)
}

output "environment_contract" {
  description = "Container environment handed to the web service (secrets excluded); the controller and gateway differ only in the per-service keys documented in README.md."
  value       = local.web_env
}

output "session_hosts" {
  description = "Wildcard session-host domain, or null when the deployment has no custom domain (session features disabled)."
  value       = local.has_domain ? "*.apps.${local.domain}" : null
}
