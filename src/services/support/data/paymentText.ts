import type { CardBrand, PaymentMethod, Prisma } from '@prisma/client'
import type { PaymentByAmountRow } from '@/services/dashboard/paymentByAmount.dashboard.service'
import type { DataRequest, DataScope, ParamsResult } from './catalog'
import type { template } from './check'
import { matchAmount, timeWindows, type TimeWindow } from './params'

/**
 * Los textos de un cobro que comparten C2 («buscar un cobro por su monto») y C7 («si la venta de ese cobro tiene factura»). Módulo puro
 * de la B (T-B42): sin base y sin servicios del panel. Una capacidad no importa valores de otra, así que lo común vive aquí.
 * Residual de la cabecera de la guardia: fuera de una capacidad la guardia no revisa que las negativas de `paymentParams` sean llaves
 * literales; las cuidan el tipo `ParamsResult` y el orquestador, que sólo contesta textos de SUPPORT_DATA_REFUSALS.
 */

export interface PaymentParams {
  amount: Prisma.Decimal
  day: 'today' | 'yesterday'
  /** De `timeWindows`: sin hora, el día (hoy, hasta el corte); con hora, una o dos ventanas de ±30 min, recortadas al día y al corte. */
  windows: TimeWindow[]
  /** La persona dijo una hora: la respuesta dice sus ventanas («hoy entre 13:30 y 14:30»), no sólo el día. */
  timed: boolean
}

/**
 * Hoy o ayer (sin día, hoy), el monto obligatorio y la hora opcional, cada uno creído sólo si está en el mensaje (los de `params.ts`,
 * T-B32 a T-B36), con `scope.now` y ningún otro reloj.
 */
export function paymentParams(request: DataRequest, message: string, scope: DataScope): ParamsResult<PaymentParams> {
  if (request.day === 'other') return { ok: false, refusal: 'PARAM_DAY' }
  const day = request.day ?? 'today'
  const amount = matchAmount(message, request.amount)
  if (!amount) return { ok: false, refusal: 'PARAM_AMOUNT' }
  const windows = timeWindows(request.time, message, day, scope)
  if (!windows) return { ok: false, refusal: 'PARAM_TIME' }
  return { ok: true, value: { amount, day, windows, timed: Boolean(request.time?.trim()) } }
}

type Template = ReturnType<typeof template>

const DAY = { today: 'hoy', yesterday: 'ayer' } as const

/** «hoy» o «ayer»: el día de la pregunta, como lo dice la respuesta (C7 lo pone delante de la hora de UN cobro). */
export const paymentDayText = (day: PaymentParams['day']): string => DAY[day]

/** «hoy», o con la hora «hoy entre 13:30 y 14:30», y con dos ventanas «ayer entre 01:30 y 02:30 o entre 13:30 y 14:30». */
export function paymentWindowsText(t: Template, params: PaymentParams): string {
  if (!params.timed) return paymentDayText(params.day)
  return `${paymentDayText(params.day)} ${params.windows.map(w => `entre ${t.time(w.from)} y ${t.time(w.to)}`).join(' o ')}`
}

/** Las marcas que se nombran; otra marca dice «Tarjeta». El texto es del código: lo que trae la base sólo elige la llave. */
const BRANDS: Partial<Record<CardBrand, string>> = { VISA: 'Visa', MASTERCARD: 'Mastercard', AMERICAN_EXPRESS: 'American Express' }
const METHODS: Record<PaymentMethod, string> = {
  CASH: 'Efectivo',
  CREDIT_CARD: 'Tarjeta de crédito',
  DEBIT_CARD: 'Tarjeta de débito',
  DIGITAL_WALLET: 'Cartera digital',
  BANK_TRANSFER: 'Transferencia',
  CRYPTOCURRENCY: 'Cripto',
  OTHER: 'Otro',
}

/**
 * La forma de pago: la marca y los últimos 4 («Visa terminación 4242»), la marca sola si no hay tarjeta enmascarada, o, sin marca, el
 * método («Efectivo»). Lo que dice Pagos del panel (`avoqado-web-dashboard/src/pages/Payment/etiquetaDeMetodo.ts`, C7 r1): el saldo a
 * favor (tipo de pago de sistema `STORE_CREDIT`) es «Saldo a favor», y cualquier otro tipo de pago propio o de sistema (Uber Eats, la
 * tarjeta de regalo) se queda con su método, «Otro». Nunca el nombre libre del tipo de pago: la lectura no lo trae. Los 4 dígitos van
 * por `t.last4`, que los anota para el cotejo. Un método que no está en la lista lanza (la respuesta sale CHECK_FAILED, nunca la llave
 * cruda).
 */
export function paymentFormLabel(
  t: Template,
  row: Pick<PaymentByAmountRow, 'method' | 'cardBrand' | 'last4' | 'tenderSystemKind'>,
): string {
  if (row.tenderSystemKind === 'STORE_CREDIT') return 'Saldo a favor'
  if (row.cardBrand) {
    const brand = BRANDS[row.cardBrand] ?? 'Tarjeta'
    return row.last4 ? `${brand} terminación ${t.last4(row.last4)}` : brand
  }
  const method = METHODS[row.method]
  if (!method) throw new Error('Unknown payment method')
  return method
}

/** El estado de un cobro, como lo dice Pagos (C2 y C7). La lectura no trae PENDING. */
const STATUS: Partial<Record<PaymentByAmountRow['status'], string>> = {
  COMPLETED: 'Completado',
  PROCESSING: 'En proceso',
  FAILED: 'Fallido',
  REFUNDED: 'Reembolsado',
}
/** Un estado fuera de la lista lanza (CHECK_FAILED), nunca la llave cruda. */
export function paymentStatusLabel(status: PaymentByAmountRow['status']): string {
  const label = STATUS[status]
  if (!label) throw new Error('Unknown payment status')
  return label
}
