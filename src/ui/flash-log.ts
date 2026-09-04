export function beginFlashLog(timestamp: string, chipLabel: string, baud: number): string[] {
  return [
    `${timestamp}  开始烧录 · ${chipLabel} @ ${baud}`,
    `${timestamp}  复位方式：等待手动复位`,
  ]
}

export type FlashLogTone = 'info' | 'attention' | 'error'

export function classifyFlashLog(line: string): FlashLogTone {
  if (/失败|错误|超时|校验失败|不支持/.test(line)) return 'error'
  if (/请按|等待|警告|注意|重试|待确认/.test(line)) return 'attention'
  return 'info'
}
