export type ChipId = 'ws63' | 'bs20' | 'bs21' | 'bs21e'
export type ChipFamily = 'ws63' | 'bs2x'

export type ChipProfile = {
  id: ChipId
  label: string
  hint: string
  baud: number
  family: ChipFamily
}

export const CHIPS: ChipProfile[] = [
  { id: 'ws63', label: 'MYF-F63', hint: 'WS63 · 1 Mbps', baud: 1_000_000, family: 'ws63' },
  { id: 'bs21e', label: 'MYF-F20 / F21', hint: 'BS21E · 网页默认 115200', baud: 115_200, family: 'bs2x' },
  { id: 'bs20', label: 'BS20', hint: 'BS2X · 网页默认 115200', baud: 115_200, family: 'bs2x' },
]

export const AVAIL_BAUD = [
  115200, 230400, 460800, 500000, 576000, 921600, 1000000, 1152000, 1500000, 2000000,
] as const

export function detectChipFromName(name: string): ChipId | null {
  const text = name.replace(/\\/g, '/').toLowerCase()
  if (/(^|[^a-z0-9])(f20|f21|myf-f20|myf-f21)([^a-z0-9]|$)/.test(text)) return 'bs21e'
  if (/(^|[^a-z0-9])f63([^a-z0-9]|$)/.test(text)) return 'ws63'
  for (const key of ['bs21e', 'bs21', 'bs20', 'ws63'] as const) {
    if (text.split(/[^a-z0-9]+/).includes(key)) return key === 'bs21' ? 'bs21e' : key
  }
  return null
}
