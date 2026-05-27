#!/bin/sh
set -eu

DEPLOY_CONTEXT_ENDPOINT="${DEPLOY_CONTEXT_ENDPOINT:-ssh://gis-master.ru}"

start_key_agent() {
  eval "$(ssh-agent -s)"
}

add_deploy_key() {
  chmod 600 /tmp/deploy_ssh_key
  ssh-add /tmp/deploy_ssh_key
  rm -f /tmp/deploy_ssh_key
}

load_b64_key() {
  variable_name="$1"
  variable_value="$2"

  echo "[deploy] loading SSH key from GitLab CI base64 variable ${variable_name}"
  start_key_agent
  printf '%s' "${variable_value}" | tr -d '\r\n ' | base64 -d > /tmp/deploy_ssh_key
  add_deploy_key
}

load_plain_key() {
  variable_name="$1"
  variable_value="$2"

  echo "[deploy] loading SSH key from GitLab CI variable ${variable_name}"
  start_key_agent
  printf '%s\n' "${variable_value}" | tr -d '\r' > /tmp/deploy_ssh_key
  add_deploy_key
}

if [ -n "${GIS_MASTER_SSH_PRIVATE_KEY_B64:-}" ]; then
  load_b64_key GIS_MASTER_SSH_PRIVATE_KEY_B64 "${GIS_MASTER_SSH_PRIVATE_KEY_B64}"
elif [ -n "${DEPLOY_SSH_PRIVATE_KEY_B64:-}" ]; then
  load_b64_key DEPLOY_SSH_PRIVATE_KEY_B64 "${DEPLOY_SSH_PRIVATE_KEY_B64}"
elif [ -n "${GIS_MASTER_SSH_PRIVATE_KEY:-}" ]; then
  load_plain_key GIS_MASTER_SSH_PRIVATE_KEY "${GIS_MASTER_SSH_PRIVATE_KEY}"
elif [ -n "${DEPLOY_SSH_PRIVATE_KEY:-}" ]; then
  load_plain_key DEPLOY_SSH_PRIVATE_KEY "${DEPLOY_SSH_PRIVATE_KEY}"
elif [ -n "${SSH_PRIVATE_KEY:-}" ]; then
  load_plain_key SSH_PRIVATE_KEY "${SSH_PRIVATE_KEY}"
elif [ -n "${CI_SSH_PRIVATE_KEY:-}" ]; then
  load_plain_key CI_SSH_PRIVATE_KEY "${CI_SSH_PRIVATE_KEY}"
elif [ -z "${SSH_AUTH_SOCK:-}" ]; then
  SSH_AUTH_SOCK="$(find /run/ssh-agent -type s 2>/dev/null | head -n 1 || true)"
  export SSH_AUTH_SOCK
fi

if [ -n "${SSH_AUTH_SOCK:-}" ]; then
  echo "[deploy] using SSH_AUTH_SOCK=${SSH_AUTH_SOCK}"
else
  echo "[deploy] SSH_AUTH_SOCK not found under /run/ssh-agent"
  echo "[deploy] add GitLab CI variable GIS_MASTER_SSH_PRIVATE_KEY_B64 or restore runner ssh-agent-socket identities"
  exit 1
fi

if ! ssh-add -l; then
  echo "[deploy] no SSH identity is available for dry-stack"
  echo "[deploy] add GitLab CI variable GIS_MASTER_SSH_PRIVATE_KEY_B64 or restore runner ssh-agent-socket identities"
  exit 1
fi

REGISTRY_HOST="${REGISTRY_HOST:-builder-registry.builder.giscloud.ru}"
REGISTRY_USER="${REGISTRY_USER:-${GHCR_USER:-}}"
REGISTRY_PASSWORD="${REGISTRY_PASSWORD:-${GHCR_TOKEN:-}}"
if [ -n "${REGISTRY_USER}" ] && [ -n "${REGISTRY_PASSWORD}" ]; then
  printf '%s' "${REGISTRY_PASSWORD}" | docker login "${REGISTRY_HOST}" -u "${REGISTRY_USER}" --password-stdin >/dev/null || true
fi

if [ "${DEPLOY_LOCAL_IMAGE:-false}" = "true" ]; then
  APP_IMAGE="${APP_IMAGE:-nats-synadia-dev:${CI_COMMIT_SHORT_SHA:-local}}"
  export APP_IMAGE
  echo "[deploy] building local app image ${APP_IMAGE}"
  docker build -f /build/docker/Dockerfile -t "${APP_IMAGE}" /build
  echo "[deploy] loading ${APP_IMAGE} into ${DEPLOY_CONTEXT_ENDPOINT}"
  docker save "${APP_IMAGE}" | docker -H "${DEPLOY_CONTEXT_ENDPOINT}" load
fi

ensure_external_overlay_network() {
  network_name="$1"
  if [ -z "${network_name}" ]; then
    return 0
  fi

  if docker -H "${DEPLOY_CONTEXT_ENDPOINT}" network inspect "${network_name}" >/dev/null 2>&1; then
    echo "[deploy] external network ${network_name} already exists"
    return 0
  fi

  echo "[deploy] creating external overlay network ${network_name}"
  docker -H "${DEPLOY_CONTEXT_ENDPOINT}" network create --driver overlay --attachable "${network_name}" >/dev/null
}

ensure_external_overlay_network "${YOUTRACK_MCP_EXTERNAL_NETWORK:-}"

i=0
until [ "$i" -ge 5 ]; do
  echo "[deploy] dry-stack endpoint ${DEPLOY_CONTEXT_ENDPOINT} (attempt $((i + 1))/5)"
  if cat nats-synadia-dev.drs | dry-stack swarm_deploy --tls-domain=gis-master.ru -x "${DEPLOY_CONTEXT_ENDPOINT}" -- --prune --with-registry-auth --resolve-image never; then
    exit 0
  fi

  i=$((i + 1))
  echo "[deploy] dry-stack failed (attempt ${i}/5), retry in 5s"
  sleep 5
done

echo "[deploy] dry-stack failed after retries"
exit 1
