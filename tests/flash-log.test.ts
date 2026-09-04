import assert from 'node:assert/strict'
import test from 'node:test'
import { beginFlashLog } from '../src/ui/flash-log.ts'

test('a new flash run replaces every log from the previous device', () => {
  const previous = ['旧设备日志', '旧烧录失败']
  const next = beginFlashLog('18:57:22', 'BS21E', 115200)

  assert.equal(next.some((line) => previous.includes(line)), false)
  assert.deepEqual(next, [
    '18:57:22  开始烧录 · BS21E @ 115200',
    '18:57:22  复位方式：等待手动复位',
  ])
})

test('flash log highlights actionable messages without dimming normal output', async () => {
  const helpers = (await import('../src/ui/flash-log.ts')) as unknown as {
    classifyFlashLog?: (line: string) => string
  }

  assert.equal(helpers.classifyFlashLog?.('18:31:31  已选择 CH342'), 'info')
  assert.equal(helpers.classifyFlashLog?.('18:31:32  请按一次开发板复位键'), 'attention')
  assert.equal(helpers.classifyFlashLog?.('18:31:33  烧录失败：连接超时'), 'error')
})
