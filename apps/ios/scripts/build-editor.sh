#!/bin/sh
# Builds the shared formatted editor (packages/editor) into the app's bundled, offline-only editor assets.
set -eu
here="$(cd "$(dirname "$0")/.." && pwd)"
node "$here/../../packages/editor/build.mjs" "$here/EnveMemory/Resources/Editor"
