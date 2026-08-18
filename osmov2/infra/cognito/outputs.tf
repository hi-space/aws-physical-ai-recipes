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

# The OSMO user id is the preferred_username claim (the gateway's jwt user_claim
# in deploy-osmo.sh), which is what the UI also displays. deploy-osmo.sh grants
# osmo-admin to it so the initial user can administer the UI on first login.
# Empty when admin_email is unset.
output "admin_user_name" {
  description = "preferred_username of the initial SSO login user; this is the OSMO user id."
  value       = var.admin_email != "" ? aws_cognito_user.admin[0].attributes["preferred_username"] : ""
}

# Retained because the sub is still the stable Cognito identifier — useful for
# looking a user up in the pool. It is no longer the OSMO user id.
output "admin_user_sub" {
  description = "Cognito subject (sub) of the initial SSO login user."
  value       = var.admin_email != "" ? aws_cognito_user.admin[0].sub : ""
}

output "admin_user_email" {
  description = "Email/username of the initial SSO login user."
  value       = var.admin_email
}
