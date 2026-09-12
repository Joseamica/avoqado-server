export type PaperWidth = 48 | 32
export const PAPER_WIDTHS: readonly PaperWidth[] = [48, 32]
export type Align = 'left' | 'center' | 'right'
export type Emphasis = 'normal' | 'bold' | 'double'

/** Lo que el intérprete produce. El backend de cada app lo convierte a bytes o llamadas del SDK. */
export type LogicalLine =
  | { kind: 'text'; text: string; align: Align; bold: boolean; double: boolean }
  | { kind: 'image'; ref: 'logo' | 'avoqadoMark'; widthPct: number }
  | { kind: 'qr'; data: string }
  | { kind: 'barcode'; data: string }
  | { kind: 'feed'; lines: number }
  | { kind: 'cut' }

export interface ReceiptSaleItem {
  name: string
  quantity: number
  unitPriceCents: number
  totalPriceCents: number
  modifiers?: string[]
  note?: string | null
  isCortesia?: boolean
  weightSummary?: string | null
  areaSourceLabel?: string | null
  isComboHeader?: boolean
  isComboComponent?: boolean
}

export interface ReceiptTender {
  kind: 'CASH' | 'CARD' | 'OTHER'
  /** Etiqueta que se imprime tras "Pago:" — "Efectivo", "Tarjeta", "Transferencia"… */
  label: string
  cardBrand?: string | null
  cardLastFour?: string | null
  authCode?: string | null
  referenceNumber?: string | null
  tenderedCents?: number | null
  changeCents?: number | null
  merchantAccountId?: string | null
}

/** Snapshot de la venta al momento de imprimir. Centavos enteros; instante ISO; zona IANA. */
export interface ReceiptSale {
  kind: 'SALE' | 'REFUND'
  orderNumber: string
  orderType: string
  occurredAt: string
  timezone: string
  items: ReceiptSaleItem[]
  subtotalCents: number
  taxCents: number
  discountCents: number | null
  tipCents: number | null
  totalCents: number
  tender: ReceiptTender
  staffName?: string | null
  transactionId?: string | null
  receiptUrl?: string | null
  areaDeliveryCode?: string | null
  reprint?: { printedAt: string } | null
  appVersion?: string | null
}

export interface ReceiptFiscalEmisor {
  id: string
  legalName: string
  rfc: string
  lugarExpedicion: string | null
  merchantAccountIds: string[]
}

/** Lo que del venue necesita el ticket: viaja en receiptInfo (spec § 5.6 y 7.3). */
export interface ReceiptVenueInfo {
  name: string
  address?: string | null
  city?: string | null
  state?: string | null
  zipCode?: string | null
  phone?: string | null
  hasLogo: boolean
  fiscalEmisors: ReceiptFiscalEmisor[]
  principalEmisorId: string | null
  legacy: { legalName: string | null; rfc: string | null }
}

export interface ReceiptInput {
  sale: ReceiptSale
  venue: ReceiptVenueInfo
}
