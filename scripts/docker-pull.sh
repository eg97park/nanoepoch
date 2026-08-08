#!/bin/sh
# Pull a Docker image, retrying a bounded number of times.
#
# Every Linux build and install proof in this repository runs inside a pulled
# image, so a registry having a bad minute reads as a failed build. On
# 2026-08-08 a run died sixteen seconds in with
#
#   Get "https://quay.io/v2/": net/http: TLS handshake timeout
#
# before a compiler had run. On a pull request that costs a click. In
# release.yml the same pull sits between a pushed tag and eight uploaded
# binaries, where a flake aborts a release halfway through and the tag has to
# be deleted and pushed again.
#
# Bounded on purpose: three attempts, 15s then 30s. A registry still refusing
# after that is having an outage rather than a hiccup, and a job that keeps
# trying turns an outage into a six-hour runner bill instead of a red X that
# says what happened.
#
# Call it before `docker run` rather than relying on run's implicit pull: an
# image already in the local store is not fetched again, so the run inherits
# the retry without knowing about it.
#
# Usage: sh scripts/docker-pull.sh <image>

set -eu

image=${1:?usage: docker-pull.sh <image>}
attempts=${DOCKER_PULL_ATTEMPTS:-3}

attempt=1
while :; do
  # `if` suppresses errexit for the condition, so a failed pull reaches the
  # retry instead of ending the script.
  if docker pull "$image"; then
    exit 0
  fi

  if [ "$attempt" -ge "$attempts" ]; then
    echo "docker-pull: giving up on $image after $attempts attempts" >&2
    exit 1
  fi

  delay=$((attempt * 15))
  echo "docker-pull: $image failed (attempt $attempt/$attempts), retrying in ${delay}s" >&2
  sleep "$delay"
  attempt=$((attempt + 1))
done
