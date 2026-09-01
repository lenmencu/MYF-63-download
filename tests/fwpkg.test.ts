import assert from 'node:assert/strict'
import test from 'node:test'
import { crc16 } from '../src/flash/crc16.ts'
import {
  inspectFwpkg,
  parseFwpkg,
  validateFwpkgForChip,
  type Fwpkg,
} from '../src/flash/fwpkg.ts'

type Partition = {
  name: string
  type: number
  burnAddr: number
  burnSize?: number
  length?: number
}

function packageBytes(partitions: Partition[]): ArrayBuffer {
  const headerSize = 12
  const infoSize = 52
  const tableSize = headerSize + infoSize * partitions.length
  const payloadLength = partitions.reduce((size, partition) => size + (partition.length ?? 32) + 16, 0)
  const bytes = new Uint8Array(tableSize + payloadLength)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0xefbeaddf, true)
  view.setUint16(6, partitions.length, true)
  view.setUint32(8, bytes.length, true)

  let payloadOffset = tableSize
  partitions.forEach((partition, index) => {
    const length = partition.length ?? 32
    const offset = headerSize + index * infoSize
    bytes.set(new TextEncoder().encode(partition.name).subarray(0, 31), offset)
    view.setUint32(offset + 32, payloadOffset, true)
    view.setUint32(offset + 36, length, true)
    view.setUint32(offset + 40, partition.burnAddr, true)
    view.setUint32(offset + 44, partition.burnSize ?? length, true)
    view.setUint32(offset + 48, partition.type, true)
    bytes.fill(index + 1, payloadOffset, payloadOffset + length)
    payloadOffset += length + 16
  })
  view.setUint16(4, crc16(bytes.subarray(6, tableSize)), true)
  return bytes.buffer
}

function parse(name: string, partitions: Partition[]): Fwpkg {
  return parseFwpkg(packageBytes(partitions), name)
}

test('accepts a complete WS63 package and rejects it for BS20', () => {
  const pkg = parse('ws63-demo_all.fwpkg', [
    { name: 'root_loaderboot_sign.bin', type: 0, burnAddr: 0 },
    { name: 'root_params_sign.bin', type: 1, burnAddr: 0x00200000 },
    { name: 'ssb_sign.bin', type: 1, burnAddr: 0x00202000 },
    { name: 'flashboot_sign.bin', type: 1, burnAddr: 0x00220000 },
    { name: 'ws63-demo-sign.bin', type: 1, burnAddr: 0x00230000 },
  ])
  const inspection = inspectFwpkg(pkg)
  assert.equal(inspection.detectedFamily, 'ws63')
  assert.equal(inspection.fullPackage, true)
  assert.deepEqual(inspection.errors, [])
  assert.match(validateFwpkgForChip(pkg, 'bs20').errors.join('\n'), /拒绝烧录/)
})

test('uses the developer-selected BS2X chip instead of inferring it from names', () => {
  const pkg = parse('bs20_all.fwpkg', [
    { name: 'loaderboot_sign.bin', type: 0, burnAddr: 0 },
    { name: 'partition.bin', type: 1, burnAddr: 0x90100000 },
    { name: 'flashboot_sign_a.bin', type: 1, burnAddr: 0x90101000 },
    { name: 'application_sign.bin', type: 1, burnAddr: 0x90115000 },
    { name: 'bs20_all_nv.bin', type: 1, burnAddr: 0x901fe000 },
  ])
  for (const chip of ['bs20', 'bs21', 'bs21e'] as const) {
    const inspection = validateFwpkgForChip(pkg, chip)
    assert.equal(inspection.detectedFamily, 'bs2x')
    assert.deepEqual(inspection.errors, [])
  }
})

test('blocks load-only packages, corrupt CRCs and overlapping flash ranges', () => {
  const loadOnly = parse('ws63-demo_load_only.fwpkg', [
    { name: 'root_loaderboot_sign.bin', type: 0, burnAddr: 0 },
    { name: 'ws63-demo-sign.bin', type: 1, burnAddr: 0x00230000 },
  ])
  assert.match(inspectFwpkg(loadOnly).errors.join('\n'), /只允许完整/)

  const corrupt = new Uint8Array(packageBytes([
    { name: 'loaderboot_sign.bin', type: 0, burnAddr: 0 },
  ]))
  corrupt[12] ^= 0xff
  assert.throws(() => parseFwpkg(corrupt.buffer, 'bad.fwpkg'), /CRC 不匹配/)

  const overlap = parse('bs20_all.fwpkg', [
    { name: 'loaderboot_sign.bin', type: 0, burnAddr: 0 },
    { name: 'partition.bin', type: 1, burnAddr: 0x90100000, burnSize: 0x4000 },
    { name: 'flashboot_sign_a.bin', type: 1, burnAddr: 0x90102000 },
    { name: 'application_sign.bin', type: 1, burnAddr: 0x90115000 },
    { name: 'bs20_all_nv.bin', type: 1, burnAddr: 0x901fe000 },
  ])
  assert.match(inspectFwpkg(overlap).errors.join('\n'), /Flash 区域重叠/)
})
