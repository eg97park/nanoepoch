# nanoepoch

Current wall-clock time as integer nanoseconds since the Unix epoch, read from
the OS realtime clock on **every** call.

```js
const { now } = require('nanoepoch')

now() // => 1785864546913306300n
```

## Why this exists

Every other nanosecond-timestamp package for Node works the same way: it reads
the wall clock once, then adds elapsed monotonic time to that anchor forever.

```js
// what nano-time, nanotime and friends do
const anchor = BigInt(Date.now()) * 1_000_000n - process.hrtime.bigint()
const now = () => anchor + process.hrtime.bigint()
```

That is not the current time. It is one old timestamp plus a stopwatch reading,
and it stops being the current time the moment anything adjusts the system
clock: an NTP step, a VM resuming from a snapshot, an administrator running
`date -s`. The anchored clock does not notice, and keeps returning confident,
precise, wrong values.

`scripts/clock-step/run.sh` steps the system clock back five seconds and asks both
techniques what happened:

```
system clock stepped back 5s
nanoepoch.now()  delta -4.993s  <- followed the step
anchored clock   delta  0.007s  <- missed the step entirely
anchored clock is now 4.999s ahead of the true time
```

nanoepoch calls `clock_gettime(CLOCK_REALTIME)` on Linux and
`GetSystemTimePreciseAsFileTime()` on Windows, once per call, with no anchor and
no cached base instant anywhere in the code. That costs about as much as
`Date.now()` — sometimes less (see [Performance](#performance)).

## Install

```sh
npm install nanoepoch
```

Prebuilt binaries ship inside the npm tarball for every supported platform, so
no compiler, Python, or `node-gyp` is required.

**Nothing runs at install time.** There is no install, preinstall, or
postinstall script, and the tarball deliberately ships no `binding.gyp` — npm
compiles a package that carries one even when it declares no script at all.
Nothing is downloaded, nothing is compiled, and nothing is executed; the right
binary is selected when you `require` the package. That is what makes this work
offline, behind a firewall, and under `--ignore-scripts`.

## Usage

```js
// CommonJS
const { now, nowMicros, nowInto } = require('nanoepoch')

// ESM
import { now, nowMicros, nowInto } from 'nanoepoch'
```

```js
now()                        // 1785864546913306300n  (bigint, nanoseconds)
nowMicros()                  // 1785864546913415     (number, microseconds)

const stamps = new BigInt64Array(1024)
nowInto(stamps, 7)           // writes into stamps[7], allocates nothing
```

## API

### `now(): bigint`

Nanoseconds since the Unix epoch. This is the primary API.

### `nowMicros(): number`

Microseconds since the Unix epoch, as an ordinary number, for callers who want
plain arithmetic and JSON. Every microsecond value is an exact double until
`2255-06-05T23:47:34.740991Z`; after that it throws rather than lose precision.

### `nowInto(target: BigInt64Array | BigUint64Array, index = 0): void`

Writes nanoseconds into `target[index]`.

This is **not** faster than `now()` — it costs 10–30ns more per call, because it
has to find and bounds-check your array every time. What it does is allocate
nothing, so a hot tracing loop can record millions of timestamps into one
preallocated buffer without creating a BigInt per event and paying for the
garbage collection later. Reach for it when allocation pressure matters more
than per-call latency; otherwise use `now()`.

Throws `TypeError` if `target` is not one of the two 64-bit array types, and
`RangeError` if `index` is out of bounds.

## Why BigInt

Nanoseconds since the epoch is currently about `1.79e18`. `Number.MAX_SAFE_INTEGER`
is about `9.01e15`. The value is roughly **198 times** larger than the biggest
integer a JavaScript number can represent exactly, so returning a double would
silently round away the last three digits or more — precisely the digits a
nanosecond timestamp exists to carry. There is no version of this API that
returns a `number` and is still correct.

`nowMicros()` exists for callers who genuinely want a `number`: microseconds do
fit, with 229 years to spare.

## Resolution is not accuracy

Resolution is how small a difference two consecutive calls can show. Accuracy is
how close the value is to real UTC. This library is responsible for the first
one. The second is entirely a property of your NTP configuration.

|  | Reported resolution | Real granularity | Absolute accuracy vs UTC |
|---|---|---|---|
| **Linux** | `clock_getres` says 1ns, which is not informative | ~1ns on a TSC clocksource; ~70ns on HPET; ~280ns on the ACPI PM timer | whatever NTP gives you: typically 0.1–10ms over the internet, microseconds with chrony plus a local stratum-1 source |
| **Windows** | 100ns FILETIME tick; the API documents "&lt;1&micro;s" precision | 100ns floor, interpolated from QPC | whatever w32time gives you: ~1ms if configured to Microsoft's high-accuracy requirements, but a default stand-alone machine syncs *once a week* and can drift by seconds |

Measured by `npm test`, which reports these numbers on every run:

| | smallest observable gap | median gap | distinct values in 100k calls |
|---|---|---|---|
| Linux x64 (WSL2, TSC) | 26ns | 30ns | 100% |
| Windows x64 | 100ns | 100ns | 33% |

The Windows figure is the FILETIME tick doing exactly what it says: a call costs
less than 100ns, so several consecutive calls land inside the same tick. Every
value nanoepoch returns on Windows is a multiple of 100, and the test suite
asserts it.

**Nanosecond resolution never implies nanosecond accuracy.** If you need to know
the true time to within a microsecond, that is a clock synchronisation problem,
and no library call can solve it for you.

## This clock can go backwards

`CLOCK_REALTIME` is not monotonic, and neither is this API. Consecutive calls
can return a smaller value than the one before. That is not a bug — it is the
whole point. The clock moves backwards when:

- an NTP daemon **steps** rather than slews the clock, which is most likely
  shortly after boot (chrony and systemd-timesyncd step past their threshold;
  Windows w32time steps past `MaxAllowedPhaseOffset`, 1s stand-alone / 300s
  domain-joined);
- someone runs `date -s`, `settimeofday`, or `SetSystemTime`;
- a virtual machine resumes, migrates, or has its time re-synced by the host;
- a leap second is inserted (the Linux kernel replays a second; Windows shows
  the 59th second at half rate; smearing NTP sources spread it over 24 hours).

**To measure durations, do not use this library.** Use
`process.hrtime.bigint()`, which is monotonic and is what Node already provides
for exactly that purpose.

nanoepoch deliberately offers no monotonic variant. Every way to build one is
worse: anchoring to a monotonic counter is the technique this package exists to
avoid, and clamping to the last returned value requires cross-call state that
would differ per worker thread and would return a value that is neither the wall
time nor a real duration.

## Limits

- **Range.** Values are signed 64-bit nanosecond counts, so the last
  representable instant is `2262-04-11T23:47:16.854775807Z`. Past that,
  nanoepoch throws `RangeError` instead of returning a wrapped value.
- **Leap seconds.** Unix time is leap-second oblivious by definition, so this is
  not TAI. See the list above for what you may observe around one.
- **Before 1970.** A clock set before the epoch throws rather than returning a
  negative timestamp.

## Platform support

Prebuilt binaries ship for:

| Platform | libc / OS floor |
|---|---|
| `win32-x64` | — |
| `win32-arm64` | — |
| `linux-x64` | glibc 2.28+ and musl |
| `linux-arm64` | glibc 2.28+ and musl |
| `darwin-arm64` | macOS 13.5+ |
| `darwin-x64` | macOS 13.5+ |

The glibc builds target glibc 2.28, which is the same floor the official Node.js
Linux binaries require — so any machine that can run a supported Node can load
them. Alpine gets its own musl builds, and the loader picks between them at
require time: it guesses cheaply, and if the guess is wrong the other candidate
is tried, so a mislabelled container cannot leave you without a binary. Force
the choice with `LIBC=glibc` or `LIBC=musl` to skip the guess entirely.

The macOS builds compile against the Node 24 headers, whose deployment target is
macOS 13.5 (`MACOSX_DEPLOYMENT_TARGET` in Node's `common.gypi`) — the same floor
Node 24 itself requires. `darwin-x64` is built on GitHub's Intel macOS image,
which is the last one they will offer; that row lives as long as the image does.

Tested against Node 22, 24, and 26. `engines` allows Node 20, which is past end
of life but still widely deployed; it gets a smoke test in CI rather than the
full matrix.

Anything outside this table has no automatic fallback: with no install script
and no `binding.gyp` in the tarball, an unsupported platform fails loudly at
`require` time instead of quietly compiling. Building from a clone still works —
see [Development](#development) — and the load error spells out the steps.

### There is no JavaScript fallback

If no binary matches your platform and a source build is not possible,
`require('nanoepoch')` throws at load time with the detected platform, the
bundled binaries, and instructions. It does not fall back to a JavaScript
implementation.

That is deliberate. The only thing JavaScript could fall back to is the anchored
technique at the top of this README, and its failure mode is invisible: the
values look exactly like real ones until the clock is adjusted, at which point
you have been recording wrong timestamps for hours without any indication. A
loud failure at deploy time is strictly better than silent data corruption in
production.

If you would rather not run a binary someone else compiled, build it yourself.
`--build-from-source` no longer applies — it works by re-running an install
script, and this package has none — so compile from a clone and point your
project at the checkout:

```sh
git clone https://github.com/eg97park/nanoepoch
cd nanoepoch && npm install && npm run build
cd /path/to/your/project && npm install /path/to/nanoepoch
```

What compiles is [`src/nanoepoch.c`](src/nanoepoch.c), about 400 lines. It also
ships inside the npm tarball so you can read the source the shipped binary was
built from, even though the tarball leaves out the `binding.gyp` that would let
you compile it in place.

## Performance

`npm run bench`. Measured with [mitata], Node 24, single machine, so treat these
as ratios rather than absolutes.

| | Linux x64 | Windows x64 |
|---|---|---|
| `Date.now()` | 30.2ns | 46.6ns |
| `performance.now()` | 30.3ns | 40.0ns |
| `process.hrtime.bigint()` | 29.3ns | 32.6ns |
| anchored hrtime shim (the wrong approach) | 27.1ns | 34.6ns |
| **`nanoepoch.now()`** | **29.7ns** | **31.2ns** |
| `nanoepoch.nowMicros()` | 31.1ns | 33.9ns |
| `nanoepoch.nowInto(arr)` | 39.9ns | 45.3ns |
| `nanoepoch.nowInto(arr, i)` | 47.9ns | 62.7ns |

Reading the OS clock on every call turns out to cost about the same as not
reading it. On Windows `now()` is the fastest option in the table, including
`Date.now()`; on Linux it is within 10% of the anchored shim it replaces. The
correctness upgrade is close to free.

Internally `now()` creates its BigInt on the native side. Mirroring
`process.hrtime.bigint()` — have the addon write into a shared `BigUint64Array`
and read the slot back in JavaScript — measured about 1.9x *slower* on both
platforms, because that path has to locate and bounds-check a typed array on
every call, while Node's internal buffer needs no argument parsing at all.

## Supply chain

A package whose entire claim is that its numbers come from the OS and nowhere
else should be auditable in one sitting, so:

- **Zero runtime dependencies.** Resolving which prebuilt binary to load is
  about sixty lines at the top of [`index.js`](index.js), not a dependency.
- **Nothing executes at install time.** No install, preinstall, or postinstall
  script, and no `binding.gyp` in the tarball — npm builds a package that ships
  one even when it declares no script at all, so leaving it out is the half of
  this that is easy to get wrong. `binding.gyp` stays in the repository, where
  that same rule is what builds the addon for contributors.
- **The binaries ship inside the tarball**, so npm provenance covers them —
  they are built by the public [release workflow](.github/workflows/release.yml)
  on GitHub-hosted runners, and the attestation ties the tarball to the exact
  commit and workflow run. Verify with:

  ```sh
  npm audit signatures
  ```

- **Publishing uses OIDC trusted publishing** — no long-lived npm token exists
  to leak. The workflow pins every GitHub Action to a full commit SHA, and the
  release gate ([`scripts/verify-prebuilds.mjs`](scripts/verify-prebuilds.mjs))
  reads each binary's ELF, PE, or Mach-O header before publish, refusing a
  release where any binary's architecture or libc disagrees with its filename —
  or where the manifest has grown an install script or a shipped `binding.gyp`.
- **You can opt out of the binaries entirely** by compiling the ~400 lines of C
  yourself; the steps are under [There is no JavaScript
  fallback](#there-is-no-javascript-fallback).

## Development

```sh
npm install            # devDependencies, plus a source build (see below)
npm run build          # the explicit build; rerun after editing src/nanoepoch.c
npm test               # the full suite
npm run bench          # the table above
npm run make-prebuild  # a prebuilt binary for the current platform
npm run attw           # check the published type declarations resolve
```

`binding.gyp` is in the repository but not in the npm tarball, so a checkout
still compiles on `npm install` — through npm's implicit `node-gyp rebuild` —
while a consumer's install compiles nothing. That implicit path uses whichever
node-gyp npm bundles, which is 10.x on the Node 22 line and cannot detect Visual
Studio 2026, so CI installs with `--ignore-scripts` and calls `npm run build`
explicitly: that one runs the `node-gyp` devDependency pinned to ^13. Do the
same locally if a build picks the wrong toolchain.

Building from source needs Node 22.22 or newer — the `node-gyp` devDependency
supports `^22.22.2 || ^24.15.0 || >=26`. Consumers are unaffected: the
published package installs a prebuilt binary on anything `engines` allows
(Node >= 20).

`make-prebuild` is not called `prebuild` because npm would silently run it as
the pre-hook of `build`.

A local build wins over a bundled prebuild, so `npm run build` is what you end
up testing. The corollary is that a stale `build/` keeps shadowing the shipped
binary until you delete it — if a prebuild seems not to take effect, `rm -rf
build` first.

nanoepoch has two development dependencies: `node-gyp` to compile and `mitata`
to benchmark.

The suite separates gates from reports on purpose: assertions cover only what
the OS actually guarantees (value ranges, the Windows 100ns tick, epoch
conversion vectors, argument validation), while everything distribution-shaped —
resolution, gap percentiles, observed backward steps — is reported as
diagnostics. Asserting on a clock's statistical behaviour in shared CI is how
you get a flaky suite that nobody trusts.

The backward-step proof changes the system clock, so it is skipped unless you
run it deliberately:

```sh
bash scripts/clock-step/run.sh   # Linux, disposable VM or container only
```

## License

MIT

[mitata]: https://github.com/evanwashere/mitata
