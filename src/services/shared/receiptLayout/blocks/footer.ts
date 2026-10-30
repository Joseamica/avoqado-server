import { divider, twoColumnLines, wrap } from '../columns'
import { amountInWordsEs, formatMoney } from '../format'
import { LABELS } from '../labels.es'
import { QR_DEFAULT_CAPTION, type Block } from '../schema'
import { forceReceiptText } from '../sanitizeText'
import type { LogicalLine, PaperWidth, ReceiptInput } from '../types'
import { feed, textLine } from './lines'

type Of<T extends Block['type']> = Extract<Block, { type: T }>

/** ~88 puntos de 576 (80 mm): firma, no protagonista (mismo tamaño que hoy en Android). */
const AVOQADO_MARK_WIDTH_PCT = 15

/**
 * Totales: 🔒 legal (el TOTAL). D3 del plan 7 de IVA: el ticket NO calcula IVA. Con IVA incluido (la norma, LFPC 7 Bis)
 * imprime «IVA incluido cuando aplica»; sólo una venta vieja que cobró el IVA aparte imprime «IVA agregado: $X».
 * Regla de cuadre: subtotal − descuento + cargo por servicio + IVA agregado + propina = TOTAL. Por eso el descuento, el
 * cargo, el IVA agregado y la propina salen SIEMPRE que sean ≠ 0 (son parte de la suma; A7-R7: ni Square ni Toast dejan
 * ocultar la propina cobrada). `showDiscount`/`showTip` sólo evitarían un renglón en $0, que de todos modos no sale;
 * `showTax` sólo apaga la leyenda. `showSubtotal: false` (plantilla «Mínimo») no imprime el subtotal: quedan el TOTAL y, si
 * los hubo, el descuento, el cargo, el IVA agregado y la propina.
 */
export function renderTotals(block: Of<'totals'>, input: ReceiptInput, width: PaperWidth): LogicalLine[] {
  const { sale } = input
  const money = (label: string, cents: number, opts: { bold?: boolean } = {}) =>
    twoColumnLines(label, formatMoney(cents), width).map(l => textLine(l, 'left', opts))
  const lines: LogicalLine[] = []
  if (block.showSubtotal) lines.push(...money(LABELS.subtotal, sale.subtotalCents))
  if (sale.discountCents) lines.push(...money(LABELS.descuento, -Math.abs(sale.discountCents)))
  if (sale.serviceChargeCents && sale.serviceChargeCents > 0) lines.push(...money(LABELS.cargoPorServicio, sale.serviceChargeCents))
  if (sale.taxCents > 0) lines.push(...money(LABELS.ivaAgregado, sale.taxCents))
  else if (block.showTax) lines.push(textLine(LABELS.ivaIncluidoCuandoAplica))
  if (sale.tipCents) lines.push(...money(LABELS.propina, sale.tipCents))
  lines.push(textLine(divider(width)))
  // En grande, el TOTAL gasta dos columnas por carácter: se acomoda a la MITAD del ancho.
  // Si ni así cabe, negritas a ancho completo — y si tampoco, etiqueta arriba y valor abajo.
  const total = formatMoney(sale.totalCents)
  const totalLabel = sale.kind === 'EXCHANGE' ? LABELS.diferencia : LABELS.total
  const half = Math.floor(width / 2)
  if (totalLabel.length + 1 + total.length <= half)
    lines.push(...twoColumnLines(totalLabel, total, half).map(l => textLine(l, 'left', { bold: true, double: true })))
  else lines.push(...twoColumnLines(totalLabel, total, width).map(l => textLine(l, 'left', { bold: true })))
  return lines
}

/** Pago: 🔒 operativo. En tarjeta, autorización y referencia van SIEMPRE que existan. Pre-cuenta (sin tender): nada. */
export function renderPayment(block: Of<'payment'>, input: ReceiptInput, width: PaperWidth): LogicalLine[] {
  const t = input.sale.tender
  if (!t) return []
  const row = (label: string, value: string, opts: { bold?: boolean } = {}) =>
    twoColumnLines(label, value, width).map(l => textLine(l, 'left', opts))
  const paymentLabel = input.sale.kind === 'EXCHANGE' && input.sale.totalCents < 0 ? LABELS.devuelto : LABELS.pago
  const lines: LogicalLine[] = [feed(), ...row(paymentLabel, forceReceiptText(t.label))]
  if (t.kind === 'CARD') {
    if (block.showCardLastFour && t.cardLastFour) {
      lines.push(...row(LABELS.tarjeta, t.cardBrand ? `${forceReceiptText(t.cardBrand)} **** ${t.cardLastFour}` : `**** ${t.cardLastFour}`))
    }
    if (t.authCode) lines.push(...row(LABELS.autorizacion, forceReceiptText(t.authCode)))
    if (t.referenceNumber) lines.push(...row(LABELS.referencia, forceReceiptText(t.referenceNumber)))
  }
  if (t.kind === 'CASH') {
    if (t.tenderedCents != null) lines.push(...row(LABELS.recibido, formatMoney(t.tenderedCents)))
    if (block.showChange && t.changeCents && t.changeCents > 0)
      lines.push(...row(LABELS.cambio, formatMoney(t.changeCents), { bold: true }))
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

/** QR del recibo digital. Sólo con URL. La leyenda por defecto no promete factura donde el negocio no la tiene (arreglo del 11-sep). */
export function renderQr(block: Of<'qr'>, input: ReceiptInput, width: PaperWidth): LogicalLine[] {
  if (input.sale.kind === 'EXCHANGE' && input.sale.pendingUpload) return []
  const url = input.sale.receiptUrl?.trim()
  if (!url) return []
  const caption = block.caption === QR_DEFAULT_CAPTION && input.sale.autofacturaAvailable === false ? LABELS.qrSinFactura : block.caption
  return [
    feed(),
    textLine(divider(width)),
    ...wrap(forceReceiptText(caption), width).map(l => textLine(l, 'center')),
    feed(),
    { kind: 'qr', data: url },
    feed(),
  ]
}

export function renderFiscalNotice(_block: Of<'fiscalNotice'>, _input: ReceiptInput, width: PaperWidth): LogicalLine[] {
  return wrap(LABELS.fiscalNotice, width).map(l => textLine(l, 'center'))
}

export function renderReference(block: Of<'reference'>, input: ReceiptInput, width: PaperWidth): LogicalLine[] {
  const lines: LogicalLine[] = []
  const centered = (text: string) => wrap(text, width).map(l => textLine(l, 'center'))
  if (block.showTransactionId && input.sale.transactionId)
    lines.push(...centered(`${LABELS.id} ${forceReceiptText(input.sale.transactionId)}`))
  if (block.showAppVersion && input.sale.appVersion) lines.push(...centered(`${LABELS.version}${forceReceiptText(input.sale.appVersion)}`))
  return lines
}

/** 🔒 plataforma: nunca se quita, siempre al final (decisión del founder). El texto sale AUNQUE la imagen falte en el aparato. */
export function renderSignature(_block: Of<'signature'>, _input: ReceiptInput, _width: PaperWidth): LogicalLine[] {
  return [
    feed(),
    { kind: 'image', ref: 'avoqadoMark', widthPct: AVOQADO_MARK_WIDTH_PCT, align: 'center' },
    feed(),
    textLine(LABELS.poweredBy, 'center'),
    { kind: 'cut' },
  ]
}
