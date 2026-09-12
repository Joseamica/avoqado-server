import { wrap } from '../columns'
import type { Align, Emphasis, LogicalLine } from '../types'

export function textLine(text: string, align: Align = 'left', opts: { bold?: boolean; double?: boolean } = {}): LogicalLine {
  return { kind: 'text', text, align, bold: opts.bold ?? false, double: opts.double ?? false }
}

export function feed(lines = 1): LogicalLine {
  return { kind: 'feed', lines }
}

/** Un bloque de texto: normal/bold envuelven al ancho; double envuelve a la MITAD (cada carácter gasta dos columnas). */
export function wrapWithEmphasis(text: string, width: number, align: Align, emphasis: Emphasis): LogicalLine[] {
  const double = emphasis === 'double'
  return wrap(text, double ? Math.floor(width / 2) : width).map(l => textLine(l, align, { bold: emphasis === 'bold', double }))
}

/**
 * Un VALOR de una sola línea (el nombre del negocio, un código): la regla de `printTitle`
 * de Android — a doble ancho si cabe; si no, letra normal completa le gana a letra grande
 * partida: cae a negritas y se envuelve.
 */
export function titleLines(value: string, width: number, align: Align, emphasis: Emphasis): LogicalLine[] {
  if (emphasis === 'double') {
    if (value.length * 2 <= width) return [textLine(value, align, { double: true })]
    return wrap(value, width).map(l => textLine(l, align, { bold: true }))
  }
  return wrap(value, width).map(l => textLine(l, align, { bold: emphasis === 'bold' }))
}
