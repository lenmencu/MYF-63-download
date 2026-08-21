import { crc16 } from './crc16.ts'
import { flashImages, loaderboot, type Fwpkg, type FwpkgImage } from './fwpkg.ts'
import { FlashCancelledError, sleep, type WebSerialPort } from '../serial/web-serial.ts'
import { sendImage } from './ymodem.ts'
import type { ChipFamily } from './chip.ts'

export const BOOT_BAUD = 115200
const PACKET_MAGIC = 0xdeadbeef
const ACK_TYPE = 0xe1
const ACK_SUCCESS = 0x5a
const CMD_HANDSHAKE = 0xf0
const CMD_DL_IMAGE = 0xd2
const CMD_RESET = 0x87
const ERASE_ALIGN = 0x2000
const FLOW_NONE = 0
const ACK_PREFIX = new Uint8Array([0xef, 0xbe, 0xad, 0xde, 0x0c, 0x00, ACK_TYPE, 0x1e])

export class HistoolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HistoolError'
  }
}

export type FlashProgress = {
  stage: string
  percent: number
}

export type FlashOptions = {
  baud: number
  family?: ChipFamily
  connectTimeoutMs?: number
  signal?: AbortSignal
  onLog?: (line: string) => void
  onProgress?: (info: FlashProgress) => void
}

function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) throw new FlashCancelledError()
}

function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n >>> 0, true)
  return b
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

function indexOf(hay: Uint8Array, needle: Uint8Array): number {
  if (needle.length > hay.length) return -1
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

function leftoverAfterAck(acc: Uint8Array): Uint8Array {
  const idx = indexOf(acc, ACK_PREFIX)
  if (idx < 0) return new Uint8Array(0)
  const frameLen = acc[idx + 4]! | (acc[idx + 5]! << 8)
  const end = idx + (frameLen >= 10 && frameLen <= 1036 ? frameLen : ACK_PREFIX.length)
  if (end >= acc.length) return new Uint8Array(0)
  const rest = acc.subarray(end)
  const out = new Uint8Array(rest.length)
  out.set(rest)
  return out
}

function buildFrame(cmd: number, payload: Uint8Array): Uint8Array {
  const packetSize = 8 + payload.length + 2
  const head = new Uint8Array(8)
  const view = new DataView(head.buffer)
  view.setUint32(0, PACKET_MAGIC, true)
  view.setUint16(4, packetSize, true)
  head[6] = cmd & 0xff
  head[7] = (cmd ^ 0xff) & 0xff
  const body = concat(head, payload)
  const csum = crc16(body)
  const tail = new Uint8Array(2)
  new DataView(tail.buffer).setUint16(0, csum, true)
  return concat(body, tail)
}

function parseFrame(buf: Uint8Array): { cmd: number; payload: Uint8Array } {
  if (buf.length < 10) throw new HistoolError('HiBurn 帧过短')
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const magic = view.getUint32(0, true)
  const packetSize = view.getUint16(4, true)
  const cmd = buf[6]!
  if (magic !== PACKET_MAGIC) throw new HistoolError(`坏魔数 0x${magic.toString(16)}`)
  if (packetSize > buf.length || packetSize < 10) {
    throw new HistoolError(`坏 packet_size ${packetSize}`)
  }
  const payload = buf.subarray(8, packetSize - 2)
  const csum = view.getUint16(packetSize - 2, true)
  const calc = crc16(buf.subarray(0, packetSize - 2))
  if (csum !== calc) {
    throw new HistoolError(`帧 CRC 不匹配 0x${csum.toString(16)} != 0x${calc.toString(16)}`)
  }
  return { cmd, payload }
}

function alignErase(length: number): number {
  if (length <= 0) return ERASE_ALIGN
  return Math.ceil(length / ERASE_ALIGN) * ERASE_ALIGN
}

async function sendCmd(ser: WebSerialPort, cmd: number, payload: Uint8Array): Promise<void> {
  await ser.write(buildFrame(cmd, payload))
}

async function readFrame(ser: WebSerialPort, timeoutMs: number): Promise<{ cmd: number; payload: Uint8Array }> {
  const magic = new Uint8Array([0xef, 0xbe, 0xad, 0xde])
  const buf: number[] = []
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    const remain = Math.max(10, deadline - performance.now())
    const b = await ser.readByte(remain)
    if (b == null) continue
    buf.push(b)
    if (buf.length < 4) {
      if (!magic.subarray(0, buf.length).every((v, i) => v === buf[i])) buf.length = 0
      continue
    }
    if (buf[0] !== magic[0] || buf[1] !== magic[1] || buf[2] !== magic[2] || buf[3] !== magic[3]) {
      buf.splice(0, buf.length - 3)
      continue
    }
    if (buf.length < 6) continue
    const framelen = buf[4]! | (buf[5]! << 8)
    if (framelen < 10 || framelen > 1036) {
      buf.length = 0
      continue
    }
    while (buf.length < framelen && performance.now() < deadline) {
      const more = await ser.read(framelen - buf.length, Math.max(10, deadline - performance.now()))
      for (const x of more) buf.push(x)
    }
    if (buf.length < framelen) throw new HistoolError('读 HiBurn 帧超时')
    return parseFrame(new Uint8Array(buf.slice(0, framelen)))
  }
  throw new HistoolError('等待 HiBurn 帧超时')
}

async function waitAck(ser: WebSerialPort, timeoutMs: number): Promise<Uint8Array> {
  const { cmd, payload } = await readFrame(ser, timeoutMs)
  if (cmd !== ACK_TYPE) throw new HistoolError(`期望 ACK，收到 cmd 0x${cmd.toString(16)}`)
  if (payload.length > 0 && payload[0] !== ACK_SUCCESS && payload[0] !== 0x00) {
    if (payload[0] === 0xa5) throw new HistoolError('设备 NACK (0xA5)')
  }
  return payload
}

async function handshake(
  ser: WebSerialPort,
  baud: number,
  connectTimeoutMs: number,
  onLog: (line: string) => void,
  family: ChipFamily,
  signal?: AbortSignal,
): Promise<void> {
  await ser.open(BOOT_BAUD)
  const payload = concat(u32le(baud), new Uint8Array([0x08, 0x01, 0x00, FLOW_NONE]))
  onLog(`等待 ROM 下载（超时 ${(connectTimeoutMs / 1000).toFixed(0)}s，目标 ${baud} baud）...`)
  const deadline = performance.now() + connectTimeoutMs

  const tryWindow = async (windowMs: number): Promise<Uint8Array | null> => {
    let acc = new Uint8Array(0)
    const end = performance.now() + windowMs
    while (performance.now() < end && performance.now() < deadline) {
      throwIfAborted(signal)
      await sendCmd(ser, CMD_HANDSHAKE, payload)
      await sleep(50, signal)
      const chunk = ser.readAvailable()
      if (chunk.length === 0) continue
      const next = new Uint8Array(acc.length + chunk.length)
      next.set(acc)
      next.set(chunk, acc.length)
      acc = next
      if (indexOf(acc, ACK_PREFIX) >= 0) return leftoverAfterAck(acc)
      if (acc.length > 4096) {
        const keep = acc.subarray(acc.length - 64)
        const trimmed = new Uint8Array(keep.length)
        trimmed.set(keep)
        acc = trimmed
      }
    }
    return null
  }

  const onHandshakeOk = async (rest: Uint8Array) => {
    if (rest.length > 0) ser.unread(rest)
    if (ser.baudRate === baud) {
      onLog('握手成功，保持当前波特率（不重开串口）')
      await ser.holdRtsLow()
      return
    }
    onLog(`握手成功，切换到 ${baud} baud（网页需重开串口）`)
    await ser.setBaudRate(baud)
    await ser.holdRtsLow()
    await sleep(300, signal)
    ser.clearInput()
  }

  if (family === 'bs2x') {
    onLog('F20/BS2X：先不拉 RTS，避免双串口板掉线...')
    const rest = await tryWindow(3000)
    if (rest) {
      await onHandshakeOk(rest)
      return
    }
    onLog('未进下载模式，改为 RTS 复位；也可手动按复位键')
  }

  while (performance.now() < deadline) {
    throwIfAborted(signal)
    await ser.pulseReset()
    ser.clearInput()
    const rest = await tryWindow(2000)
    if (rest) {
      await onHandshakeOk(rest)
      return
    }
  }
  throw new HistoolError('握手超时：请在烧录时按一下模组复位键后重试')
}

async function loadLoaderboot(
  ser: WebSerialPort,
  image: FwpkgImage,
  onLog: (line: string) => void,
  onYmodem?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  onLog(`Ymodem 下装 loaderboot ${image.name} (${image.length} 字节)...`)
  await sendImage(ser, image, onYmodem, signal)
  try {
    await waitAck(ser, 10_000)
  } catch (err) {
    onLog(`loaderboot 后无 ACK（${err instanceof Error ? err.message : err}），继续`)
  }
  onLog('loaderboot 已运行')
  await sleep(200, signal)
}

async function downloadImage(
  ser: WebSerialPort,
  image: FwpkgImage,
  onLog: (line: string) => void,
  onYmodem?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const eraseSize = alignErase(image.length)
  const payload = concat(
    u32le(image.burnAddr),
    u32le(image.length),
    u32le(eraseSize),
    new Uint8Array([0x00, 0xff]),
  )
  onLog(
    `写 ${image.name} → 0x${image.burnAddr.toString(16).padStart(8, '0')} (${image.length} 字节)`,
  )
  ser.clearInput()
  await sendCmd(ser, CMD_DL_IMAGE, payload)
  throwIfAborted(signal)
  const eraseTimeout = eraseSize >= 0x100000 ? 120_000 : 30_000
  await waitAck(ser, eraseTimeout)
  // 不要清空缓冲：F20 loaderboot 常把 ACK 和 Ymodem 'C' 连发，清掉 'C' 就会一直等到超时。
  const pending = ser.inWaiting()
  if (pending > 0) {
    onLog(`擦除 ACK 后缓冲还有 ${pending} 字节，留给 Ymodem`)
  }
  await sendImage(ser, image, onYmodem, signal)
  try {
    await waitAck(ser, 8000)
  } catch {
    /* histool also ignores missing ACK here */
  }
  await sleep(100, signal)
}

async function resetChip(ser: WebSerialPort, onLog: (line: string) => void): Promise<void> {
  onLog('复位（协议 + RTS）')
  try {
    await sendCmd(ser, CMD_RESET, new Uint8Array([0x00, 0x00]))
    try {
      await waitAck(ser, 3000)
    } catch {
      /* ignore */
    }
  } catch (err) {
    onLog(`协议复位失败（${err instanceof Error ? err.message : err}），改用 RTS`)
  }
  try {
    await ser.pulseReset()
  } catch {
    /* ignore */
  }
}

export async function flashFwpkg(
  ser: WebSerialPort,
  pkg: Fwpkg,
  options: FlashOptions,
): Promise<void> {
  const onLog = options.onLog ?? (() => undefined)
  const onProgress = options.onProgress ?? (() => undefined)
  const loader = loaderboot(pkg)
  if (!loader) throw new HistoolError('fwpkg 中没有 loaderboot（type 0）')
  const images = flashImages(pkg)
  if (images.length === 0) throw new HistoolError('fwpkg 中没有可写 Flash 镜像')

  const loaderWeight = loader.length
  const flashWeight = images.reduce((n, img) => n + img.length, 0)
  const totalWeight = loaderWeight + flashWeight
  let doneWeight = 0
  const report = (stage: string, extra = 0) => {
    const pct = totalWeight <= 0 ? 0 : Math.min(99, Math.round(((doneWeight + extra) / totalWeight) * 95) + 3)
    onProgress({ stage, percent: pct })
  }

  onProgress({ stage: '握手', percent: 2 })
  throwIfAborted(options.signal)
  await handshake(
    ser,
    options.baud,
    options.connectTimeoutMs ?? 15_000,
    onLog,
    options.family ?? 'ws63',
    options.signal,
  )

  report('下装 loaderboot')
  await loadLoaderboot(ser, loader, onLog, (done, total) => {
    const extra = total > 0 ? (done / total) * loader.length : 0
    report('下装 loaderboot', extra)
  }, options.signal)
  doneWeight += loader.length

  for (const img of images) {
    throwIfAborted(options.signal)
    report(`写入 ${img.name}`)
    await downloadImage(ser, img, onLog, (done, total) => {
      const extra = total > 0 ? (done / total) * img.length : 0
      report(`写入 ${img.name}`, extra)
    }, options.signal)
    doneWeight += img.length
  }

  await resetChip(ser, onLog)
  onProgress({ stage: '完成', percent: 100 })
  onLog('烧录完成')
}
