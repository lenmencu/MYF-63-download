export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new FlashCancelledError())
      return
    }
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      window.clearTimeout(timer)
      reject(new FlashCancelledError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

export class SerialError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SerialError'
  }
}

export class FlashCancelledError extends Error {
  constructor(message = '已取消烧录') {
    super(message)
    this.name = 'FlashCancelledError'
  }
}

export class WebSerialPort {
  private port: SerialPort
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  private chunks: Uint8Array[] = []
  private chunkOffset = 0
  private queued = 0
  private waiters: Array<() => void> = []
  private pumping = false
  private openFlag = false
  private pumpTask: Promise<void> | null = null
  private signal: AbortSignal | null = null
  private currentBaud = 0
  private unbindAbort: (() => void) | null = null
  private pumpError: Error | null = null

  constructor(port: SerialPort) {
    this.port = port
  }

  get baudRate(): number {
    return this.currentBaud
  }

  get isOpen(): boolean {
    return this.openFlag
  }

  get abortSignal(): AbortSignal | null {
    return this.signal
  }

  bindAbort(signal: AbortSignal): void {
    this.unbindAbort?.()
    this.signal = signal
    const onAbort = () => this.notify()
    signal.addEventListener('abort', onAbort)
    this.unbindAbort = () => signal.removeEventListener('abort', onAbort)
  }

  private ensureRunning(): void {
    if (this.signal?.aborted) throw new FlashCancelledError()
    if (this.pumpError) throw this.pumpError
  }

  inWaiting(): number {
    return this.queued
  }

  async open(baudRate: number): Promise<void> {
    if (this.openFlag) await this.close()
    await this.port.open({
      baudRate,
      bufferSize: 2 * 1024 * 1024,
      flowControl: 'none',
    })
    if (!this.port.readable || !this.port.writable) {
      throw new SerialError('串口打开后没有可读/可写流')
    }
    this.writer = this.port.writable.getWriter()
    this.openFlag = true
    this.currentBaud = baudRate
    this.pumpError = null
    this.clearInput()
    this.pumping = true
    this.pumpTask = this.pump()
    await this.holdRtsLow()
  }

  async setBaudRate(baudRate: number): Promise<void> {
    this.ensureRunning()
    if (this.openFlag && this.currentBaud === baudRate) return
    await this.holdRtsLow()
    await this.stopIo()
    await this.port.close()
    this.openFlag = false
    await this.open(baudRate)
  }

  async close(): Promise<void> {
    await this.stopIo()
    if (this.openFlag) {
      try {
        await this.port.close()
      } catch {
        /* already closed */
      }
      this.openFlag = false
      this.currentBaud = 0
    }
    this.unbindAbort?.()
    this.unbindAbort = null
    this.signal = null
  }

  async write(data: Uint8Array): Promise<void> {
    this.ensureRunning()
    if (!this.writer) throw new SerialError('串口未打开')
    await this.writer.write(data)
  }

  async flush(): Promise<void> {
    /* Web Serial writes are awaited; nothing extra to flush. */
  }

  clearInput(): void {
    this.chunks = []
    this.chunkOffset = 0
    this.queued = 0
  }

  unread(data: Uint8Array): void {
    if (data.length === 0) return
    if (this.chunkOffset > 0 && this.chunks.length > 0) {
      this.chunks[0] = this.chunks[0]!.subarray(this.chunkOffset)
      this.chunkOffset = 0
    }
    const copy = new Uint8Array(data.length)
    copy.set(data)
    this.chunks.unshift(copy)
    this.queued += copy.length
    this.notify()
  }

  readAvailable(): Uint8Array {
    return this.take(this.queued)
  }

  async readByte(timeoutMs: number): Promise<number | null> {
    const buf = await this.read(1, timeoutMs)
    return buf.length === 0 ? null : buf[0]!
  }

  async read(n: number, timeoutMs: number): Promise<Uint8Array> {
    const deadline = performance.now() + timeoutMs
    while (this.queued < n) {
      this.ensureRunning()
      const remain = deadline - performance.now()
      if (remain <= 0) break
      await this.wait(remain)
    }
    this.ensureRunning()
    const count = Math.min(n, this.queued)
    return this.take(count)
  }

  async readExact(n: number, timeoutMs: number): Promise<Uint8Array> {
    const got = await this.read(n, timeoutMs)
    if (got.length < n) throw new SerialError('读串口超时')
    return got
  }

  async holdRtsLow(): Promise<boolean> {
    try {
      await this.port.setSignals({ dataTerminalReady: false, requestToSend: false })
      return true
    } catch {
      return false
    }
  }

  async pulseReset(): Promise<boolean> {
    try {
      await this.port.setSignals({ dataTerminalReady: false, requestToSend: true })
      await sleep(100)
      await this.port.setSignals({ dataTerminalReady: false, requestToSend: false })
      await sleep(50)
      return true
    } catch {
      return false
    }
  }

  private notify(): void {
    const pending = this.waiters
    this.waiters = []
    for (const fn of pending) fn()
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        this.waiters = this.waiters.filter((fn) => fn !== done)
        resolve()
      }, ms)
      const done = () => {
        window.clearTimeout(timer)
        resolve()
      }
      this.waiters.push(done)
    })
  }

  private take(n: number): Uint8Array {
    const out = new Uint8Array(n)
    let filled = 0
    while (filled < n && this.chunks.length > 0) {
      const cur = this.chunks[0]!
      const avail = cur.length - this.chunkOffset
      const copy = Math.min(avail, n - filled)
      out.set(cur.subarray(this.chunkOffset, this.chunkOffset + copy), filled)
      filled += copy
      this.chunkOffset += copy
      this.queued -= copy
      if (this.chunkOffset >= cur.length) {
        this.chunks.shift()
        this.chunkOffset = 0
      }
    }
    return out
  }

  private async pump(): Promise<void> {
    if (!this.port.readable) return
    this.reader = this.port.readable.getReader()
    try {
      while (this.pumping) {
        const { value, done } = await this.reader.read()
        if (done) break
        if (value && value.length > 0) {
          this.chunks.push(value)
          this.queued += value.length
          this.notify()
        }
      }
    } catch (err) {
      if (this.pumping) {
        this.pumpError = new SerialError(`串口读取失败：${err instanceof Error ? err.message : String(err)}`)
        this.notify()
      }
    } finally {
      if (this.pumping && !this.pumpError) {
        this.pumpError = new SerialError('串口设备已断开')
        this.notify()
      }
      try {
        this.reader.releaseLock()
      } catch {
        /* ignore */
      }
      this.reader = null
    }
  }

  private async stopIo(): Promise<void> {
    this.pumping = false
    this.notify()
    try {
      await this.reader?.cancel()
    } catch {
      /* ignore */
    }
    if (this.pumpTask) {
      await this.pumpTask
      this.pumpTask = null
    }
    try {
      this.writer?.releaseLock()
    } catch {
      /* ignore */
    }
    this.writer = null
    this.clearInput()
  }
}

const USB_NAMES: Record<number, string> = {
  0x0403: 'FTDI',
  0x067b: 'Prolific',
  0x10c4: 'CP210x',
  0x1a86: 'WCH',
  0x2341: 'Arduino',
  0x239a: 'Adafruit',
  0x2e8a: 'Raspberry Pi',
  0x303a: 'Espressif',
  0x0483: 'ST CDC',
  0x0525: 'USB CDC',
  0x1d6b: 'Linux USB',
  0x12d1: 'Huawei',
  0x2c7c: 'Quectel',
  0x10d6: 'HiSilicon',
}

function hex4(n: number): string {
  return n.toString(16).padStart(4, '0')
}

function deviceName(vid: number, pid: number): string {
  const key = `${hex4(vid)}:${hex4(pid)}`
  const named: Record<string, string> = {
    '1a86:7523': 'CH340',
    '1a86:5523': 'CH341',
    '1a86:55d2': 'CH342',
    '1a86:55d3': 'CH342',
    '1a86:55d4': 'CH342',
    '1a86:55da': 'CH343',
    '1a86:55d8': 'CH9102',
  }
  return named[key] ?? USB_NAMES[vid] ?? 'USB'
}

export function portLabel(port: SerialPort, index?: number): string {
  const info = port.getInfo()
  const n = index != null ? ` #${index + 1}` : ''
  if (info.usbVendorId != null) {
    const chip = deviceName(info.usbVendorId, info.usbProductId ?? 0)
    const pid = hex4(info.usbProductId ?? 0)
    return `${chip}${n} (${hex4(info.usbVendorId)}:${pid})`
  }
  return `串口设备${n}`
}

export async function listSerialPorts(): Promise<SerialPort[]> {
  if (!hasWebSerial() || !navigator.serial) return []
  return navigator.serial.getPorts()
}

export function serialEventPort(ev: Event): SerialPort | null {
  const e = ev as Event & { port?: SerialPort; target: EventTarget | null }
  if (e.port) return e.port
  if (e.target && typeof (e.target as SerialPort).getInfo === 'function') {
    return e.target as SerialPort
  }
  return null
}

export function hasWebSerial(): boolean {
  return typeof navigator !== 'undefined' && navigator.serial != null
}
