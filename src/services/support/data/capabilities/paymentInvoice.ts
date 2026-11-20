import { findPaymentsByAmount, invoiceStateOfOrders, type PaymentByAmountRow } from '@/services/dashboard/paymentByAmount.dashboard.service'
import { sumsLegacyQrPayments } from '@/services/legacy/qrPayments.legacy.service'
import type { DataCapability } from '../catalog'
import { template } from '../check'
import { paymentDayText, paymentFormLabel, paymentParams, paymentStatusLabel, paymentWindowsText, type PaymentParams } from '../paymentText'

/**
 * C7 · «Si la venta de ese cobro tiene factura»: el cobro se busca como en C2 (monto, hoy o ayer, hora opcional) y se dice si SU venta
 * tiene factura, como el listado de ventas del panel con su factura («Nueva factura»: `invoiceStateOfOrders`, la regla del candado de
 * emisión). Permisos y candado de esa pantalla: `orders:read` (la ruta), `cfdi:view` y la función CFDI (Premium), sin puesto
 * (`order.dashboard.controller.ts`, `puedeVerFacturas`). Nunca escoge un cobro: de dos a cinco los lista todos, uno por renglón; con
 * más, pide la hora. Nunca imprime el folio, el UUID, el RFC ni ligas: la lectura no los trae.
 */

/** «De dos a cinco se listan todos»: la regla de esta capacidad, no `scope.rows` (con menos renglones la lista saldría incompleta). */
const UP_TO = 5

/** El estado de la venta de UN cobro: el de la regla del panel, sin factura (`NONE`), o un cobro sin venta ligada (`NO_SALE`). */
type Invoice = 'VIGENTE' | 'EN_CANCELACION' | 'NONE' | 'NO_SALE'
type Row = PaymentByAmountRow & { invoice: Invoice }
type Found = { total: number; rows: Row[]; legacyQr: boolean }

const ONE: Record<Invoice, string> = {
  VIGENTE: 'su venta ya tiene factura.',
  EN_CANCELACION: 'la factura de su venta está en cancelación.',
  NONE: 'su venta no tiene factura.',
  NO_SALE: 'ese cobro no está ligado a una venta.',
}
const MANY: Record<Invoice, string> = {
  VIGENTE: 'ya tiene factura',
  EN_CANCELACION: 'factura en cancelación',
  NONE: 'sin factura',
  NO_SALE: 'sin venta ligada',
}
const LEGACY_QR = 'No incluye los cobros QR del sistema anterior.'

export const paymentInvoice: DataCapability<PaymentParams, Found> = {
  key: 'payment_invoice',
  label: 'si la venta de ese cobro tiene factura',
  object: 'si la venta de ese cobro tiene factura',
  aiHint: 'Si la venta de un cobro ya tiene factura. Se identifica por el monto y la hora del cobro, de hoy o de ayer; nunca por folio.',
  permissions: ['orders:read', 'cfdi:view'],
  gate: { featureCode: 'CFDI', gateKind: 'FEATURE', refusal: 'PLAN_INVOICES' },
  params: paymentParams,
  read: async (scope, params) => {
    const found = await findPaymentsByAmount(scope.venueId, { amount: params.amount, windows: params.windows, take: UP_TO })
    // La sucursal del puente tiene cobros QR del sistema anterior que esta lectura no ve: la respuesta lo dice.
    const legacyQr = sumsLegacyQrPayments(scope.venueId)
    // Más de cinco: no se escoge ninguno, y no se leen facturas.
    if (found.total > UP_TO) return { total: found.total, rows: [], legacyQr }
    // Cada venta se pide una vez; lo que se imprime son los COBROS, en el orden de la lectura, cada uno con el estado de SU venta.
    const sales = [...new Set(found.rows.flatMap(row => (row.orderId ? [row.orderId] : [])))]
    const states = await invoiceStateOfOrders(scope.venueId, sales)
    return {
      total: found.total,
      rows: found.rows.map(row => ({ ...row, invoice: row.orderId ? (states.get(row.orderId) ?? 'NONE') : 'NO_SALE' })),
      legacyQr,
    }
  },
  render: (scope, params, found) => {
    const t = template(scope.timezone)
    const lines: string[] = []
    if (found.total > UP_TO)
      lines.push(
        `Hay ${t.count(found.total)} cobros de exactamente ${t.money(params.amount)} ${paymentWindowsText(t, params)} en ${t.text(scope.venueName)} (corte ${t.time(scope.now)}). Dime la hora más exacta y te digo el de ese cobro.`,
      )
    else if (!found.rows.length)
      lines.push(
        `No encontré cobros de exactamente ${t.money(params.amount)} (contando la propina) ${paymentWindowsText(t, params)} en ${t.text(scope.venueName)} (corte ${t.time(scope.now)}). Si la cuenta se pagó en partes, dime el monto de una de ellas.`,
      )
    else if (found.rows.length === 1) {
      const [row] = found.rows
      lines.push(
        `Cobro de exactamente ${t.money(params.amount)} ${paymentDayText(params.day)} a las ${t.time(row.createdAt)} (${paymentFormLabel(t, row)} · ${paymentStatusLabel(row.status)}) en ${t.text(scope.venueName)} (corte ${t.time(scope.now)}): ${ONE[row.invoice]}`,
      )
    } else {
      // Los huecos se anotan en el orden en que salen en el texto (el cotejo los busca así).
      lines.push(
        `Cobros de exactamente ${t.money(params.amount)} ${paymentWindowsText(t, params)} en ${t.text(scope.venueName)} (corte ${t.time(scope.now)}): ${t.count(found.total)}`,
      )
      for (const row of found.rows)
        lines.push(`${t.time(row.createdAt)} · ${paymentFormLabel(t, row)} · ${paymentStatusLabel(row.status)} · ${MANY[row.invoice]}`)
    }
    if (found.legacyQr) lines.push(LEGACY_QR)
    return t.done(lines.join('\n'))
  },
}
