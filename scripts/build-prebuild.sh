#!/usr/bin/env sh
# Builds one prebuilt binary into prebuilds/<platform>-<arch>/.
#
# Runs INSIDE a build container, not on the runner:
#   glibc  quay.io/pypa/manylinux_2_28_{x86_64,aarch64}  -> glibc 2.28 floor
#   musl   node:24-alpine                                -> musl
#
# Building in a pinned container rather than on the runner is what keeps the
# glibc floor stable while GitHub rolls its images forward.

set -eu

NODE_VERSION="${NODE_VERSION:-v24.19.0}"

# Alpine images ship without a compiler; manylinux ships without Node.
if command -v apk >/dev/null 2>&1; then
  apk add --no-cache build-base python3 >/dev/null
fi

if ! command -v node >/dev/null 2>&1; then
  case "$(uname -m)" in
    x86_64) node_arch=x64 ;;
    aarch64 | arm64) node_arch=arm64 ;;
    *) echo "build-prebuild: unsupported architecture $(uname -m)" >&2; exit 1 ;;
  esac
  archive="node-${NODE_VERSION}-linux-${node_arch}.tar.xz"
  curl -fsSLO "https://nodejs.org/dist/${NODE_VERSION}/${archive}"
  mkdir -p /opt/node
  tar xf "${archive}" -C /opt/node --strip-components=1
  rm -f "${archive}"
  PATH="/opt/node/bin:${PATH}"
  export PATH
fi

echo "build-prebuild: node $(node --version), $(uname -m), libc $(ldd --version 2>&1 | head -1)"

# The glibc and musl builds run one after the other over the same mounted
# workspace, so start from a known state rather than inheriting the previous
# container's tree (which it created as root).
rm -rf node_modules build

# --ignore-scripts so the install step does not build the addon a second time.
npm install --ignore-scripts --no-audit --no-fund

# Detects its own libc and puts ".glibc" or ".musl" in the filename. The loader
# reads that tag at require time and refuses a binary built for the other libc,
# so both can live in one prebuilds/linux-x64/ directory without an Alpine host
# ever loading the glibc build.
#
# Named make-prebuild, not prebuild: npm would treat a script called "prebuild"
# as the implicit pre-hook of "build" and run it on every npm run build.
npm run make-prebuild

# The build goes through build/ on the way to prebuilds/. Leaving it behind
# would shadow the prebuild, because the loader looks in build/ first -- and the
# point of the following jobs is to exercise what ships.
rm -rf build

find prebuilds -type f -exec ls -l {} +
