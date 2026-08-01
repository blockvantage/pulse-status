#!/usr/bin/env bash

set -euo pipefail

source_url="${1:-}"
destination="${2:-}"

if [ -z "$source_url" ] || [ -z "$destination" ]; then
  echo "usage: preserve-monitor-freshness.sh <source-url> <destination>" >&2
  exit 2
fi

case "$source_url" in
  https://raw.githubusercontent.com/*) ;;
  *) exit 0 ;;
esac

candidate="$(mktemp)"
trap 'rm -f "$candidate"' EXIT

if ! curl --fail --silent --show-error --location --max-time 10 \
  "${source_url}?run=${GITHUB_RUN_ID:-local}" \
  -o "$candidate"; then
  exit 0
fi

node - "$candidate" "$destination" <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const [source, destination] = process.argv.slice(2);
let payload;
try {
  payload = JSON.parse(readFileSync(source, "utf8"));
} catch {
  process.exit(0);
}

const canonicalUtcSeconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const checkedAt = payload && typeof payload.checkedAt === "string"
  ? payload.checkedAt
  : "";
if (!canonicalUtcSeconds.test(checkedAt)) process.exit(0);

const checkedAtMs = Date.parse(checkedAt);
if (
  !Number.isFinite(checkedAtMs) ||
  new Date(checkedAtMs).toISOString() !== checkedAt.replace("Z", ".000Z") ||
  checkedAtMs > Date.now()
) {
  process.exit(0);
}

writeFileSync(destination, `${JSON.stringify({ checkedAt })}\n`);
NODE
