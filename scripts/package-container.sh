#!/usr/bin/env bash
# Optional local export after a source build. No release service is required.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
image="${1:-ocs-server-headless:local}"
[[ "$image" =~ ^[a-zA-Z0-9._:/@-]+$ ]] || { echo 'Invalid image name.' >&2; exit 1; }
architecture=$(docker image inspect --format '{{.Architecture}}' "$image")
revision="${GITHUB_SHA:-local}"
[[ "$revision" =~ ^[a-f0-9]{40}$|^local$ ]] || { echo 'Invalid revision.' >&2; exit 1; }
bundle=$(mktemp -d)
trap 'rm -rf -- "$bundle"' EXIT
cp deploy/install.sh deploy/.env.example deploy/seccomp-chromium.json deploy/NOTICE deploy/PLAYWRIGHT-LICENSE "$bundle/"
cp docs/offline-deployment.md "$bundle/DEPLOYMENT.md"
sed "s|ocs-server-headless:local|$image|" deploy/compose.yaml > "$bundle/compose.yaml"
docker save "$image" | gzip > "$bundle/ocs-server-image.tar.gz"
(cd "$bundle"; sha256sum install.sh .env.example seccomp-chromium.json NOTICE PLAYWRIGHT-LICENSE DEPLOYMENT.md compose.yaml ocs-server-image.tar.gz > SHA256SUMS)
mkdir -p releases
archive="releases/ocs-server-linux-${architecture}-${revision}.tar.gz"
# The image is already compressed; avoid recompressing the large archive.
tar -cf - -C "$bundle" . | gzip --fast > "$archive"
printf 'Release bundle: %s\n' "$archive"
