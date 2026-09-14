import { divider, indentedLines, itemLines, twoColumnLines } from '../columns'
import { formatDateTime, formatMoney } from '../format'
import { LABELS } from '../labels.es'
import { forceReceiptText } from '../sanitizeText'
import type { Block } from '../schema'
import type { LogicalLine, PaperWidth, ReceiptInput } from '../types'
import { textLine } from './lines'

type Of<T extends Block['type']> = Extract<Block, { type: T }>

/** Folio y fecha: 🔒 legal. La fecha es la de la VENTA del snapshot — nunca la de impresión (arreglo 3 de la PAX). */
export function renderOrderInfo(block: Of<'orderInfo'>, input: ReceiptInput, width: PaperWidth): LogicalLine[] {
  const { sale } = input
  const lines: LogicalLine[] = []
  const refund = sale.kind === 'REFUND'
  const row = (label: string, value: string) => twoColumnLines(label, value, width).map(l => textLine(l))
  if (refund) lines.push(textLine(LABELS.devolucionTitulo, 'center', { bold: true }))
  lines.push(...row(refund ? LABELS.devolucion : LABELS.orden, forceReceiptText(sale.orderNumber)))
  lines.push(...row(LABELS.fecha, formatDateTime(sale.occurredAt, sale.timezone)))
  if (block.showOrderType) lines.push(...row(LABELS.tipo, forceReceiptText(sale.orderType)))
  if (sale.reprint) lines.push(...row(LABELS.reimpresion, formatDateTime(sale.reprint.printedAt, sale.timezone)))
  return lines
}

export function renderStaff(_block: Of<'staff'>, input: ReceiptInput, width: PaperWidth): LogicalLine[] {
  if (!input.sale.staffName) return []
  return twoColumnLines(LABELS.atendio, forceReceiptText(input.sale.staffName), width).map(l => textLine(l))
}

/** Artículos: 🔒 legal (cantidad y descripción). El nombre se envuelve; nunca se recorta. */
export function renderItems(block: Of<'items'>, input: ReceiptInput, width: PaperWidth): LogicalLine[] {
  const lines: LogicalLine[] = [
    ...itemLines(LABELS.cant, LABELS.articulo, LABELS.precio, width).map(l => textLine(l, 'left', { bold: true })),
    textLine(divider(width)),
  ]
  const aux = (text: string) => indentedLines(text, width).map(l => textLine(l))
  for (const item of input.sale.items) {
    const component = item.isComboComponent === true
    const name = forceReceiptText(component ? `${item.quantity}x ${item.name}` : item.name)
    const price = component ? '' : item.isCortesia ? LABELS.cortesia : formatMoney(item.totalPriceCents)
    lines.push(
      ...itemLines(component ? '' : String(item.quantity), name, price, width, component ? 2 : 0).map(l =>
        textLine(l, 'left', { bold: item.isComboHeader === true }),
      ),
    )
    if (item.weightSummary) lines.push(...aux(forceReceiptText(item.weightSummary)))
    if (item.areaSourceLabel) lines.push(...aux(forceReceiptText(item.areaSourceLabel)))
    if (block.showModifiers) for (const m of item.modifiers ?? []) lines.push(...aux(`+ ${forceReceiptText(m)}`))
    if (block.showNotes && item.note) lines.push(...aux(`${LABELS.nota} ${forceReceiptText(item.note)}`))
  }
  return lines
}
