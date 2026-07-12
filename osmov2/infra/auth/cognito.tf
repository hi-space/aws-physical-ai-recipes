# Cognito user pool as OSMO IdP. Hosted-UI custom domain is omitted for the
# reference deployment; the pool's default issuer/jwks are used directly.

resource "aws_cognito_user_pool" "osmo" {
  count = var.deploy_cognito ? 1 : 0

  name                     = "${var.name_prefix}-osmo"
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  username_configuration {
    case_sensitive = false
  }

  password_policy {
    minimum_length                   = 8
    require_lowercase                = true
    require_numbers                  = true
    require_symbols                  = false
    require_uppercase                = true
    temporary_password_validity_days = 7
  }

  admin_create_user_config {
    allow_admin_create_user_only = false
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  tags = merge(var.common_tags, { Name = "${var.name_prefix}-cognito-pool" })
}

resource "aws_cognito_user_pool_client" "browser" {
  count = var.deploy_cognito ? 1 : 0

  name            = "${var.name_prefix}-browser"
  user_pool_id    = aws_cognito_user_pool.osmo[0].id
  generate_secret = true

  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"]

  callback_urls = var.osmo_hostname != "" ? ["https://${var.osmo_hostname}/oauth2/callback"] : []
  logout_urls   = var.osmo_hostname != "" ? ["https://${var.osmo_hostname}/oauth2/sign_out"] : []

  explicit_auth_flows = ["ALLOW_REFRESH_TOKEN_AUTH"]

  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }
  access_token_validity  = 1
  id_token_validity      = 1
  refresh_token_validity = 7
}

resource "aws_cognito_user_pool_client" "cli" {
  count = var.deploy_cognito ? 1 : 0

  name         = "${var.name_prefix}-cli"
  user_pool_id = aws_cognito_user_pool.osmo[0].id

  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = false
  explicit_auth_flows                  = ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]

  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }
  access_token_validity  = 1
  id_token_validity      = 1
  refresh_token_validity = 7
}

resource "aws_cognito_user_group" "admin" {
  count        = var.deploy_cognito ? 1 : 0
  name         = "osmo-admin"
  user_pool_id = aws_cognito_user_pool.osmo[0].id
  description  = "OSMO administrators with full access"
  precedence   = 1
}

resource "aws_cognito_user_group" "user" {
  count        = var.deploy_cognito ? 1 : 0
  name         = "osmo-user"
  user_pool_id = aws_cognito_user_pool.osmo[0].id
  description  = "Standard OSMO users"
  precedence   = 10
}

locals {
  cognito_issuer = var.deploy_cognito ? "https://cognito-idp.${var.aws_region}.amazonaws.com/${aws_cognito_user_pool.osmo[0].id}" : ""
}
