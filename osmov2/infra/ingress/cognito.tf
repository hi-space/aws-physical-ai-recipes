locals {
  cognito_enabled       = var.enable_cognito_auth
  cognito_create_admin  = var.enable_cognito_auth && var.cognito_admin_email != ""
  cognito_callback_urls = ["https://${local.domain_name}/oauth2/idpresponse"]
  cognito_logout_urls   = ["https://${local.domain_name}"]

  cognito_user_pool_arn     = one(aws_cognito_user_pool.osmo[*].arn)
  cognito_browser_client_id = one(aws_cognito_user_pool_client.browser[*].id)
  cognito_user_pool_domain  = one(aws_cognito_user_pool_domain.osmo[*].domain)
  cognito_issuer            = local.cognito_enabled ? "https://cognito-idp.${var.aws_region}.amazonaws.com/${one(aws_cognito_user_pool.osmo[*].id)}" : null
}

resource "aws_cognito_user_pool" "osmo" {
  count = local.cognito_enabled ? 1 : 0

  name                     = "${var.cluster_name}-osmo"
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  password_policy {
    minimum_length                   = 8
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = false
    temporary_password_validity_days = 7
  }

  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  tags = var.tags
}

resource "aws_cognito_user_pool_domain" "osmo" {
  count = local.cognito_enabled ? 1 : 0

  domain       = var.cognito_domain_prefix
  user_pool_id = aws_cognito_user_pool.osmo[0].id
}

resource "aws_cognito_user_pool_client" "browser" {
  count = local.cognito_enabled ? 1 : 0

  name         = "${var.cluster_name}-browser"
  user_pool_id = aws_cognito_user_pool.osmo[0].id

  generate_secret = true

  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"]

  callback_urls = local.cognito_callback_urls
  logout_urls   = local.cognito_logout_urls

  explicit_auth_flows = ["ALLOW_REFRESH_TOKEN_AUTH"]

  access_token_validity  = var.cognito_access_token_validity_hours
  id_token_validity      = var.cognito_access_token_validity_hours
  refresh_token_validity = 7

  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }

  depends_on = [aws_cognito_user_pool_domain.osmo]
}

resource "aws_cognito_user_group" "admin" {
  count = local.cognito_enabled ? 1 : 0

  name         = "osmo-admin"
  user_pool_id = aws_cognito_user_pool.osmo[0].id
  precedence   = 1
  description  = "OSMO administrators"
}

resource "aws_cognito_user_group" "user" {
  count = local.cognito_enabled ? 1 : 0

  name         = "osmo-user"
  user_pool_id = aws_cognito_user_pool.osmo[0].id
  precedence   = 10
  description  = "OSMO users"
}

resource "aws_cognito_user" "admin" {
  count = local.cognito_create_admin ? 1 : 0

  user_pool_id = aws_cognito_user_pool.osmo[0].id
  username     = var.cognito_admin_email

  attributes = {
    email          = var.cognito_admin_email
    email_verified = "true"
  }

  temporary_password = var.cognito_admin_temp_password
}

resource "aws_cognito_user_in_group" "admin" {
  count = local.cognito_create_admin ? 1 : 0

  user_pool_id = aws_cognito_user_pool.osmo[0].id
  group_name   = aws_cognito_user_group.admin[0].name
  username     = aws_cognito_user.admin[0].username
}
