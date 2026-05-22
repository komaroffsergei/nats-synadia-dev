#!/usr/bin/env bash
set -euo pipefail

cd /build/docker

export REGISTRY_HOST="${CI_REGISTRY_HOST:-builder-registry.builder.giscloud.ru}"
export OTEL_RESOURCE_ATTRIBUTES="service.name=docker-builder,pipeline.id=${CI_PIPELINE_ID:-local},project.name=${CI_PROJECT_NAME:-nats-synadia-dev}"
export CI_PIPELINE_IID="${CI_PIPELINE_IID:-${CI_PIPELINE_ID:-0}}"
export BUILDX_BAKE_ENTITLEMENTS_FS="${BUILDX_BAKE_ENTITLEMENTS_FS:-0}"

# `changed` ускоряет CI, но ему нужна .git history внутри build container.
# Если GitLab отдал shallow checkout без нужного before SHA, не валим pipeline:
# fallback строит targets из docker-compose.yml целиком. Для этого маленького
# проекта один image, поэтому full fallback дешевле, чем ручной перезапуск.
if ! build-labels -n -c docker-compose.yml changed gitlab set_version to_dockerfiles to_compose | tee bake.yml; then
  echo "[build] changed target detection failed; falling back to full build-labels plan"
  build-labels -n -c docker-compose.yml gitlab set_version to_dockerfiles to_compose | tee bake.yml
fi

push_args=()
if [ -z "${CI_SKIP_PUSH:-}" ]; then
  push_args+=(--push)
fi

has_build_targets() {
  ruby -r yaml -e '
    bake = YAML.load_file("bake.yml") || {}
    services = bake.fetch("services", {})
    exit(services.empty? ? 1 : 0)
  '
}

if ! has_build_targets; then
  echo "[build] no changed Docker targets"
  exit 0
fi

docker buildx bake -f bake.yml "${push_args[@]}"
