output "auth_provider" {
  description = "Active auth provider (cognito | identity-center | none)."
  value       = var.deploy_cognito ? "cognito" : (var.deploy_identity_center ? "identity-center" : "none")
}

output "oidc_issuer_url" {
  description = "OIDC issuer URL for the OSMO gateway."
  value       = var.deploy_cognito ? local.cognito_issuer : ""
}

output "oidc_jwks_uri" {
  description = "OIDC JWKS URI."
  value       = var.deploy_cognito ? "${local.cognito_issuer}/.well-known/jwks.json" : ""
}

output "browser_client_id" {
  description = "Browser (authorization code) OAuth client ID."
  value       = var.deploy_cognito ? aws_cognito_user_pool_client.browser[0].id : ""
}

output "cli_client_id" {
  description = "CLI OAuth client ID."
  value       = var.deploy_cognito ? aws_cognito_user_pool_client.cli[0].id : ""
}

output "cookie_domain" {
  description = "Cookie domain for oauth2-proxy."
  value       = var.osmo_hostname != "" ? join(".", slice(split(".", var.osmo_hostname), 1, length(split(".", var.osmo_hostname)))) : ""
}
