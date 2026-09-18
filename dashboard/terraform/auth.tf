# Cognito user pool + hosted UI + ALB app client, the three RBAC groups and a bootstrap admin whose
# permanent password lives in Secrets Manager (mirror of infra/lib/constructs/auth.ts).

resource "aws_cognito_user_pool" "pool" {
  name                     = local.prefix
  deletion_protection      = var.cognito_deletion_protection ? "ACTIVE" : "INACTIVE"
  alias_attributes         = ["email"]
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
  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }
  schema {
    name                = "email"
    attribute_data_type = "String"
    required            = true
    mutable             = true
    string_attribute_constraints {
      min_length = 0
      max_length = 2048
    }
  }
  lifecycle {
    ignore_changes = [schema]
  }
}

resource "aws_cognito_user_group" "groups" {
  for_each = {
    admins      = { description = "Full access: clusters, quotas, users, edge deployments", precedence = 1 }
    researchers = { description = "Submit/cancel workflows, datasets, sessions, uploads", precedence = 5 }
    viewers     = { description = "Read-only", precedence = 10 }
  }
  name         = each.key
  user_pool_id = aws_cognito_user_pool.pool.id
  description  = each.value.description
  precedence   = each.value.precedence
}

resource "aws_cognito_user_pool_domain" "hosted_ui" {
  domain       = local.cognito_domain_prefix
  user_pool_id = aws_cognito_user_pool.pool.id
}

resource "aws_cognito_user_pool_client" "alb" {
  name                                 = "alb"
  user_pool_id                         = aws_cognito_user_pool.pool.id
  generate_secret                      = true
  explicit_auth_flows                  = ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  callback_urls                        = ["${local.origin}/oauth2/idpresponse"]
  logout_urls                          = ["${local.origin}/"]
  supported_identity_providers         = ["COGNITO"]
  prevent_user_existence_errors        = "ENABLED"
  access_token_validity                = 1
  id_token_validity                    = 1
  refresh_token_validity               = 30
  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }
}

# ---- bootstrap admin (permanent password, no e-mail round trip)
resource "random_password" "admin" {
  length      = 20
  special     = false
  min_upper   = 1
  min_lower   = 1
  min_numeric = 1
}

resource "aws_secretsmanager_secret" "admin" {
  name                    = "${local.prefix}/admin"
  description             = "Bootstrap admin login for the Physical AI Dashboard (Cognito)"
  recovery_window_in_days = var.secret_recovery_window_days
}

resource "aws_secretsmanager_secret_version" "admin" {
  secret_id = aws_secretsmanager_secret.admin.id
  secret_string = jsonencode({
    username = var.admin_username
    email    = local.admin_email
    loginUrl = "${local.origin}/"
    password = random_password.admin.result
  })
}

resource "aws_cognito_user" "admin" {
  user_pool_id   = aws_cognito_user_pool.pool.id
  username       = var.admin_username
  password       = random_password.admin.result
  message_action = "SUPPRESS"
  attributes = {
    email          = local.admin_email
    email_verified = "true"
  }
  lifecycle {
    ignore_changes = [password]
  }
}

resource "aws_cognito_user_in_group" "admin" {
  user_pool_id = aws_cognito_user_pool.pool.id
  group_name   = aws_cognito_user_group.groups["admins"].name
  username     = aws_cognito_user.admin.username
}
