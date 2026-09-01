export type MonitorDirection = 'rx' | 'tx'

export type MonitorLogEntry = {
  id: number
  direction: MonitorDirection
  text: string
}

export type MonitorNewline = 'none' | 'lf' | 'cr' | 'crlf'

const MONITOR_LOG_LIMIT = 200_000
const MONITOR_LOG_RETAIN = 160_000

const NEWLINE_BYTES: Record<MonitorNewline, Uint8Array> = {
  none: new Uint8Array(),
  lf: new Uint8Array([0x0a]),
  cr: new Uint8Array([0x0d]),
  crlf: new Uint8Array([0x0d, 0x0a]),
}

export function buildSerialPayload(text: string, newline: MonitorNewline): Uint8Array {
  const payload = new TextEncoder().encode(text)
  const ending = NEWLINE_BYTES[newline]
  const output = new Uint8Array(payload.length + ending.length)
  output.set(payload)
  output.set(ending, payload.length)
  return output
}

export function appendMonitorEntry(previous: MonitorLogEntry[], entry: MonitorLogEntry): MonitorLogEntry[] {
  const next = [...previous, entry]
  const total = next.reduce((length, item) => length + item.text.length, 0)
  if (total <= MONITOR_LOG_LIMIT) return next

  let discard = total - MONITOR_LOG_RETAIN
  const retained: MonitorLogEntry[] = []
  for (const item of next) {
    if (discard >= item.text.length) {
      discard -= item.text.length
      continue
    }
    if (discard > 0) {
      retained.push({ ...item, text: item.text.slice(discard) })
      discard = 0
    } else {
      retained.push(item)
    }
  }
  return retained
}
