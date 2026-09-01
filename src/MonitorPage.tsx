import { useEffect, useRef, useState } from 'react'
import { AVAIL_BAUD } from './flash/chip.ts'
import { PortPicker } from './PortPicker.tsx'
import { hasWebSerial, portLabel, sleep, WebSerialPort } from './serial/web-serial.ts'
import {
  appendMonitorEntry,
  buildSerialPayload,
  type MonitorLogEntry,
  type MonitorNewline,
} from './ui/monitor-log.ts'

type Props = {
  ports: SerialPort[]
  port: SerialPort | null
  onSelectPort: (port: SerialPort) => void
  onAddPort: () => Promise<SerialPort>
  onRefreshPorts: () => Promise<SerialPort[]>
}

function stamp(): string {
  const d = new Date()
  const ms = String(d.getMilliseconds()).padStart(3, '0')
  return `${d.toLocaleTimeString('zh-CN', { hour12: false })}.${ms}`
}

export function MonitorPage({ ports, port, onSelectPort, onAddPort, onRefreshPorts }: Props) {
  const [open, setOpen] = useState(false)
  const [baud, setBaud] = useState(115200)
  const baudRef = useRef(115200)
  const [newline, setNewline] = useState<MonitorNewline>('crlf')
  const [autoScroll, setAutoScroll] = useState(true)
  const [timestamps, setTimestamps] = useState(true)
  const [text, setText] = useState('')
  const [log, setLog] = useState<MonitorLogEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [deviceLabel, setDeviceLabel] = useState('未连接')
  const sessionRef = useRef<WebSerialPort | null>(null)
  const decoderRef = useRef(new TextDecoder())
  const lineStartRef = useRef(true)
  const entryIdRef = useRef(0)
  const logBoxRef = useRef<HTMLPreElement>(null)
  const stopRef = useRef(false)
  const timestampsRef = useRef(timestamps)
  timestampsRef.current = timestamps
  baudRef.current = baud

  useEffect(() => {
    return () => {
      stopRef.current = true
      void sessionRef.current?.close()
    }
  }, [])

  useEffect(() => {
    if (!autoScroll) return
    const el = logBoxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [log, autoScroll])

  function appendBytes(bytes: Uint8Array) {
    if (bytes.length === 0) return
    let chunk = decoderRef.current.decode(bytes, { stream: true })
    if (timestampsRef.current) {
      let out = ''
      for (const ch of chunk) {
        if (lineStartRef.current) {
          out += `[${stamp()}] `
          lineStartRef.current = false
        }
        out += ch
        if (ch === '\n') lineStartRef.current = true
      }
      chunk = out
    }
    const entry = { id: ++entryIdRef.current, direction: 'rx' as const, text: chunk }
    setLog((prev) => appendMonitorEntry(prev, entry))
  }

  async function pump(io: WebSerialPort) {
    while (!stopRef.current && io.isOpen) {
      const data = io.inWaiting() > 0 ? io.readAvailable() : await io.read(1, 80)
      if (data.length) appendBytes(data)
    }
  }

  async function connect() {
    setError(null)
    try {
      const selected = port ?? (await onAddPort())
      setDeviceLabel(portLabel(selected))
      stopRef.current = false
      decoderRef.current = new TextDecoder()
      lineStartRef.current = true
      const io = new WebSerialPort(selected)
      await io.open(baudRef.current)
      sessionRef.current = io
      setOpen(true)
      void pump(io).catch((err: unknown) => {
        if (!stopRef.current) {
          setError(err instanceof Error ? err.message : String(err))
        }
      })
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotFoundError') return
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function disconnect() {
    stopRef.current = true
    const io = sessionRef.current
    sessionRef.current = null
    setOpen(false)
    await io?.close()
  }

  async function changeBaud(next: number) {
    const wasOpen = open
    setBaud(next)
    baudRef.current = next
    if (!wasOpen) return
    await disconnect()
    await sleep(80)
    await connect()
  }

  async function send() {
    const io = sessionRef.current
    if (!io || !open) return
    const command = text
    const out = buildSerialPayload(command, newline)
    try {
      await io.write(out)
      const ending = newline === 'none' ? '' : `  ⏎ ${newline === 'crlf' ? '\\r\\n' : `\\${newline === 'lf' ? 'n' : 'r'}`}`
      const entry = {
        id: ++entryIdRef.current,
        direction: 'tx' as const,
        text: `\n[${stamp()}]  TX › ${command}${ending}\n`,
      }
      setLog((prev) => appendMonitorEntry(prev, entry))
      setText('')
      setError(null)
    } catch (err) {
      setError(`发送失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function resetBoard() {
    const io = sessionRef.current
    if (!io || !open) return
    await io.pulseReset()
  }

  return (
    <div className="page-monitor">
      <section className="card monitor-card">
        <aside className="monitor-side">
          <header className="card-head">
            <h1>🖥️ 串口监视器</h1>
          </header>

          <PortPicker
            ports={ports}
            selected={port}
            disabled={open}
            onSelect={onSelectPort}
            onAdd={() => void onAddPort()}
            onRefresh={() => void onRefreshPorts()}
          />

          <div className="conn">
            <span className={open ? 'dot on' : 'dot'} />
            <span>{open ? `已连接 ${deviceLabel}` : port ? portLabel(port) : '未连接'}</span>
          </div>

          <div className="side-actions">
            {open ? (
              <button type="button" className="btn ghost" onClick={() => void disconnect()}>
                断开
              </button>
            ) : (
              <button type="button" className="btn primary" onClick={() => void connect()} disabled={!hasWebSerial()}>
                连接
              </button>
            )}
            <button type="button" className="btn ghost" disabled={!open} onClick={() => void resetBoard()}>
              复位
            </button>
          </div>

          <label className="field">
            <span className="label">📡 波特率</span>
            <select
              className="select"
              value={baud}
              onChange={(e) => void changeBaud(Number(e.target.value))}
            >
              {AVAIL_BAUD.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>

          <div className="field">
            <span className="label">发送换行</span>
            <div className="seg">
              {([
                ['none', '无'],
                ['lf', '\\n'],
                ['cr', '\\r'],
                ['crlf', '\\r\\n'],
              ] as const).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={newline === id ? 'seg-btn on' : 'seg-btn'}
                  onClick={() => setNewline(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <label className="toggle">
            <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
            自动滚动
          </label>
          <label className="toggle">
            <input type="checkbox" checked={timestamps} onChange={(e) => setTimestamps(e.target.checked)} />
            时间戳
          </label>

          <div className="side-actions">
            <button type="button" className="btn ghost" onClick={() => setLog([])}>
              🧹 清屏
            </button>
          </div>

          {error ? <p className="error-text">{error}</p> : null}
          {!hasWebSerial() ? (
            <p className="error-text">请使用 Chrome 或 Edge 打开本页。</p>
          ) : null}

          <div className="send-box">
            <input
              className="text-input"
              value={text}
              disabled={!open}
              placeholder={newline === 'crlf' ? '输入命令，回车发送（附加 \\r\\n）' : '输入命令，回车发送'}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void send()
                }
              }}
            />
            <button type="button" className="btn primary" disabled={!open} onClick={() => void send()}>
              发送
            </button>
          </div>
        </aside>

        <div className="monitor-log-wrap">
          <pre className="monitor-log" ref={logBoxRef}>
            {log.length > 0 ? (
              log.map((entry) => (
                <span className={`log-${entry.direction}`} key={entry.id}>
                  {entry.text}
                </span>
              ))
            ) : (
              <span className="log-placeholder">日志输出</span>
            )}
          </pre>
          {autoScroll && open ? <span className="stick-hint">已贴底</span> : null}
        </div>
      </section>
    </div>
  )
}
