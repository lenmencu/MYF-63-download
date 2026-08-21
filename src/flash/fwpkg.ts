import { crc16 } from './crc16.ts'

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
  return { magic, crc, count, totalSize, images }
}

export function loaderboot(pkg: Fwpkg): FwpkgImage | null {
  return pkg.images.find((img) => img.type === TYPE_LOADERBOOT) ?? null
}

export function flashImages(pkg: Fwpkg): FwpkgImage[] {
  return pkg.images.filter((img) => img.type === TYPE_FLASH)
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}
