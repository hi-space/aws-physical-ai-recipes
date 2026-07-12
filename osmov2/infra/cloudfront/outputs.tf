output "osmo_ui_cloudfront_domain" {
  description = "CloudFront domain name for OSMO Admin UI."
  value       = aws_cloudfront_distribution.osmo_ui.domain_name
}

output "osmo_ui_cloudfront_id" {
  description = "CloudFront distribution ID for OSMO Admin UI."
  value       = aws_cloudfront_distribution.osmo_ui.id
}

output "grafana_cloudfront_domain" {
  description = "CloudFront domain name for Grafana."
  value       = aws_cloudfront_distribution.grafana.domain_name
}

output "grafana_cloudfront_id" {
  description = "CloudFront distribution ID for Grafana."
  value       = aws_cloudfront_distribution.grafana.id
}

output "web_acl_arn" {
  description = "WAF WebACL ARN attached to CloudFront distributions."
  value       = aws_wafv2_web_acl.this.arn
}

output "waf_ip_set_arn" {
  description = "WAF IP set ARN for managing allowed IPs."
  value       = aws_wafv2_ip_set.allowed.arn
}
