/**
 * Primitivas de acomodo del ticket. Nacieron como puerto de `ESCPOSPrinter.kt` (printTwoColumns,
 * printThreeColumns, printDivider) y desde la Fase 3 garantizan además que NINGÚN renglón se pasa
 * del ancho: un renglón largo lo parte la impresora donde quiere y sin alinear.
 * Cambiar un ancho aquí cambia los casos dorados y, por tanto, las tres apps.
 */
export const QTY_WIDTH = 5
export const PRICE_WIDTH = 10

/** Etiqueta a la izquierda y valor a la derecha. Si no caben juntos: la etiqueta arriba y el valor debajo, pegado a la derecha. Nunca recorta. */
export function twoColumnLines(left: string, right: string, width: number): string[] {
  if (left.length + 1 + right.length <= width) return [left + ' '.repeat(width - left.length - right.length) + right]
  return [...wrap(left, width), ...wrap(right, width).map(l => l.padStart(width))]
}

/**
 * Cantidad · artículo · precio. El nombre NUNCA se recorta: se envuelve bajo su propia columna
 * (la descripción es dato del comprobante). `indent` sangra el nombre (componentes de combo).
 * La columna de cantidad mide 5 y CRECE con la cantidad (siempre un espacio detrás): una fija
 * pegaba «10000Artículo» y con 123456 el renglón medía 33 en papel de 32.
 */
export function itemLines(qty: string, name: string, price: string, width: number, indent = 0): string[] {
  const qtyWidth = Math.max(QTY_WIDTH, qty.length + 1)
  const priceWidth = Math.max(PRICE_WIDTH, price.length)
  const nameWidth = width - qtyWidth - priceWidth
  const chunks = wrap(name, Math.max(1, nameWidth - 1 - indent)).map(c => ' '.repeat(indent) + c)
  return chunks.map((chunk, i) =>
    i === 0 ? qty.padEnd(qtyWidth) + chunk.padEnd(nameWidth) + price.padStart(priceWidth) : ' '.repeat(qtyWidth) + chunk,
  )
}

/** Un renglón auxiliar bajo el artículo (peso, área, modificador, nota): sangría de 2 y envuelto al ancho. */
export function indentedLines(text: string, width: number): string[] {
  return wrap(text, width - 2).map(l => `  ${l}`)
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
