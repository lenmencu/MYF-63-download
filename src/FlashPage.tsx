import { useCallback, useEffect, useRef, useState } from 'react'
import { CHIPS, detectChipFromName, AVAIL_BAUD, type ChipId } from './flash/chip.ts'
import { formatSize, parseFwpkg, type Fwpkg } from './flash/fwpkg.ts'
import { flashFwpkg } from './flash/hiburn.ts'
import { PortPicker } from './PortPicker.tsx'
import { FlashCancelledError, hasWebSerial, portLabel, WebSerialPort } from './serial/web-serial.ts'

type Props = {
  ports: SerialPort[]
  port: SerialPort | null
  onSelectPort: (port: SerialPort) => void
  onAddPort: () => Promise<SerialPort>
  onRefreshPorts: () => Promise<SerialPort[]>
  onBusy: (busy: boolean) => void
}

function nowStamp(): string {
  const d = new Date()
  return d.toLocaleTimeString('zh-CN', { hour12: false })
}

export function FlashPage({ ports, port, onSelectPort, onAddPort, onRefreshPorts, onBusy }: Props) {
  const [chip, setChip] = useState<ChipId>('ws63')
  const [fileName, setFileName] = useState<string | null>(null)
  const [pkg, setPkg] = useState<Fwpkg | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [percent, setPercent] = useState(0)
  const [stage, setStage] = useState('等待开始')
  const [flashing, setFlashing] = useState(false)
  const [baud, setBaud] = useState(1_000_000)
  const logRef = useRef<HTMLPreElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const ioRef = useRef<WebSerialPort | null>(null)

  const profile = CHIPS.find((c) => c.id === chip)!

  const log = useCallback((line: string) => {
    setLogs((prev) => [...prev.slice(-400), `${nowStamp()}  ${line}`])
  }, [])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [logs])

  async function loadFile(file: File) {
    setParseError(null)
    setPkg(null)
    setFileName(file.name)
    try {
      const buf = await file.arrayBuffer()
      const parsed = parseFwpkg(buf, file.name)
      setPkg(parsed)
      const detected = detectChipFromName(file.name)
      if (detected) {
        setChip(detected)
        const next = CHIPS.find((c) => c.id === detected)
        if (next) setBaud(next.baud)
      }
      log(`已解析 ${file.name}，${parsed.count} 个镜像，共 ${formatSize(parsed.totalSize)}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setParseError(msg)
      log(`解析失败：${msg}`)
    }
  }

  async function addPort() {
    try {
      const p = await onAddPort()
      log(`已选择 ${portLabel(p)}`)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotFoundError') return
      log(`选择串口失败：${err instanceof Error ? err.message : err}`)
    }
  }

  async function startFlash() {
    if (!port || !pkg || flashing) return
    const ac = new AbortController()
    abortRef.current = ac
    setFlashing(true)
    onBusy(true)
    setPercent(0)
    setStage('开始')
    const io = new WebSerialPort(port)
    io.bindAbort(ac.signal)
    ioRef.current = io
    try {
      log(`开始烧录 · ${profile.label} @ ${baud}`)
      await flashFwpkg(io, pkg, {
        baud,
        family: profile.family,
        signal: ac.signal,
        onLog: log,
        onProgress: (info) => {
          setPercent(info.percent)
          setStage(info.stage)
        },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setStage(err instanceof FlashCancelledError ? '已取消' : '失败')
      log(`${err instanceof FlashCancelledError ? '已取消' : '失败'}：${msg}`)
    } finally {
      ioRef.current = null
      abortRef.current = null
      try {
        await io.close()
      } catch {
        /* ignore */
      }
      setFlashing(false)
      onBusy(false)
    }
  }

  function cancelFlash() {
    abortRef.current?.abort()
  }

  const canFlash = port != null && pkg != null && !flashing && hasWebSerial()

  return (
    <div className="page-flash">
      <div className="flash-split">
        <section className="card flash-card">
          <header className="card-head">
            <h1>在线烧录</h1>
            <p>本地选择 .fwpkg，浏览器完成写入</p>
          </header>

          <div className="field">
            <span className="label">选择芯片</span>
            <div className="chip-row">
              {CHIPS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={item.id === chip ? 'chip-btn on' : 'chip-btn'}
                  disabled={flashing}
                  onClick={() => {
                    setChip(item.id)
                    setBaud(item.baud)
                  }}
                >
                  <strong>{item.label}</strong>
                  <small>{item.hint}</small>
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <span className="label">上传固件</span>
            <button
              type="button"
              className="dropzone"
              disabled={flashing}
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                const file = e.dataTransfer.files[0]
                if (file) void loadFile(file)
              }}
            >
              {fileName ? (
                <span className="file-chip">
                  {fileName}
                  {pkg ? ` · ${formatSize(pkg.totalSize)}` : ''}
                </span>
              ) : (
                <span>拖入或选择 .fwpkg</span>
              )}
            </button>
            <input
              ref={inputRef}
              type="file"
              accept=".fwpkg"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void loadFile(file)
                e.target.value = ''
              }}
            />
            {parseError ? <p className="error-text">{parseError}</p> : null}
          </div>

          <PortPicker
            ports={ports}
            selected={port}
            disabled={flashing}
            onSelect={onSelectPort}
            onAdd={() => void addPort()}
            onRefresh={() => void onRefreshPorts()}
          />

          <label className="field">
            <span className="label">下载波特率</span>
            <select
              className="select"
              disabled={flashing}
              value={baud}
              onChange={(e) => setBaud(Number(e.target.value))}
            >
              {AVAIL_BAUD.map((b) => (
                <option key={b} value={b}>
                  {b}
                  {b === 115200 ? '（网页推荐，不重开串口）' : ''}
                  {b === 500000 ? '（histool 桌面默认）' : ''}
                  {b === 1000000 ? '（F63 默认）' : ''}
                </option>
              ))}
            </select>
          </label>

          {profile.family === 'bs2x' ? (
            <p className="hint">
              F20 开发板是 CH342 双串口：请选 UART0 烧录口（SERIAL-A），不要选 AT 口（SERIAL-B）。网页默认
              115200，避免改波特率时关开串口把下载模式冲掉。
            </p>
          ) : null}

          <div className="flash-actions">
            <button type="button" className="btn primary flash-go" disabled={!canFlash} onClick={() => void startFlash()}>
              {flashing ? stage : '开始烧录'}
            </button>
            {flashing ? (
              <button type="button" className="btn ghost" onClick={cancelFlash}>
                取消烧录
              </button>
            ) : null}
          </div>
          <div className="bar">
            <div className="bar-fill" style={{ width: `${percent}%` }} />
          </div>
          <p className="hint">握手 115200 → {baud === 115200 ? '保持 115200' : baud.toLocaleString()} → Ymodem 写区</p>
          {!hasWebSerial() ? (
            <p className="error-text">当前浏览器不支持 Web Serial，请使用 Chrome 或 Edge，并在 localhost 或 HTTPS 下打开。</p>
          ) : null}
        </section>

        <aside className="art" aria-hidden="true">
          <ModuleArt />
        </aside>
      </div>

      <pre className="flash-log" ref={logRef}>
        {logs.length === 0 ? '日志将显示在这里。固件只在本地解析。' : logs.join('\n')}
      </pre>
    </div>
  )
}

function ModuleArt() {
  return (
    <svg viewBox="0 0 360 280" className="module-svg">
      <rect x="28" y="48" width="304" height="184" rx="18" fill="#e7ebef" />
      <rect x="48" y="68" width="264" height="144" rx="10" fill="#d8dee4" />
      <rect x="78" y="92" width="160" height="96" rx="6" fill="#6b8499" />
      <rect x="90" y="104" width="136" height="72" rx="3" fill="#5a7388" />
      <circle cx="118" cy="128" r="8" fill="#c5d2dc" />
      <circle cx="148" cy="128" r="8" fill="#c5d2dc" />
      <circle cx="178" cy="128" r="8" fill="#c5d2dc" />
      <rect x="108" y="150" width="100" height="8" rx="2" fill="#9aafbe" />
      <rect x="252" y="100" width="36" height="80" rx="4" fill="#9aa8b4" />
      <rect x="258" y="108" width="24" height="10" rx="2" fill="#eef2f5" />
      <rect x="258" y="124" width="24" height="10" rx="2" fill="#eef2f5" />
      <rect x="258" y="140" width="24" height="10" rx="2" fill="#eef2f5" />
    </svg>
  )
}
