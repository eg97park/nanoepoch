// The hardening gate reads bytes that no functional test can reach: RELRO,
// BIND_NOW, a stack canary, the DT_NEEDED set, Control Flow Guard, the glibc
// and macOS floors. A binary missing every one of them still returns correct
// timestamps, so these checks are the only thing standing between a toolchain
// change and a silently weaker release.
//
// Which means the checks themselves need testing, and they cannot be tested
// against the shipped binaries: release-guard.test.mjs's real-binary cases skip
// unless a checkout holds all eight prebuilds, which is never true in CI and
// rarely true locally. Everything here is built from synthesised headers
// instead, so it runs on every platform on every pull request -- including the
// malformed cases, where the requirement is a named refusal rather than a
// RangeError escaping the parser.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseElf, parseMachO, parsePe } from '../scripts/lib/binfmt.mjs'
import { inspect } from '../scripts/lib/hardening.mjs'

/* ----------------------------------------------------------------- ELF ---- */

const PT_LOAD = 1
const PT_DYNAMIC = 2
const PT_GNU_STACK = 0x6474E551
const PT_GNU_RELRO = 0x6474E552

const DT_NULL = 0
const DT_NEEDED = 1
const DT_STRTAB = 5
const DT_STRSZ = 10
const DT_FLAGS = 30
const DT_VERNEED = 0x6FFFFFFE
const DT_VERNEEDNUM = 0x6FFFFFFF

const EM_X86_64 = 62

// A minimal but structurally honest ELF64: one PT_LOAD mapping the whole file
// at vaddr == file offset, so every vaddr in the dynamic section resolves
// through it, plus whichever segments the case under test needs.
//
//   0x0000  ELF header
//   0x0040  program headers
//   0x1000  .dynamic
//   0x1800  .gnu.version_r
//   0x2000  .dynstr
function elf64 ({
  machine = EM_X86_64,
  needed = ['libc.so.6'],
  bindNow = true,
  relro = true,
  gnuStack = true,
  execStack = false,
  stackChk = true,
  strtabVaddr = 0x2000,
  glibcVersions = ['2.2.5', '2.17']
} = {}) {
  const file = Buffer.alloc(0x3000)

  const names = [...needed]
  if (stackChk) names.push('__stack_chk_fail')
  for (const version of glibcVersions) names.push(`GLIBC_${version}`)
  // A leading NUL so no real name can sit at strtab offset 0.
  let strtab = '\0'
  const offsets = new Map()
  for (const name of names) {
    offsets.set(name, strtab.length)
    strtab += `${name}\0`
  }
  file.write(strtab, 0x2000, 'latin1')

  // .gnu.version_r: one Verneed naming the library, then one Vernaux per
  // version required from it. This is where the real glibc floor lives -- the
  // highest GLIBC_x.y here is what a machine actually needs to load the file.
  if (glibcVersions.length > 0) {
    file.writeUInt16LE(1, 0x1800) // vn_version
    file.writeUInt16LE(glibcVersions.length, 0x1802) // vn_cnt
    file.writeUInt32LE(offsets.get(needed[0]) ?? 0, 0x1804) // vn_file
    file.writeUInt32LE(16, 0x1808) // vn_aux, relative to the Verneed
    file.writeUInt32LE(0, 0x180C) // vn_next: the only entry
    glibcVersions.forEach((version, index) => {
      const at = 0x1810 + index * 16
      file.writeUInt32LE(0, at) // vna_hash
      file.writeUInt32LE(offsets.get(`GLIBC_${version}`), at + 8) // vna_name
      file.writeUInt32LE(index === glibcVersions.length - 1 ? 0 : 16, at + 12) // vna_next
    })
  }

  const dynamic = []
  for (const name of needed) dynamic.push([DT_NEEDED, offsets.get(name)])
  dynamic.push([DT_STRTAB, strtabVaddr])
  dynamic.push([DT_STRSZ, strtab.length])
  if (bindNow) dynamic.push([DT_FLAGS, 0x8])
  if (glibcVersions.length > 0) {
    dynamic.push([DT_VERNEED, 0x1800])
    dynamic.push([DT_VERNEEDNUM, 1])
  }
  dynamic.push([DT_NULL, 0])

  dynamic.forEach(([tag, value], index) => {
    file.writeBigUInt64LE(BigInt(tag), 0x1000 + index * 16)
    file.writeBigUInt64LE(BigInt(value), 0x1000 + index * 16 + 8)
  })

  const segments = [
    { type: PT_LOAD, flags: 5, offset: 0, vaddr: 0, filesz: 0x3000 },
    { type: PT_DYNAMIC, flags: 6, offset: 0x1000, vaddr: 0x1000, filesz: dynamic.length * 16 }
  ]
  if (relro) segments.push({ type: PT_GNU_RELRO, flags: 4, offset: 0x1000, vaddr: 0x1000, filesz: 0x100 })
  if (gnuStack) segments.push({ type: PT_GNU_STACK, flags: execStack ? 7 : 6, offset: 0, vaddr: 0, filesz: 0 })

  // e_ident
  file.write('\x7fELF', 0, 'latin1')
  file.writeUInt8(2, 4) // 64-bit
  file.writeUInt8(1, 5) // little-endian
  file.writeUInt8(1, 6) // version
  file.writeUInt16LE(3, 16) // e_type: ET_DYN
  file.writeUInt16LE(machine, 18)
  file.writeUInt32LE(1, 20)
  file.writeBigUInt64LE(64n, 0x20) // e_phoff
  file.writeBigUInt64LE(0n, 40) // e_shoff: no section headers, i.e. stripped
  file.writeUInt16LE(64, 52) // e_ehsize
  file.writeUInt16LE(56, 0x36) // e_phentsize
  file.writeUInt16LE(segments.length, 0x38) // e_phnum

  segments.forEach((segment, index) => {
    const at = 64 + index * 56
    file.writeUInt32LE(segment.type, at)
    file.writeUInt32LE(segment.flags, at + 4)
    file.writeBigUInt64LE(BigInt(segment.offset), at + 8)
    file.writeBigUInt64LE(BigInt(segment.vaddr), at + 16)
    file.writeBigUInt64LE(BigInt(segment.vaddr), at + 24)
    file.writeBigUInt64LE(BigInt(segment.filesz), at + 32)
    file.writeBigUInt64LE(BigInt(segment.filesz), at + 40)
  })

  return file
}

function faults (buffer, target) {
  return inspect(buffer, target, { skipMachine: true }).problems
}

test('a correctly hardened glibc binary draws no complaint', () => {
  assert.deepEqual(faults(elf64(), 'linux-x64-glibc'), [])
})

test('the libraries --as-needed should have dropped are refused', () => {
  // Exactly the state every glibc build was in before the flag landed: gyp
  // links a loadable_module through the C++ driver, so libstdc++, libgcc_s and
  // libm arrive without a single symbol being used from them.
  const binary = elf64({
    needed: ['libstdc++.so.6', 'libm.so.6', 'libgcc_s.so.1', 'libpthread.so.0', 'libc.so.6']
  })
  const [fault] = faults(binary, 'linux-x64-glibc')
  assert.match(fault, /must link exactly libc\.so\.6/)
})

test('aarch64 glibc may name the dynamic linker, and need not', () => {
  // What the 0.4.0 release actually produced. ld.so is not a dependency -- it
  // is what processes DT_NEEDED, mapped before the first entry is read -- so
  // naming it costs nothing, unlike the four libraries above.
  assert.deepEqual(
    faults(elf64({ needed: ['ld-linux-aarch64.so.1', 'libc.so.6'] }), 'linux-arm64-glibc'), [])

  // Tolerated, not demanded: a toolchain that stops emitting it has produced
  // the tidier binary and must not fail a release for it.
  assert.deepEqual(faults(elf64({ needed: ['libc.so.6'] }), 'linux-arm64-glibc'), [])
})

test('the linker allowance does not weaken the --as-needed check that shares it', () => {
  // The allowance is one name on one target. It must not become a hole that a
  // real dependency can hide in, and it must not spread to the arch where the
  // toolchain does not do this.
  const [withLibrary] = faults(
    elf64({ needed: ['ld-linux-aarch64.so.1', 'libstdc++.so.6', 'libc.so.6'] }), 'linux-arm64-glibc')
  assert.match(withLibrary, /libstdc\+\+\.so\.6/,
    'the diagnostic must name everything the binary links, not the filtered list')

  assert.match(faults(elf64({ needed: ['ld-linux-x86-64.so.2', 'libc.so.6'] }), 'linux-x64-glibc')[0],
    /must link exactly libc\.so\.6/,
    'x86-64 glibc does not do this, so seeing it there is a change worth stopping for')
})

test('a musl-tagged binary that links glibc is refused, and the reverse', () => {
  assert.match(faults(elf64({ needed: ['libc.so.6'] }), 'linux-x64-musl')[0],
    /must link exactly libc\.musl-x86_64\.so\.1/)
  assert.match(faults(elf64({ needed: ['libc.musl-x86_64.so.1'], glibcVersions: [] }), 'linux-x64-glibc')[0],
    /must link exactly libc\.so\.6/)
})

test('a musl binary needs no versioned glibc symbols', () => {
  // musl does not version its symbols at all, so the glibc floor check must not
  // apply to those two targets.
  assert.deepEqual(faults(elf64({ needed: ['libc.musl-x86_64.so.1'], glibcVersions: [] }), 'linux-x64-musl'), [])
})

test('the advertised glibc floor is enforced against the symbols, not the README', () => {
  // GLIBC_2.28 is the floor the support table promises, and the only thing that
  // has ever backed it up is the build image. A toolchain that pulled in a
  // newer symbol would move the real floor with nothing to notice -- on
  // linux-arm64 especially, which no job loads on an old distribution.
  assert.deepEqual(faults(elf64({ glibcVersions: ['2.2.5', '2.17', '2.28'] }), 'linux-x64-glibc'), [])

  const [fault] = faults(elf64({ glibcVersions: ['2.17', '2.34'] }), 'linux-x64-glibc')
  assert.match(fault, /requires GLIBC_2\.34, above the 2\.28 floor/)
})

test('a glibc binary with no versioned symbols at all is refused', () => {
  assert.match(faults(elf64({ glibcVersions: [] }), 'linux-x64-glibc')[0], /no versioned glibc symbols/)
})

test('lazy binding is refused however the linker spelled it', () => {
  // DT_BIND_NOW, DF_BIND_NOW and DF_1_NOW all mean the same thing, and which
  // one appears depends on the linker's age. Absence of all three is what makes
  // RELRO partial, which is what the glibc builds had.
  const [fault] = faults(elf64({ bindNow: false }), 'linux-x64-glibc')
  assert.match(fault, /no BIND_NOW/)
})

test('a missing RELRO segment is refused', () => {
  assert.match(faults(elf64({ relro: false }), 'linux-x64-glibc')[0], /no PT_GNU_RELRO/)
})

test('a missing stack canary is refused', () => {
  assert.match(faults(elf64({ stackChk: false }), 'linux-x64-glibc')[0], /no __stack_chk_fail/)
})

test('an executable stack is refused', () => {
  assert.match(faults(elf64({ execStack: true }), 'linux-x64-glibc')[0], /stack is marked executable/)
})

test('a dynamic string table outside every loadable segment is a named fault', () => {
  // The malformed case that would otherwise read past the end of the buffer and
  // turn a precise refusal into a stack trace out of the release gate.
  const binary = elf64({ strtabVaddr: 0xDEAD0000 })
  const [fault] = faults(binary, 'linux-x64-glibc')
  assert.match(fault, /outside every loadable segment/)
})

test('truncated ELF bytes are refused rather than throwing', () => {
  for (const length of [0, 4, 20, 63, 100]) {
    const result = parseElf(elf64().subarray(0, length))
    assert.equal(result.ok, false, `${length} bytes should not parse`)
    assert.equal(typeof result.problem, 'string')
  }
})

/* ------------------------------------------------------------------ PE ---- */

// A minimal PE32+ with one section, so the load config data directory can be
// resolved from an RVA the way a real image's is.
//
//   0x0080  PE signature      0x0098  optional header
//   0x0188  section table     0x1000  the section body, holding the load config
function pe64 ({ machine = 0x8664, dllCharacteristics = 0x4160, guardFlags = 0x10017500, guardCount = 55 } = {}) {
  const file = Buffer.alloc(0x2000)
  const peOffset = 0x80
  const optional = peOffset + 24
  const sizeOfOptional = 112 + 16 * 8

  file.write('MZ', 0, 'latin1')
  file.writeUInt32LE(peOffset, 0x3C)
  file.write('PE\0\0', peOffset, 'latin1')

  file.writeUInt16LE(machine, peOffset + 4)
  file.writeUInt16LE(1, peOffset + 6) // one section
  file.writeUInt16LE(sizeOfOptional, peOffset + 20)

  file.writeUInt16LE(0x20B, optional) // PE32+
  file.writeUInt16LE(dllCharacteristics, optional + 0x46)
  file.writeUInt32LE(16, optional + 108) // NumberOfRvaAndSizes
  file.writeUInt32LE(0x1000, optional + 112 + 10 * 8) // load config RVA
  file.writeUInt32LE(0x140, optional + 112 + 10 * 8 + 4) // load config size

  const section = optional + sizeOfOptional
  file.write('.rdata\0\0', section, 'latin1')
  file.writeUInt32LE(0x1000, section + 8) // VirtualSize
  file.writeUInt32LE(0x1000, section + 12) // VirtualAddress
  file.writeUInt32LE(0x1000, section + 16) // SizeOfRawData
  file.writeUInt32LE(0x1000, section + 20) // PointerToRawData

  file.writeBigUInt64LE(BigInt(guardCount), 0x1000 + 0x88)
  file.writeUInt32LE(guardFlags, 0x1000 + 0x90)

  return file
}

test('a Windows binary linked with /guard:cf draws no complaint', () => {
  assert.deepEqual(faults(pe64(), 'win32-x64'), [])
})

test('the DllCharacteristics every pre-0.3.2 Windows binary had are refused', () => {
  // 0x0160 is HIGH_ENTROPY_VA | DYNAMIC_BASE | NX_COMPAT -- everything except
  // Control Flow Guard, which node-gyp turns off through node's config.gypi.
  const problems = faults(pe64({ dllCharacteristics: 0x0160, guardFlags: 0x100, guardCount: 0 }), 'win32-x64')
  assert.match(problems.join('\n'), /Control Flow Guard \(\/guard:cf\) is off/)
})

test('a CFG bit with no guard function table is called out as cosmetic', () => {
  // The trap a DllCharacteristics-only check would fall into: a statically
  // linked MSVC CRT contributes CF_INSTRUMENTED by itself, so the flag can be
  // set while the module was never really instrumented.
  const problems = faults(pe64({ dllCharacteristics: 0x4160, guardFlags: 0x100, guardCount: 0 }), 'win32-x64')
  assert.match(problems.join('\n'), /Control Flow Guard is cosmetic/)
})

test('ASLR and DEP are required too', () => {
  const problems = faults(pe64({ dllCharacteristics: 0x4000 }), 'win32-x64')
  assert.match(problems.join('\n'), /high-entropy ASLR is off/)
  assert.match(problems.join('\n'), /ASLR \(DYNAMIC_BASE\) is off/)
  assert.match(problems.join('\n'), /DEP \(NX_COMPAT\) is off/)
})

test('truncated PE bytes are refused rather than throwing', () => {
  for (const length of [0, 2, 0x40, 0x90, 0x100]) {
    const result = parsePe(pe64().subarray(0, length))
    assert.equal(result.ok, false, `${length} bytes should not parse`)
    assert.equal(typeof result.problem, 'string')
  }
})

/* -------------------------------------------------------------- Mach-O ---- */

function machO ({ cpuType = 0x0100000C, minos = (13 << 16) | (5 << 8) } = {}) {
  const file = Buffer.alloc(0x400)
  file.writeUInt32LE(0xFEEDFACF, 0)
  file.writeUInt32LE(cpuType, 4)
  file.writeUInt32LE(6, 12) // MH_DYLIB
  file.writeUInt32LE(1, 16) // one load command

  file.writeUInt32LE(0x32, 32) // LC_BUILD_VERSION
  file.writeUInt32LE(24, 36) // cmdsize
  file.writeUInt32LE(1, 40) // platform: macOS
  file.writeUInt32LE(minos, 44)
  return file
}

test('a macOS binary at the advertised floor draws no complaint', () => {
  assert.deepEqual(faults(machO(), 'darwin-arm64'), [])
  assert.equal(parseMachO(machO()).minosText, '13.5')
})

test('a macOS binary that needs more than the README promises is refused', () => {
  // The floor is inherited from the Node headers' MACOSX_DEPLOYMENT_TARGET, so
  // a Node bump can raise it without anyone touching this repository. Then the
  // support table is wrong for exactly the readers who cannot find out cheaply.
  const [fault] = faults(machO({ minos: (14 << 16) | (2 << 8) }), 'darwin-arm64')
  assert.match(fault, /requires macOS 14\.2, above the 13\.5 floor/)
})

test('a binary older than the advertised floor is accepted as conservative', () => {
  assert.deepEqual(faults(machO({ minos: (11 << 16) }), 'darwin-arm64'), [])
})

test('a universal binary is named as one rather than called corrupt', () => {
  const fat = Buffer.alloc(0x400)
  fat.writeUInt32BE(0xCAFEBABE, 0)
  assert.match(faults(fat, 'darwin-arm64')[0], /universal \(fat\) binary/)
})

test('an unknown target is refused rather than silently passing', () => {
  assert.match(inspect(elf64(), 'linux-riscv64-glibc').problems[0], /unknown target/)
})
