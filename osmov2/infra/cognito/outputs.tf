output "user_pool_id" {
  description = "Cognito user pool ID."
  value       = aws_cognito_user_pool.this.id
}

output "user_pool_domain" {
  description = "Hosted UI domain prefix."
  value       = aws_cognito_user_pool_domain.this.domain
}

output "hosted_ui_url" {
  description = "Base URL of the Cognito hosted UI."
  value       = "https://${aws_cognito_user_pool_domain.this.domain}.auth.${var.aws_region}.amazoncognito.com"
}

output "oidc_issuer_url" {
  description = "OIDC issuer URL for oauth2-proxy (gateway.oauth2Proxy.oidcIssuerUrl)."
  value       = "https://cognito-idp.${var.aws_region}.amazonaws.com/${aws_cognito_user_pool.this.id}"
}

output "client_id" {
  description = "App client ID (gateway.oauth2Proxy.clientId)."
  value       = aws_cognito_user_pool_client.oauth2.id
}

output "client_secret" {
  description = "App client secret. Store in the oauth2-proxy-secrets K8s secret."
  value       = aws_cognito_user_pool_client.oauth2.client_secret
  sensitive   = true
}
