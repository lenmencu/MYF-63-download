import { useCallback, useEffect, useState } from 'react'
import { FlashPage } from './FlashPage.tsx'
import { MonitorPage } from './MonitorPage.tsx'
import { hasWebSerial, listSerialPorts, serialEventPort } from './serial/web-serial.ts'
import brandLogo from './assets/mingyufeng-logo.png'
import './App.css'

type Page = 'flash' | 'monitor'

export default function App() {
  const [page, setPage] = useState<Page>('flash')
  const [ports, setPorts] = useState<SerialPort[]>([])
  const [port, setPort] = useState<SerialPort | null>(null)
  const [busy, setBusy] = useState(false)

  const refreshPorts = useCallback(async () => {
    const list = await listSerialPorts()
    setPorts(list)
    setPort((current) => {
      if (current && list.includes(current)) return current
      return list[0] ?? null
    })
    return list
  }, [])

  const addPort = useCallback(async () => {
    if (!hasWebSerial() || !navigator.serial) {
      throw new Error('请使用 Chrome 或 Edge')
    }
    const next = await navigator.serial.requestPort()
    const list = await listSerialPorts()
    const merged = list.includes(next) ? list : [...list, next]
    setPorts(merged)
    setPort(next)
    return next
  }, [])

  useEffect(() => {
    void refreshPorts()
    if (!hasWebSerial() || !navigator.serial) return
    const serial = navigator.serial
    const onChange = (ev: Event) => {
      const changed = serialEventPort(ev)
      void refreshPorts().then((list) => {
        if (ev.type === 'connect' && changed && list.includes(changed)) {
          setPort(changed)
        }
      })
    }
    serial.addEventListener('connect', onChange)
    serial.addEventListener('disconnect', onChange)
    return () => {
      serial.removeEventListener('connect', onChange)
      serial.removeEventListener('disconnect', onChange)
    }
  }, [refreshPorts])

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img src={brandLogo} alt="明裕丰 MINGYUFENG" />
          <span className="brand-divider" aria-hidden="true" />
          <span className="brand-product">DEVICE WORKBENCH</span>
        </div>
        <nav aria-label="主导航">
          <button
            type="button"
            className={page === 'flash' ? 'nav on' : 'nav'}
            disabled={busy}
            onClick={() => setPage('flash')}
          >
            <span>01</span> 在线烧录
          </button>
          <button
            type="button"
            className={page === 'monitor' ? 'nav on' : 'nav'}
            disabled={busy}
            onClick={() => setPage('monitor')}
          >
            <span>02</span> 串口监视器
          </button>
        </nav>
        <span className="badge"><i /> SYSTEM READY</span>
      </header>

      <main className="shell">
        {page === 'flash' ? (
          <FlashPage
            ports={ports}
            port={port}
            onSelectPort={setPort}
            onAddPort={addPort}
            onRefreshPorts={refreshPorts}
            onBusy={setBusy}
          />
        ) : (
          <MonitorPage
            ports={ports}
            port={port}
            onSelectPort={setPort}
            onAddPort={addPort}
            onRefreshPorts={refreshPorts}
          />
        )}
      </main>
    </div>
  )
}
