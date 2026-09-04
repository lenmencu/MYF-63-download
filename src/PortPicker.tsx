import { hasWebSerial, portLabel } from './serial/web-serial.ts'

type Props = {
  ports: SerialPort[]
  selected: SerialPort | null
  disabled?: boolean
  onSelect: (port: SerialPort) => void
  onAdd: () => Promise<unknown> | unknown
  onRefresh: () => Promise<unknown> | unknown
}

export function PortPicker({ ports, selected, disabled, onSelect, onAdd, onRefresh }: Props) {
  const selectedIndex = selected ? ports.indexOf(selected) : -1

  async function add() {
    try {
      await onAdd()
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotFoundError') return
      throw err
    }
  }

  return (
    <div className="field">
      <span className="label">选择串口 / SERIAL PORT</span>
      <div className="port-row">
        <select
          className="select port-select"
          disabled={disabled || !hasWebSerial()}
          value={selectedIndex >= 0 ? String(selectedIndex) : ''}
          onChange={(e) => {
            const port = ports[Number(e.target.value)]
            if (port) onSelect(port)
          }}
        >
          {ports.length === 0 ? (
            <option value="">未发现已授权串口</option>
          ) : (
            ports.map((port, index) => (
              <option key={`${portLabel(port)}-${index}`} value={index}>
                {portLabel(port, index)}
              </option>
            ))
          )}
        </select>
        <button type="button" className="btn ghost" disabled={disabled} onClick={() => void onRefresh()}>
          刷新
        </button>
        <button type="button" className="btn ghost" disabled={disabled || !hasWebSerial()} onClick={() => void add()}>
          添加串口
        </button>
      </div>
    </div>
  )
}
