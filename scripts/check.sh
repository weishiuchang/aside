#!/bin/sh
# Type check against the pi install that loads this extension (no local node_modules needed).
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
agent_dir=${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}
modules="$agent_dir/install/releases/$(cat "$agent_dir/install/current-version")/node_modules"
[ -d "$modules/@earendil-works" ] || { echo "pi install not found at $modules" >&2; exit 1; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/tsconfig.json" <<JSON
{
	"extends": "$root/tsconfig.json",
	"compilerOptions": {
		"typeRoots": ["$modules/@types"],
		"paths": { "@earendil-works/*": ["$modules/@earendil-works/*/dist/index.d.ts"] }
	},
	"include": ["$root/index.ts", "$root/src/**/*.ts"]
}
JSON
npx -y -p typescript@5 tsc -p "$tmp/tsconfig.json"
