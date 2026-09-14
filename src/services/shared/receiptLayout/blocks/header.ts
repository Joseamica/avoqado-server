import { addressLine } from '../address'
import { divider, wrap } from '../columns'
import { LABELS } from '../labels.es'
import { resolveEmisor } from '../resolveEmisor'
import { forceReceiptText } from '../sanitizeText'
import type { Block } from '../schema'
import type { LogicalLine, PaperWidth, ReceiptInput } from '../types'
import { feed, textLine, titleLines, wrapWithEmphasis } from './lines'

type Of<T extends Block['type']> = Extract<Block, { type: T }>

const LOGO_WIDTH_PCT = { S: 40, M: 60, L: 80 } as const

/** El logo va donde el negocio lo puso (D13). Sin un ráster utilizable el aparato manda `hasLogo = false`: ni imagen NI hueco. */
export function renderLogo(block: Of<'logo'>, input: ReceiptInput, _width: PaperWidth): LogicalLine[] {
  if (!input.venue.hasLogo) return []
  return [{ kind: 'image', ref: 'logo', widthPct: LOGO_WIDTH_PCT[block.size], align: block.align }, feed()]
}

export function renderBusinessName(block: Of<'businessName'>, input: ReceiptInput, width: PaperWidth): LogicalLine[] {
  return titleLines(forceReceiptText(input.venue.name), width, block.align, block.emphasis)
}

/** Nada de «RFC:» vacíos: sin emisor resuelto no se imprime nada (spec § 5.3). */
export function renderFiscal(block: Of<'fiscal'>, input: ReceiptInput, width: PaperWidth): LogicalLine[] {
  const emisor = resolveEmisor(input.venue, input.sale.tender?.merchantAccountId)
  if (!emisor) return []
  const valores = [
    emisor.legalName,
    emisor.rfc ? `${LABELS.rfc} ${emisor.rfc}` : null,
    emisor.lugarExpedicion ? `${LABELS.lugarExpedicion} ${emisor.lugarExpedicion}` : null,
  ].filter((v): v is string => Boolean(v))
  return valores.flatMap(v => wrap(forceReceiptText(v), width).map(l => textLine(l, block.align)))
}

export function renderAddress(block: Of<'address'>, input: ReceiptInput, width: PaperWidth): LogicalLine[] {
  const texto = addressLine(input.venue)
  if (!texto) return []
  return wrap(forceReceiptText(texto), width).map(l => textLine(l, block.align))
}

export function renderPhone(block: Of<'phone'>, input: ReceiptInput, width: PaperWidth): LogicalLine[] {
  if (!input.venue.phone) return []
  return wrap(`${LABELS.tel} ${forceReceiptText(input.venue.phone)}`, width).map(l => textLine(l, block.align))
}

/** Defensa en profundidad: aunque el servidor ya rechazó lo prohibido, aquí se vuelve a sanear antes de emitir. */
export function renderText(block: Of<'text'>, _input: ReceiptInput, width: PaperWidth): LogicalLine[] {
  return block.lines.flatMap(l => wrapWithEmphasis(forceReceiptText(l), width, block.align, block.emphasis))
}

export function renderSeparator(block: Of<'separator'>, _input: ReceiptInput, width: PaperWidth): LogicalLine[] {
  if (block.style === 'blank') return [feed()]
  return [textLine(divider(width, block.style === 'double' ? '=' : '-'), 'left')]
}
