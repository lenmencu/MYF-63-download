import assert from 'node:assert/strict'
import test from 'node:test'

type MonitorLogEntry = { id: number; direction: 'rx' | 'tx'; text: string }
type AppendMonitorEntry = (previous: MonitorLogEntry[], entry: MonitorLogEntry) => MonitorLogEntry[]
type BuildSerialPayload = (text: string, newline: 'none' | 'lf' | 'cr' | 'crlf') => Uint8Array

async function loadMonitorHelpers(): Promise<{
  appendMonitorEntry?: AppendMonitorEntry
  buildSerialPayload?: BuildSerialPayload
}> {
  const modulePath = '../src/ui/monitor-log.js'
  return import(modulePath)
    .then((module) => ({
      appendMonitorEntry: module.appendMonitorEntry as AppendMonitorEntry | undefined,
      buildSerialPayload: module.buildSerialPayload as BuildSerialPayload | undefined,
    }))
    .catch(() => ({}))
}

test('monitor log retains only the newest 160000 characters after reaching its limit', async () => {
  const { appendMonitorEntry } = await loadMonitorHelpers()
  const previous: MonitorLogEntry[] = [{ id: 1, direction: 'rx', text: `old-marker:${'a'.repeat(199_990)}` }]
  const latest: MonitorLogEntry = { id: 2, direction: 'tx', text: `new-marker:${'b'.repeat(100)}` }
  const result = appendMonitorEntry?.(previous, latest)
  const combined = result?.map((entry) => entry.text).join('')

  assert.equal(combined?.length, 160_000)
  assert.equal(combined?.includes('old-marker'), false)
  assert.equal(result?.at(-1)?.direction, 'tx')
  assert.equal(combined?.endsWith(latest.text), true)
})

test('serial payload appends exactly the selected newline', async () => {
  const { buildSerialPayload } = await loadMonitorHelpers()
  assert.deepEqual(buildSerialPayload?.('AT', 'none'), new Uint8Array([0x41, 0x54]))
  assert.deepEqual(buildSerialPayload?.('AT', 'crlf'), new Uint8Array([0x41, 0x54, 0x0d, 0x0a]))
})
