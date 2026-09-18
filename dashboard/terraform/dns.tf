# TLS certificate (dashboard + *.apps session hosts) and Route 53 aliases to the ALB.

resource "aws_acm_certificate" "cert" {
  count                     = local.has_domain ? 1 : 0
  domain_name               = local.domain
  subject_alternative_names = ["*.apps.${local.domain}"]
  validation_method         = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = { for dvo in(local.has_domain ? aws_acm_certificate.cert[0].domain_validation_options : []) : dvo.domain_name => {
    name   = dvo.resource_record_name
    record = dvo.resource_record_value
    type   = dvo.resource_record_type
  } }
  zone_id         = var.hosted_zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "cert" {
  count                   = local.has_domain ? 1 : 0
  certificate_arn         = aws_acm_certificate.cert[0].arn
  validation_record_fqdns = [for record in aws_route53_record.cert_validation : record.fqdn]
}

resource "aws_route53_record" "dashboard" {
  count   = local.has_domain ? 1 : 0
  zone_id = var.hosted_zone_id
  name    = local.domain
  type    = "A"
  alias {
    name                   = aws_lb.alb.dns_name
    zone_id                = aws_lb.alb.zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "sessions" {
  count   = local.has_domain ? 1 : 0
  zone_id = var.hosted_zone_id
  name    = "*.apps.${local.domain}"
  type    = "A"
  alias {
    name                   = aws_lb.alb.dns_name
    zone_id                = aws_lb.alb.zone_id
    evaluate_target_health = false
  }
}

# ---- no custom domain: self-signed certificate for the ALB DNS name (browsers warn; Cognito still works)
resource "tls_private_key" "self_signed" {
  count     = local.has_domain ? 0 : 1
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "tls_self_signed_cert" "self_signed" {
  count                 = local.has_domain ? 0 : 1
  private_key_pem       = tls_private_key.self_signed[0].private_key_pem
  dns_names             = [aws_lb.alb.dns_name]
  validity_period_hours = 24 * 365 * 5
  allowed_uses          = ["key_encipherment", "digital_signature", "server_auth"]
  subject {
    common_name  = aws_lb.alb.dns_name
    organization = "Physical AI Dashboard"
  }
}

resource "aws_acm_certificate" "self_signed" {
  count            = local.has_domain ? 0 : 1
  private_key      = tls_private_key.self_signed[0].private_key_pem
  certificate_body = tls_self_signed_cert.self_signed[0].cert_pem
  lifecycle {
    create_before_destroy = true
  }
}

locals {
  listener_certificate_arn = local.has_domain ? aws_acm_certificate_validation.cert[0].certificate_arn : aws_acm_certificate.self_signed[0].arn
}
