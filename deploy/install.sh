#!/usr/bin/env bash
# Build and start a source checkout; importing an offline bundle is explicit.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
if [ "$#" -gt 1 ]; then
  echo 'Usage: bash deploy/install.sh [--load-image]' >&2
  exit 1
fi
mode=source
case "${1:-}" in
  '') ;;
  --load-image) mode=archive ;;
  -h|--help)
    printf '%s\n' 'Usage: bash deploy/install.sh [--load-image]' \
      'Default: build the complete application from the source checkout and start it.' \
      '--load-image: verify and import an optional offline bundle instead of building.'
    exit 0 ;;
  *) echo "Unknown option: $1" >&2; exit 1 ;;
esac
if [ "$mode" = source ]; then
  test -f ../Dockerfile && test -f ../pnpm-lock.yaml || {
    echo 'A complete source checkout is required. For an offline bundle, use bash install.sh --load-image.' >&2
    exit 1
  }
else
  test -f ocs-server-image.tar.gz && test -f SHA256SUMS || {
    echo 'The offline bundle must contain ocs-server-image.tar.gz and SHA256SUMS.' >&2
    exit 1
  }
fi
command -v docker >/dev/null || { echo 'Install Docker Engine and the Compose plugin first.' >&2; exit 1; }
docker compose version >/dev/null
docker info >/dev/null
if [ ! -f .env ]; then
  (umask 077; cp .env.example .env; chmod 600 .env)
fi
compose=(docker compose --project-directory "$PWD" --env-file "$PWD/.env" --file "$PWD/compose.yaml")
"${compose[@]}" config --quiet
if [ "$mode" = source ]; then
  # A failed build leaves the existing service running. Recreate only after success.
  "${compose[@]}" build --pull ocs
  documentation=../docs/deployment.md
else
  sha256sum --check SHA256SUMS
  docker load --input ocs-server-image.tar.gz
  documentation=DEPLOYMENT.md
fi
"${compose[@]}" up --detach --no-build --pull never --wait --wait-timeout 90
printf 'OCS is ready. See .env for settings and %s for login, backup and upgrades.\n' "$documentation"
