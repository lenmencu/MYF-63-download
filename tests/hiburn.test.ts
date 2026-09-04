import assert from 'node:assert/strict'
import test from 'node:test'
import {
  acceptOptionalLoaderAck,
  applyLoaderBaud,
  BOOT_BAUD,
  buildBaudratePayload,
  buildFrame,
  extractFirstFrame,
  hasHandshakeAck,
  HistoolError,
  parseFrame,
} from '../src/flash/hiburn.ts'

test('loader baud payload uses the HiBurn 0x5A layout', () => {
  assert.deepEqual(buildBaudratePayload(2_000_000), new Uint8Array([0x80, 0x84, 0x1e, 0x00, 0x08, 0x01, 0x00, 0x00]))
})

test('loader baud switch waits for acknowledgements on both sides of serial reopen', async () => {
  const events: string[] = []
  const changed = await applyLoaderBaud(
    500_000,
    async (payload) => {
      events.push(`command:${new DataView(payload.buffer, payload.byteOffset).getUint32(0, true)}`)
    },
    async () => {
      events.push('ack:old-baud')
    },
    async (baud) => {
      events.push(`reopen:${baud}`)
    },
    async () => {
      events.push('ack:new-baud')
    },
  )

  assert.equal(changed, true)
  assert.deepEqual(events, ['command:500000', 'ack:old-baud', 'reopen:500000', 'ack:new-baud'])
})

test('115200 download skips loader baud command and serial reopen', async () => {
  const events: string[] = []
  const changed = await applyLoaderBaud(
    BOOT_BAUD,
    async () => { events.push('command') },
    async () => { events.push('ack') },
    async () => { events.push('reopen') },
    async () => { events.push('second-ack') },
  )

  assert.equal(changed, false)
  assert.deepEqual(events, [])
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

test('ROM handshake accepts its fixed ACK header when trailing CRC bytes are unusable', () => {
  const romReplyMixedWithBootLog = new Uint8Array([
    0x62, 0x6f, 0x6f, 0x74, 0x0d, 0x0a,
    0xef, 0xbe, 0xad, 0xde, 0x0c, 0x00, 0xe1, 0x1e,
    0x5a, 0x00, 0x61, 0x74,
  ])

  assert.equal(hasHandshakeAck(romReplyMixedWithBootLog), true)
  assert.equal(hasHandshakeAck(new Uint8Array([0xef, 0xbe, 0xad, 0xde, 0x0c, 0x00, 0xe1, 0x00])), false)
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
