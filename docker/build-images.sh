#!/usr/bin/env bash
set -euo pipefail

cd /build/docker

export REGISTRY_HOST="${CI_REGISTRY_HOST:-builder-registry.builder.giscloud.ru}"
export OTEL_RESOURCE_ATTRIBUTES="service.name=docker-builder,pipeline.id=${CI_PIPELINE_ID:-local},project.name=${CI_PROJECT_NAME:-nats-synadia-dev}"

build-labels -n -c docker-compose.yml changed gitlab set_version to_dockerfiles to_compose | tee bake.yml

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
