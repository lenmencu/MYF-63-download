import { crc16 } from './crc16.ts'
import type { FwpkgImage } from './fwpkg.ts'
import { FlashCancelledError, type WebSerialPort } from '../serial/web-serial.ts'

const SOH = 0x01
const STX = 0x02
const EOT = 0x04
const ACK = 0x06
const NAK = 0x15
const CAN = 0x18
const CHAR_C = 0x43

const WAIT_C_TIMEOUT = 15_000
const ACK_TIMEOUT = 3_000
const XMIT_TIMEOUT = 60_000

export class YmodemError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'YmodemError'
  }
}

function be16(n: number): Uint8Array {
  return new Uint8Array([(n >> 8) & 0xff, n & 0xff])
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

async function waitChar(ser: WebSerialPort, expected: number, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    const remain = Math.max(10, deadline - performance.now())
    const b = await ser.readByte(remain)
    if (b === expected) return true
    if (b === CAN) throw new YmodemError('接收端取消 (CAN)')
  }
  return false
}

async function waitAck(ser: WebSerialPort, timeoutMs = ACK_TIMEOUT): Promise<boolean> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    const remain = Math.max(10, deadline - performance.now())
    const b = await ser.readByte(remain)
    if (b === ACK) return true
    if (b === NAK) return false
    if (b === CAN) throw new YmodemError('接收端取消 (CAN)')
  }
  return false
}

function headerBlock(name: string, size: number): Uint8Array {
  const payload = new Uint8Array(128)
  const encoded = new TextEncoder().encode(`${name}\0${size}\0`)
  payload.set(encoded.subarray(0, Math.min(encoded.length, 128)))
  return concat(new Uint8Array([SOH, 0x00, 0xff]), payload, be16(crc16(payload)))
}

function emptyHeader(): Uint8Array {
  const payload = new Uint8Array(128)
  return concat(new Uint8Array([SOH, 0x00, 0xff]), payload, be16(crc16(payload)))
}

function dataBlock(seq: number, chunk: Uint8Array): Uint8Array {
  const data = new Uint8Array(1024)
  data.set(chunk)
  const seqB = seq & 0xff
  return concat(new Uint8Array([STX, seqB, 0xff - seqB]), data, be16(crc16(data)))
}

async function sendBlock(ser: WebSerialPort, blk: Uint8Array, signal?: AbortSignal): Promise<void> {
  const deadline = performance.now() + XMIT_TIMEOUT
  while (performance.now() < deadline) {
    if (signal?.aborted) throw new FlashCancelledError()
    await ser.write(blk)
    if (await waitAck(ser)) return
  }
  throw new YmodemError('ymodem ACK 超时')
}

export async function sendImage(
  ser: WebSerialPort,
  image: FwpkgImage,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  try {
    if (!(await waitChar(ser, CHAR_C, WAIT_C_TIMEOUT))) {
      throw new YmodemError(`等待 Ymodem 'C' 超时 (${image.name})`)
    }
    await sendBlock(ser, headerBlock(image.name, image.length), signal)

    const totalBlk = image.length === 0 ? 0 : Math.ceil(image.length / 1024)
    let sentBlk = 0
    let offset = 0
    let seq = 1
    while (offset < image.length) {
      if (signal?.aborted) throw new FlashCancelledError()
      const n = Math.min(1024, image.length - offset)
      const chunk = image.bytes.subarray(offset, offset + n)
      await sendBlock(ser, dataBlock(seq, chunk), signal)
      offset += n
      seq = (seq + 1) & 0xff
      sentBlk += 1
      onProgress?.(sentBlk, totalBlk)
    }

    await ser.write(new Uint8Array([EOT]))
    const eotDeadline = performance.now() + XMIT_TIMEOUT
    let acked = false
    while (performance.now() < eotDeadline) {
      if (signal?.aborted) throw new FlashCancelledError()
      if (await waitAck(ser)) {
        acked = true
        break
      }
      await ser.write(new Uint8Array([EOT]))
    }
    if (!acked) throw new YmodemError('等待 EOT ACK 超时')

    await waitChar(ser, CHAR_C, 1000)
    await sendBlock(ser, emptyHeader(), signal)
  } catch (err) {
    if (err instanceof FlashCancelledError) {
      try {
        await ser.write(new Uint8Array([CAN, CAN]))
      } catch {
        /* ignore */
      }
    }
    throw err
  }
}
