# Cognito Browser Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Protect the OSMO Web UI with AWS Cognito browser login using ALB-native `authenticate-cognito`, layered onto the existing `infra/ingress` Terraform root.

**Architecture:** Add Cognito resources (User Pool, browser app client, prefix Hosted UI domain, groups, optional admin user) to `infra/ingress`, gated by `enable_cognito_auth`. When enabled, inject `authenticate-cognito` annotations into the existing `kubernetes_ingress_v1.osmo_admin` and drop the host-less catch-all rule so OAuth callbacks resolve to the domain. No OSMO chart or script changes.

**Tech Stack:** Terraform (>= 1.5.0, < 2.0.0), AWS provider ~> 5.0, Kubernetes provider ~> 2.36, AWS Load Balancer Controller (chart 3.2.2).

## Global Constraints

- Terraform required_version: `>= 1.5.0, < 2.0.0` (do not change).
- AWS provider `~> 5.0`, Kubernetes provider `~> 2.36`, Helm provider `~> 2.17` (do not change).
- All new resources live in `infra/ingress/`. Do NOT modify OSMO charts, `scripts/`, or `infra/core`.
- Cognito login requires HTTPS + domain-based callback — reuses the module's existing ACM cert and `domain_name`.
- `enable_cognito_auth = false` MUST reproduce today's behavior exactly (auth-less ALB, catch-all rule present).
- Client secret must NOT appear in Ingress annotations (ALB↔Cognito handle it); only pool ARN / client ID / domain prefix go into annotations.
- Verification for every task: `terraform -chdir=infra/ingress fmt -check` and `terraform -chdir=infra/ingress validate` (after `init -backend=false`). No live apply in this plan.

---

### Task 1: Add Cognito input variables

**Files:**
- Modify: `infra/ingress/variables.tf` (append at end)

**Interfaces:**
- Produces: variables `enable_cognito_auth` (bool), `cognito_domain_prefix` (string), `cognito_admin_email` (string), `cognito_admin_temp_password` (string, sensitive), `cognito_access_token_validity_hours` (number). Later tasks reference `var.enable_cognito_auth`, `var.cognito_domain_prefix`, `var.cognito_admin_email`, `var.cognito_admin_temp_password`.

- [ ] **Step 1: Append the variables**

Add to the end of `infra/ingress/variables.tf`:

```hcl
variable "enable_cognito_auth" {
  description = "Enable AWS Cognito browser authentication on the admin ALB. When true, the host-less catch-all Ingress rule is removed and login is domain-only."
  type        = bool
  default     = false
}

variable "cognito_domain_prefix" {
  description = "Cognito Hosted UI domain prefix (globally unique). Resolves to <prefix>.auth.<region>.amazoncognito.com. Required when enable_cognito_auth is true."
  type        = string
  default     = ""

  validation {
    condition     = var.cognito_domain_prefix == "" || can(regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$", var.cognito_domain_prefix))
    error_message = "cognito_domain_prefix must be a lowercase DNS label (letters, digits, hyphens; not starting or ending with a hyphen)."
  }
}

variable "cognito_admin_email" {
  description = "Optional email for an initial Cognito admin user placed in the osmo-admin group. Leave empty to skip user creation."
  type        = string
  default     = ""
}

variable "cognito_admin_temp_password" {
  description = "Temporary password for the initial Cognito admin user. Must satisfy the pool password policy. The user is forced to change it on first login."
  type        = string
  default     = ""
  sensitive   = true
}

variable "cognito_access_token_validity_hours" {
  description = "Access and ID token validity in hours for the browser app client."
  type        = number
  default     = 1
}
```

- [ ] **Step 2: Format and validate**

Run: `cd /home/ubuntu/workspace/aws-physical-ai-recipes/osmov2 && terraform -chdir=infra/ingress fmt && terraform -chdir=infra/ingress init -backend=false && terraform -chdir=infra/ingress validate`
Expected: `Success! The configuration is valid.` (variables-only change still validates because Cognito resources arrive in Task 2; if validate reports missing references it means a later task's file was added out of order — proceed to Task 2.)

- [ ] **Step 3: Commit**

```bash
cd /home/ubuntu/workspace/aws-physical-ai-recipes/osmov2
git add infra/ingress/variables.tf
git commit -m "feat(ingress): add Cognito browser-auth input variables"
```

---

### Task 2: Add Cognito resources

**Files:**
- Create: `infra/ingress/cognito.tf`

**Interfaces:**
- Consumes: `var.enable_cognito_auth`, `var.cognito_domain_prefix`, `var.cognito_admin_email`, `var.cognito_admin_temp_password`, `var.cognito_access_token_validity_hours`, `var.aws_region`, `local.domain_name` (from main.tf), `var.tags`.
- Produces: resources `aws_cognito_user_pool.osmo` (count-gated), `aws_cognito_user_pool_client.browser`, `aws_cognito_user_pool_domain.osmo`, `aws_cognito_user_group.admin`, `aws_cognito_user_group.user`, `aws_cognito_user.admin`, `aws_cognito_user_in_group.admin`. Also local values `local.cognito_enabled`, `local.cognito_user_pool_arn`, `local.cognito_browser_client_id`, `local.cognito_user_pool_domain`, `local.cognito_issuer` used by Tasks 3 and 4.

- [ ] **Step 1: Create the file**

Create `infra/ingress/cognito.tf`:

```hcl
locals {
  cognito_enabled       = var.enable_cognito_auth
  cognito_create_admin  = var.enable_cognito_auth && var.cognito_admin_email != ""
  cognito_callback_urls = ["https://${local.domain_name}/oauth2/idpresponse"]
  cognito_logout_urls   = ["https://${local.domain_name}"]

  cognito_user_pool_arn      = one(aws_cognito_user_pool.osmo[*].arn)
  cognito_browser_client_id  = one(aws_cognito_user_pool_client.browser[*].id)
  cognito_user_pool_domain   = one(aws_cognito_user_pool_domain.osmo[*].domain)
  cognito_issuer             = local.cognito_enabled ? "https://cognito-idp.${var.aws_region}.amazonaws.com/${one(aws_cognito_user_pool.osmo[*].id)}" : null
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
  id_token_validity       = var.cognito_access_token_validity_hours
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
```

- [ ] **Step 2: Format and validate**

Run: `cd /home/ubuntu/workspace/aws-physical-ai-recipes/osmov2 && terraform -chdir=infra/ingress fmt && terraform -chdir=infra/ingress validate`
Expected: `Success! The configuration is valid.`

- [ ] **Step 3: Commit**

```bash
cd /home/ubuntu/workspace/aws-physical-ai-recipes/osmov2
git add infra/ingress/cognito.tf
git commit -m "feat(ingress): add Cognito user pool, browser client, groups, admin user"
```

---

### Task 3: Add Cognito outputs

**Files:**
- Modify: `infra/ingress/outputs.tf` (append at end)

**Interfaces:**
- Consumes: `local.cognito_user_pool_arn`, `local.cognito_browser_client_id`, `local.cognito_user_pool_domain`, `local.cognito_issuer` (from Task 2), `var.aws_region`.
- Produces: outputs `cognito_user_pool_arn`, `cognito_browser_client_id`, `cognito_user_pool_domain`, `cognito_issuer`, `cognito_hosted_ui_domain`.

- [ ] **Step 1: Append outputs**

Add to the end of `infra/ingress/outputs.tf`:

```hcl
output "cognito_user_pool_arn" {
  description = "Cognito user pool ARN (null when Cognito auth is disabled)."
  value       = local.cognito_user_pool_arn
}

output "cognito_browser_client_id" {
  description = "Cognito browser app client ID (null when Cognito auth is disabled)."
  value       = local.cognito_browser_client_id
}

output "cognito_user_pool_domain" {
  description = "Cognito Hosted UI domain prefix (null when Cognito auth is disabled)."
  value       = local.cognito_user_pool_domain
}

output "cognito_hosted_ui_domain" {
  description = "Fully qualified Cognito Hosted UI domain (null when Cognito auth is disabled)."
  value       = local.cognito_user_pool_domain == null ? null : "${local.cognito_user_pool_domain}.auth.${var.aws_region}.amazoncognito.com"
}

output "cognito_issuer" {
  description = "Cognito OIDC issuer URL (null when Cognito auth is disabled)."
  value       = local.cognito_issuer
}
```

- [ ] **Step 2: Format and validate**

Run: `cd /home/ubuntu/workspace/aws-physical-ai-recipes/osmov2 && terraform -chdir=infra/ingress fmt && terraform -chdir=infra/ingress validate`
Expected: `Success! The configuration is valid.`

- [ ] **Step 3: Commit**

```bash
cd /home/ubuntu/workspace/aws-physical-ai-recipes/osmov2
git add infra/ingress/outputs.tf
git commit -m "feat(ingress): expose Cognito outputs for admin ALB auth"
```

---

### Task 4: Wire Cognito auth into the Ingress

**Files:**
- Modify: `infra/ingress/main.tf:167-244` (the `kubernetes_ingress_v1.osmo_admin` resource)

**Interfaces:**
- Consumes: `var.enable_cognito_auth`, `local.cognito_user_pool_arn`, `local.cognito_browser_client_id`, `local.cognito_user_pool_domain` (from Task 2).
- Produces: conditional `authenticate-cognito` annotations; host-less catch-all rule removed when auth enabled. Also `depends_on` extended to Cognito client/domain so the callback URL is registered before the ALB references the pool.

- [ ] **Step 1: Make annotations conditional**

In `infra/ingress/main.tf`, replace the `annotations = { ... }` block (currently lines 173-185) with a `merge()` that appends Cognito annotations when enabled. Replace:

```hcl
    annotations = {
      "alb.ingress.kubernetes.io/backend-protocol"         = "HTTP"
      "alb.ingress.kubernetes.io/certificate-arn"          = aws_acm_certificate_validation.osmo_admin.certificate_arn
      "alb.ingress.kubernetes.io/healthcheck-path"         = var.healthcheck_path
      "alb.ingress.kubernetes.io/inbound-cidrs"            = join(",", var.allowed_cidrs)
      "alb.ingress.kubernetes.io/listen-ports"             = jsonencode([{ HTTP = 80 }, { HTTPS = 443 }])
      "alb.ingress.kubernetes.io/load-balancer-attributes" = "idle_timeout.timeout_seconds=3600,routing.http2.enabled=true"
      "alb.ingress.kubernetes.io/load-balancer-name"       = local.load_balancer_name
      "alb.ingress.kubernetes.io/scheme"                   = var.load_balancer_scheme
      "alb.ingress.kubernetes.io/ssl-redirect"             = "443"
      "alb.ingress.kubernetes.io/success-codes"            = "200-399"
      "alb.ingress.kubernetes.io/target-type"              = "ip"
    }
```

with:

```hcl
    annotations = merge(
      {
        "alb.ingress.kubernetes.io/backend-protocol"         = "HTTP"
        "alb.ingress.kubernetes.io/certificate-arn"          = aws_acm_certificate_validation.osmo_admin.certificate_arn
        "alb.ingress.kubernetes.io/healthcheck-path"         = var.healthcheck_path
        "alb.ingress.kubernetes.io/inbound-cidrs"            = join(",", var.allowed_cidrs)
        "alb.ingress.kubernetes.io/listen-ports"             = jsonencode([{ HTTP = 80 }, { HTTPS = 443 }])
        "alb.ingress.kubernetes.io/load-balancer-attributes" = "idle_timeout.timeout_seconds=3600,routing.http2.enabled=true"
        "alb.ingress.kubernetes.io/load-balancer-name"       = local.load_balancer_name
        "alb.ingress.kubernetes.io/scheme"                   = var.load_balancer_scheme
        "alb.ingress.kubernetes.io/ssl-redirect"             = "443"
        "alb.ingress.kubernetes.io/success-codes"            = "200-399"
        "alb.ingress.kubernetes.io/target-type"              = "ip"
      },
      var.enable_cognito_auth ? {
        "alb.ingress.kubernetes.io/auth-type" = "cognito"
        "alb.ingress.kubernetes.io/auth-idp-cognito" = jsonencode({
          userPoolARN      = local.cognito_user_pool_arn
          userPoolClientID = local.cognito_browser_client_id
          userPoolDomain   = local.cognito_user_pool_domain
        })
        "alb.ingress.kubernetes.io/auth-scope"                      = "openid email profile"
        "alb.ingress.kubernetes.io/auth-session-timeout"            = "3600"
        "alb.ingress.kubernetes.io/auth-on-unauthenticated-request" = "authenticate"
      } : {}
    )
```

- [ ] **Step 2: Make the catch-all rule conditional**

In the same resource, replace the second `rule { ... }` block (the host-less catch-all, currently lines 220-237, including its preceding comment) with a `dynamic "rule"` that only renders when auth is disabled. Replace:

```hcl
    # Host-less catch-all so the raw ALB DNS name also routes (demo access
    # without the domain). HTTPS still uses the domain_name ACM cert, so hitting
    # the raw ALB address over https shows a cert-name warning (expected).
    rule {
      http {
        path {
          path      = "/"
          path_type = "Prefix"

          backend {
            service {
              name = var.osmo_ui_service_name

              port {
                number = var.osmo_ui_service_port
              }
            }
          }
        }
      }
    }
```

with:

```hcl
    # Host-less catch-all so the raw ALB DNS name also routes (demo access
    # without the domain). Removed when Cognito auth is enabled, because the
    # OAuth callback is registered against domain_name and raw-DNS access would
    # fail the login redirect.
    dynamic "rule" {
      for_each = var.enable_cognito_auth ? [] : [1]

      content {
        http {
          path {
            path      = "/"
            path_type = "Prefix"

            backend {
              service {
                name = var.osmo_ui_service_name

                port {
                  number = var.osmo_ui_service_port
                }
              }
            }
          }
        }
      }
    }
```

- [ ] **Step 3: Extend depends_on**

In the same resource, replace the `depends_on` block (currently lines 240-243):

```hcl
  depends_on = [
    helm_release.aws_load_balancer_controller,
    aws_acm_certificate_validation.osmo_admin
  ]
```

with:

```hcl
  depends_on = [
    helm_release.aws_load_balancer_controller,
    aws_acm_certificate_validation.osmo_admin,
    aws_cognito_user_pool_client.browser,
    aws_cognito_user_pool_domain.osmo
  ]
```

- [ ] **Step 4: Format and validate**

Run: `cd /home/ubuntu/workspace/aws-physical-ai-recipes/osmov2 && terraform -chdir=infra/ingress fmt && terraform -chdir=infra/ingress validate`
Expected: `Success! The configuration is valid.`

- [ ] **Step 5: Verify disabled-path parity with a plan dry check**

Run: `cd /home/ubuntu/workspace/aws-physical-ai-recipes/osmov2 && terraform -chdir=infra/ingress validate && grep -c 'dynamic "rule"' infra/ingress/main.tf`
Expected: validate succeeds; grep prints `1` (catch-all is now the only dynamic rule). Confirm by reading the resource that rule 1 (host = domain_name) remains a static block.

- [ ] **Step 6: Commit**

```bash
cd /home/ubuntu/workspace/aws-physical-ai-recipes/osmov2
git add infra/ingress/main.tf
git commit -m "feat(ingress): attach authenticate-cognito to admin ALB when enabled"
```

---

### Task 5: Update tfvars example, README, and security docs

**Files:**
- Modify: `infra/ingress/terraform.tfvars.example`
- Modify: `infra/ingress/README.md`
- Modify: `docs/security.md`

**Interfaces:**
- Consumes: variables from Task 1. No code produced.

- [ ] **Step 1: Extend the tfvars example**

Append to `infra/ingress/terraform.tfvars.example` (before the closing `tags` block or at end — after the `allowed_cidrs` list):

```hcl
# Optional: AWS Cognito browser authentication for the admin UI.
# When enable_cognito_auth is true, the UI is reachable only via domain_name
# (the raw ALB DNS catch-all route is removed) and users must sign in through
# the Cognito Hosted UI.
enable_cognito_auth   = false
cognito_domain_prefix = "aws-osmo-dev-repro-auth" # globally unique
# cognito_admin_email       = "admin@example.com"
# cognito_admin_temp_password = "ChangeMe123!"
```

- [ ] **Step 2: Add a README section**

Append to `infra/ingress/README.md` a new section after "Required inputs":

```markdown
## Cognito Browser Authentication (optional)

Set `enable_cognito_auth = true` to require AWS Cognito login before the admin
UI is served. The ALB performs the OIDC Authorization Code handshake itself
(`authenticate-cognito`); no in-cluster proxy or Redis session store is added.

Additional inputs:

- `cognito_domain_prefix` (required when enabled): globally unique Hosted UI
  prefix, resolving to `<prefix>.auth.<region>.amazoncognito.com`.
- `cognito_admin_email` (optional): creates an initial admin user in the
  `osmo-admin` group.
- `cognito_admin_temp_password` (optional): temporary password for that user;
  Cognito forces a change on first login.

When enabled, access is domain-only: the host-less catch-all rule is removed so
the OAuth callback (`https://<domain_name>/oauth2/idpresponse`) always resolves.
The `osmo-admin` and `osmo-user` groups are created for future role mapping but
no authorization logic is wired yet — any authenticated user reaches the UI.

The OSMO CLI and automation continue to use bearer tokens; only the browser UI
is gated by Cognito.
```

- [ ] **Step 3: Add a security.md note**

Append to `docs/security.md` a new section:

```markdown
## Cognito Browser Authentication (optional ingress)

The optional `infra/ingress` root can require AWS Cognito login for the admin
UI via ALB-native `authenticate-cognito` (`enable_cognito_auth = true`). The
ALB handles the OIDC handshake; no sidecar or session store is deployed.

- Login is domain-only when enabled (the raw ALB DNS catch-all is removed).
- The browser app client holds a generated secret managed between the ALB and
  Cognito; it is never placed in Ingress annotations.
- `osmo-admin` / `osmo-user` groups are defined for future RBAC. Today any
  authenticated user can reach the UI — there is no per-role authorization.
- The OSMO CLI and service-to-service calls remain bearer-token based and are
  unaffected.
```

- [ ] **Step 4: Verify docs render and no broken tfvars**

Run: `cd /home/ubuntu/workspace/aws-physical-ai-recipes/osmov2 && terraform -chdir=infra/ingress fmt -check && grep -n "enable_cognito_auth" infra/ingress/terraform.tfvars.example infra/ingress/README.md docs/security.md`
Expected: fmt passes; grep shows the variable referenced in all three files.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/workspace/aws-physical-ai-recipes/osmov2
git add infra/ingress/terraform.tfvars.example infra/ingress/README.md docs/security.md
git commit -m "docs(ingress): document Cognito browser authentication"
```

---

## Self-Review Notes

- **Spec coverage:** Cognito resources in ingress (Task 2), prefix domain (Task 2), groups-only no-RBAC (Task 2 + docs), browser client with idpresponse callback (Task 2), ALB annotations (Task 4), conditional catch-all removal (Task 4), variables/outputs (Tasks 1, 3), docs (Task 5). CLI/Keycloak/Identity Center/device endpoints excluded per spec.
- **Disabled parity:** `enable_cognito_auth = false` → all Cognito resources have count 0, annotations `merge` adds nothing, catch-all rule renders. Matches current behavior.
- **Conditional safety:** count-gated resources referenced via `one(resource[*].attr)` (returns null when absent), avoiding index-out-of-range on the disabled path.
- **No placeholders:** all code blocks are complete and copy-ready.
