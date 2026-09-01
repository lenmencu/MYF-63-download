import assert from 'node:assert/strict'
import test from 'node:test'
import {
  acceptOptionalLoaderAck,
  BOOT_BAUD,
  buildFrame,
  extractFirstFrame,
  HistoolError,
  parseFrame,
  resolveWebFlashBaud,
} from '../src/flash/hiburn.ts'

test('browser flashing keeps the ROM session open at its boot baud', () => {
  assert.deepEqual(resolveWebFlashBaud(BOOT_BAUD), { baud: BOOT_BAUD, adjusted: false })
  assert.deepEqual(resolveWebFlashBaud(2_000_000), { baud: BOOT_BAUD, adjusted: true })
  assert.deepEqual(resolveWebFlashBaud(500_000), { baud: BOOT_BAUD, adjusted: true })
})

test('HiBurn frame round-trips with command inverse and CRC validation', () => {
  const payload = new Uint8Array([0x5a, 0x00, 0x12, 0x34])
  const encoded = buildFrame(0xe1, payload)
  const parsed = parseFrame(encoded)
  assert.equal(parsed.cmd, 0xe1)
  assert.deepEqual(parsed.payload, payload)

  const badInverse = encoded.slice()
  badInverse[7] ^= 1
  assert.throws(() => parseFrame(badInverse), HistoolError)

  const badCrc = encoded.slice()
  badCrc[8] ^= 1
  assert.throws(() => parseFrame(badCrc), /CRC 不匹配/)
})

test('frame extraction survives noise, partial input and preserves Ymodem bytes', () => {
  const frame = buildFrame(0xe1, new Uint8Array([0x5a, 0x00]))
  const partial = extractFirstFrame(new Uint8Array([0x99, 0xef, 0xbe]))
  assert.equal(partial.frame, null)
  assert.deepEqual(partial.rest, new Uint8Array([0xef, 0xbe]))

  const input = new Uint8Array(3 + frame.length + 1)
  input.set([0x00, 0x11, 0x22])
  input.set(frame, 3)
  input[input.length - 1] = 0x43
  const extracted = extractFirstFrame(input)
  assert.deepEqual(extracted.frame, frame)
  assert.deepEqual(extracted.rest, new Uint8Array([0x43]))
})

test('BS2X loader may continue when its post-Ymodem HiBurn ACK is absent', async () => {
  assert.equal(await acceptOptionalLoaderAck(async () => undefined), true)
  assert.equal(
    await acceptOptionalLoaderAck(async () => {
      throw new HistoolError('等待 HiBurn 帧超时')
    }),
    false,
  )
  await assert.rejects(
    acceptOptionalLoaderAck(async () => {
      throw new TypeError('programming error')
    }),
    TypeError,
  )
})
