output "auth_provider" {
  description = "Active auth provider (cognito | identity-center | none)."
  value       = var.deploy_cognito ? "cognito" : (var.deploy_identity_center ? "identity-center" : "none")
}

output "oidc_issuer_url" {
  description = "OIDC issuer URL for the OSMO gateway."
  value       = ""
}

output "oidc_jwks_uri" {
  description = "OIDC JWKS URI."
  value       = ""
}

output "browser_client_id" {
  description = "Browser (authorization code) OAuth client ID."
  value       = ""
}

output "cli_client_id" {
  description = "CLI OAuth client ID."
  value       = ""
}

output "cookie_domain" {
  description = "Cookie domain for oauth2-proxy."
  value       = var.osmo_hostname != "" ? join(".", slice(split(".", var.osmo_hostname), 1, length(split(".", var.osmo_hostname)))) : ""
}
