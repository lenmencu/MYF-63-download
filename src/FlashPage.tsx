import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CHIPS, type ChipId } from './flash/chip.ts'
import { formatSize, parseFwpkg, validateFwpkgForChip, type Fwpkg } from './flash/fwpkg.ts'
import { BOOT_BAUD, FlashVerificationError, flashFwpkg } from './flash/hiburn.ts'
import { PortPicker } from './PortPicker.tsx'
import { FlashCancelledError, hasWebSerial, portLabel, WebSerialPort } from './serial/web-serial.ts'
import { beginFlashLog } from './ui/flash-log.ts'

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
  const logRef = useRef<HTMLPreElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const ioRef = useRef<WebSerialPort | null>(null)

  const profile = CHIPS.find((c) => c.id === chip)!
  const inspection = useMemo(() => (pkg ? validateFwpkgForChip(pkg, chip) : null), [pkg, chip])

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
    if (!port || !pkg || !inspection || inspection.errors.length > 0 || flashing) return
    const ac = new AbortController()
    abortRef.current = ac
    setFlashing(true)
    onBusy(true)
    setPercent(0)
    setStage('开始')
    setLogs(beginFlashLog(nowStamp(), profile.label, BOOT_BAUD))
    const io = new WebSerialPort(port)
    io.bindAbort(ac.signal)
    ioRef.current = io
    try {
      await flashFwpkg(io, pkg, {
        baud: BOOT_BAUD,
        connectTimeoutMs: profile.connectTimeoutMs,
        signal: ac.signal,
        onLog: log,
        onProgress: (info) => {
          setPercent(info.percent)
          setStage(info.stage)
        },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const result =
        err instanceof FlashCancelledError
          ? '已取消'
          : err instanceof FlashVerificationError
            ? '写入完成，启动待确认'
            : '失败'
      setStage(result)
      log(`${result}：${msg}`)
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

  const canFlash =
    port != null && pkg != null && inspection != null && inspection.errors.length === 0 && !flashing && hasWebSerial()

  return (
    <div className="page-flash">
      <div className="flash-split">
        <section className="card flash-card">
          <div className="flash-card-top">
            <header className="card-head">
              <h1>在线烧录</h1>
              <p>本地选择 .fwpkg，浏览器完成写入</p>
            </header>
          </div>

          <div className="field">
            <span className="label">选择芯片</span>
            <div className="chip-row">
              {CHIPS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={item.id === chip ? 'chip-btn on' : 'chip-btn'}
                  disabled={flashing}
                  onClick={() => setChip(item.id)}
                >
                  <strong>{item.label}</strong>
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
            {inspection?.errors.map((error) => (
              <p className="error-text" key={error}>
                {error}
              </p>
            ))}
            {inspection?.warnings.map((warning) => (
              <p className="hint" key={warning}>
                {warning}
              </p>
            ))}
          </div>

          <PortPicker
            ports={ports}
            selected={port}
            disabled={flashing}
            onSelect={onSelectPort}
            onAdd={() => void addPort()}
            onRefresh={() => void onRefreshPorts()}
          />

          <p className="hint">请选择正确的烧录口；点击开始烧录后，请按一次开发板复位键。</p>

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
          <p className="hint">
            握手 115200 → 保持串口连接 → Ymodem 写区 → 复位并验证启动日志
          </p>
          {!hasWebSerial() ? (
            <p className="error-text">当前浏览器不支持 Web Serial，请使用 Chrome 或 Edge，并在 localhost 或 HTTPS 下打开。</p>
          ) : null}
        </section>

      </div>

      <pre className="flash-log" ref={logRef}>
        {logs.length === 0 ? '日志将显示在这里。固件只在本地解析。' : logs.join('\n')}
      </pre>
    </div>
  )
}
