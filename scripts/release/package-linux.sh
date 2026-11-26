#!/usr/bin/env bash
# Build a Linux x64 tarball: bundled Core + upstream adapter, Web panel, config
# example, systemd unit and docs. Requires Node >= 22.16 and pnpm on the build host.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "${root}"

version=$(node -p "require('./package.json').version")
stage_rel="release-linux/lodestar-${version}-linux-x64"
stage="${root}/${stage_rel}"
archive="${root}/lodestar-${version}-linux-x64.tar.gz"

rm -rf "${root}/release-linux"
mkdir -p "${stage}/config" "${stage}/data" "${stage}/web"

echo "Building packages..."
pnpm build

echo "Bundling external runtime..."
pnpm exec esbuild scripts/upstream.mjs \
  --bundle --platform=node --format=cjs --target=node22 \
  --outfile="${stage_rel}/lodestar.cjs" --log-level=warning \
  --log-override:empty-import-meta=silent

cp -r packages/web/dist/. "${stage}/web/"
cp docs/linux.md "${stage}/README.md"
cp deploy/lodestar.service.example "${stage}/lodestar.service.example"
cp LICENSE "${stage}/LICENSE"

node -e "
const fs = require('fs');
const path = '${stage_rel}/config/upstream.example.json';
const cfg = JSON.parse(fs.readFileSync('config/upstream.example.json', 'utf8'));
cfg.admin.webRoot = 'web';
fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
"

tar -C "${root}/release-linux" -czf "${archive}" "lodestar-${version}-linux-x64"
rm -rf "${root}/release-linux"

echo ""
echo "Linux package ready:"
echo "  ${archive}"
if command -v sha256sum >/dev/null 2>&1; then
  echo "  $(sha256sum "${archive}" | cut -d' ' -f1)  ${archive##*/}"
fi
