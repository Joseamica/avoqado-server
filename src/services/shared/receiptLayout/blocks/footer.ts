import { divider, twoColumns, wrap } from '../columns'
import { amountInWordsEs, formatMoney } from '../format'
import { LABELS } from '../labels.es'
import { forceReceiptText } from '../sanitizeText'
import type { Block } from '../schema'
import type { LogicalLine, PaperWidth, ReceiptInput } from '../types'
import { feed, textLine } from './lines'

type Of<T extends Block['type']> = Extract<Block, { type: T }>

/** ~88 puntos de 576 (80 mm): firma, no protagonista (mismo tamaño que hoy en Android). */
const AVOQADO_MARK_WIDTH_PCT = 15

/** Totales: 🔒 legal (el TOTAL). Etiqueta «IVA incluido:» porque el precio ya trae el impuesto (spec § 9). */
export function renderTotals(block: Of<'totals'>, input: ReceiptInput, width: PaperWidth): LogicalLine[] {
  const { sale } = input
  const money = (label: string, cents: number, opts: { bold?: boolean } = {}) =>
    textLine(twoColumns(label, formatMoney(cents), width), 'left', opts)
  const lines: LogicalLine[] = []
  if (block.showSubtotal) lines.push(money(LABELS.subtotal, sale.subtotalCents))
  if (block.showDiscount && sale.discountCents) lines.push(money(LABELS.descuento, -Math.abs(sale.discountCents)))
  if (block.showTax) lines.push(money(LABELS.ivaIncluido, sale.taxCents))
  if (block.showTip && sale.tipCents) lines.push(money(LABELS.propina, sale.tipCents))
  lines.push(textLine(divider(width)))
  // En grande, el TOTAL gasta dos columnas por carácter: se acomoda a la MITAD del ancho.
  // Si ni así cabe (totales de seis cifras en 58 mm), negritas a ancho completo — nunca partido.
  const total = formatMoney(sale.totalCents)
  const half = Math.floor(width / 2)
  if (LABELS.total.length + 1 + total.length <= half)
    lines.push(textLine(twoColumns(LABELS.total, total, half), 'left', { bold: true, double: true }))
  else lines.push(textLine(twoColumns(LABELS.total, total, width), 'left', { bold: true }))
  return lines
}

/** Pago: 🔒 operativo. En tarjeta, autorización y referencia van SIEMPRE: son lo que el cliente necesita ante un contracargo. */
export function renderPayment(block: Of<'payment'>, input: ReceiptInput, width: PaperWidth): LogicalLine[] {
  const t = input.sale.tender
  const row = (label: string, value: string, opts: { bold?: boolean } = {}) => textLine(twoColumns(label, value, width), 'left', opts)
  const lines: LogicalLine[] = [feed(), row(LABELS.pago, forceReceiptText(t.label))]
  if (t.kind === 'CARD') {
    if (block.showCardLastFour && t.cardLastFour) {
      lines.push(row(LABELS.tarjeta, t.cardBrand ? `${forceReceiptText(t.cardBrand)} **** ${t.cardLastFour}` : `**** ${t.cardLastFour}`))
    }
    if (t.authCode) lines.push(row(LABELS.autorizacion, forceReceiptText(t.authCode)))
    if (t.referenceNumber) lines.push(row(LABELS.referencia, forceReceiptText(t.referenceNumber)))
  }
  if (t.kind === 'CASH') {
    if (t.tenderedCents != null) lines.push(row(LABELS.recibido, formatMoney(t.tenderedCents)))
    if (block.showChange && t.changeCents && t.changeCents > 0) lines.push(row(LABELS.cambio, formatMoney(t.changeCents), { bold: true }))
  }
  return lines
}

export function renderAmountInWords(_block: Of<'amountInWords'>, input: ReceiptInput, width: PaperWidth): LogicalLine[] {
  return wrap(amountInWordsEs(input.sale.totalCents), width).map(l => textLine(l, 'center'))
}

/** Vale de área: 🔒 operativo. Sólo cuando la venta lo trae; igual que hoy en Android. */
export function renderAreaDelivery(_block: Of<'areaDelivery'>, input: ReceiptInput, width: PaperWidth): LogicalLine[] {
  const code = input.sale.areaDeliveryCode?.trim()
  if (!code) return []
  return [
    feed(),
    textLine(divider(width, '=')),
    textLine(LABELS.entregaPorArea, 'center', { bold: true }),
    ...wrap(LABELS.presentaComprobante, width).map(l => textLine(l, 'center')),
    feed(),
    { kind: 'barcode', data: code },
    feed(),
    textLine(code, 'center', { bold: true, double: code.length * 2 <= width }),
  ]
}

export function renderQr(block: Of<'qr'>, input: ReceiptInput, width: PaperWidth): LogicalLine[] {
  const url = input.sale.receiptUrl?.trim()
  if (!url) return []
  return [
    feed(),
    textLine(divider(width)),
    ...wrap(forceReceiptText(block.caption), width).map(l => textLine(l, 'center')),
    feed(),
    { kind: 'qr', data: url },
    feed(),
  ]
}

export function renderFiscalNotice(_block: Of<'fiscalNotice'>, _input: ReceiptInput, width: PaperWidth): LogicalLine[] {
  return wrap(LABELS.fiscalNotice, width).map(l => textLine(l, 'center'))
}

export function renderReference(block: Of<'reference'>, input: ReceiptInput, _width: PaperWidth): LogicalLine[] {
  const lines: LogicalLine[] = []
  if (block.showTransactionId && input.sale.transactionId)
    lines.push(textLine(`${LABELS.id} ${forceReceiptText(input.sale.transactionId)}`, 'center'))
  if (block.showAppVersion && input.sale.appVersion)
    lines.push(textLine(`${LABELS.version}${forceReceiptText(input.sale.appVersion)}`, 'center'))
  return lines
}

/** 🔒 plataforma: nunca se quita, siempre al final (decisión del founder). El texto sale AUNQUE la imagen falte en el aparato. */
export function renderSignature(_block: Of<'signature'>, _input: ReceiptInput, _width: PaperWidth): LogicalLine[] {
  return [
    feed(),
    { kind: 'image', ref: 'avoqadoMark', widthPct: AVOQADO_MARK_WIDTH_PCT },
    feed(),
    textLine(LABELS.poweredBy, 'center'),
    { kind: 'cut' },
  ]
}
