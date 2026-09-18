# Cognito user pool + hosted UI + ALB app client, the three RBAC groups and a bootstrap admin whose
# permanent password lives in Secrets Manager (mirror of infra/lib/constructs/auth.ts).

resource "aws_cognito_user_pool" "pool" {
  name                     = local.prefix
  deletion_protection      = var.cognito_deletion_protection ? "ACTIVE" : "INACTIVE"
  alias_attributes         = ["email"]
  auto_verified_attributes = ["email"]
  # Managed login (branding v2) requires the Essentials or Plus feature plan; Lite only has the
  # classic hosted UI. Essentials is the cheapest tier that unlocks the themed login below.
  user_pool_tier = "ESSENTIALS"

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
  # v2 = managed login (the branding designer + aws_cognito_managed_login_branding below).
  # v1 is the classic hosted UI that only supports aws_cognito_user_pool_ui_customization.
  managed_login_version = 2
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

# ---- managed login (branding v2) themed to the dashboard's dark palette (web/src/app/globals.css).
# Colours are RRGGBBAA. colorSchemeMode=DARK renders the darkMode values below; the lightMode values
# are Cognito defaults kept for document completeness (never shown while the mode is DARK). Unspecified
# keys fall back to Cognito defaults, so this only needs to carry the palette we care about.
locals {
  # dashboard palette (globals.css) as Cognito RRGGBBAA hex
  ml_bg         = "0b0e14ff" # --color-bg
  ml_bg_elev    = "111622ff" # --color-bg-elev
  ml_bg_elev2   = "171d2bff" # --color-bg-elev-2
  ml_border     = "232b3bff" # --color-border
  ml_border_str = "33405aff" # --color-border-strong
  ml_fg         = "e6e9f0ff" # --color-fg
  ml_fg_muted   = "98a2b8ff" # --color-fg-muted
  ml_fg_faint   = "66718aff" # --color-fg-faint
  ml_accent     = "6ea8feff" # --color-accent
  ml_accent_str = "3b82f6ff" # --color-accent-strong
}

resource "aws_cognito_managed_login_branding" "alb" {
  user_pool_id = aws_cognito_user_pool.pool.id
  client_id    = aws_cognito_user_pool_client.alb.id
  # Provider requires exactly one of settings / use_cognito_provided_values; supplying settings
  # (a partial doc) is enough — Cognito fills every unspecified key with its defaults.

  settings = jsonencode({
    categories = {
      global = {
        colorSchemeMode = "DARK"
        pageHeader      = { enabled = false }
        pageFooter      = { enabled = false }
        spacingDensity  = "REGULAR"
      }
      form = {
        displayGraphics = true
        location        = { horizontal = "CENTER", vertical = "CENTER" }
      }
    }
    components = {
      pageBackground = {
        image     = { enabled = false } # solid colour, no default gradient image
        darkMode  = { color = local.ml_bg }
        lightMode = { color = "ffffffff" }
      }
      pageText = {
        darkMode  = { headingColor = local.ml_fg, bodyColor = local.ml_fg_muted, descriptionColor = local.ml_fg_muted }
        lightMode = { headingColor = "000716ff", bodyColor = "414d5cff", descriptionColor = "414d5cff" }
      }
      form = {
        borderRadius    = 12
        backgroundImage = { enabled = false }
        logo            = { enabled = false, location = "CENTER", position = "TOP", formInclusion = "IN" }
        darkMode        = { backgroundColor = local.ml_bg_elev, borderColor = local.ml_border }
        lightMode       = { backgroundColor = "ffffffff", borderColor = "c6c6cdff" }
      }
      primaryButton = {
        darkMode = {
          defaults = { backgroundColor = local.ml_accent_str, textColor = "ffffffff" }
          hover    = { backgroundColor = local.ml_accent, textColor = local.ml_bg }
          active   = { backgroundColor = local.ml_accent, textColor = local.ml_bg }
          disabled = { backgroundColor = local.ml_bg_elev2, borderColor = local.ml_border }
        }
        lightMode = {
          defaults = { backgroundColor = "0972d3ff", textColor = "ffffffff" }
          hover    = { backgroundColor = "033160ff", textColor = "ffffffff" }
          active   = { backgroundColor = "033160ff", textColor = "ffffffff" }
          disabled = { backgroundColor = "ffffffff", borderColor = "ffffffff" }
        }
      }
      secondaryButton = {
        darkMode = {
          defaults = { backgroundColor = local.ml_bg_elev, borderColor = local.ml_border_str, textColor = local.ml_accent }
          hover    = { backgroundColor = local.ml_bg_elev2, borderColor = local.ml_accent, textColor = local.ml_accent }
          active   = { backgroundColor = local.ml_border, borderColor = local.ml_accent, textColor = local.ml_accent }
        }
        lightMode = {
          defaults = { backgroundColor = "ffffffff", borderColor = "0972d3ff", textColor = "0972d3ff" }
          hover    = { backgroundColor = "f2f8fdff", borderColor = "033160ff", textColor = "033160ff" }
          active   = { backgroundColor = "d3e7f9ff", borderColor = "033160ff", textColor = "033160ff" }
        }
      }
    }
    componentClasses = {
      buttons = { borderRadius = 8 }
      input = {
        borderRadius = 8
        darkMode     = { defaults = { backgroundColor = local.ml_bg, borderColor = local.ml_border_str }, placeholderColor = local.ml_fg_faint }
        lightMode    = { defaults = { backgroundColor = "ffffffff", borderColor = "7d8998ff" }, placeholderColor = "5f6b7aff" }
      }
      inputLabel       = { darkMode = { textColor = local.ml_fg }, lightMode = { textColor = "000716ff" } }
      inputDescription = { darkMode = { textColor = local.ml_fg_muted }, lightMode = { textColor = "5f6b7aff" } }
      link = {
        darkMode  = { defaults = { textColor = local.ml_accent }, hover = { textColor = local.ml_accent_str } }
        lightMode = { defaults = { textColor = "0972d3ff" }, hover = { textColor = "033160ff" } }
      }
      focusState = { darkMode = { borderColor = local.ml_accent }, lightMode = { borderColor = "0972d3ff" } }
      divider    = { darkMode = { borderColor = local.ml_border }, lightMode = { borderColor = "ebebf0ff" } }
    }
  })
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
