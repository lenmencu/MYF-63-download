export function beginFlashLog(timestamp: string, chipLabel: string, baud: number): string[] {
  return [
    `${timestamp}  开始烧录 · ${chipLabel} @ ${baud}`,
    `${timestamp}  复位方式：等待手动复位`,
  ]
}
