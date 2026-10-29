#!/usr/bin/env bash
# Install Linux/macOS user-local tooling and the headless workspace. Never invokes sudo.
set -euo pipefail

NODE_VERSION=v22.22.0
PNPM_VERSION=10.21.0
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS_DIR="${XDG_DATA_HOME:-${HOME}/.local/share}/ocs-server"
NODE_DIR="${TOOLS_DIR}/node-${NODE_VERSION}"
PNPM_DIR="${TOOLS_DIR}/pnpm-${PNPM_VERSION}"
WITH_BROWSER=0

log() { printf '[setup] %s\n' "$*"; }
fail() { printf '[setup] %s\n' "$*" >&2; exit 1; }
for argument in "$@"; do
	case "$argument" in
		--with-browser) WITH_BROWSER=1 ;;
		*) fail "Unknown option: ${argument}. Supported: --with-browser" ;;
	esac
done

case "$(uname -s)" in
	Linux) NODE_OS=linux ;;
	Darwin) NODE_OS=darwin ;;
	*) fail 'Run this script inside WSL or Linux/macOS; Windows users can run scripts/setup.ps1.' ;;
esac
if [ "$NODE_OS" = linux ] && ! command -v flock >/dev/null 2>&1; then
	fail 'Linux runtime requires flock (util-linux). Install it with the OS package manager or use the container deployment bundle.'
fi
case "$(uname -m)" in
	x86_64|amd64) NODE_ARCH=x64 ;;
	aarch64|arm64) NODE_ARCH=arm64 ;;
	*) fail 'Only x64 and arm64 are supported by this installer.' ;;
esac

if [ -x "${NODE_DIR}/bin/node" ]; then export PATH="${NODE_DIR}/bin:${PATH}"; fi
if ! command -v node >/dev/null 2>&1 || ! node -e "if (+process.versions.node.split('.')[0] < 22 || process.platform !== '${NODE_OS}') process.exit(1)"; then
	command -v curl >/dev/null 2>&1 || fail 'curl is required to download Node.js.'
	command -v tar >/dev/null 2>&1 || fail 'tar is required to unpack Node.js.'
	ARCHIVE="node-${NODE_VERSION}-${NODE_OS}-${NODE_ARCH}.tar.gz"
	DOWNLOAD_DIR="$(mktemp -d)"
	trap 'rm -f -- "${DOWNLOAD_DIR}/${ARCHIVE}" "${DOWNLOAD_DIR}/SHASUMS256.txt" "${DOWNLOAD_DIR}/checksum"; rmdir -- "$DOWNLOAD_DIR" 2>/dev/null || true' EXIT
	log "Downloading official Node.js ${NODE_VERSION} (${NODE_OS}-${NODE_ARCH})"
	curl --fail --location --retry 3 "https://nodejs.org/dist/${NODE_VERSION}/${ARCHIVE}" -o "${DOWNLOAD_DIR}/${ARCHIVE}"
	curl --fail --location --retry 3 "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt" -o "${DOWNLOAD_DIR}/SHASUMS256.txt"
	awk -v archive="$ARCHIVE" '$2 == archive {print}' "${DOWNLOAD_DIR}/SHASUMS256.txt" > "${DOWNLOAD_DIR}/checksum"
	[ -s "${DOWNLOAD_DIR}/checksum" ] || fail 'Official checksum does not contain the requested archive.'
	if command -v sha256sum >/dev/null 2>&1; then
		(cd "$DOWNLOAD_DIR" && sha256sum --check checksum)
	elif command -v shasum >/dev/null 2>&1; then
		(cd "$DOWNLOAD_DIR" && shasum --algorithm 256 --check checksum)
	else
		fail 'sha256sum or shasum is required to verify Node.js.'
	fi
	mkdir -p "$NODE_DIR"
	tar -xzf "${DOWNLOAD_DIR}/${ARCHIVE}" --strip-components=1 -C "$NODE_DIR"
	export PATH="${NODE_DIR}/bin:${PATH}"
fi
node -e "if (+process.versions.node.split('.')[0] < 22 || process.platform !== '${NODE_OS}') process.exit(1)" || fail 'A native Node.js >=22 is required.'
log "Using $(node --version) ($(node -p process.platform))"

# A project-specific prefix avoids changing global npm packages or Corepack shims.
if [ ! -f "${PNPM_DIR}/node_modules/pnpm/bin/pnpm.cjs" ]; then
	log "Installing user-local pnpm ${PNPM_VERSION}"
	npm install --prefix "$PNPM_DIR" --no-package-lock --no-audit --no-fund --ignore-scripts "pnpm@${PNPM_VERSION}"
fi
export PATH="${PNPM_DIR}/node_modules/.bin:${PATH}"
mkdir -p "$TOOLS_DIR"
printf 'export PATH=%q:%q:"$PATH"\n' "${NODE_DIR}/bin" "${PNPM_DIR}/node_modules/.bin" > "${TOOLS_DIR}/env.sh"

cd "$PROJECT_DIR"
node "${PNPM_DIR}/node_modules/pnpm/bin/pnpm.cjs" install --frozen-lockfile
node "${PNPM_DIR}/node_modules/pnpm/bin/pnpm.cjs" build
node "${PNPM_DIR}/node_modules/pnpm/bin/pnpm.cjs" build:web
if [ "$WITH_BROWSER" -eq 1 ]; then
	# This downloads browser binaries only. OS shared libraries remain an administrator task.
	node "${PNPM_DIR}/node_modules/pnpm/bin/pnpm.cjs" browser:install
fi
log 'Headless backend and web console are built. No Electron or desktop session is needed.'
log "Load tooling into your shell: source \"${TOOLS_DIR}/env.sh\""
log 'Next: pnpm browser:install (unless --with-browser was used), then pnpm start.'
