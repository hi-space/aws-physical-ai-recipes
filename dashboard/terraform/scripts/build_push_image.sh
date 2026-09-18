#!/usr/bin/env bash
# Build one image with BuildKit for linux/amd64 and push it to ECR under its content-hash tag.
# Idempotent: when the tag already exists in the repository the build is skipped entirely.
# Env: AWS_REGION CONTEXT DOCKERFILE REPOSITORY TAG IMAGE_LABEL
set -euo pipefail
: "${AWS_REGION:?}" "${CONTEXT:?}" "${DOCKERFILE:?}" "${REPOSITORY:?}" "${TAG:?}"
registry="${REPOSITORY%%/*}"
repository_name="${REPOSITORY#*/}"

if aws ecr describe-images --region "$AWS_REGION" --repository-name "$repository_name" --image-ids "imageTag=$TAG" >/dev/null 2>&1; then
  echo "[images] ${IMAGE_LABEL:-image} ${TAG} already published; skipping build" >&2
  exit 0
fi

aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$registry" >/dev/null
echo "[images] building ${IMAGE_LABEL:-image} from ${CONTEXT} (${DOCKERFILE})" >&2
DOCKER_BUILDKIT=1 docker build --platform linux/amd64 --provenance=false --sbom=false \
  -f "${CONTEXT}/${DOCKERFILE}" -t "${REPOSITORY}:${TAG}" "$CONTEXT" >&2
docker push "${REPOSITORY}:${TAG}" >&2
echo "[images] pushed ${REPOSITORY}:${TAG}" >&2
