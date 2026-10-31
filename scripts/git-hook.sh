#!/bin/sh
set -eu

fail() { printf 'OCS Git hook: %s\n' "$*" >&2; exit 1; }

hook=${1:-}
shift || true
case "$hook" in
	pre-push) ;;
	commit-msg) [ "$#" -eq 1 ] || fail 'Missing commit message file.' ;;
	*) fail 'Expected pre-push or commit-msg.' ;;
esac

repository_dir=$(cd -- "$(dirname -- "$0")/.." && pwd -P)
cd -- "$repository_dir"

case "$(uname -s)" in
	MINGW*|MSYS*|CYGWIN*)
		# GitHub Desktop has its own PATH. Use the same Linux dependencies as setup.ps1.
		command -v wsl.exe >/dev/null 2>&1 || fail 'WSL is required; run scripts/setup.ps1 first.'
		distribution=$(git config --get ocs.hooksWslDistribution || true)
		wsl_run() {
			if [ -n "$distribution" ]; then
				exec env MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' wsl.exe --distribution "$distribution" "$@"
			else
				exec env MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' wsl.exe "$@"
			fi
		}
		linux_path() {
			# Desktop's bundled Git provides pwd -W, but omits cygpath and bash.
			windows_path=$(cd -- "$(dirname -- "$1")" && printf '%s/%s' "$(pwd -W)" "$(basename -- "$1")") || return
			# Prevent MSYS from converting Linux arguments back into Windows paths.
			converted_path=$(wsl_run --exec wslpath -a "$windows_path") || return
			printf '%s' "$converted_path" | tr -d '\r'
		}
		linux_repository=$(linux_path "$repository_dir") || fail 'Cannot open the repository in WSL; check the default distribution.'
		[ -n "$linux_repository" ] || fail 'WSL returned an empty repository path.'
		if [ "$hook" = commit-msg ]; then
			linux_message=$(linux_path "$1") || fail 'Cannot resolve the commit message file in WSL.'
			set -- "$linux_message"
		fi
		wsl_run --cd "$linux_repository" --exec bash ./scripts/git-hook.sh "$hook" "$@"
		;;
esac

# setup.sh generates Bash-compatible quoting for paths, including spaces.
if [ -z "${BASH_VERSION:-}" ]; then exec bash "$repository_dir/scripts/git-hook.sh" "$hook" "$@"; fi

# setup.sh writes a lightweight toolchain loader; GUI hooks do not source shell rc files.
tooling_env="${XDG_DATA_HOME:-${HOME}/.local/share}/ocs-server/env.sh"
if [ -f "$tooling_env" ]; then . "$tooling_env"; fi
command -v node >/dev/null 2>&1 || fail 'Node.js is missing; run bash scripts/setup.sh in WSL.'
command -v pnpm >/dev/null 2>&1 || fail 'pnpm is missing; run bash scripts/setup.sh in WSL.'
node -e 'if (process.platform === "win32" || Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' \
	|| fail 'Native Node.js >=22 is required; run bash scripts/setup.sh in WSL.'

case "$hook" in
	pre-push)
		pnpm lint
		pnpm typecheck
		pnpm typecheck:web
		;;
	commit-msg)
		pnpm exec commitlint --edit "$1"
		;;
esac
