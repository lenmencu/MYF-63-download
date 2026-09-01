export type ChipId = 'ws63' | 'bs20' | 'bs21' | 'bs21e'
export type ChipFamily = 'ws63' | 'bs2x'

export type ChipProfile = {
  id: ChipId
  label: string
  baud: number
  family: ChipFamily
  connectTimeoutMs: number
}

export const CHIPS: ChipProfile[] = [
  {
    id: 'ws63',
    label: 'WS63',
    baud: 2_000_000,
    family: 'ws63',
    connectTimeoutMs: 30_000,
  },
  {
    id: 'bs20',
    label: 'BS20',
    baud: 500_000,
    family: 'bs2x',
    connectTimeoutMs: 30_000,
  },
  {
    id: 'bs21',
    label: 'BS21',
    baud: 500_000,
    family: 'bs2x',
    connectTimeoutMs: 30_000,
  },
  {
    id: 'bs21e',
    label: 'BS21E',
    baud: 500_000,
    family: 'bs2x',
    connectTimeoutMs: 30_000,
  },
]

export const AVAIL_BAUD = [
  115200, 230400, 460800, 500000, 576000, 921600, 1000000, 1152000, 1500000, 2000000,
] as const

export function chipProfile(id: ChipId): ChipProfile {
  const profile = CHIPS.find((item) => item.id === id)
  if (!profile) throw new Error(`未知芯片 ${id}`)
  return profile
}
