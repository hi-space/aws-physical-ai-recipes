terraform {
  required_version = ">= 1.5.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = var.tags
  }
}

data "aws_caller_identity" "current" {}

resource "aws_cognito_user_pool" "this" {
  name = var.name

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  password_policy {
    minimum_length                   = 8
    require_uppercase                = true
    require_lowercase                = true
    require_numbers                  = true
    require_symbols                  = false
    temporary_password_validity_days = 7
  }

  mfa_configuration = "OFF"

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
    recovery_mechanism {
      name     = "verified_phone_number"
      priority = 2
    }
  }

  # Disable public self-registration: only administrators may create users
  # (admin-create-user). This pool fronts an internal admin UI, so open
  # sign-up would let unauthorized users provision accounts.
  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  deletion_protection = var.deletion_protection ? "ACTIVE" : "INACTIVE"

  # Cognito auto-provisions the standard "email" schema attribute from
  # username_attributes. It is not declared here (fresh applies create it
  # implicitly) and cannot be removed via the API, so ignore it to keep
  # imported state clean.
  lifecycle {
    ignore_changes = [schema]
  }
}

# Hosted UI domain. The account ID keeps the prefix globally unique so the
# example applies cleanly in any account without a naming collision.
resource "aws_cognito_user_pool_domain" "this" {
  domain       = "${var.name}-${data.aws_caller_identity.current.account_id}"
  user_pool_id = aws_cognito_user_pool.this.id
}

resource "aws_cognito_user_pool_client" "oauth2" {
  name         = var.client_name
  user_pool_id = aws_cognito_user_pool.this.id

  # oauth2-proxy uses the authorization-code flow with a client secret.
  generate_secret = true

  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]

  supported_identity_providers = ["COGNITO"]

  callback_urls = ["https://${var.ui_hostname}/oauth2/callback"]
  logout_urls   = ["https://${var.ui_hostname}"]

  explicit_auth_flows = [
    "ALLOW_REFRESH_TOKEN_AUTH",
    "ALLOW_USER_SRP_AUTH",
  ]

  refresh_token_validity  = 30
  enable_token_revocation = true

  # generate_secret is create-only and the AWS API does not return it, so an
  # imported client always shows a spurious "forces replacement" diff.
  # Replacing would rotate client_id/secret and break the live oauth2-proxy
  # integration, so pin it.
  lifecycle {
    ignore_changes = [generate_secret]
  }
}

# Initial SSO login user. Self-registration is disabled, so the pool needs at
# least one admin-created user to sign in. Terraform provisions it with a
# permanent password (message_action SUPPRESS, no temp-password email) so the
# full deploy is non-interactive. Set admin_email/admin_password to enable;
# leave admin_email empty to manage users manually with admin-create-user.
resource "aws_cognito_user" "admin" {
  count = var.admin_email != "" ? 1 : 0

  user_pool_id = aws_cognito_user_pool.this.id
  username     = var.admin_email

  # preferred_username drives the OSMO web UI's displayed identity and its
  # "My Workflows" filter (via oauth2-proxy x-auth-request-preferred-username).
  # Without it oauth2-proxy falls back to the Cognito sub (UUID), so the UI
  # filters by an unreadable UUID that never matches CLI-submitted owners.
  attributes = {
    email              = var.admin_email
    email_verified     = "true"
    preferred_username = split("@", var.admin_email)[0]
  }

  password       = var.admin_password
  message_action = "SUPPRESS"

  lifecycle {
    # The API never returns the password, so ignore it to avoid a perpetual
    # diff; rotate credentials with admin-set-user-password out of band.
    ignore_changes = [password]
  }
}
