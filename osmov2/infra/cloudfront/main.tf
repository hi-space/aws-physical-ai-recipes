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
  region = "us-east-1"
  alias  = "global"

  default_tags {
    tags = var.tags
  }
}

provider "aws" {
  region = var.alb_region

  default_tags {
    tags = var.tags
  }
}

resource "aws_wafv2_ip_set" "allowed" {
  provider           = aws.global
  name               = "${var.name_prefix}-allowed-ips"
  scope              = "CLOUDFRONT"
  ip_address_version = "IPV4"
  addresses          = var.allowed_cidrs
}

resource "aws_wafv2_web_acl" "this" {
  provider = aws.global
  name     = "${var.name_prefix}-cloudfront-acl"
  scope    = "CLOUDFRONT"

  default_action {
    block {}
  }

  rule {
    name     = "allow-whitelisted-ips"
    priority = 0

    action {
      allow {}
    }

    statement {
      ip_set_reference_statement {
        arn = aws_wafv2_ip_set.allowed.arn
      }
    }

    visibility_config {
      sampled_requests_enabled   = true
      cloudwatch_metrics_enabled = true
      metric_name                = "allow-whitelisted-ips"
    }
  }

  visibility_config {
    sampled_requests_enabled   = true
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.name_prefix}-cloudfront-acl"
  }
}

resource "aws_cloudfront_distribution" "osmo_ui" {
  provider = aws.global
  comment  = "OSMO Admin UI via ALB"
  enabled  = true

  origin {
    domain_name = var.osmo_alb_dns_name
    origin_id   = "osmo-alb-origin"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id       = "osmo-alb-origin"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    origin_request_policy_id = "216adef6-5c7f-47e4-b989-5492eafa07d3"
  }

  web_acl_id = aws_wafv2_web_acl.this.arn

  price_class = "PriceClass_200"

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
}

resource "aws_cloudfront_distribution" "grafana" {
  provider = aws.global
  comment  = "OSMO Grafana via ALB"
  enabled  = true

  origin {
    domain_name = var.grafana_alb_dns_name
    origin_id   = "grafana-alb-origin"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id       = "grafana-alb-origin"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    origin_request_policy_id = "216adef6-5c7f-47e4-b989-5492eafa07d3"
  }

  web_acl_id = aws_wafv2_web_acl.this.arn

  price_class = "PriceClass_200"

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
}
