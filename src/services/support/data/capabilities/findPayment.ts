import { findPaymentsByAmount, type PaymentByAmountRow } from '@/services/dashboard/paymentByAmount.dashboard.service'
import { sumsLegacyQrPayments } from '@/services/legacy/qrPayments.legacy.service'
import type { DataCapability } from '../catalog'
import { template } from '../check'
import { paymentFormLabel, paymentParams, paymentStatusLabel, paymentWindowsText, type PaymentParams } from '../paymentText'

/**
 * C2 · «Buscar un cobro por su monto»: si entró un cobro de cierto monto hoy o ayer, opcionalmente cerca de una hora. Los cobros que
 * lista Pagos del panel (sin los PENDING), con el importe o el importe + propina exactos al centavo. Permiso de la ruta del panel
 * (`payments:read`), sin puesto ni candado de plan. Nunca imprime el id del cobro, folio, referencia ni la tarjeta enmascarada: la
 * lectura no los trae.
 */

type Found = { total: number; rows: PaymentByAmountRow[]; legacyQr: boolean }

const LEGACY_QR = 'No incluye los cobros QR del sistema anterior.'
// T-F11b: un cobro atorado en el procesador o encolado sin red llega después; un «no encontré» a secas puede hacer que se cobre dos veces.
const NOT_FOUND_CAUTION =
  'Que no aparezca no quiere decir que no se cobró: si la terminal se trabó o estuvo sin internet, el cobro puede llegar después. Antes de cobrar otra vez, revisa la terminal.'

export const findPayment: DataCapability<PaymentParams, Found> = {
  key: 'find_payment',
  label: 'buscar un cobro por su monto',
  object: 'los cobros',
  aiHint: 'Si entró un cobro de cierto monto hoy o ayer, opcionalmente cerca de una hora. Necesita el monto.',
  permissions: ['payments:read'],
  params: paymentParams,
  read: async (scope, params) => {
    const found = await findPaymentsByAmount(scope.venueId, { amount: params.amount, windows: params.windows, take: scope.rows })
    // La sucursal del puente tiene cobros QR del sistema anterior que esta lectura no ve: la respuesta lo dice.
    return { total: found.total, rows: found.rows, legacyQr: sumsLegacyQrPayments(scope.venueId) }
  },
  render: (scope, params, found) => {
    const t = template(scope.timezone)
    const lines: string[] = []
    if (!found.rows.length) {
      lines.push(
        `No encontré cobros de exactamente ${t.money(params.amount)} (contando la propina) ${paymentWindowsText(t, params)} en ${t.text(scope.venueName)} (corte ${t.time(scope.now)}). Si fue con centavos u otra hora, escríbelo así.`,
        NOT_FOUND_CAUTION,
      )
      if (found.legacyQr) lines.push(LEGACY_QR)
      return t.done(lines.join('\n'))
    }
    lines.push(
      `Cobros de exactamente ${t.money(params.amount)} ${paymentWindowsText(t, params)} en ${t.text(scope.venueName)} (corte ${t.time(scope.now)}): ${t.count(found.total)}`,
    )
    // Los huecos se anotan en el orden en que salen en el texto (el cotejo los busca así): la propina, en su lugar del renglón.
    for (const row of found.rows) {
      lines.push(
        `${t.time(row.createdAt)} · ${t.money(row.amount)}${row.tipAmount.gt(0) ? ` + propina ${t.money(row.tipAmount)}` : ''} · ${paymentFormLabel(t, row)} · ${paymentStatusLabel(row.status)}`,
      )
    }
    const more = found.total - found.rows.length
    const last = [...(more > 0 ? [`y ${t.count(more)} más; el resto está en el panel.`] : []), ...(found.legacyQr ? [LEGACY_QR] : [])]
    if (last.length) lines.push(last.join(' '))
    return t.done(lines.join('\n'))
  },
}
