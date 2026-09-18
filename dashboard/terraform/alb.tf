# Public entry: ALB with Cognito authentication in front of the web service, unauthenticated
# health/logout/API-token paths, and *.apps.<domain> host routing to the session gateway.

resource "aws_security_group" "alb" {
  name        = "${local.prefix}-alb"
  description = "${local.prefix} ALB"
  vpc_id      = local.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTP redirect"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "alb_all" {
  security_group_id = aws_security_group.alb.id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_security_group" "service" {
  name        = "${local.prefix}-service"
  description = "${local.prefix} service"
  vpc_id      = local.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "service_web" {
  security_group_id            = aws_security_group.service.id
  description                  = "from ALB"
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
  referenced_security_group_id = aws_security_group.alb.id
}

resource "aws_vpc_security_group_ingress_rule" "service_gateway" {
  security_group_id            = aws_security_group.service.id
  description                  = "Authenticated session hosts from ALB"
  ip_protocol                  = "tcp"
  from_port                    = 3002
  to_port                      = 3002
  referenced_security_group_id = aws_security_group.alb.id
}

resource "aws_vpc_security_group_ingress_rule" "service_runtime" {
  security_group_id = aws_security_group.service.id
  description       = "Scoped workload runtime protocol from private VPC"
  ip_protocol       = "tcp"
  from_port         = 3001
  to_port           = 3001
  cidr_ipv4         = data.aws_vpc.vpc.cidr_block
}

resource "aws_vpc_security_group_egress_rule" "service_all" {
  security_group_id = aws_security_group.service.id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_lb" "alb" {
  name                       = substr("${local.prefix}-alb", 0, 32)
  load_balancer_type         = "application"
  internal                   = false
  security_groups            = [aws_security_group.alb.id]
  subnets                    = local.public_subnet_ids
  idle_timeout               = 300
  drop_invalid_header_fields = true
}

resource "aws_lb_target_group" "web" {
  name                 = substr("${local.prefix}-web", 0, 32)
  port                 = 3000
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = local.vpc_id
  deregistration_delay = 10
  health_check {
    path                = "/api/health"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
    matcher             = "200"
  }
}

resource "aws_lb_target_group" "gateway" {
  count                = local.has_domain ? 1 : 0
  name                 = substr("${local.prefix}-gw", 0, 32)
  port                 = 3002
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = local.vpc_id
  deregistration_delay = 15
  health_check {
    path                = "/health"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
    matcher             = "200"
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.alb.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-Res-2021-06"
  certificate_arn   = local.listener_certificate_arn

  default_action {
    type = "authenticate-cognito"
    authenticate_cognito {
      user_pool_arn              = aws_cognito_user_pool.pool.arn
      user_pool_client_id        = aws_cognito_user_pool_client.alb.id
      user_pool_domain           = aws_cognito_user_pool_domain.hosted_ui.domain
      session_timeout            = 43200
      on_unauthenticated_request = "authenticate"
    }
  }
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

resource "aws_lb_listener_rule" "bypass" {
  for_each = {
    health = { priority = 1, paths = ["/api/health"] }
    logout = { priority = 2, paths = ["/api/logout"] }
    tokens = { priority = 3, paths = ["/api/v1/*"] }
  }
  listener_arn = aws_lb_listener.https.arn
  priority     = each.value.priority
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
  condition {
    path_pattern {
      values = each.value.paths
    }
  }
}

resource "aws_lb_listener_rule" "sessions" {
  count        = local.has_domain ? 1 : 0
  listener_arn = aws_lb_listener.https.arn
  priority     = 5
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.gateway[0].arn
  }
  condition {
    host_header {
      values = ["*.apps.${local.domain}"]
    }
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.alb.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      protocol    = "HTTPS"
      port        = "443"
      status_code = "HTTP_301"
    }
  }
}
