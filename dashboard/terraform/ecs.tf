# ECS Fargate: web (browser API), controller (workflow worker, Cloud Map name "controller") and
# gateway (session transport) — mirror of constructs/service.ts.

resource "aws_cloudwatch_log_group" "ecs" {
  name              = "/aws/ecs/${local.prefix}"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_cluster" "cluster" {
  name = local.prefix
  setting {
    name  = "containerInsights"
    value = "enhanced"
  }
}

resource "aws_service_discovery_private_dns_namespace" "internal" {
  name = local.cloudmap_namespace
  vpc  = local.vpc_id
}

resource "aws_service_discovery_service" "controller" {
  name = "controller"
  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.internal.id
    routing_policy = "MULTIVALUE"
    dns_records {
      ttl  = 60
      type = "A"
    }
  }
  health_check_custom_config {}
}

locals {
  health_check = { web = 3000, controller = 3001, gateway = 3002 }
  health_path  = { web = "/api/health", controller = "/health", gateway = "/health" }
  env_list = {
    web        = [for k, v in local.web_env : { name = k, value = v }]
    controller = [for k, v in local.controller_env : { name = k, value = v }]
    gateway    = [for k, v in local.gateway_env : { name = k, value = v }]
  }
}

resource "aws_ecs_task_definition" "web" {
  family                   = "${local.prefix}-web"
  cpu                      = tostring(var.web_cpu)
  memory                   = tostring(var.web_memory_mib)
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  task_role_arn            = aws_iam_role.web.arn
  execution_role_arn       = aws_iam_role.execution["web"].arn
  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }
  container_definitions = jsonencode([{
    name         = "web"
    image        = local.image_uris["web"]
    essential    = true
    environment  = local.env_list.web
    portMappings = [{ containerPort = 3000, protocol = "tcp" }]
    stopTimeout  = 30
    healthCheck = {
      command     = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }
    logConfiguration = {
      logDriver = "awslogs"
      options   = { "awslogs-group" = aws_cloudwatch_log_group.ecs.name, "awslogs-region" = var.region, "awslogs-stream-prefix" = "web" }
    }
  }])
}

resource "aws_ecs_task_definition" "controller" {
  family                   = "${local.prefix}-controller"
  cpu                      = tostring(var.controller_cpu)
  memory                   = tostring(var.controller_memory_mib)
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  task_role_arn            = aws_iam_role.controller.arn
  execution_role_arn       = aws_iam_role.execution["controller"].arn
  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }
  container_definitions = jsonencode([{
    name         = "controller"
    image        = local.image_uris["web"]
    command      = ["node", "/app/services/controller.cjs"]
    essential    = true
    environment  = local.env_list.controller
    secrets      = [{ name = "RUNTIME_SIGNING_KEY", valueFrom = "${aws_secretsmanager_secret.runtime_signing.arn}:key::" }]
    portMappings = [{ containerPort = 3001, protocol = "tcp" }]
    stopTimeout  = 90
    healthCheck = {
      command     = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }
    logConfiguration = {
      logDriver = "awslogs"
      options   = { "awslogs-group" = aws_cloudwatch_log_group.ecs.name, "awslogs-region" = var.region, "awslogs-stream-prefix" = "controller" }
    }
  }])
}

resource "aws_ecs_task_definition" "gateway" {
  count                    = local.has_domain ? 1 : 0
  family                   = "${local.prefix}-gateway"
  cpu                      = tostring(var.gateway_cpu)
  memory                   = tostring(var.gateway_memory_mib)
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  task_role_arn            = aws_iam_role.gateway.arn
  execution_role_arn       = aws_iam_role.execution["gateway"].arn
  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }
  container_definitions = jsonencode([{
    name         = "gateway"
    image        = local.image_uris["web"]
    command      = ["node", "/app/services/gateway.cjs"]
    essential    = true
    environment  = local.env_list.gateway
    portMappings = [{ containerPort = 3002, protocol = "tcp" }]
    healthCheck = {
      command     = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:3002/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }
    logConfiguration = {
      logDriver = "awslogs"
      options   = { "awslogs-group" = aws_cloudwatch_log_group.ecs.name, "awslogs-region" = var.region, "awslogs-stream-prefix" = "gateway" }
    }
  }])
}

resource "aws_ecs_service" "web" {
  name                               = "${local.prefix}-web"
  cluster                            = aws_ecs_cluster.cluster.id
  task_definition                    = aws_ecs_task_definition.web.arn
  desired_count                      = 1
  launch_type                        = "FARGATE"
  enable_execute_command             = true
  health_check_grace_period_seconds  = 90
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  network_configuration {
    subnets          = local.private_subnet_ids
    security_groups  = [aws_security_group.service.id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 3000
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  depends_on = [aws_lb_listener.https, aws_eks_access_entry.services]
}

resource "aws_ecs_service" "controller" {
  name                               = "${local.prefix}-controller"
  cluster                            = aws_ecs_cluster.cluster.id
  task_definition                    = aws_ecs_task_definition.controller.arn
  desired_count                      = 1
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  network_configuration {
    subnets          = local.private_subnet_ids
    security_groups  = [aws_security_group.service.id]
    assign_public_ip = false
  }
  service_registries {
    registry_arn = aws_service_discovery_service.controller.arn
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  depends_on = [aws_ecs_service.web, aws_eks_access_entry.services]
}

resource "aws_ecs_service" "gateway" {
  count                              = local.has_domain ? 1 : 0
  name                               = "${local.prefix}-gateway"
  cluster                            = aws_ecs_cluster.cluster.id
  task_definition                    = aws_ecs_task_definition.gateway[0].arn
  desired_count                      = 1
  launch_type                        = "FARGATE"
  health_check_grace_period_seconds  = 60
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  network_configuration {
    subnets          = local.private_subnet_ids
    security_groups  = [aws_security_group.service.id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.gateway[0].arn
    container_name   = "gateway"
    container_port   = 3002
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  depends_on = [aws_lb_listener_rule.sessions, aws_eks_access_entry.services]
}
