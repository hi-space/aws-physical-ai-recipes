# Container images. The CDK stack publishes them as image assets; here every image gets its own ECR
# repository and is built with the local Docker daemon (BuildKit, linux/amd64) and pushed under a tag
# equal to the content hash of its build context, so unchanged sources never rebuild and image
# profiles keep matching. Any image can be replaced with `image_overrides` (bring your own URI).

locals {
  repo_root = abspath("${path.module}/../..")

  # Contexts with a plain Dockerfile at their root (web honors its .dockerignore).
  simple_images = {
    web       = { context = "${local.repo_root}/dashboard/web", dockerfile = "Dockerfile", exclude = "node_modules,.next,.git,dist,*.tsbuildinfo,next-env.d.ts,.env,.env.local,.results,e2e,playwright-report,test-results" }
    runtime   = { context = "${local.repo_root}/dashboard/runtime", dockerfile = "Dockerfile", exclude = "pai-runtime,pai-runtime-arm64" }
    workspace = { context = "${local.repo_root}/dashboard/session-image", dockerfile = "Dockerfile", exclude = "__pycache__" }
  }
  workload_names = concat(["mujoco", "isaaclab", "ros2"], var.extended_images ? ["groot", "openpi"] : [])
  workload_images = { for name in local.workload_names : name => {
    context    = data.external.workload_context.result.context
    dockerfile = "dashboard/images/${name}/Dockerfile"
    exclude    = ""
  } }
  all_images   = merge(local.simple_images, local.workload_images)
  build_images = { for name, spec in local.all_images : name => spec if !contains(keys(var.image_overrides), name) }
}

# Narrow workload context staged at plan time (see scripts/stage_workload_context.py).
data "external" "workload_context" {
  program = ["python3", "${path.module}/scripts/stage_workload_context.py"]
  query = {
    repository_root = local.repo_root
    output_dir      = "${path.module}/.context/workload"
  }
}

data "external" "context_hash" {
  for_each = local.simple_images
  program  = ["python3", "${path.module}/scripts/tree_hash.py"]
  query = {
    directory = each.value.context
    exclude   = each.value.exclude
  }
}

locals {
  image_hashes = merge(
    { for name in keys(local.simple_images) : name => data.external.context_hash[name].result.hash },
    { for name in local.workload_names : name => data.external.workload_context.result.hash },
  )
  image_tags = { for name, hash in local.image_hashes : name => substr(hash, 0, 40) }
}

resource "aws_ecr_repository" "images" {
  for_each             = local.build_images
  name                 = "${local.prefix}/${each.key}"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
  image_scanning_configuration {
    scan_on_push = false
  }
}

resource "terraform_data" "image_build" {
  for_each         = local.build_images
  triggers_replace = [local.image_hashes[each.key], aws_ecr_repository.images[each.key].repository_url]

  provisioner "local-exec" {
    interpreter = ["bash", "-c"]
    command     = "bash ${path.module}/scripts/build_push_image.sh"
    environment = {
      AWS_REGION  = var.region
      CONTEXT     = each.value.context
      DOCKERFILE  = each.value.dockerfile
      REPOSITORY  = aws_ecr_repository.images[each.key].repository_url
      TAG         = local.image_tags[each.key]
      IMAGE_LABEL = each.key
    }
  }
}

data "aws_ecr_image" "built" {
  for_each        = local.build_images
  repository_name = aws_ecr_repository.images[each.key].name
  image_tag       = local.image_tags[each.key]
  depends_on      = [terraform_data.image_build]
}

locals {
  image_uris = merge(
    { for name in keys(local.build_images) : name => "${aws_ecr_repository.images[name].repository_url}:${local.image_tags[name]}" },
    var.image_overrides,
  )
  workload_image_env = merge(
    {
      MUJOCO_IMAGE_URI    = local.image_uris["mujoco"]
      ISAACLAB_IMAGE_URI  = local.image_uris["isaaclab"]
      ROS2_IMAGE_URI      = local.image_uris["ros2"]
      WORKSPACE_IMAGE_URI = local.image_uris["workspace"]
    },
    var.extended_images ? {
      GROOT_RUNTIME_IMAGE_URI = local.image_uris["groot"]
      OPENPI_IMAGE_URI        = local.image_uris["openpi"]
    } : {},
  )
}
