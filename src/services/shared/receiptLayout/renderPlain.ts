import type { Align, LogicalLine, PaperWidth } from './types'

function place(text: string, align: Align, width: number): string {
  if (text.length >= width) return text
  if (align === 'right') return text.padStart(width)
  if (align === 'center') return ' '.repeat(Math.floor((width - text.length) / 2)) + text
  return text
}

/**
 * Líneas lógicas → texto plano: para revisar los goldens a ojo, para el MCP y para la vista
 * previa. Una línea `double` se pinta a su ancho lógico (la mitad) y en MAYÚSCULAS para que se
 * distinga de una normal.
 */
export function renderPlain(lines: LogicalLine[], width: PaperWidth): string {
  const out: string[] = []
  for (const l of lines) {
    switch (l.kind) {
      case 'text':
        out.push(l.double ? place(l.text.toUpperCase(), l.align, Math.floor(width / 2)) : place(l.text, l.align, width))
        break
      case 'image':
        out.push(place(l.ref === 'logo' ? '[LOGO]' : '[AVOQADO]', l.align, width))
        break
      case 'qr':
        out.push(place(`[QR ${l.data}]`, 'center', width))
        break
      case 'barcode':
        out.push(place(`[BARRAS ${l.data}]`, 'center', width))
        break
      case 'feed':
        for (let i = 0; i < l.lines; i += 1) out.push('')
        break
      case 'cut':
        out.push(`${'-'.repeat(width)} corte`)
        break
    }
  }
  return out.join('\n')
}
