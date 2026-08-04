#!/usr/bin/env bash
# Drives the backward-clock-step proof (scripts/clock-step/step.mjs).
#
# Stopping the time daemons first is not optional. `timedatectl set-ntp false`
# only covers systemd-timesyncd, and GitHub-hosted Ubuntu runners are Azure VMs
# that typically run chronyd against the host's PTP clock with a makestep policy
# aggressive enough to undo the injected offset mid-test.
#
# Intended for a disposable VM or container. It changes the system clock.

set -euo pipefail

cd "$(dirname "$0")/../.."

if [ "$(uname -s)" != "Linux" ]; then
  echo "clock-step: only implemented for Linux, found $(uname -s)" >&2
  exit 1
fi

if ! sudo -n true 2>/dev/null; then
  echo "clock-step: needs passwordless sudo to set the system clock" >&2
  exit 1
fi

DAEMONS="chrony chronyd systemd-timesyncd ntp ntpsec openntpd"
STOPPED=""

# Capture whether NTP was on, so a host that deliberately keeps it off is left
# that way rather than "restored" into a state it never had.
NTP_WAS=$(timedatectl show -p NTP --value 2>/dev/null || echo unknown)

echo "--- time synchronisation before ---"
timedatectl show 2>/dev/null || true
if command -v chronyc >/dev/null 2>&1; then sudo -n chronyc tracking 2>/dev/null || true; fi

# Reference pair for restoring the clock ourselves. /proc/uptime is monotonic
# and survives whatever happens to the wall clock in between, so the expected
# time can always be recomputed -- including when the test process is killed
# between the step and its own cleanup.
REF_REAL=$(date +%s.%N)
REF_MONO=$(cut -d' ' -f1 /proc/uptime)

restore () {
  local status=$?
  echo "--- restoring the clock ---"

  local now_mono expected drift
  now_mono=$(cut -d' ' -f1 /proc/uptime)
  expected=$(awk -v r="$REF_REAL" -v a="$REF_MONO" -v b="$now_mono" 'BEGIN{printf "%.6f", r + (b - a)}')
  drift=$(awk -v e="$expected" -v n="$(date +%s.%N)" 'BEGIN{d=n-e; if (d<0) d=-d; printf "%.3f", d}')

  # Only correct a real discrepancy: if the test cleaned up after itself, this
  # must not nudge the clock again.
  if awk -v d="$drift" 'BEGIN{exit !(d > 1.0)}'; then
    echo "clock is off by ${drift}s, setting it to @${expected}"
    sudo -n date -s "@${expected}" >/dev/null || true
  else
    echo "clock is within ${drift}s of expected, leaving it alone"
  fi

  echo "--- restoring time synchronisation ---"
  for unit in $STOPPED; do
    echo "restarting $unit"
    sudo -n systemctl start "$unit" 2>/dev/null || true
  done
  if [ "$NTP_WAS" = "yes" ]; then
    sudo -n timedatectl set-ntp true 2>/dev/null || true
  fi
  if command -v chronyc >/dev/null 2>&1; then sudo -n chronyc makestep 2>/dev/null || true; fi

  timedatectl show 2>/dev/null || true
  return $status
}
trap restore EXIT

echo "--- stopping time daemons ---"
sudo -n timedatectl set-ntp false 2>/dev/null || true
for unit in $DAEMONS; do
  if systemctl is-active --quiet "$unit" 2>/dev/null; then
    echo "stopping $unit"
    sudo -n systemctl stop "$unit" 2>/dev/null && STOPPED="$STOPPED $unit"
  fi
done

for unit in $DAEMONS; do
  if systemctl is-active --quiet "$unit" 2>/dev/null; then
    echo "clock-step: $unit is still running and would fight the injected step" >&2
    exit 1
  fi
done
echo "no time daemon is active"

echo "--- running the step proof ---"
# Explicit path: step.mjs is deliberately outside the default test glob so it
# can never run alongside the tests whose clock it would disturb.
NANOEPOCH_CLOCK_STEP=1 node --test scripts/clock-step/step.mjs
