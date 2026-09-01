import { crc16 } from './crc16.ts'
import { chipProfile, type ChipFamily, type ChipId } from './chip.ts'

export const TYPE_LOADERBOOT = 0
export const TYPE_FLASH = 1

const FWPKG_MAGIC = 0xefbeaddf
const MAX_IMAGES = 16
const HEADER_SIZE = 12
const IMAGE_INFO_SIZE = 52

export type FwpkgImage = {
  name: string
  offset: number
  length: number
  burnAddr: number
  burnSize: number
  type: number
  bytes: Uint8Array
}

export type Fwpkg = {
  fileName: string
  fileSize: number
  magic: number
  crc: number
  count: number
  totalSize: number
  images: FwpkgImage[]
}

function u16(view: DataView, offset: number): number {
  return view.getUint16(offset, true)
}

function u32(view: DataView, offset: number): number {
  return view.getUint32(offset, true)
}

function cString(bytes: Uint8Array): string {
  const z = bytes.indexOf(0)
  const slice = z >= 0 ? bytes.subarray(0, z) : bytes
  return new TextDecoder('ascii').decode(slice)
}

export function parseFwpkg(buf: ArrayBuffer, fileName: string): Fwpkg {
  if (buf.byteLength < HEADER_SIZE) {
    throw new Error('fwpkg 文件头过短')
  }
  const view = new DataView(buf)
  const magic = u32(view, 0)
  const crc = u16(view, 4)
  const count = u16(view, 6)
  const totalSize = u32(view, 8)
  if (magic !== FWPKG_MAGIC) {
    throw new Error(`无效 fwpkg 魔数 0x${magic.toString(16)}`)
  }
  if (count > MAX_IMAGES) {
    throw new Error(`镜像数量过多: ${count}`)
  }
  const tableLen = HEADER_SIZE + count * IMAGE_INFO_SIZE
  if (buf.byteLength < tableLen) {
    throw new Error('fwpkg 分区表不完整')
  }
  const table = new Uint8Array(buf, 0, tableLen)
  const got = crc16(table.subarray(6))
  if (got !== crc) {
    throw new Error(
      `fwpkg CRC 不匹配: file=0x${crc.toString(16)} calc=0x${got.toString(16)}`,
    )
  }
  if (totalSize !== buf.byteLength) {
    throw new Error(`fwpkg 总长度不匹配: header=${totalSize} file=${buf.byteLength}`)
  }

  const images: FwpkgImage[] = []
  const raw = new Uint8Array(buf)
  for (let i = 0; i < count; i++) {
    const off = HEADER_SIZE + i * IMAGE_INFO_SIZE
    const iv = new DataView(buf, off, IMAGE_INFO_SIZE)
    const name = cString(new Uint8Array(buf, off, 32))
    const offset = iv.getUint32(32, true)
    const length = iv.getUint32(36, true)
    const burnAddr = iv.getUint32(40, true)
    const burnSize = iv.getUint32(44, true)
    const type = iv.getUint32(48, true)
    if (length === 0) {
      throw new Error(`镜像 ${name || i} 长度为 0`)
    }
    if (offset < tableLen) {
      throw new Error(`镜像 ${name || i} 与 fwpkg 分区表重叠`)
    }
    if (offset + length > raw.length) {
      throw new Error(`镜像 ${name || i} 超出文件范围`)
    }
    images.push({
      name: name || `${fileName}#${i}`,
      offset,
      length,
      burnAddr,
      burnSize,
      type,
      bytes: raw.subarray(offset, offset + length),
    })
  }

  const byOffset = [...images].sort((a, b) => a.offset - b.offset)
  for (let i = 1; i < byOffset.length; i++) {
    const previous = byOffset[i - 1]!
    const current = byOffset[i]!
    if (previous.offset + previous.length > current.offset) {
      throw new Error(`镜像 ${previous.name} 与 ${current.name} 的文件数据重叠`)
    }
  }

  return { fileName, fileSize: buf.byteLength, magic, crc, count, totalSize, images }
}

export function loaderboot(pkg: Fwpkg): FwpkgImage | null {
  return pkg.images.find((img) => img.type === TYPE_LOADERBOOT) ?? null
}

export function flashImages(pkg: Fwpkg): FwpkgImage[] {
  return pkg.images.filter((img) => img.type === TYPE_FLASH)
}

export type FwpkgInspection = {
  detectedFamily: ChipFamily | null
  fullPackage: boolean
  errors: string[]
  warnings: string[]
}

function familyFromAddress(address: number): ChipFamily | null {
  if (address >= 0x90000000 && address < 0xa0000000) return 'bs2x'
  if (address < 0x01000000) return 'ws63'
  return null
}

function fullPackageByContents(pkg: Fwpkg, family: ChipFamily | null): boolean {
  const flash = flashImages(pkg)
  const names = flash.map((image) => image.name.toLowerCase())
  if (family === 'ws63') {
    return (
      flash.length >= 4 &&
      names.some((name) => name.includes('param')) &&
      names.some((name) => name.includes('ssb')) &&
      names.some((name) => name.includes('flashboot'))
    )
  }
  if (family === 'bs2x') {
    return (
      flash.length >= 4 &&
      names.some((name) => name.includes('partition')) &&
      names.some((name) => name.includes('flashboot')) &&
      names.some((name) => name.includes('application')) &&
      names.some((name) => name.includes('_nv'))
    )
  }
  return false
}

export function inspectFwpkg(pkg: Fwpkg): FwpkgInspection {
  const errors: string[] = []
  const warnings: string[] = []
  const loaders = pkg.images.filter((image) => image.type === TYPE_LOADERBOOT)
  const flash = flashImages(pkg)
  const unsupported = pkg.images.filter((image) => image.type !== TYPE_LOADERBOOT && image.type !== TYPE_FLASH)

  if (loaders.length !== 1) errors.push(`完整固件必须有且只有一个 loaderboot，当前为 ${loaders.length} 个`)
  if (flash.length === 0) errors.push('固件中没有可写入的 Flash 镜像')
  if (unsupported.length > 0) {
    errors.push(`暂不支持分区类型：${[...new Set(unsupported.map((image) => image.type))].join('、')}`)
  }

  const addressFamilies = new Set<ChipFamily>()
  for (const image of flash) {
    const family = familyFromAddress(image.burnAddr)
    if (!family) {
      errors.push(`${image.name} 的烧录地址 0x${image.burnAddr.toString(16)} 不属于已知 WS63/BS2X 区域`)
      continue
    }
    addressFamilies.add(family)
    const reserved = image.burnSize || image.length
    if (reserved < image.length) {
      errors.push(`${image.name} 的 burnSize 小于镜像长度`)
    }
    if (image.burnAddr + reserved > 0x1_0000_0000) {
      errors.push(`${image.name} 的烧录范围超过 32 位地址空间`)
    }
  }
  if (addressFamilies.size > 1) errors.push('固件同时包含 WS63 与 BS2X 地址，拒绝烧录')
  const detectedFamily = addressFamilies.size === 1 ? [...addressFamilies][0]! : null

  const byAddress = [...flash].sort((a, b) => a.burnAddr - b.burnAddr)
  for (let i = 1; i < byAddress.length; i++) {
    const previous = byAddress[i - 1]!
    const current = byAddress[i]!
    const previousEnd = previous.burnAddr + (previous.burnSize || previous.length)
    if (previousEnd > current.burnAddr) {
      errors.push(`${previous.name} 与 ${current.name} 的 Flash 区域重叠`)
    }
  }

  const duplicateNames = pkg.images
    .map((image) => image.name)
    .filter((name, index, all) => all.indexOf(name) !== index)
  if (duplicateNames.length > 0) warnings.push(`固件中存在重名镜像：${[...new Set(duplicateNames)].join('、')}`)

  const fullPackage = loaders.length === 1 && fullPackageByContents(pkg, detectedFamily)
  if (!fullPackage) errors.push('当前只允许完整 .fwpkg；该文件缺少完整启动链、应用或 NV/参数分区')

  return { detectedFamily, fullPackage, errors, warnings }
}

export function validateFwpkgForChip(pkg: Fwpkg, selectedChip: ChipId): FwpkgInspection {
  const inspection = inspectFwpkg(pkg)
  const selected = chipProfile(selectedChip)
  if (inspection.detectedFamily && inspection.detectedFamily !== selected.family) {
    inspection.errors.push(
      `已选择 ${selected.label}，但固件地址属于 ${inspection.detectedFamily.toUpperCase()}，拒绝烧录`,
    )
  }
  return inspection
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}
