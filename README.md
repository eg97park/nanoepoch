# nanoepoch

Current wall-clock time as integer nanoseconds since the Unix epoch, read from
the OS realtime clock on **every** call.

```js
const { now } = require('nanoepoch')

now() // => 1785864546913306300n
```

## Why this exists

Every nanosecond-timestamp package for Node I could find works the same way: it
reads the wall clock once, then adds elapsed monotonic time to that anchor
forever.

```js
// nano-time@1.0.0 and nanotime@1.0.2, checked 2026-08
const anchor = BigInt(Date.now()) * 1_000_000n - process.hrtime.bigint()
const now = () => anchor + process.hrtime.bigint()
```

If you know one that reads the clock on every call, open an issue and this
sentence changes. Two near misses, so the claim is not wider than it should be:
[`microtime`][microtime] genuinely does read the OS clock every call — through
`gettimeofday`, at microsecond resolution, returning a `number` — and
[`@thi.ng/timestamp`][thi-ng-timestamp] returns `process.hrtime.bigint()`
directly, which is a monotonic counter rather than a wall-clock timestamp and
does not claim otherwise.

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
| **Linux** | [`clock_getres`][clock_gettime] says 1ns, which is not informative | ~1ns on a TSC clocksource; ~70ns on HPET; ~280ns on the ACPI PM timer | whatever NTP gives you: typically 0.1–10ms over the internet, microseconds with chrony plus a local stratum-1 source |
| **Windows** | 100ns FILETIME tick; [the API][GetSystemTimePreciseAsFileTime] documents "&lt;1&micro;s" precision | 100ns floor, interpolated from QPC | whatever [w32time][w32time-accuracy] gives you: ~1ms if configured to Microsoft's high-accuracy requirements, but a default stand-alone machine syncs *once a week* and can drift by seconds |

The Linux granularities are properties of the clocksource, not of the API — read
yours with `cat /sys/devices/system/clocksource/clocksource0/current_clocksource`.

Measured by the resolution test in the repository, which reports these numbers
on every run:

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
  Windows w32time steps past [`MaxAllowedPhaseOffset`][w32time-settings], 1s
  stand-alone / 300s domain-joined);
- someone runs `date -s`, `settimeofday`, or `SetSystemTime`;
- a virtual machine resumes, migrates, or has its time re-synced by the host;
- a leap second is inserted. Unix time cannot represent one, so something has to
  give: the Linux kernel replays a second, and a smearing NTP source spreads it
  over hours instead. On Windows the picture depends on the OS version and on
  the process — Windows 10 1809 and Server 2019 added [platform leap-second
  support][ms-leap-seconds], and a process opts in to seeing a 60th second with
  `SetProcessInformation`. nanoepoch does not opt in and never converts to
  `SYSTEMTIME`: it reads the raw FILETIME tick count. If you need to know what
  your machines do across a leap second, measure it there rather than trusting
  this paragraph — the honest summary is that Unix time has no representation
  for the event and every platform reconciles that differently.

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
| `win32-x64` | Windows 10 / Server 2016 |
| `win32-arm64` | Windows 10 |
| `linux-x64` | glibc 2.28+ and musl |
| `linux-arm64` | glibc 2.28+ and musl |
| `darwin-arm64` | macOS 13.5+ |
| `darwin-x64` | macOS 13.5+ |

Every floor in that table is Node's, not the API's, and the release gate reads
it out of the binaries rather than taking this table's word for it.

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

The Windows rows are Node's support floor too:
`GetSystemTimePreciseAsFileTime` itself has shipped since Windows 8 and
Server 2012, so what actually decides is which Windows the Node you are running
supports.

### Support

Three different questions, which the single word "supported" tends to blur:

| | Node versions | What that means |
|---|---|---|
| Installs and loads | >= 20 (`engines`) | The prebuilds are Node-API 6, so they load on anything `engines` allows. Node 20 is past end of life and gets a load-only smoke test in CI, not the full matrix. |
| Tested on every push | 22, 24, 26 | The full suite, across all eight targets. |
| Building from a clone | >= 22.22 | What the `node-gyp` devDependency requires. Consumers never build. |

Security fixes land on the latest 0.x release only; there are no maintenance
branches before 1.0. Which package versions that covers is in
[SECURITY.md](SECURITY.md).

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
cd nanoepoch && npm install && npm run dev:build
cd /path/to/your/project && npm install /path/to/nanoepoch
```

What compiles is [`src/nanoepoch.c`](src/nanoepoch.c), about 400 lines. It ships
inside the npm tarball, together with the `binding.gyp` that builds it, under
[`build-recipe/`](build-recipe/) — one directory down, where npm's two
root-only checks cannot see it and turn it back into an install-time build.
`BUILD-INFO.json`, also in the tarball, records the SHA-256 of every shipped
binary alongside the compiler, Node version, and container image digest that
produced it, and the release refuses to publish if the shipped source does not
hash to what those builds compiled. So you can rebuild from what you were sent
and compare — see [`build-recipe/README.md`](build-recipe/README.md).

### Bundlers

nanoepoch finds its `.node` file relative to its own package directory at
require time, so **mark it external and leave it in `node_modules`**:

```js
// webpack — the "commonjs" prefix is load-bearing; a bare 'nanoepoch' compiles
// to a global lookup and fails at runtime
externals: { nanoepoch: 'commonjs nanoepoch' }
```

```sh
esbuild --external:nanoepoch     # ncc: --external nanoepoch
```

That is the supported configuration, and the only one. If you inline the package
into a bundle instead, `__dirname` stops pointing at the package, the loader
cannot find `prebuilds/`, and `require` throws at deploy time with the usual
diagnostic. Copying the package's `prebuilds/` directory next to your bundle
output is then your job; nothing here does it for you.

`index.js` carries a `__non_webpack_require__` guard so webpack does not warn
about a computed `require`. That suppresses a warning — it does not move the
binary.

## Performance

`npm run bench`, with [mitata]. Both columns are one machine — an Intel Core
Ultra 7 265K, Node 24.19.0, plugged in on the Windows "Balanced" plan — so the
ratios are comparable to each other and the absolute numbers are not comparable
to your hardware. The Linux column is WSL2 (kernel 6.6.87, `tsc` clocksource),
which is a virtual machine: expect a bare-metal Linux host to differ.

| | Linux x64 (WSL2) | Windows x64 |
|---|---|---|
| `Date.now()` | 28.9ns | 55.5ns |
| `performance.now()` | 27.5ns | 47.4ns |
| `process.hrtime.bigint()` | 26.6ns | 41.1ns |
| anchored hrtime shim (the wrong approach) | 26.4ns | 41.1ns |
| **`nanoepoch.now()`** | **31.0ns** | **37.3ns** |
| `nanoepoch.nowMicros()` | 29.4ns | 40.7ns |
| `nanoepoch.nowInto(arr)` | 39.2ns | 50.5ns |
| `nanoepoch.nowInto(arr, i)` | 46.8ns | 62.3ns |

Reading the OS clock on every call turns out to cost about the same as not
reading it. On Windows `now()` is the fastest option in the table, including
`Date.now()` and including the anchored shim it replaces; on Linux it costs
about 4ns more than that shim. The correctness upgrade is close to free.

CI runs the benchmark on every push so the command above cannot quietly stop
working, but it does not assert on the numbers: timings from a shared runner are
not something to fail a build over.

Internally `now()` creates its BigInt on the native side. Mirroring
`process.hrtime.bigint()` — have the addon write into a shared `BigUint64Array`
and read the slot back in JavaScript — measured about 1.9x *slower* on both
platforms, because that path has to locate and bounds-check a typed array on
every call, while Node's internal buffer needs no argument parsing at all.

## Supply chain

A package whose entire claim is that its numbers come from the OS and nowhere
else should be auditable in one sitting, so:

- **Zero npm dependencies.** Resolving which prebuilt binary to load is about
  sixty lines at the top of [`index.js`](index.js), not a dependency. At the OS
  level both Linux builds link `libc` and nothing else — the release gate
  compares the binaries' `DT_NEEDED` entries against an exact list, so that
  stays true or the release stops.
- **Nothing executes at install time.** No install, preinstall, or postinstall
  script; no `*.gyp` at the tarball root, because npm builds a package that
  ships one even when it declares no script at all; and `"gypfile": false` in
  the manifest, because npm otherwise *writes that install script itself* into
  the manifest it uploads — it prepares that manifest from the publish
  directory, and this repository does keep a `binding.gyp` (that is what builds
  the addon for contributors). 0.3.0 got the first two right, missed the third,
  and every install of it failed; 0.3.1 is the fix. The release gate
  ([`scripts/verify-prebuilds.mjs`](scripts/verify-prebuilds.mjs)) refuses a
  manifest that has lost any of the three, `npm publish --dry-run` is checked
  before anything is uploaded, and the workflow re-reads the published manifest
  from the registry afterwards.
- **The binaries ship inside the tarball**, so npm provenance covers them —
  they are built by the public [release workflow](.github/workflows/release.yml)
  on GitHub-hosted runners, and the attestation ties the tarball to the exact
  commit and workflow run. Each binary also carries its own attestation, so a
  single `.node` file can be checked without the registry:

  ```sh
  npm audit signatures
  gh attestation verify node_modules/nanoepoch/prebuilds/<target>/nanoepoch*.node \
    --repo eg97park/nanoepoch
  ```

- **Every binary is recorded, and the record ships with it.**
  `BUILD-INFO.json` in the tarball carries each binary's SHA-256 and size, the
  Node and node-gyp versions, the compiler, the container image digest, and the
  SHA-256 of the `src/nanoepoch.c` and `binding.gyp` they were compiled from.
  The release refuses to publish if the shipped source does not hash to what the
  builds compiled, and after publishing it installs the package from the
  registry on all eight platforms and re-checks every binary against that file.
- **Publishing uses OIDC trusted publishing** — no long-lived npm token exists
  to leak. A release only happens from a tag whose commit is on `main` and whose
  CI run passed. Every GitHub Action is pinned to a full commit SHA.
- **The release gate reads the binaries, not just their names.** Before publish
  it checks each one's ELF, PE, or Mach-O header against the platform its
  filename claims, and then what the linker actually did: full RELRO and
  `BIND_NOW`, a stack protector, a non-executable stack, Control Flow Guard on
  Windows, that the glibc and macOS floors are no higher than the table above
  promises, and that the symbols really were stripped.
- **You can rebuild what you were shipped.** `src/nanoepoch.c` and the
  `binding.gyp` that builds it both travel in the tarball, under
  [`build-recipe/`](build-recipe/), with instructions for comparing your result
  against `BUILD-INFO.json`. The steps for using your own build instead are
  under [There is no JavaScript fallback](#there-is-no-javascript-fallback).

## Development

Everything below runs from a clone, not from an installed package.

```sh
npm install            # devDependencies only; nothing is compiled
npm run dev:build      # the build; rerun after editing src/nanoepoch.c
npm test               # the full suite
npm run bench          # the table above
npm run make-prebuild  # a prebuilt binary for the current platform
npm run attw           # check the published type declarations resolve
```

`npm install` compiles nothing, here or anywhere else. npm builds a package
whose root holds a `binding.gyp` even when it declares no install script — and
this repository does keep one, because that is what compiles the addon — but
`"gypfile": false` in the manifest turns that implicit `node-gyp rebuild` off
everywhere, including for contributors. So the build is always the explicit
step, which is also what pins it: `dev:build` runs the `node-gyp`
devDependency at ^13, while npm's implicit path would have used whichever
node-gyp npm bundles (10.x on the Node 22 line, which cannot detect Visual
Studio 2026).

The script is called `dev:build` rather than `build` so that it reads as what
it is. `npm run build` inside an *installed* nanoepoch would fail with
`gyp: binding.gyp not found` — the tarball ships no `binding.gyp` — which is
the exact symptom of the 0.3.0 breakage, on a package that is in fact fine.

Building from source needs Node 22.22 or newer — the `node-gyp` devDependency
supports `^22.22.2 || ^24.15.0 || >=26`. Consumers are unaffected: the
published package installs a prebuilt binary on anything `engines` allows
(Node >= 20).

`make-prebuild` is not called `prebuild` because npm runs a script called
`pre<name>` as the hook of `<name>`, so that name is a trap waiting for any
script called `build`.

A local build wins over a bundled prebuild, so `npm run dev:build` is what you end
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
[microtime]: https://www.npmjs.com/package/microtime
[thi-ng-timestamp]: https://www.npmjs.com/package/@thi.ng/timestamp
[clock_gettime]: https://man7.org/linux/man-pages/man3/clock_gettime.3.html
[GetSystemTimePreciseAsFileTime]: https://learn.microsoft.com/en-us/windows/win32/api/sysinfoapi/nf-sysinfoapi-getsystemtimepreciseasfiletime
[w32time-accuracy]: https://learn.microsoft.com/en-us/windows-server/networking/windows-time-service/support-boundary
[w32time-settings]: https://learn.microsoft.com/en-us/windows-server/networking/windows-time-service/windows-time-service-tools-and-settings
[ms-leap-seconds]: https://learn.microsoft.com/en-us/troubleshoot/windows-server/active-directory/support-for-leap-second
