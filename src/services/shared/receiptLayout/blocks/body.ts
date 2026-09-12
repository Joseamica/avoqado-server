import { divider, threeColumns, twoColumns } from '../columns'
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
  if (refund) lines.push(textLine(LABELS.devolucionTitulo, 'center', { bold: true }))
  lines.push(textLine(twoColumns(refund ? LABELS.devolucion : LABELS.orden, forceReceiptText(sale.orderNumber), width)))
  lines.push(textLine(twoColumns(LABELS.fecha, formatDateTime(sale.occurredAt, sale.timezone), width)))
  if (block.showOrderType) lines.push(textLine(twoColumns(LABELS.tipo, forceReceiptText(sale.orderType), width)))
  if (sale.reprint) lines.push(textLine(twoColumns(LABELS.reimpresion, formatDateTime(sale.reprint.printedAt, sale.timezone), width)))
  return lines
}

export function renderStaff(_block: Of<'staff'>, input: ReceiptInput, width: PaperWidth): LogicalLine[] {
  if (!input.sale.staffName) return []
  return [textLine(twoColumns(LABELS.atendio, forceReceiptText(input.sale.staffName), width))]
}

/** Artículos: 🔒 legal (cantidad y descripción). Renglón a renglón como `generateReceipt` de Android. */
export function renderItems(block: Of<'items'>, input: ReceiptInput, width: PaperWidth): LogicalLine[] {
  const lines: LogicalLine[] = [
    textLine(threeColumns(LABELS.cant, LABELS.articulo, LABELS.precio, width), 'left', { bold: true }),
    textLine(divider(width)),
  ]
  for (const item of input.sale.items) {
    const component = item.isComboComponent === true
    const name = forceReceiptText(component ? `  ${item.quantity}x ${item.name}` : item.name)
    const price = component ? '' : item.isCortesia ? LABELS.cortesia : formatMoney(item.totalPriceCents)
    lines.push(
      textLine(threeColumns(component ? '' : String(item.quantity), name, price, width), 'left', { bold: item.isComboHeader === true }),
    )
    if (item.weightSummary) lines.push(textLine(`  ${forceReceiptText(item.weightSummary)}`))
    if (item.areaSourceLabel) lines.push(textLine(`  ${forceReceiptText(item.areaSourceLabel)}`))
    if (block.showModifiers) for (const m of item.modifiers ?? []) lines.push(textLine(`  + ${forceReceiptText(m)}`))
    if (block.showNotes && item.note) lines.push(textLine(`  ${LABELS.nota} ${forceReceiptText(item.note)}`))
  }
  return lines
}
