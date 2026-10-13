#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
corepack pnpm install --frozen-lockfile
if [ "$#" -gt 0 ]; then
  corepack pnpm build:components "$@"
fi
corepack pnpm build:bundle
