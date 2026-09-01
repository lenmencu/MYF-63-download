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
