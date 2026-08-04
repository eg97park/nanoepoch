'use strict'

// Install-time half of what node-gyp-build used to do: if a binary this process
// can actually load is already present, do nothing; otherwise build from source.
//
// On the four prebuilt targets this is a no-op that costs one require. It earns
// its place on the platforms outside that matrix -- macOS above all, where
// nanoepoch arrives as a transitive dependency on developer machines -- by
// turning "no prebuilt binary" into a source build rather than a hard failure.
//
// Note for anyone auditing lifecycle scripts: this file spawns node-gyp and
// nothing else, writes nothing outside build/, and takes no arguments. It opens
// no network connection itself; node-gyp does fetch the Node headers when it
// actually has to compile, which on a prebuilt target never happens.

const { spawnSync } = require('child_process')
const path = require('path')

const packageRoot = path.join(__dirname, '..')

// npm sets this from --build-from-source. Honouring it is what lets someone
// distrust the shipped binary and compile the source they can read, which for a
// package like this one is a reasonable thing to want.
const buildFromSource = process.env.npm_config_build_from_source === 'true'

// The install-time check is deliberately the runtime check. Anything less --
// looking for a file, guessing at libc -- can disagree with the loader, and a
// disagreement here means either a pointless compile or a missed one.
if (!buildFromSource) {
  try {
    require(path.join(packageRoot, 'index.js'))
    process.exit(0)
  } catch (error) {
    // The addon loaded but the platform clock is unusable. Compiling the same
    // source again cannot change that, and hiding the reason behind a build log
    // would be worse than stopping here.
    if (error && typeof error.code === 'string' && error.code.startsWith('ERR_NANOEPOCH_') &&
        error.code !== 'ERR_NANOEPOCH_LOAD_FAILED') {
      console.error(error.message)
      process.exit(1)
    }
  }
}

// Prefer this package's OWN node-gyp devDependency, which exists only when the
// repository itself is being built. It is pinned to ^13 because node-gyp 12.0.x
// cannot detect Visual Studio 2026.
//
// The lookup is a deliberate literal path rather than require.resolve, which
// would walk up node_modules from here. Installed as a dependency this file
// lives at <app>/node_modules/nanoepoch/scripts/, so that walk reaches the
// CONSUMER's hoisted tree -- and node-gyp is a common transitive dependency
// there at versions 3.x through 10.x. Borrowing one of those is strictly worse
// than the fallback: node-gyp <= 9 dies on Python 3.12 because distutils is
// gone, and < 12.1 is the very VS2026 blindness the pin exists to avoid.
//
// The fallback is the right answer for a consumer anyway. npm puts its own
// bundled node-gyp on PATH for lifecycle scripts, and that one tracks the npm
// the user is actually running.
function nodeGypCommand () {
  try {
    const local = path.join(packageRoot, 'node_modules', 'node-gyp', 'package.json')
    const manifest = require(local)
    const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin['node-gyp']
    return { command: process.execPath, args: [path.join(path.dirname(local), bin), 'rebuild'], shell: false }
  } catch {
    // What npm puts on PATH is a .cmd on Windows, and a .cmd cannot be spawned
    // without a shell. Sending an args array through a shell is exactly what
    // DEP0190 warns about, so the whole invocation goes in the command string
    // instead. It is a constant -- nothing here is interpolated.
    if (process.platform === 'win32') return { command: 'node-gyp.cmd rebuild', args: [], shell: true }
    return { command: 'node-gyp', args: ['rebuild'], shell: false }
  }
}

const { command, args, shell } = nodeGypCommand()
const result = spawnSync(command, args, {
  cwd: packageRoot,
  stdio: 'inherit',
  shell,
  windowsHide: true
})

if (result.error || result.status !== 0) {
  // Say what actually went wrong before the generic advice. A spawn that never
  // started (no node-gyp on PATH at all) and a compiler that rejected the
  // source have completely different fixes, and only this line distinguishes
  // them -- node-gyp prints nothing in the first case.
  if (result.error) console.error(`nanoepoch: could not run ${command}: ${result.error.message}`)
  else if (result.signal) console.error(`nanoepoch: ${command} was killed by ${result.signal}`)

  console.error([
    '',
    'nanoepoch: building from source failed on ' + process.platform + '-' + process.arch +
      (buildFromSource ? ' (--build-from-source was requested).' : ', and no prebuilt binary matched.'),
    'There is no JavaScript fallback -- see',
    'https://github.com/eg97park/nanoepoch#there-is-no-javascript-fallback',
    '',
    'A source build needs a C toolchain and Python:',
    '  Debian/Ubuntu : apt-get install -y build-essential python3',
    '  Alpine        : apk add build-base python3',
    '  macOS         : xcode-select --install',
    '  Windows       : Visual Studio Build Tools, "Desktop development with C++"',
    ''
  ].join('\n'))
  process.exit(result.status === 0 || result.status === null ? 1 : result.status)
}
