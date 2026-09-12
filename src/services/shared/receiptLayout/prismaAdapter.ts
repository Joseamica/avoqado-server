import { Prisma } from '@prisma/client'
import type { ReceiptInput, ReceiptSale, ReceiptSaleItem, ReceiptTender, ReceiptVenueInfo } from './types'

/**
 * 🔴 EL ÚNICO SITIO DE LA FASE 1 DONDE EL DINERO CAMBIA DE UNIDAD.
 *
 * La plataforma trabaja en PESOS 1:1 (`Decimal(x,2)`); el intérprete del ticket pide CENTAVOS
 * ENTEROS. Se usa la aritmética de Decimal, nunca la del flotante: `Number('19.99') * 100` da
 * 1998.9999999999998 y trunca un centavo en CADA ticket.
 *
 * Misma técnica que `toStripeAmount` (src/services/payments/providers/money.ts), el otro
 * cruce de frontera de unidades del repo. Hay una prueba que falla si aparece aritmética de
 * dinero en cualquier otro archivo de este módulo.
 */
export function pesosACentavos(d: Prisma.Decimal | number | string | null | undefined): number {
  if (d === null || d === undefined) return 0
  const dec = d instanceof Prisma.Decimal ? d : new Prisma.Decimal(d)
  const centavos = dec.mul(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber()
  if (!Number.isSafeInteger(centavos)) {
    throw new Error(`Conversión de dinero inválida para el ticket: ${dec.toString()} -> ${centavos}`)
  }
  return centavos
}

// ─── Tipos mínimos: lo que el llamador tiene que pedirle a Prisma ───────────────────────
// Los nombres están VERIFICADOS contra prisma/schema.prisma el 12-sep-2026. Si alguno cambia,
// cámbialo aquí y en el `select` del llamador, nunca inventes uno.

export interface OrderItemParaTicket {
  /** Nombre DENORMALIZADO del producto. Es nulable en el schema. */
  productName: string | null
  quantity: number
  unitPrice: Prisma.Decimal
  total: Prisma.Decimal
  notes: string | null
  isCortesia: boolean
  weightQuantity: Prisma.Decimal | null
  weightUnit: string | null
  modifiers: Array<{ name: string | null }>
}

export interface OrderParaTicket {
  orderNumber: string
  type: string
  subtotal: Prisma.Decimal
  taxAmount: Prisma.Decimal
  discountAmount: Prisma.Decimal | null
  total: Prisma.Decimal
  items: OrderItemParaTicket[]
}

export interface PaymentParaTicket {
  amount: Prisma.Decimal
  tipAmount: Prisma.Decimal
  method: string
  createdAt: Date
  merchantAccountId: string | null
  cardBrand: string | null
  maskedPan: string | null
  authorizationNumber: string | null
  referenceNumber: string | null
  receiptUrl: string | null
  processedBy?: { firstName: string | null; lastName: string | null } | null
}

export interface VenueParaTicket {
  name: string
  address: string | null
  city: string | null
  state: string | null
  zipCode: string | null
  phone: string | null
  logo: string | null
  rfc: string | null
  legalName: string | null
  timezone: string
  fiscalEmisors: Array<{
    id: string
    legalName: string
    rfc: string
    lugarExpedicion: string | null
    /** 🔴 `merchantAccountId` es NULABLE en MerchantFiscalConfig: se filtran los nulos. */
    merchantConfigs: Array<{ merchantAccountId: string | null }>
  }>
}

// ─── Etiquetas de los enums reales ──────────────────────────────────────────────────────

const ETIQUETA_TIPO: Record<string, string> = {
  DINE_IN: 'En mesa',
  TAKEOUT: 'Para llevar',
  DELIVERY: 'A domicilio',
  PICKUP: 'Recoger',
  MANUAL_ENTRY: 'En tienda',
}

const ETIQUETA_METODO: Record<string, string> = {
  CASH: 'Efectivo',
  CREDIT_CARD: 'Tarjeta',
  DEBIT_CARD: 'Tarjeta',
  DIGITAL_WALLET: 'Cartera digital',
  BANK_TRANSFER: 'Transferencia',
  CRYPTOCURRENCY: 'Cripto',
  OTHER: 'Otro',
}

/** Los últimos cuatro de un PAN enmascarado ("411111******1234" -> "1234"). */
function ultimosCuatro(maskedPan: string | null): string | null {
  if (!maskedPan) return null
  const digitos = maskedPan.replace(/\D/g, '')
  return digitos.length >= 4 ? digitos.slice(-4) : null
}

/**
 * 🔴 `tenderedCents` y `changeCents` quedan en null A PROPÓSITO: `Payment` NO guarda el
 * efectivo que el cliente entregó ni el cambio (verificado en el schema el 12-sep). Eso sólo
 * lo sabe el aparato que cobró. El intérprete ya omite esos renglones cuando faltan, así que
 * un ticket armado en el SERVIDOR (vista previa, MCP) sale sin «Recibido/Cambio» — que es la
 * verdad, no un hueco. Si algún día se persisten, se llenan aquí y en ningún otro sitio.
 */
function aTender(payment: PaymentParaTicket): ReceiptTender {
  const esEfectivo = payment.method === 'CASH'
  const esTarjeta = payment.method === 'CREDIT_CARD' || payment.method === 'DEBIT_CARD'
  return {
    kind: esEfectivo ? 'CASH' : esTarjeta ? 'CARD' : 'OTHER',
    label: ETIQUETA_METODO[payment.method] ?? 'Otro',
    cardBrand: payment.cardBrand,
    cardLastFour: ultimosCuatro(payment.maskedPan),
    authCode: payment.authorizationNumber,
    referenceNumber: payment.referenceNumber,
    tenderedCents: null,
    changeCents: null,
    merchantAccountId: payment.merchantAccountId,
  }
}

function aItem(i: OrderItemParaTicket): ReceiptSaleItem {
  const resumenPeso =
    i.weightQuantity && i.weightUnit
      ? `${i.weightQuantity.toString()} ${i.weightUnit} × $${i.unitPrice.toFixed(2)}/${i.weightUnit}`
      : null
  const modificadores = i.modifiers.map(m => m.name).filter((n): n is string => Boolean(n))
  return {
    // Sin nombre denormalizado NI producto, el ticket dice «Artículo» — nunca «undefined».
    name: i.productName ?? 'Artículo',
    quantity: i.quantity,
    unitPriceCents: pesosACentavos(i.unitPrice),
    totalPriceCents: pesosACentavos(i.total),
    modifiers: modificadores.length > 0 ? modificadores : undefined,
    note: i.notes,
    isCortesia: i.isCortesia,
    weightSummary: resumenPeso,
  }
}

/**
 * El venue tal como lo necesita el ticket. Lo usan el adaptador completo, la vista previa del
 * dashboard y las tools del MCP: un solo mapeo, para que la vista previa no pueda divergir del
 * ticket real.
 */
export function buildVenueInfo(venue: VenueParaTicket): ReceiptVenueInfo {
  return {
    name: venue.name,
    address: venue.address,
    city: venue.city,
    state: venue.state,
    zipCode: venue.zipCode,
    phone: venue.phone,
    hasLogo: Boolean(venue.logo),
    fiscalEmisors: venue.fiscalEmisors.map(e => ({
      id: e.id,
      legalName: e.legalName,
      rfc: e.rfc,
      lugarExpedicion: e.lugarExpedicion,
      merchantAccountIds: e.merchantConfigs.map(m => m.merchantAccountId).filter((id): id is string => Boolean(id)),
    })),
    // El principal = el primero de la lista; el llamador la pide con orderBy createdAt asc,
    // que es el mismo criterio que nómina y contabilidad (spec § 5.6, caso 2).
    principalEmisorId: venue.fiscalEmisors[0]?.id ?? null,
    legacy: { legalName: venue.legalName, rfc: venue.rfc },
  }
}

/** Prisma → lo que el intérprete puro de la Fase 0 sabe leer. */
export function buildReceiptInput(params: {
  order: OrderParaTicket
  payment: PaymentParaTicket
  venue: VenueParaTicket
  kind?: 'SALE' | 'REFUND'
  areaDeliveryCode?: string | null
  transactionId?: string | null
  reprintAt?: Date | null
  appVersion?: string | null
}): ReceiptInput {
  const { order, payment, venue } = params

  const sale: ReceiptSale = {
    kind: params.kind ?? 'SALE',
    orderNumber: order.orderNumber,
    orderType: ETIQUETA_TIPO[order.type] ?? 'En tienda',
    // 🔴 La fecha de la VENTA, no la de impresión (arreglo 3 de la PAX, spec § 10).
    occurredAt: payment.createdAt.toISOString(),
    timezone: venue.timezone,
    items: order.items.map(aItem),
    subtotalCents: pesosACentavos(order.subtotal),
    taxCents: pesosACentavos(order.taxAmount),
    discountCents: order.discountAmount ? pesosACentavos(order.discountAmount) || null : null,
    tipCents: pesosACentavos(payment.tipAmount) || null,
    totalCents: pesosACentavos(order.total),
    tender: aTender(payment),
    staffName: [payment.processedBy?.firstName, payment.processedBy?.lastName].filter(Boolean).join(' ') || null,
    transactionId: params.transactionId ?? null,
    receiptUrl: payment.receiptUrl,
    areaDeliveryCode: params.areaDeliveryCode ?? null,
    reprint: params.reprintAt ? { printedAt: params.reprintAt.toISOString() } : null,
    appVersion: params.appVersion ?? null,
  }

  return { sale, venue: buildVenueInfo(venue) }
}
