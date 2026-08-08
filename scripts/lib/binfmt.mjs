// Just enough PE, ELF and Mach-O parsing to answer the questions the release
// gate asks about a binary it is about to publish: which architecture, which
// libc, which hardening features the linker actually applied, and whether the
// symbols were really stripped.
//
// Written by hand rather than pulled in, for the same reason the loader is: a
// package whose claim is that it has no dependencies cannot grow one to check
// its own binaries. It is also less code than it looks -- every function walks
// one table and stops.
//
// Two rules hold everywhere in this file:
//
//   1. Nothing throws on malformed input. A truncated or nonsense file returns
//      { ok: false, problem } so the caller can report a fault by name. A gate
//      that dies with a RangeError turns a precise refusal into a stack trace,
//      which is the failure mode listPrebuilds() in verify-prebuilds.mjs
//      already guards against.
//   2. Nothing here reads the filesystem. The same functions run in the release
//      gate, in the per-pull-request CI check, and in tests over synthesised
//      bytes.

// A bounds-checked view. Every read returns undefined past the end rather than
// throwing, and the callers below treat undefined as "malformed".
class Reader {
  constructor (buffer) {
    this.buffer = buffer
  }

  u8 (offset) {
    return offset >= 0 && offset + 1 <= this.buffer.length ? this.buffer.readUInt8(offset) : undefined
  }

  u16 (offset, little = true) {
    if (offset < 0 || offset + 2 > this.buffer.length) return undefined
    return little ? this.buffer.readUInt16LE(offset) : this.buffer.readUInt16BE(offset)
  }

  u32 (offset, little = true) {
    if (offset < 0 || offset + 4 > this.buffer.length) return undefined
    return little ? this.buffer.readUInt32LE(offset) : this.buffer.readUInt32BE(offset)
  }

  // Returned as a Number, not a BigInt. Every value read through this is a file
  // offset, a size, or a virtual address in a binary of at most a few hundred
  // kilobytes, so the 2^53 ceiling is unreachable -- and a value that somehow
  // exceeded it would be rejected by the bounds checks that follow.
  u64 (offset, little = true) {
    if (offset < 0 || offset + 8 > this.buffer.length) return undefined
    const value = little ? this.buffer.readBigUInt64LE(offset) : this.buffer.readBigUInt64BE(offset)
    return value > Number.MAX_SAFE_INTEGER ? undefined : Number(value)
  }

  // NUL-terminated string starting at offset, bounded by limit.
  cstring (offset, limit = this.buffer.length) {
    if (offset < 0 || offset >= this.buffer.length) return undefined
    const end = Math.min(limit, this.buffer.length)
    const stop = this.buffer.indexOf(0, offset)
    if (stop === -1 || stop > end) return undefined
    return this.buffer.toString('latin1', offset, stop)
  }
}

/* ------------------------------------------------------------------ PE ---- */

// DllCharacteristics bits worth naming.
export const PE_HIGH_ENTROPY_VA = 0x0020
export const PE_DYNAMIC_BASE = 0x0040
export const PE_NX_COMPAT = 0x0100
export const PE_GUARD_CF = 0x4000

// IMAGE_GUARD_* bits in the load config directory.
export const GUARD_CF_INSTRUMENTED = 0x0100
export const GUARD_CF_FUNCTION_TABLE_PRESENT = 0x0400

export function parsePe (buffer) {
  const reader = new Reader(buffer)

  if (reader.u16(0) !== 0x5A4D) return { ok: false, problem: 'not a PE file (no MZ signature)' }
  const peOffset = reader.u32(0x3C)
  if (peOffset === undefined || reader.u32(peOffset) !== 0x00004550) {
    return { ok: false, problem: 'corrupt PE header (no PE\\0\\0 signature)' }
  }

  const machine = reader.u16(peOffset + 4)
  const sizeOfOptional = reader.u16(peOffset + 20)
  const sectionCount = reader.u16(peOffset + 6)
  if (machine === undefined || sizeOfOptional === undefined || sectionCount === undefined) {
    return { ok: false, problem: 'truncated PE COFF header' }
  }

  const optional = peOffset + 24
  if (reader.u16(optional) !== 0x20B) {
    return { ok: false, problem: 'not a PE32+ image; every target this package ships is 64-bit' }
  }

  const dllCharacteristics = reader.u16(optional + 0x46)
  if (dllCharacteristics === undefined) return { ok: false, problem: 'truncated PE optional header' }

  // Sections, so a data-directory RVA can be turned into a file offset.
  const sections = []
  const sectionTable = optional + sizeOfOptional
  for (let index = 0; index < sectionCount; index += 1) {
    const entry = sectionTable + index * 40
    const virtualAddress = reader.u32(entry + 12)
    const sizeOfRawData = reader.u32(entry + 16)
    const pointerToRawData = reader.u32(entry + 20)
    if (virtualAddress === undefined || sizeOfRawData === undefined || pointerToRawData === undefined) {
      return { ok: false, problem: 'truncated PE section table' }
    }
    sections.push({ virtualAddress, sizeOfRawData, pointerToRawData })
  }

  const toOffset = (rva) => {
    for (const section of sections) {
      if (rva >= section.virtualAddress && rva < section.virtualAddress + section.sizeOfRawData) {
        return section.pointerToRawData + (rva - section.virtualAddress)
      }
    }
    return undefined
  }

  // DataDirectory[10] is the load config table, which is where the Control Flow
  // Guard function table lives. Its presence is what separates a real /guard:cf
  // link from the CF_INSTRUMENTED bit a statically linked CRT contributes on
  // its own.
  let guardFlags = 0
  let guardCfFunctionCount = 0
  const loadConfigRva = reader.u32(optional + 112 + 10 * 8)
  const loadConfigSize = reader.u32(optional + 112 + 10 * 8 + 4)
  if (loadConfigRva && loadConfigSize) {
    const at = toOffset(loadConfigRva)
    if (at !== undefined) {
      // Both fields sit past offset 0x88, and older/smaller load config
      // directories simply do not reach that far -- which reads as "no CFG",
      // the correct answer.
      guardCfFunctionCount = loadConfigSize > 0x88 ? (reader.u64(at + 0x88) ?? 0) : 0
      guardFlags = loadConfigSize > 0x90 ? (reader.u32(at + 0x90) ?? 0) : 0
    }
  }

  return { ok: true, machine, dllCharacteristics, guardFlags, guardCfFunctionCount }
}

/* ----------------------------------------------------------------- ELF ---- */

const PT_LOAD = 1
const PT_DYNAMIC = 2
const PT_GNU_STACK = 0x6474E551
const PT_GNU_RELRO = 0x6474E552
const PT_GNU_PROPERTY = 0x6474E553

const DT_NULL = 0
const DT_NEEDED = 1
const DT_STRTAB = 5
const DT_STRSZ = 10
const DT_BIND_NOW = 24
const DT_FLAGS = 30
const DT_VERNEED = 0x6FFFFFFE
const DT_VERNEEDNUM = 0x6FFFFFFF
const DT_FLAGS_1 = 0x6FFFFFFB

const DF_BIND_NOW = 0x8
const DF_1_NOW = 0x1

const SHT_SYMTAB = 2

export function parseElf (buffer) {
  const reader = new Reader(buffer)

  if (reader.u32(0, false) !== 0x7F454C46) return { ok: false, problem: 'not an ELF file' }
  if (reader.u8(4) !== 2) return { ok: false, problem: 'not a 64-bit ELF file' }
  if (reader.u8(5) !== 1) return { ok: false, problem: 'not a little-endian ELF file' }

  const machine = reader.u16(18)
  const phoff = reader.u64(0x20)
  const phentsize = reader.u16(0x36)
  const phnum = reader.u16(0x38)
  if (machine === undefined || phoff === undefined || phentsize === undefined || phnum === undefined) {
    return { ok: false, problem: 'truncated ELF header' }
  }
  if (phentsize < 56) return { ok: false, problem: `implausible ELF program header size (${phentsize})` }

  const loads = []
  let dynamic
  let hasRelro = false
  let hasGnuProperty = false
  let gnuStackExecutable = false
  let hasGnuStack = false

  for (let index = 0; index < phnum; index += 1) {
    const entry = phoff + index * phentsize
    const type = reader.u32(entry)
    const flags = reader.u32(entry + 4)
    const offset = reader.u64(entry + 8)
    const vaddr = reader.u64(entry + 16)
    const filesz = reader.u64(entry + 32)
    if (type === undefined || flags === undefined || offset === undefined ||
        vaddr === undefined || filesz === undefined) {
      return { ok: false, problem: 'truncated ELF program header table' }
    }

    if (type === PT_LOAD) loads.push({ offset, vaddr, filesz })
    else if (type === PT_DYNAMIC) dynamic = { offset, filesz }
    else if (type === PT_GNU_RELRO) hasRelro = true
    else if (type === PT_GNU_PROPERTY) hasGnuProperty = true
    else if (type === PT_GNU_STACK) {
      hasGnuStack = true
      gnuStackExecutable = (flags & 0x1) !== 0
    }
  }

  // Virtual address to file offset, through whichever PT_LOAD contains it.
  // A dynamic-section pointer that resolves through none of them is the
  // malformed case that would otherwise read past the end of the buffer.
  const toOffset = (vaddr) => {
    for (const load of loads) {
      if (vaddr >= load.vaddr && vaddr < load.vaddr + load.filesz) {
        return load.offset + (vaddr - load.vaddr)
      }
    }
    return undefined
  }

  const result = {
    ok: true,
    machine,
    hasRelro,
    hasGnuProperty,
    hasGnuStack,
    gnuStackExecutable,
    bindNow: false,
    needed: [],
    maxGlibc: null,
    hasStackChk: false,
    hasSymtab: false,
    hasDebugSections: false
  }

  if (dynamic) {
    const neededOffsets = []
    let strtabVaddr
    let strsz = 0
    let verneedVaddr
    let verneednum = 0
    let flags = 0
    let flags1 = 0
    let sawBindNow = false

    const end = dynamic.offset + dynamic.filesz
    for (let at = dynamic.offset; at + 16 <= end; at += 16) {
      const tag = reader.u64(at)
      const value = reader.u64(at + 8)
      if (tag === undefined || value === undefined) {
        return { ok: false, problem: 'truncated ELF dynamic section' }
      }
      if (tag === DT_NULL) break
      if (tag === DT_NEEDED) neededOffsets.push(value)
      else if (tag === DT_STRTAB) strtabVaddr = value
      else if (tag === DT_STRSZ) strsz = value
      else if (tag === DT_BIND_NOW) sawBindNow = true
      else if (tag === DT_FLAGS) flags = value
      else if (tag === DT_FLAGS_1) flags1 = value
      else if (tag === DT_VERNEED) verneedVaddr = value
      else if (tag === DT_VERNEEDNUM) verneednum = value
    }

    // Three encodings mean the same thing, and which one a linker emits depends
    // on its age and its defaults. Any of them is full RELRO.
    result.bindNow = sawBindNow || (flags & DF_BIND_NOW) !== 0 || (flags1 & DF_1_NOW) !== 0

    if (strtabVaddr !== undefined) {
      const strtab = toOffset(strtabVaddr)
      if (strtab === undefined) {
        return { ok: false, problem: 'ELF dynamic string table is outside every loadable segment' }
      }
      const limit = Math.min(strtab + strsz, buffer.length)

      for (const nameOffset of neededOffsets) {
        const name = reader.cstring(strtab + nameOffset, limit)
        if (name === undefined) return { ok: false, problem: 'ELF DT_NEEDED name runs past the string table' }
        result.needed.push(name)
      }

      // The canary symbol is looked for inside the dynamic string table rather
      // than in the whole file: an arbitrary byte match elsewhere would be a
      // false positive, and this survives `strip --strip-all`, which is the
      // state every shipped binary is in.
      if (strsz > 0) {
        result.hasStackChk = buffer.includes('__stack_chk_fail\0', strtab, 'latin1') &&
          buffer.indexOf('__stack_chk_fail\0', strtab, 'latin1') < limit
      }

      // Highest glibc symbol version required, which is the real floor -- the
      // README's "glibc 2.28" claim is otherwise checked nowhere.
      if (verneedVaddr !== undefined && verneednum > 0) {
        const versions = []
        let at = toOffset(verneedVaddr)
        for (let index = 0; index < verneednum && at !== undefined; index += 1) {
          const count = reader.u16(at + 2)
          const auxOffset = reader.u32(at + 8)
          const next = reader.u32(at + 12)
          if (count === undefined || auxOffset === undefined || next === undefined) break
          let aux = at + auxOffset
          for (let entry = 0; entry < count; entry += 1) {
            const nameOffset = reader.u32(aux + 8)
            const auxNext = reader.u32(aux + 12)
            if (nameOffset === undefined || auxNext === undefined) break
            const name = reader.cstring(strtab + nameOffset, limit)
            const match = name && /^GLIBC_(\d+)\.(\d+)$/.exec(name)
            if (match) versions.push([Number(match[1]), Number(match[2])])
            if (auxNext === 0) break
            aux += auxNext
          }
          if (next === 0) break
          at += next
        }
        if (versions.length > 0) {
          versions.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]))
          result.maxGlibc = versions[versions.length - 1].join('.')
        }
      }
    }
  }

  // Section headers, for the strip check. A binary that still has a symbol
  // table or .debug_* sections was shipped unstripped, which leaks build paths
  // and makes a "same image, same bytes" comparison meaningless.
  const shoff = reader.u64(40)
  const shentsize = reader.u16(58)
  const shnum = reader.u16(60)
  const shstrndx = reader.u16(62)
  if (shoff && shentsize && shnum) {
    const stringSection = shoff + shstrndx * shentsize
    const stringTable = reader.u64(stringSection + 24)
    for (let index = 0; index < shnum; index += 1) {
      const entry = shoff + index * shentsize
      const nameOffset = reader.u32(entry)
      const type = reader.u32(entry + 4)
      if (type === SHT_SYMTAB) result.hasSymtab = true
      if (stringTable !== undefined && nameOffset !== undefined) {
        const name = reader.cstring(stringTable + nameOffset)
        if (name && name.startsWith('.debug')) result.hasDebugSections = true
      }
    }
  }

  return result
}

/* -------------------------------------------------------------- Mach-O ---- */

const MH_MAGIC_64 = 0xFEEDFACF
const FAT_MAGIC = 0xCAFEBABE
const FAT_CIGAM = 0xBEBAFECA
const LC_VERSION_MIN_MACOSX = 0x24
const LC_BUILD_VERSION = 0x32

// "13.5" from the packed X.Y.Z the load commands carry.
export function formatMacosVersion (packed) {
  if (packed === undefined || packed === null) return null
  const patch = packed & 0xFF
  const minor = (packed >> 8) & 0xFF
  const major = (packed >> 16) & 0xFFFF
  return patch === 0 ? `${major}.${minor}` : `${major}.${minor}.${patch}`
}

export function parseMachO (buffer) {
  const reader = new Reader(buffer)

  const magic = reader.u32(0)
  // A universal binary IS Mach-O, so calling it corrupt would send the reader
  // hunting for a broken build instead of the stray `lipo` that made it.
  if (magic === FAT_MAGIC || magic === FAT_CIGAM) {
    return { ok: false, fat: true, problem: 'universal (fat) binary; each directory ships exactly one architecture' }
  }
  if (magic !== MH_MAGIC_64) return { ok: false, problem: 'not a Mach-O file' }

  const cpuType = reader.u32(4)
  const ncmds = reader.u32(16)
  if (cpuType === undefined || ncmds === undefined) return { ok: false, problem: 'truncated Mach-O header' }

  let minos = null
  let at = 32
  for (let index = 0; index < ncmds; index += 1) {
    const cmd = reader.u32(at)
    const cmdsize = reader.u32(at + 4)
    if (cmd === undefined || cmdsize === undefined || cmdsize < 8) {
      return { ok: false, problem: 'truncated Mach-O load command' }
    }
    // LC_BUILD_VERSION is what modern toolchains emit; LC_VERSION_MIN_MACOSX is
    // the older spelling of the same fact.
    if (cmd === LC_BUILD_VERSION) minos = reader.u32(at + 12) ?? minos
    else if (cmd === LC_VERSION_MIN_MACOSX && minos === null) minos = reader.u32(at + 8) ?? minos
    at += cmdsize
  }

  // Darwin prefixes C symbols with an underscore, so the canary the compiler
  // references is spelled ___stack_chk_fail. It is an undefined symbol resolved
  // by dyld, so it survives `strip -Sx` -- unlike on ELF there is no dynamic
  // string table to bound the search to, so this is a whole-file scan and
  // therefore weaker evidence than its ELF counterpart.
  const hasStackChk = buffer.includes('___stack_chk_fail', 0, 'latin1')

  return { ok: true, cpuType, minos, minosText: formatMacosVersion(minos), hasStackChk }
}
