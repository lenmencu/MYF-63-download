import { crc16 } from './crc16.ts'
import { flashImages, loaderboot, type Fwpkg, type FwpkgImage } from './fwpkg.ts'
import { FlashCancelledError, sleep, type WebSerialPort } from '../serial/web-serial.ts'
import { sendImage } from './ymodem.ts'

export const BOOT_BAUD = 115200
const PACKET_MAGIC = 0xdeadbeef
const ACK_TYPE = 0xe1
const ACK_SUCCESS = 0x5a
const CMD_HANDSHAKE = 0xf0
const CMD_SET_BAUDRATE = 0x5a
const CMD_DL_IMAGE = 0xd2
const CMD_RESET = 0x87
const ERASE_ALIGN = 0x2000
const FLOW_NONE = 0
const FRAME_MAGIC = new Uint8Array([0xef, 0xbe, 0xad, 0xde])

export class HistoolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HistoolError'
  }
}

export class FlashVerificationError extends HistoolError {
  readonly writeCompleted = true

  constructor(message: string) {
    super(message)
    this.name = 'FlashVerificationError'
  }
}

export type FlashProgress = {
  stage: string
  percent: number
}

export type FlashOptions = {
  baud: number
  connectTimeoutMs?: number
  bootVerifyTimeoutMs?: number
  signal?: AbortSignal
  onLog?: (line: string) => void
  onProgress?: (info: FlashProgress) => void
}

export type FlashResult = {
  bootLog: string
  bootVerified: true
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

export function buildBaudratePayload(baud: number): Uint8Array {
  return concat(u32le(baud), new Uint8Array([0x08, 0x01, 0x00, FLOW_NONE]))
}

export async function applyLoaderBaud(
  baud: number,
  sendBaudCommand: (payload: Uint8Array) => Promise<void>,
  waitForAck: () => Promise<void>,
  reopenSerial: (baud: number) => Promise<void>,
): Promise<boolean> {
  if (baud === BOOT_BAUD) return false
  await sendBaudCommand(buildBaudratePayload(baud))
  await waitForAck()
  await reopenSerial(baud)
  return true
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.length)
  copy.set(bytes)
  return copy
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

export function buildFrame(cmd: number, payload: Uint8Array): Uint8Array {
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

export function parseFrame(buf: Uint8Array): { cmd: number; payload: Uint8Array } {
  if (buf.length < 10) throw new HistoolError('HiBurn 帧过短')
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const magic = view.getUint32(0, true)
  const packetSize = view.getUint16(4, true)
  const cmd = buf[6]!
  const cmdInverse = buf[7]!
  if (magic !== PACKET_MAGIC) throw new HistoolError(`坏魔数 0x${magic.toString(16)}`)
  if (packetSize !== buf.length || packetSize < 10) {
    throw new HistoolError(`坏 packet_size ${packetSize}`)
  }
  if (cmdInverse !== ((cmd ^ 0xff) & 0xff)) throw new HistoolError('HiBurn 命令反码不匹配')
  const payload = buf.subarray(8, packetSize - 2)
  const csum = view.getUint16(packetSize - 2, true)
  const calc = crc16(buf.subarray(0, packetSize - 2))
  if (csum !== calc) {
    throw new HistoolError(`帧 CRC 不匹配 0x${csum.toString(16)} != 0x${calc.toString(16)}`)
  }
  return { cmd, payload }
}

function magicSuffix(bytes: Uint8Array): Uint8Array {
  const max = Math.min(FRAME_MAGIC.length - 1, bytes.length)
  for (let length = max; length > 0; length--) {
    const suffix = bytes.subarray(bytes.length - length)
    if (suffix.every((value, index) => value === FRAME_MAGIC[index])) return copyBytes(suffix)
  }
  return new Uint8Array(0)
}

export function extractFirstFrame(bytes: Uint8Array): { frame: Uint8Array | null; rest: Uint8Array } {
  const start = indexOf(bytes, FRAME_MAGIC)
  if (start < 0) return { frame: null, rest: magicSuffix(bytes) }
  const candidate = bytes.subarray(start)
  if (candidate.length < 6) return { frame: null, rest: copyBytes(candidate) }
  const frameLength = candidate[4]! | (candidate[5]! << 8)
  if (frameLength < 10 || frameLength > 1036) {
    return extractFirstFrame(candidate.subarray(1))
  }
  if (candidate.length < frameLength) return { frame: null, rest: copyBytes(candidate) }
  return {
    frame: copyBytes(candidate.subarray(0, frameLength)),
    rest: copyBytes(candidate.subarray(frameLength)),
  }
}

function alignErase(length: number): number {
  if (length <= 0) return ERASE_ALIGN
  return Math.ceil(length / ERASE_ALIGN) * ERASE_ALIGN
}

async function sendCmd(ser: WebSerialPort, cmd: number, payload: Uint8Array): Promise<void> {
  await ser.write(buildFrame(cmd, payload))
}

async function readFrame(ser: WebSerialPort, timeoutMs: number): Promise<{ cmd: number; payload: Uint8Array }> {
  const magic = FRAME_MAGIC
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
  validateAckPayload(payload)
  return payload
}

export async function acceptOptionalLoaderAck(waitForAck: () => Promise<void>): Promise<boolean> {
  try {
    await waitForAck()
    return true
  } catch (err) {
    if (err instanceof HistoolError) return false
    throw err
  }
}

function validateAckPayload(payload: Uint8Array): void {
  if (payload.length === 0) throw new HistoolError('设备 ACK 缺少状态码')
  if (payload[0] === 0xa5) throw new HistoolError('设备 NACK (0xA5)')
  if (payload[0] !== ACK_SUCCESS && payload[0] !== 0x00) {
    throw new HistoolError(`设备返回未知状态 0x${payload[0]!.toString(16).padStart(2, '0')}`)
  }
}

async function handshake(
  ser: WebSerialPort,
  connectTimeoutMs: number,
  onLog: (line: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  await ser.open(BOOT_BAUD)
  const payload = buildBaudratePayload(BOOT_BAUD)
  onLog(`等待 ROM 下载（超时 ${(connectTimeoutMs / 1000).toFixed(0)}s，固定 ${BOOT_BAUD} baud）...`)
  const deadline = performance.now() + connectTimeoutMs

  const tryWindow = async (windowMs: number): Promise<Uint8Array | null> => {
    let acc: Uint8Array = new Uint8Array(0)
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
      while (acc.length > 0) {
        const extracted = extractFirstFrame(acc)
        acc = extracted.rest
        if (!extracted.frame) break
        let frame: { cmd: number; payload: Uint8Array }
        try {
          frame = parseFrame(extracted.frame)
        } catch (err) {
          onLog(`忽略损坏的握手响应：${err instanceof Error ? err.message : err}`)
          continue
        }
        if (frame.cmd !== ACK_TYPE) continue
        validateAckPayload(frame.payload)
        return acc
      }
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
    onLog(`握手成功，保持 ${BOOT_BAUD} baud 下装 loaderboot`)
    await ser.holdRtsLow()
  }

  onLog('请现在按一下开发板复位键，页面会自动继续')
  const rest = await tryWindow(connectTimeoutMs)
  if (rest) {
    await onHandshakeOk(rest)
    return
  }
  throw new HistoolError('握手超时：没有检测到手动复位后的 ROM 响应')
}

async function switchLoaderBaud(
  ser: WebSerialPort,
  baud: number,
  onLog: (line: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (baud === BOOT_BAUD) {
    onLog(`Flash 下载保持 ${BOOT_BAUD} baud`)
    return
  }
  throwIfAborted(signal)
  ser.clearInput()
  onLog(`请求 loaderboot 切换 Flash 下载速率至 ${baud} baud...`)
  try {
    await applyLoaderBaud(
      baud,
      async (payload) => sendCmd(ser, CMD_SET_BAUDRATE, payload),
      async () => {
        await waitAck(ser, 3000)
      },
      async (nextBaud) => {
        await sleep(50, signal)
        await ser.setBaudRate(nextBaud)
      },
    )
  } catch (err) {
    throw new HistoolError(
      `下载波特率切换失败（${baud} baud）：${err instanceof Error ? err.message : String(err)}；请复位后选择 115200 重试`,
    )
  }
  await ser.holdRtsLow()
  await sleep(100, signal)
  ser.clearInput()
  onLog(`下载波特率已切换为 ${baud} baud`)
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
  const acknowledged = await acceptOptionalLoaderAck(async () => {
    await waitAck(ser, 10_000)
  })
  onLog(acknowledged ? 'loaderboot 已确认运行' : 'loaderboot 未返回附加 ACK，按兼容模式继续')
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
  onLog(`${image.name} 的 Ymodem 传输已由设备确认`)
  await sleep(100, signal)
}

function hasBootEvidence(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false
  let printable = 0
  for (const byte of bytes) {
    if (byte === 0x0a || byte === 0x0d || byte === 0x09 || (byte >= 0x20 && byte <= 0x7e)) printable += 1
  }
  return printable >= 4 && printable / bytes.length >= 0.5
}

async function collectBootLog(
  ser: WebSerialPort,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const chunks: Uint8Array[] = []
  let size = 0
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    throwIfAborted(signal)
    const pending = ser.inWaiting()
    const next = pending > 0 ? ser.readAvailable() : await ser.read(1, Math.min(150, deadline - performance.now()))
    if (next.length === 0) continue
    chunks.push(next)
    size += next.length
    const bytes = concat(...chunks)
    if (hasBootEvidence(bytes) && (bytes.includes(0x0a) || size >= 32)) {
      return new TextDecoder().decode(bytes).replaceAll('\0', '')
    }
    if (size >= 8192) break
  }
  const bytes = concat(...chunks)
  if (hasBootEvidence(bytes)) return new TextDecoder().decode(bytes).replaceAll('\0', '')
  throw new FlashVerificationError('镜像已经写入，但没有检测到有效启动日志；请检查日志串口或手动复位')
}

async function resetAndVerify(
  ser: WebSerialPort,
  timeoutMs: number,
  onLog: (line: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  onLog('镜像写入完成，发送协议复位')
  try {
    await sendCmd(ser, CMD_RESET, new Uint8Array([0x00, 0x00]))
    try {
      await waitAck(ser, 1000)
    } catch {
      /* Some loader versions reset before their ACK reaches the host. */
    }
  } catch (err) {
    onLog(`协议复位未确认：${err instanceof Error ? err.message : err}`)
  }

  await ser.setBaudRate(BOOT_BAUD)
  ser.clearInput()
  onLog('正在检查 115200 baud 启动日志；若无输出，请再按一下开发板复位键')
  return collectBootLog(ser, timeoutMs, signal)
}

export async function flashFwpkg(
  ser: WebSerialPort,
  pkg: Fwpkg,
  options: FlashOptions,
): Promise<FlashResult> {
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
    options.connectTimeoutMs ?? 30_000,
    onLog,
    options.signal,
  )

  report('下装 loaderboot')
  await loadLoaderboot(ser, loader, onLog, (done, total) => {
    const extra = total > 0 ? (done / total) * loader.length : 0
    report('下装 loaderboot', extra)
  }, options.signal)
  doneWeight += loader.length

  onProgress({ stage: '切换下载速率', percent: Math.max(4, Math.round((doneWeight / totalWeight) * 95) + 3) })
  await switchLoaderBaud(ser, options.baud, onLog, options.signal)

  for (const img of images) {
    throwIfAborted(options.signal)
    report(`写入 ${img.name}`)
    await downloadImage(ser, img, onLog, (done, total) => {
      const extra = total > 0 ? (done / total) * img.length : 0
      report(`写入 ${img.name}`, extra)
    }, options.signal)
    doneWeight += img.length
  }

  onProgress({ stage: '验证启动', percent: 99 })
  let bootLog: string
  try {
    bootLog = await resetAndVerify(
      ser,
      options.bootVerifyTimeoutMs ?? 15_000,
      onLog,
      options.signal,
    )
  } catch (err) {
    if (err instanceof FlashCancelledError || err instanceof FlashVerificationError) throw err
    throw new FlashVerificationError(
      `镜像已经写入，但启动验证失败：${err instanceof Error ? err.message : String(err)}`,
    )
  }
  onLog(`已检测到启动日志：${bootLog.trim().slice(0, 160)}`)
  onProgress({ stage: '完成', percent: 100 })
  onLog('烧录与启动验证完成')
  return { bootLog, bootVerified: true }
}
