interface SerialPortInfo {
  usbVendorId?: number
  usbProductId?: number
}

interface SerialOptions {
  baudRate: number
  dataBits?: 7 | 8
  stopBits?: 1 | 2
  parity?: 'none' | 'even' | 'odd'
  bufferSize?: number
  flowControl?: 'none' | 'hardware'
}

interface SerialOutputSignals {
  dataTerminalReady?: boolean
  requestToSend?: boolean
  break?: boolean
}

interface SerialPort extends EventTarget {
  readonly readable: ReadableStream<Uint8Array> | null
  readonly writable: WritableStream<Uint8Array> | null
  open(options: SerialOptions): Promise<void>
  close(): Promise<void>
  forget(): Promise<void>
  getInfo(): SerialPortInfo
  setSignals(signals: SerialOutputSignals): Promise<void>
}

interface Serial extends EventTarget {
  requestPort(options?: {
    filters?: Array<{ usbVendorId: number; usbProductId?: number }>
  }): Promise<SerialPort>
  getPorts(): Promise<SerialPort[]>
  addEventListener(
    type: 'connect' | 'disconnect',
    listener: (ev: Event) => void,
    options?: boolean | AddEventListenerOptions,
  ): void
  removeEventListener(
    type: 'connect' | 'disconnect',
    listener: (ev: Event) => void,
    options?: boolean | EventListenerOptions,
  ): void
}

interface Navigator {
  serial?: Serial
}
