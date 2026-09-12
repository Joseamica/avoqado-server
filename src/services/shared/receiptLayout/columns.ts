/**
 * Puerto 1:1 de las primitivas de acomodo de avoqado-android
 * (`printing/data/ESCPOSPrinter.kt`: printTwoColumns, printThreeColumns, printDivider).
 * Los anchos (4 para cantidad, 10 para precio) son los del ticket actual: si cambian
 * aquí, cambian los casos dorados y por tanto las tres apps.
 */
export const QTY_WIDTH = 4
export const PRICE_WIDTH = 10

export function twoColumns(left: string, right: string, width: number): string {
  const rightLen = right.length
  const leftLen = Math.max(0, Math.min(left.length, width - rightLen - 1))
  const paddingLen = width - leftLen - rightLen
  return left.slice(0, leftLen) + ' '.repeat(Math.max(paddingLen, 1)) + right
}

export function threeColumns(qty: string, name: string, price: string, width: number): string {
  const priceWidth = Math.max(PRICE_WIDTH, price.length)
  const nameWidth = width - QTY_WIDTH - priceWidth
  const truncatedName = name.slice(0, Math.max(0, nameWidth - 1))
  return qty.padEnd(QTY_WIDTH) + truncatedName.padEnd(nameWidth) + price.padStart(priceWidth)
}

export function divider(width: number, char = '-'): string {
  return char.repeat(width)
}

export function wrap(text: string, width: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return ['']
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    let rest = word
    while (rest.length > width) {
      if (current) {
        lines.push(current)
        current = ''
      }
      lines.push(rest.slice(0, width))
      rest = rest.slice(width)
    }
    if (!current) current = rest
    else if (current.length + 1 + rest.length <= width) current += ' ' + rest
    else {
      lines.push(current)
      current = rest
    }
  }
  if (current) lines.push(current)
  return lines
}
