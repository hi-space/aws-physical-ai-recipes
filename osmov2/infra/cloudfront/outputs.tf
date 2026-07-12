output "cloudfront_domain_name" {
  description = "CloudFront distribution domain name (use this to access OSMO UI)."
  value       = aws_cloudfront_distribution.this.domain_name
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID."
  value       = aws_cloudfront_distribution.this.id
}

output "web_acl_arn" {
  description = "WAF WebACL ARN attached to CloudFront."
  value       = aws_wafv2_web_acl.this.arn
}

output "waf_ip_set_arn" {
  description = "WAF IP set ARN for managing allowed IPs."
  value       = aws_wafv2_ip_set.allowed.arn
}
