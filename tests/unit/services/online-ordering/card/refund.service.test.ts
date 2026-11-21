// tests/unit/services/online-ordering/card/refund.service.test.ts
/**
 * La devolución a la tarjeta en aislamiento: la máquina de estados (sólo avanza, CAS), qué se le manda a Stripe, cuándo nace el
 * renglón del libro (`issueRefund` va espiado), el sello, la revisión tardía, la reversa y «Devolver por otro medio». La tabla de
 * devoluciones es un doble en memoria que contesta las mismas consultas; la prueba con Postgres real está en
 * `tests/integration/online-ordering/card-refund.integration.test.ts`.
 */
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'

const refund = jest.fn()
const getRefund = jest.fn()
const listRefunds = jest.fn()
const getApplicationFeeRefundedCents = jest.fn()
const getChargeRefunds = jest.fn()
jest.mock('@/services/payments/provider-registry', () => ({
  __esModule: true,
  getProvider: jest.fn(() => ({ refund, getRefund, listRefunds, getApplicationFeeRefundedCents, getChargeRefunds })),
}))
jest.mock('@/services/dashboard/refund.dashboard.service', () => ({
  __esModule: true,
  issueRefund: jest.fn(),
  bloquearCobroParaReembolso: jest.fn(),
  writeRefundInTx: jest.fn(),
}))
// D661 (Task 6): lo que el saldo a favor usa de afuera, espiado (la libreta y el núcleo del reembolso tienen sus propias pruebas).
jest.mock('@/services/storeCredit/storeCreditTender', () => ({
  __esModule: true,
  storeCreditAvailable: jest.fn(() => true),
  prepararMediosDeSaldoAFavor: jest.fn(async () => undefined),
  resolveStoreCreditTenderInTx: jest.fn(async () => ({
    tenderTypeId: 'tt-saldo',
    tenderRevision: 1,
    method: 'OTHER',
    tenderLabel: 'Saldo a favor',
    tenderCountsAsCash: false,
    tenderCaptureTip: false,
    tenderSatFormaPago: '17',
    tenderCommissionPercent: null,
    fundsFlow: 'EXTERNAL_RECORDED',
  })),
}))
jest.mock('@/services/giftCards/giftCardLedger', () => ({
  __esModule: true,
  abonarSaldoAFavorEnTx: jest.fn(),
}))
jest.mock('@/services/tpv/paymentEffects.service', () => ({
  __esModule: true,
  enqueueRefundPaymentEffectsInTx: jest.fn(async () => undefined),
}))
jest.mock('@/services/wallet/stampLedger.service', () => ({
  __esModule: true,
  reverseStampForOrder: jest.fn(async () => ({ reversed: true })),
}))
jest.mock('@/services/dashboard/notification.dashboard.service', () => ({
  __esModule: true,
  sendVenueNotification: jest.fn(async () => []),
}))

import { logAction } from '@/services/dashboard/activity-log.service'
import logger from '@/config/logger'
import { bloquearCobroParaReembolso, issueRefund, writeRefundInTx } from '@/services/dashboard/refund.dashboard.service'
import { prepararMediosDeSaldoAFavor, storeCreditAvailable } from '@/services/storeCredit/storeCreditTender'
import { abonarSaldoAFavorEnTx } from '@/services/giftCards/giftCardLedger'
import { enqueueRefundPaymentEffectsInTx } from '@/services/tpv/paymentEffects.service'
import { sendVenueNotification } from '@/services/dashboard/notification.dashboard.service'
import { reverseStampForOrder } from '@/services/wallet/stampLedger.service'
import {
  advanceCardRefund,
  handleStripeRefundEvent,
  hayDevolucionPorFuera,
  refundCardOnlineOrder,
  resolveReversedCardRefund,
  NEVER_AGAIN,
} from '@/services/online-ordering/card/refund.service'
import { cerrarDevueltosPendientes, sweepCardRefunds } from '@/services/online-ordering/card/refund-reconciler.service'
import { cerrarComoDevueltoEnTx } from '@/services/online-ordering/card/devuelto'
import * as devuelto from '@/services/online-ordering/card/devuelto'
import { operationHash } from '@/utils/operationHash'

const D = (v: string) => new Prisma.Decimal(v)
const NOW = new Date('2026-10-29T18:00:00.000Z')
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const at = (ms: number) => new Date(NOW.getTime() + ms)
const CHARGE = {
  id: 'ch1',
  venueId: 'v1',
  onlineOrderId: 'oo1',
  ecommerceMerchantId: 'em1',
  paymentIntentId: 'pi_1',
  amount: D('250.00'),
  applicationFeeCents: 290,
  status: 'CAPTURED',
  merchantSnapshot: { connectAccountId: 'acct_A', sandboxMode: true, providerCode: 'STRIPE_CONNECT' },
}
const readEntry = <T>(read: () => Promise<T>) => read()

// ── La tabla de devoluciones, en memoria: contesta las consultas del servicio y nunca comparte el objeto guardado ──
type Row = Record<string, any>
const store = new Map<string, Row>()
const reversals: Row[] = []
let seq = 0
const matches = (row: Row, where: Record<string, any> = {}): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (k === 'chargeId_key') return row.chargeId === v.chargeId && row.key === v.key
    if (k === 'OR') return (v as Record<string, any>[]).some(sub => matches(row, sub))
    // El filtro por relación (`charge: { onlineOrder: { orderId } }`): en este doble el único cargo es ch1, del pedido ord1.
    if (k === 'charge') return row.chargeId === 'ch1' && v?.onlineOrder?.orderId === 'ord1'
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v) return v.in.includes(row[k])
      if ('lte' in v) return row[k] <= v.lte
      if ('not' in v) return row[k] !== v.not
    }
    if (v === null) return row[k] == null
    return row[k] === v
  })
const rows = () => [...store.values()]
const masNuevas = (filas: Row[]) => [...filas].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
const cardRefund = {
  findUnique: jest.fn(async ({ where, select }: any) => {
    const r = rows().find(x => matches(x, where))
    // El aviso de Stripe pide la foto del cargo (Codex r1 C2): en este doble el único cargo es ch1.
    return r ? { ...r, ...(select?.charge ? { charge: CHARGE } : {}) } : null
  }),
  findFirst: jest.fn(async ({ where, orderBy }: any) => {
    const hallados = rows().filter(x => matches(x, where))
    const r = orderBy ? masNuevas(hallados)[0] : hallados[0]
    return r ? { ...r } : null
  }),
  findMany: jest.fn(async ({ where, take }: any) =>
    rows()
      .filter(x => matches(x, where))
      .sort((a, b) => a.nextCheckAt.getTime() - b.nextCheckAt.getTime() || (a.id < b.id ? -1 : 1))
      .slice(0, take)
      .map(x => ({ ...x })),
  ),
  create: jest.fn(async ({ data }: any) => {
    const row = {
      id: `cr${String(++seq).padStart(3, '0')}`,
      status: 'REQUESTED',
      nextCheckAt: NOW,
      createdAt: NOW,
      stripeRefundId: null,
      refundPaymentId: null,
      feeRefundedCents: null,
      stampReversedAt: null,
      alertedAt: null,
      lastError: null,
      recordedAt: null,
      lastSentAt: null,
      note: null,
      ...data,
    }
    store.set(row.id, row)
    return { ...row }
  }),
  updateMany: jest.fn(async ({ where, data }: any) => {
    let count = 0
    for (const r of rows()) {
      if (!matches(r, where)) continue
      Object.assign(r, data)
      count++
    }
    return { count }
  }),
  aggregate: jest.fn(async ({ where }: any) => {
    const f = rows().filter(x => matches(x, where))
    return {
      _sum: {
        feeRefundedCents: f.length ? f.reduce((s, x) => s + (x.feeRefundedCents ?? 0), 0) : null,
        amountCents: f.length ? f.reduce((s, x) => s + x.amountCents, 0) : null,
      },
    }
  }),
}
const reversal = {
  create: jest.fn(async ({ data }: any) => {
    const row = { id: `rv${reversals.length + 1}`, resolvedAt: null, ...data }
    reversals.push(row)
    return { ...row }
  }),
  findUnique: jest.fn(async ({ where }: any) => {
    const r = reversals.find(x => matches(x, where))
    return r ? { ...r } : null
  }),
  updateMany: jest.fn(async ({ where, data }: any) => {
    let count = 0
    for (const r of reversals) {
      if (!matches(r, where)) continue
      Object.assign(r, data)
      count++
    }
    return { count }
  }),
}
/** Una fila sembrada a mano (como la dejaría un proceso que murió en medio). */
const seed = (o: Row): Row => {
  const row = {
    id: o.id ?? `cr${String(++seq).padStart(3, '0')}`,
    venueId: 'v1',
    chargeId: 'ch1',
    key: o.key ?? `key-${seq}`,
    amountCents: 25_000,
    reason: 'CANCELLED_ORDER',
    staffId: 'staff1',
    note: null,
    requestHash: 'h',
    status: 'REQUESTED',
    stripeRefundId: null,
    refundPaymentId: null,
    feeRefundedCents: null,
    stampReversedAt: null,
    nextCheckAt: NOW,
    lastError: null,
    alertedAt: null,
    recordedAt: null,
    lastSentAt: null,
    createdAt: NOW,
    ...o,
  }
  store.set(row.id, row)
  return row
}
const get = (id: string) => store.get(id)!

// Lo que contesta la caja (`postPayOutInTx` real): sesión abierta o ninguna.
let openSession: Array<{ id: string }> = [{ id: 'cds1' }]
const drawerEvents: Row[] = []

const stateOf = (status: string, o: Partial<{ refundId: string; amountCents: number; failureReason: string | null }> = {}) => ({
  refundId: o.refundId ?? 're_1',
  status,
  amountCents: o.amountCents ?? 25_000,
  failureReason: o.failureReason ?? null,
})
const created = (status: 'PENDING' | 'SUCCEEDED' | 'FAILED', refundId = 're_1') => ({ refundId, amount: 25_000, status })
const pedir = (
  o: Partial<{
    amount: string
    key: string
    note: string | null
    reason: string
    orderId: string
    expected: string | null
    destino: 'CARD' | 'STORE_CREDIT'
    efectoEsperado: { cierraComoDevuelto: boolean }
  }> = {},
) =>
  refundCardOnlineOrder({
    venueId: 'v1',
    orderId: o.orderId ?? 'ord1',
    amount: D(o.amount ?? '250.00'),
    reason: (o.reason ?? 'CANCELLED_ORDER') as any,
    staffId: 'staff1',
    idempotencyKey: o.key ?? 'llave-del-panel-1',
    note: o.note === undefined ? null : o.note,
    // Sin decir otra cosa, el operador vio la lista al día.
    expectedLatestRefundId: o.expected === undefined ? (masNuevas(rows())[0]?.id ?? null) : o.expected,
    ...(o.destino ? { destino: o.destino } : {}),
    ...(o.efectoEsperado ? { efectoEsperado: o.efectoEsperado } : {}),
  })

// Sólo el reloj es falso (`new Date()` del servicio = NOW); los temporizadores siguen reales.
beforeAll(() => {
  jest.useFakeTimers({
    now: NOW,
    doNotFake: [
      'nextTick',
      'setImmediate',
      'clearImmediate',
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'queueMicrotask',
    ],
  })
})
afterAll(() => jest.useRealTimers())

beforeEach(() => {
  jest.setSystemTime(NOW)
  jest.clearAllMocks()
  store.clear()
  reversals.length = 0
  drawerEvents.length = 0
  seq = 0
  openSession = [{ id: 'cds1' }]
  ;(prismaMock as any).onlineOrderCardRefund = cardRefund
  ;(prismaMock as any).onlineOrderCardRefundReversal = reversal
  ;(prismaMock as any).moneyAnomaly = { createMany: jest.fn(async () => ({ count: 1 })) }
  ;(prismaMock as any).cashDrawerEvent = {
    findFirst: jest.fn(async ({ where }: any) => drawerEvents.find(e => e.localId === where.localId) ?? null),
    create: jest.fn(async ({ data }: any) => {
      const e = { id: `cde${drawerEvents.length + 1}`, ...data }
      drawerEvents.push(e)
      return { id: e.id }
    }),
  }
  ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prismaMock))
  ;(prismaMock.$queryRaw as jest.Mock).mockImplementation(async (q: any) => {
    const sql = Array.isArray(q) ? q.join('?') : Array.isArray(q?.strings) ? q.strings.join('?') : String(q)
    if (sql.includes('"CashDrawerSession"')) return openSession
    if (sql.includes('"processorId"')) return [{ id: 'pay1', processorData: { refunds: [{ refundPaymentId: 'rf1' }] } }]
    return [{ id: 'ord1' }] // el candado de la orden
  })
  prismaMock.onlineOrder.findFirst.mockResolvedValue({ paymentMode: 'CARD_ONLINE', charge: CHARGE } as any)
  prismaMock.onlineOrderCharge.findUnique.mockResolvedValue({ ...CHARGE, onlineOrder: { orderId: 'ord1' } } as any)
  prismaMock.payment.findFirst.mockResolvedValue({ id: 'pay1' } as any)
  prismaMock.payment.update.mockResolvedValue({} as any)
  ;(prismaMock.staff.findUnique as jest.Mock).mockResolvedValue({ firstName: 'Ana', lastName: 'Gerente' })
  ;(bloquearCobroParaReembolso as jest.Mock).mockResolvedValue({ remainingBeforeCents: 25_000 })
  ;(issueRefund as jest.Mock).mockImplementation(async (i: any) => ({
    refundId: `pay-refund-${i.idempotencyKey}`,
    originalPaymentId: 'pay1',
    amount: i.amount / 100,
    remainingRefundable: 0,
    status: 'COMPLETED',
  }))
  refund.mockResolvedValue(created('SUCCEEDED'))
  ;(reverseStampForOrder as jest.Mock).mockResolvedValue({ reversed: true })
  getRefund.mockResolvedValue(stateOf('SUCCEEDED'))
  listRefunds.mockResolvedValue([])
  getApplicationFeeRefundedCents.mockResolvedValue(290)
  getChargeRefunds.mockResolvedValue({ amountRefundedCents: 0, refunds: [] })
})

describe('la vista del operador: sólo pasa si lo último que vio sigue siendo lo último (Codex panel r4)', () => {
  const A = 'llave-intento-a'
  const B = 'llave-intento-b'

  it('dos llaves con la misma vista: la primera devuelve; la segunda 409 CARD_REFUND_STALE_VIEW, sin fila ni Stripe', async () => {
    await pedir({ key: A, amount: '50.00', expected: null })
    await expect(pedir({ key: B, amount: '50.00', expected: null })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CARD_REFUND_STALE_VIEW',
    })
    expect(refund).toHaveBeenCalledTimes(1)
    expect(store.size).toBe(1)
  })

  it('la misma llave con la vista vieja sigue siendo replay: el reintento recupera su devolución', async () => {
    const r = await pedir({ key: A, amount: '50.00', expected: null })
    const otra = await pedir({ key: A, amount: '50.00', expected: null })
    expect(otra).toMatchObject({ replay: true, cardRefundId: r.cardRefundId })
    expect(refund).toHaveBeenCalledTimes(1)
  })

  it('una FAILED también cuenta como la última: con la vista vieja rebota; viéndola, se puede otra', async () => {
    refund.mockResolvedValueOnce(created('FAILED'))
    const fallida = await pedir({ key: A, amount: '50.00', expected: null })
    expect(fallida.status).toBe('FAILED')
    await expect(pedir({ key: B, amount: '50.00', expected: null })).rejects.toMatchObject({ code: 'CARD_REFUND_STALE_VIEW' })
    await expect(pedir({ key: B, amount: '50.00', expected: fallida.cardRefundId })).resolves.toMatchObject({ replay: false })
  })

  it('decir que vio una devolución cuando el pedido no tiene ninguna → 409, nada se crea', async () => {
    await expect(pedir({ key: A, amount: '50.00', expected: 'cr-que-no-existe' })).rejects.toMatchObject({ code: 'CARD_REFUND_STALE_VIEW' })
    expect(store.size).toBe(0)
    expect(refund).not.toHaveBeenCalled()
  })
})

describe('refundCardOnlineOrder', () => {
  it('Codex r3 #3: un cobro hecho a mano en Stripe sin comisión NO pide devolver una comisión que no existe', async () => {
    prismaMock.payment.findFirst.mockResolvedValue({ id: 'pay1', feeAmount: new Prisma.Decimal('0.00') } as any)
    getApplicationFeeRefundedCents.mockResolvedValue(0)
    const r = await pedir()
    expect(refund).toHaveBeenCalledTimes(1)
    expect(refund.mock.calls[0][1]).toMatchObject({ paymentIntentId: 'pi_1', amount: 25_000, refundApplicationFee: false })
    expect(r).toMatchObject({ status: 'RECORDED' })
  })

  it('reembolso total: Stripe con refund_application_fee y metadata con cardRefundId; un renglón REFUND con la comisión devuelta', async () => {
    const r = await pedir()
    expect(r).toMatchObject({ status: 'RECORDED', cardRefundStatus: 'RECORDED', replay: false })
    const row = get(r.cardRefundId)
    expect(refund).toHaveBeenCalledTimes(1)
    expect(refund).toHaveBeenCalledWith(expect.objectContaining({ providerCredentials: { connectAccountId: 'acct_A' } }), {
      paymentIntentId: 'pi_1',
      amount: 25_000,
      refundApplicationFee: true,
      idempotencyKey: `online-order:ord1:refund:${row.id}`,
      metadata: { type: 'online_order_refund', cardRefundId: row.id, orderId: 'ord1', venueId: 'v1' },
    })
    expect(issueRefund).toHaveBeenCalledTimes(1)
    expect(issueRefund).toHaveBeenCalledWith({
      venueId: 'v1',
      paymentId: 'pay1',
      amount: 25_000,
      reason: 'CANCELLED_ORDER',
      staffId: 'staff1',
      note: 'Stripe re_1',
      idempotencyKey: `oocr_${row.id}`,
      viaOnlineOrders: true,
      platformFeeRefundCents: 290,
      excludeCardRefundId: row.id,
    })
    expect(row).toMatchObject({
      status: 'RECORDED',
      stripeRefundId: 're_1',
      refundPaymentId: `pay-refund-oocr_${row.id}`,
      feeRefundedCents: 290,
    })
    expect(r.refundId).toBe(row.refundPaymentId)
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'ONLINE_ORDER_CARD_REFUNDED', entityId: row.id }))
  })

  it('parcial dos veces: la comisión de cada una es lo que Stripe devolvió de más (leído, no calculado)', async () => {
    getApplicationFeeRefundedCents.mockResolvedValueOnce(145)
    ;(bloquearCobroParaReembolso as jest.Mock).mockResolvedValueOnce({ remainingBeforeCents: 25_000 })
    const a = await pedir({ amount: '125.00', key: 'llave-parcial-a' })
    refund.mockResolvedValueOnce(created('SUCCEEDED', 're_2'))
    getApplicationFeeRefundedCents.mockResolvedValueOnce(290)
    ;(bloquearCobroParaReembolso as jest.Mock).mockResolvedValueOnce({ remainingBeforeCents: 12_500 })
    const b = await pedir({ amount: '125.00', key: 'llave-parcial-b' })
    expect(get(a.cardRefundId).feeRefundedCents).toBe(145)
    expect(get(b.cardRefundId).feeRefundedCents).toBe(145)
    expect((issueRefund as jest.Mock).mock.calls.map(c => c[0].platformFeeRefundCents)).toEqual([145, 145])
  })

  it('misma llave y misma solicitud → replay sin otra devolución; otro importe → 409 IDEMPOTENCY_KEY_REUSED y Stripe no se llama', async () => {
    const first = await pedir()
    const again = await pedir()
    expect(again).toMatchObject({ cardRefundId: first.cardRefundId, status: 'RECORDED', replay: true })
    expect(refund).toHaveBeenCalledTimes(1)
    expect(issueRefund).toHaveBeenCalledTimes(1)

    refund.mockClear()
    await expect(pedir({ amount: '100.00' })).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED' })
    expect(refund).not.toHaveBeenCalled()
    expect(store.size).toBe(1)
  })

  it('la repetición va ANTES de validar saldo: con el cobro ya devuelto, la misma llave sigue siendo replay', async () => {
    const first = await pedir()
    ;(bloquearCobroParaReembolso as jest.Mock).mockResolvedValue({ remainingBeforeCents: 0 })
    await expect(pedir()).resolves.toMatchObject({ cardRefundId: first.cardRefundId, replay: true })
  })

  it('con otra devolución en curso del mismo pedido → 409 y nada nuevo', async () => {
    seed({ status: 'PENDING', stripeRefundId: 're_9', key: 'otra' })
    await expect(pedir({ amount: '10.00' })).rejects.toMatchObject({ statusCode: 409, code: 'CARD_REFUND_IN_PROGRESS' })
    expect(store.size).toBe(1)
    expect(refund).not.toHaveBeenCalled()
  })

  it('más de lo que queda por devolver → 400 sin fila ni Stripe', async () => {
    ;(bloquearCobroParaReembolso as jest.Mock).mockResolvedValue({ remainingBeforeCents: 10_000 })
    await expect(pedir({ amount: '150.00' })).rejects.toMatchObject({ statusCode: 400 })
    expect(store.size).toBe(0)
    expect(refund).not.toHaveBeenCalled()
  })

  it('un cargo que no está CAPTURED → 400; un pedido que no es de tarjeta → 400', async () => {
    prismaMock.onlineOrder.findFirst.mockResolvedValueOnce({
      paymentMode: 'CARD_ONLINE',
      charge: { ...CHARGE, status: 'AUTHORIZED' },
    } as any)
    await expect(pedir()).rejects.toMatchObject({ statusCode: 400 })
    prismaMock.onlineOrder.findFirst.mockResolvedValueOnce({ paymentMode: 'PAY_AT_PICKUP', charge: null } as any)
    await expect(pedir()).rejects.toMatchObject({ statusCode: 400 })
    expect(refund).not.toHaveBeenCalled()
  })

  it('Stripe responde pending → sin renglón; al ver succeeded escribe uno solo', async () => {
    refund.mockResolvedValue(created('PENDING'))
    const r = await pedir()
    expect(r).toMatchObject({ status: 'PENDING', refundId: null })
    expect(issueRefund).not.toHaveBeenCalled()
    expect(get(r.cardRefundId).nextCheckAt).toEqual(at(MIN))

    getRefund.mockResolvedValue(stateOf('PENDING'))
    await expect(advanceCardRefund(r.cardRefundId, at(MIN))).resolves.toBe('PENDING')
    expect(issueRefund).not.toHaveBeenCalled()

    getRefund.mockResolvedValue(stateOf('SUCCEEDED'))
    await expect(advanceCardRefund(r.cardRefundId, at(2 * MIN))).resolves.toBe('RECORDED')
    await expect(advanceCardRefund(r.cardRefundId, at(3 * MIN))).resolves.toBe('RECORDED')
    expect(issueRefund).toHaveBeenCalledTimes(1)
  })

  it('failed → ningún renglón y ONLINE_ORDER_CARD_REFUND_FAILED', async () => {
    refund.mockResolvedValue(created('FAILED'))
    const r = await pedir()
    expect(r).toMatchObject({ status: 'FAILED', refundId: null })
    expect(issueRefund).not.toHaveBeenCalled()
    expect(get(r.cardRefundId).status).toBe('FAILED')
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'ONLINE_ORDER_CARD_REFUND_FAILED' }))
  })

  it.each([400, 404])(
    'Stripe rechaza la solicitud (StripeInvalidRequestError %s) → FAILED con su motivo: no se movió dinero',
    async code => {
      refund.mockRejectedValue(
        Object.assign(new Error('Charge ch_1 has been charged back'), { type: 'StripeInvalidRequestError', statusCode: code }),
      )
      const r = await pedir()
      expect(r.status).toBe('FAILED')
      expect(get(r.cardRefundId)).toMatchObject({ status: 'FAILED', lastError: 'Charge ch_1 has been charged back' })
    },
  )

  it('fix r1 M1: un 409 (idempotency_key_in_use tras los reintentos del SDK) NO es «no existe»: queda SENDING y se resuelve por listRefunds', async () => {
    refund.mockRejectedValue(
      Object.assign(new Error('There is currently another in-progress request using this Idempotent Key'), {
        type: 'StripeInvalidRequestError',
        statusCode: 409,
      }),
    )
    const r = await pedir()
    expect(r).toMatchObject({ status: 'UNKNOWN', cardRefundStatus: 'SENDING' })
    listRefunds.mockResolvedValue([{ ...stateOf('SUCCEEDED', { refundId: 're_late' }), metadata: { cardRefundId: r.cardRefundId } }])
    await expect(advanceCardRefund(r.cardRefundId, at(MIN))).resolves.toBe('RECORDED')
    expect(get(r.cardRefundId).stripeRefundId).toBe('re_late')
    expect(refund).toHaveBeenCalledTimes(1)
  })

  it('la respuesta de Stripe se pierde → UNKNOWN: la fila queda SENDING (su monto reservado) con lastError', async () => {
    refund.mockRejectedValue(Object.assign(new Error('se perdió la respuesta'), { type: 'StripeConnectionError' }))
    const r = await pedir()
    expect(r).toMatchObject({ status: 'UNKNOWN', cardRefundStatus: 'SENDING' })
    expect(get(r.cardRefundId)).toMatchObject({ status: 'SENDING', lastError: 'se perdió la respuesta', nextCheckAt: at(MIN) })
  })
})

describe('advanceCardRefund', () => {
  it('SENDING sin id: aparece por metadata.cardRefundId → se toma; no aparece tras 1 h → sigue SENDING con alerta (una vez), nunca FAILED', async () => {
    const found = seed({ status: 'SENDING' })
    listRefunds.mockResolvedValue([{ ...stateOf('SUCCEEDED', { refundId: 're_found' }), metadata: { cardRefundId: found.id } }])
    await expect(advanceCardRefund(found.id, at(MIN))).resolves.toBe('RECORDED')
    expect(get(found.id).stripeRefundId).toBe('re_found')
    expect(refund).not.toHaveBeenCalled()

    // Ruling r1: ausente en Stripe y su último envío de hace más de 5 min → se re-envía con la MISMA clave, uno por pasada.
    const lost = seed({ status: 'SENDING', lastSentAt: NOW })
    listRefunds.mockResolvedValue([{ ...stateOf('SUCCEEDED', { refundId: 're_other' }), metadata: { cardRefundId: 'otra' } }])
    refund.mockRejectedValue(Object.assign(new Error('Stripe no responde'), { type: 'StripeConnectionError' }))
    await expect(advanceCardRefund(lost.id, at(5 * MIN))).resolves.toBe('SENDING') // justo 5 min: todavía no
    expect(refund).not.toHaveBeenCalled()
    expect(get(lost.id).alertedAt).toBeNull()
    await expect(advanceCardRefund(lost.id, at(HOUR))).rejects.toThrow('Stripe no responde')
    expect(refund).toHaveBeenCalledTimes(1)
    expect(refund.mock.calls[0][1]).toMatchObject({ idempotencyKey: `online-order:ord1:refund:${lost.id}`, amount: 25_000 })
    await expect(advanceCardRefund(lost.id, at(HOUR + 15 * MIN))).rejects.toThrow('Stripe no responde')
    expect(refund).toHaveBeenCalledTimes(2)
    expect(get(lost.id)).toMatchObject({ status: 'SENDING', stripeRefundId: null, alertedAt: at(HOUR), lastSentAt: at(HOUR + 15 * MIN) })
    expect((logAction as jest.Mock).mock.calls.filter(c => c[0].action === 'ONLINE_ORDER_CARD_REFUND_STUCK')).toHaveLength(1)
  })

  it('ruling r1: SENDING ausente re-enviado cuando Stripe sí contesta → toma el id y sigue; nunca más de un re-envío por pasada', async () => {
    const lost = seed({ status: 'SENDING', lastSentAt: at(-10 * MIN) })
    refund.mockResolvedValue(created('SUCCEEDED', 're_resent'))
    await expect(advanceCardRefund(lost.id, NOW)).resolves.toBe('RECORDED')
    expect(refund).toHaveBeenCalledTimes(1)
    expect(get(lost.id)).toMatchObject({ stripeRefundId: 're_resent', lastSentAt: NOW })

    // Dos ejecutores a la vez sobre la MISMA fila ausente: sólo uno gana el CAS del re-envío.
    refund.mockClear()
    const twin = seed({ status: 'SENDING', lastSentAt: at(-10 * MIN) })
    refund.mockResolvedValue(created('PENDING', 're_twin'))
    await Promise.all([advanceCardRefund(twin.id, NOW), advanceCardRefund(twin.id, NOW)])
    expect(refund).toHaveBeenCalledTimes(1)
  })

  it('pedido con sello previo: la devolución revierte el sello una vez, también si se repite', async () => {
    const r = await pedir()
    expect(reverseStampForOrder).toHaveBeenCalledTimes(1)
    expect(reverseStampForOrder).toHaveBeenCalledWith('v1', 'ord1')
    expect(get(r.cardRefundId).stampReversedAt).toEqual(NOW)
    await pedir() // replay
    await advanceCardRefund(r.cardRefundId, at(HOUR)) // revisión tardía
    expect(reverseStampForOrder).toHaveBeenCalledTimes(1)
  })

  it('REFUND confirmado y la reversa del sello falla → la siguiente pasada la revierte una sola vez y fija stampReversedAt', async () => {
    ;(reverseStampForOrder as jest.Mock).mockRejectedValueOnce(new Error('se murió el proceso'))
    const r = await pedir()
    // fix r1 M3: el error de una RECORDED espera min(revisión tardía, 15 min).
    expect(get(r.cardRefundId)).toMatchObject({ status: 'RECORDED', stampReversedAt: null, nextCheckAt: at(15 * MIN), recordedAt: NOW })

    await sweepCardRefunds(at(15 * MIN), readEntry)
    expect(get(r.cardRefundId).stampReversedAt).toEqual(at(15 * MIN))
    await sweepCardRefunds(at(HOUR), readEntry)
    expect(reverseStampForOrder).toHaveBeenCalledTimes(2) // la que falló + la que quedó
    expect(issueRefund).toHaveBeenCalledTimes(1)
  })

  it('M4: la reversa del sello que falla siempre, al rendirse (30 días + margen), deja 🚨 y ONLINE_ORDER_CARD_REFUND_STAMP_STUCK UNA vez', async () => {
    ;(reverseStampForOrder as jest.Mock).mockRejectedValue(new Error('el candado del cliente no se suelta'))
    // La llave única de MoneyAnomaly, como en Postgres (`skipDuplicates`).
    const llaves = new Set<string>()
    ;(prismaMock as any).moneyAnomaly.createMany.mockImplementation(async ({ data }: any) => {
      const nuevas = data.filter((d: any) => !llaves.has(d.stripeEventId))
      for (const d of nuevas) llaves.add(d.stripeEventId)
      return { count: nuevas.length }
    })
    const errorSpy = jest.spyOn(logger, 'error')
    try {
      const r = await pedir()
      const stampStuck = () => (logAction as jest.Mock).mock.calls.filter(c => c[0].action === 'ONLINE_ORDER_CARD_REFUND_STAMP_STUCK')
      await sweepCardRefunds(at(15 * MIN), readEntry)
      await sweepCardRefunds(at(30 * DAY), readEntry)
      expect(stampStuck()).toHaveLength(0) // todavía dentro del margen: se sigue intentando sin alarma
      await sweepCardRefunds(at(31 * DAY + MIN), readEntry)
      expect(get(r.cardRefundId)).toMatchObject({ status: 'RECORDED', stampReversedAt: null, nextCheckAt: NEVER_AGAIN })
      expect(stampStuck()).toHaveLength(1)
      expect(stampStuck()[0][0]).toMatchObject({ entity: 'OnlineOrderCardRefund', entityId: r.cardRefundId, venueId: 'v1' })
      expect(errorSpy.mock.calls.filter(([m]: unknown[]) => typeof m === 'string' && m.includes('sello'))).toHaveLength(1)
      expect(llaves.has(`oocr:STAMP_STUCK:${r.cardRefundId}`)).toBe(true)
      // Otra pasada o un aviso de Stripe que la avance a mano: ni otra alerta ni otra bitácora.
      await sweepCardRefunds(at(400 * DAY), readEntry)
      await expect(advanceCardRefund(r.cardRefundId, at(401 * DAY))).rejects.toThrow('el candado del cliente no se suelta')
      expect(stampStuck()).toHaveLength(1)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('el proceso muere entre issueRefund y el CAS: la siguiente pasada repite issueRefund con la MISMA llave y recupera el renglón', async () => {
    const row = seed({ status: 'SUCCEEDED', stripeRefundId: 're_1', feeRefundedCents: 290 })
    await expect(advanceCardRefund(row.id, at(MIN))).resolves.toBe('RECORDED')
    expect(getApplicationFeeRefundedCents).not.toHaveBeenCalled() // la comisión ya estaba guardada: no se vuelve a leer
    expect((issueRefund as jest.Mock).mock.calls[0][0]).toMatchObject({ idempotencyKey: `oocr_${row.id}`, platformFeeRefundCents: 290 })
  })

  it('fix r1 M2: un sello que falla siempre no tapa la revisión tardía: Stripe dice failed → REVERSED; el sello se retoma después', async () => {
    ;(reverseStampForOrder as jest.Mock).mockRejectedValue(new Error('el candado del cliente no se suelta'))
    const r = await pedir()
    getRefund.mockResolvedValue(stateOf('FAILED'))
    const pasada = await sweepCardRefunds(at(15 * MIN), readEntry)
    expect(pasada.errors).toBe(1) // el sello volvió a fallar…
    expect(get(r.cardRefundId).status).toBe('REVERSED') // …pero el fallo tardío ya se detectó
    expect(reversals).toHaveLength(1)
    ;(reverseStampForOrder as jest.Mock).mockResolvedValue({ reversed: true })
    await sweepCardRefunds(at(30 * MIN), readEntry)
    expect(get(r.cardRefundId)).toMatchObject({ status: 'REVERSED', stampReversedAt: at(30 * MIN) })
    getRefund.mockClear()
    await sweepCardRefunds(at(400 * DAY), readEntry)
    expect(getRefund).not.toHaveBeenCalled()
  })

  it('fix r1 M3: el calendario tardío cuenta desde que quedó RECORDED (no desde que se pidió) y un error no lo alarga más de 15 min', async () => {
    const row = seed({ status: 'PENDING', stripeRefundId: 're_slow', createdAt: at(-5 * DAY), nextCheckAt: at(-MIN) })
    await expect(advanceCardRefund(row.id, NOW)).resolves.toBe('RECORDED')
    expect(get(row.id)).toMatchObject({ recordedAt: NOW, nextCheckAt: at(HOUR) })
    getRefund.mockRejectedValue(new Error('Stripe no responde'))
    await sweepCardRefunds(at(HOUR), readEntry)
    expect(get(row.id).nextCheckAt).toEqual(at(HOUR + 15 * MIN))
    await sweepCardRefunds(at(30 * DAY), readEntry)
    expect(get(row.id).nextCheckAt).toEqual(at(30 * DAY + 15 * MIN)) // dentro del margen: sigue intentando
    await sweepCardRefunds(at(32 * DAY), readEntry)
    expect(get(row.id).nextCheckAt.getTime()).toBeGreaterThan(at(365 * DAY).getTime()) // pasado 30 días + margen: se deja
  })

  it('RECORDED reciente: se vuelve a revisar a 1 h, 1 día, 3, 7 y 30 días; luego deja de revisarse', async () => {
    const r = await pedir()
    expect(get(r.cardRefundId).nextCheckAt).toEqual(at(HOUR))
    const checks = [HOUR, DAY, 3 * DAY, 7 * DAY]
    const next = [DAY, 3 * DAY, 7 * DAY, 30 * DAY]
    for (const [i, c] of checks.entries()) {
      await sweepCardRefunds(at(c), readEntry)
      expect(get(r.cardRefundId).nextCheckAt).toEqual(at(next[i]))
    }
    await sweepCardRefunds(at(30 * DAY), readEntry)
    expect(get(r.cardRefundId).nextCheckAt.getTime()).toBeGreaterThan(at(365 * DAY).getTime())
    expect(getRefund).toHaveBeenCalledTimes(5)
    getRefund.mockClear()
    await sweepCardRefunds(at(400 * DAY), readEntry)
    expect(getRefund).not.toHaveBeenCalled()
  })

  it.each(['FAILED', 'CANCELED'])(
    'RECORDED que Stripe reporta %s → REVERSED, una reversa, caché y anomalía; el REFUND intacto; aviso al negocio',
    async stripeStatus => {
      const r = await pedir()
      getRefund.mockResolvedValue(stateOf(stripeStatus, { failureReason: 'expired_or_canceled_card' }))
      await expect(advanceCardRefund(r.cardRefundId, at(HOUR))).resolves.toBe('REVERSED')
      await expect(advanceCardRefund(r.cardRefundId, at(2 * HOUR))).resolves.toBe('REVERSED')

      expect(reversals).toHaveLength(1)
      expect(reversals[0]).toMatchObject({
        venueId: 'v1',
        cardRefundId: r.cardRefundId,
        stripeRefundId: 're_1',
        amountCents: 25_000,
        feeCents: 290,
        failureReason: 'expired_or_canceled_card',
        detectedAt: at(HOUR),
      })
      expect(get(r.cardRefundId)).toMatchObject({ status: 'REVERSED', refundPaymentId: `pay-refund-oocr_${r.cardRefundId}` })
      // El renglón REFUND no se toca: sólo se escribió una vez, y la caché del cobro original gana refundReversals[].
      expect(issueRefund).toHaveBeenCalledTimes(1)
      const cache = (prismaMock.payment.update.mock.calls[0][0] as any).data.processorData
      expect(cache.refunds).toEqual([{ refundPaymentId: 'rf1' }])
      expect(cache.refundReversals).toEqual([
        expect.objectContaining({ cardRefundId: r.cardRefundId, stripeRefundId: 're_1', amountCents: 25_000, amount: 250 }),
      ])
      expect((prismaMock as any).moneyAnomaly.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [expect.objectContaining({ category: 'ONLINE_ORDER_CARD_REFUND_REVERSED', stripeEventId: 'oocr:REVERSED:re_1' })],
          skipDuplicates: true,
        }),
      )
      expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'ONLINE_ORDER_CARD_REFUND_REVERSED' }))
      expect(sendVenueNotification).toHaveBeenCalledWith(
        'v1',
        expect.objectContaining({
          message:
            'La devolución de $250.00 a la tarjeta del cliente falló en el banco. El dinero regresó a tu cuenta de Stripe. Devuélvelo por otro medio.',
        }),
        expect.any(Array),
      )
    },
  )
})

describe('sweepCardRefunds', () => {
  it('51 filas PENDING que no cambian no impiden avanzar la 52.ª (cada una mueve su nextCheckAt)', async () => {
    for (let i = 0; i < 51; i++) seed({ status: 'PENDING', stripeRefundId: `re_p${i}`, nextCheckAt: at(-10 * MIN + i) })
    const healthy = seed({ status: 'PENDING', stripeRefundId: 're_ok', nextCheckAt: at(-MIN) })
    getRefund.mockImplementation(async (_m: any, id: string) => stateOf(id === 're_ok' ? 'SUCCEEDED' : 'PENDING', { refundId: id }))

    const first = await sweepCardRefunds(NOW, readEntry)
    expect(first.scanned).toBe(50)
    expect(get(healthy.id).status).toBe('PENDING')
    await sweepCardRefunds(NOW, readEntry)
    expect(get(healthy.id).status).toBe('RECORDED')
  })

  it('un lote completo cuya consulta lanza mueve su nextCheckAt (con lastError) y la devolución sana detrás se registra', async () => {
    for (let i = 0; i < 50; i++) seed({ status: 'PENDING', stripeRefundId: `re_x${i}`, nextCheckAt: at(-10 * MIN + i) })
    const healthy = seed({ status: 'SUCCEEDED', stripeRefundId: 're_ok', nextCheckAt: at(-MIN) })
    getRefund.mockRejectedValue(new Error('la cuenta de Stripe ya no existe'))

    const first = await sweepCardRefunds(NOW, readEntry)
    expect(first).toMatchObject({ scanned: 50, errors: 50 })
    expect(rows().filter(r => r.lastError === 'la cuenta de Stripe ya no existe' && r.nextCheckAt > NOW)).toHaveLength(50)
    const second = await sweepCardRefunds(NOW, readEntry)
    expect(second).toMatchObject({ scanned: 1, advanced: 1, errors: 0 })
    expect(get(healthy.id).status).toBe('RECORDED')
  })
})

describe('resolveReversedCardRefund', () => {
  const reversed = async () => {
    const r = await pedir()
    getRefund.mockResolvedValue(stateOf('FAILED'))
    await advanceCardRefund(r.cardRefundId, at(HOUR))
    return r.cardRefundId
  }
  const resolver = (cardRefundId: string, method: 'CASH' | 'BANK_TRANSFER', note: string | null = null) =>
    resolveReversedCardRefund({ venueId: 'v1', orderId: 'ord1', cardRefundId, method, staffId: 'staff2', note })

  it('en efectivo con caja abierta → RESOLVED + un PAY_OUT; resolver dos veces → replay sin otro PAY_OUT', async () => {
    const id = await reversed()
    await expect(resolver(id, 'CASH', 'Se le dio en caja')).resolves.toEqual({ status: 'RESOLVED', replay: false })
    expect(drawerEvents).toHaveLength(1)
    expect(drawerEvents[0]).toMatchObject({
      sessionId: 'cds1',
      venueId: 'v1',
      type: 'PAY_OUT',
      staffId: 'staff2',
      localId: `oocr-payout:${id}`,
      note: 'Reembolso: Devolución de pedido en línea (falló la tarjeta)',
    })
    expect(drawerEvents[0].amount.toFixed(2)).toBe('250.00')
    expect(get(id).status).toBe('RESOLVED')
    expect(reversals[0]).toMatchObject({
      resolvedMethod: 'CASH',
      resolvedByStaffId: 'staff2',
      resolvedNote: 'Se le dio en caja',
      cashDrawerEventId: 'cde1',
    })
    expect(reversals[0].resolvedAt).toBeInstanceOf(Date)
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'ONLINE_ORDER_CARD_REFUND_RESOLVED', staffId: 'staff2' }))

    await expect(resolver(id, 'CASH')).resolves.toEqual({ status: 'RESOLVED', replay: true })
    expect(drawerEvents).toHaveLength(1)
  })

  it('en efectivo sin caja abierta (o cerrada a media resolución) → 409: ni PAY_OUT ni RESOLVED', async () => {
    const id = await reversed()
    openSession = []
    await expect(resolver(id, 'CASH')).rejects.toMatchObject({ statusCode: 409, code: 'CASH_DRAWER_NOT_OPEN' })
    expect(drawerEvents).toHaveLength(0)
    expect(get(id).status).toBe('REVERSED')
    expect(reversals[0].resolvedAt).toBeNull()
  })

  it('por transferencia → RESOLVED sin tocar la caja', async () => {
    const id = await reversed()
    openSession = []
    await expect(resolver(id, 'BANK_TRANSFER')).resolves.toEqual({ status: 'RESOLVED', replay: false })
    expect(drawerEvents).toHaveLength(0)
    expect(reversals[0]).toMatchObject({ resolvedMethod: 'BANK_TRANSFER', cashDrawerEventId: null })
  })

  it('una devolución que no está REVERSED → 409', async () => {
    const r = await pedir()
    await expect(resolver(r.cardRefundId, 'BANK_TRANSFER')).rejects.toMatchObject({ statusCode: 409, code: 'CARD_REFUND_NOT_REVERSED' })
  })
})

describe('handleStripeRefundEvent', () => {
  const event = (data: Record<string, unknown>, type = 'refund.failed') => ({ id: 'evt_1', type, account: 'acct_A', livemode: false, data })

  it('refund.failed con nuestra metadata dispara advanceCardRefund (se relee Stripe; el aviso no se cree)', async () => {
    const r = await pedir()
    getRefund.mockResolvedValue(stateOf('FAILED'))
    await handleStripeRefundEvent(event({ id: 're_1', metadata: { type: 'online_order_refund', cardRefundId: r.cardRefundId } }))
    expect(getRefund).toHaveBeenCalledWith(expect.anything(), 're_1')
    expect(get(r.cardRefundId).status).toBe('REVERSED')
  })

  it('sin metadata, de un cargo de pedido en línea y sin fila → MoneyAnomaly (devolución hecha fuera de Avoqado), sin dinero', async () => {
    prismaMock.onlineOrderCharge.findUnique.mockResolvedValueOnce({
      id: 'ch1',
      venueId: 'v1',
      onlineOrderId: 'oo1',
      merchantSnapshot: CHARGE.merchantSnapshot,
    } as any)
    await handleStripeRefundEvent(
      event({ id: 're_manual', payment_intent: 'pi_1', amount: 5_000, status: 'succeeded', metadata: {} }, 'refund.created'),
    )
    expect((prismaMock as any).moneyAnomaly.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ category: 'ONLINE_ORDER_REFUND_OUTSIDE_AVOQADO', stripeEventId: 'oocr:OUTSIDE:re_manual' })],
        skipDuplicates: true,
      }),
    )
    expect(issueRefund).not.toHaveBeenCalled()
    expect(store.size).toBe(0)
  })

  it('sin metadata y de un cobro que no es de pedido en línea → nada', async () => {
    prismaMock.onlineOrderCharge.findUnique.mockResolvedValueOnce(null)
    await handleStripeRefundEvent(event({ id: 're_dep', payment_intent: 'pi_dep', metadata: { type: 'reservation_deposit_refund' } }))
    expect((prismaMock as any).moneyAnomaly.createMany).not.toHaveBeenCalled()
  })
})

// ── D661 (Task 5): la llave y el destino ────────────────────────────────────────────────────────────────────────────────────────
describe('D661 (Task 5): el destino entra a la huella sólo si es saldo a favor', () => {
  it('un reintento de una fila escrita por el código base (CARD, sin destino en la huella) devuelve su resultado, no 409', async () => {
    // La huella que escribía el código de antes: importe + motivo + nota, sin destino.
    const previa = seed({
      key: 'llave-del-codigo-base',
      status: 'RECORDED',
      stripeRefundId: 're_base',
      refundPaymentId: 'pay-refund-base',
      stampReversedAt: NOW,
      requestHash: operationHash({ amountCents: 25_000, reason: 'CANCELLED_ORDER', note: null }),
    })
    for (const destino of [undefined, 'CARD'] as const) {
      await expect(pedir({ key: 'llave-del-codigo-base', ...(destino ? { destino } : {}) })).resolves.toMatchObject({
        cardRefundId: previa.id,
        refundId: 'pay-refund-base',
        replay: true,
      })
    }
    expect(store.size).toBe(1)
    expect(refund).not.toHaveBeenCalled()
  })

  it('misma llave con STORE_CREDIT → 409', async () => {
    const primera = await pedir()
    await expect(pedir({ destino: 'STORE_CREDIT' })).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED' })
    expect(store.size).toBe(1)
    expect(get(primera.cardRefundId).status).toBe('RECORDED')
    expect(refund).toHaveBeenCalledTimes(1)
  })

  it('STORE_CREDIT con una llave nueva: 4xx «no disponible», nunca se trata como tarjeta (ni fila ni Stripe)', async () => {
    await expect(pedir({ destino: 'STORE_CREDIT', key: 'llave-saldo-nueva' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'REFUND_DESTINATION_NOT_AVAILABLE',
      message: expect.stringContaining('saldo a favor'),
    })
    expect(store.size).toBe(0)
    expect(refund).not.toHaveBeenCalled()
    expect(prismaMock.onlineOrder.updateMany).not.toHaveBeenCalled()
  })
})

// ── D661 (Task 5): «Cancelar y devolver» a la tarjeta en «Nadie»: 100 %, reserva antes de Stripe y cierre «Devuelto» ────────
describe('D661 (Task 5): devolver a la tarjeta un pedido de «Nadie»', () => {
  type Pedido = Row
  const PEDIDO: Pedido = {
    id: 'oo1',
    orderId: 'ord1',
    paymentMode: 'CARD_ONLINE',
    requiresAcceptance: false,
    status: 'ACCEPTED',
    refundRequestedAt: null,
    refundedAt: null,
    completedAt: null,
    printClaimedAt: null,
    printedAt: null,
    order: { orderNumber: 'W-1' },
  }
  let pedido: Pedido
  /** El doble de la tabla, tomado UNA vez (antes de envolverlo para registrar en qué transacción escribe). */
  const updateManyDeLaTabla = cardRefund.updateMany.getMockImplementation()!
  /** Qué transacción hizo cada escritura (0 = ninguna): el retiro de la reserva va en la MISMA que el estado terminal (r5 #4). */
  let tx = 0
  let txAbierta = 0
  const escrituras: Array<{ que: string; tx: number; arg: any }> = []
  /** El pedido, en memoria: contesta el CAS como Postgres (estado, marcas y modo en el `where`). */
  const cumple = (p: Pedido, where: Record<string, any>): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (['orderId', 'venueId', 'charge'].includes(k)) return true // un solo pedido; la fila de devolución anotada la da la prueba
      if (k === 'OR') return (v as Record<string, any>[]).some(sub => cumple(p, sub))
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        if ('in' in v) return v.in.includes(p[k])
        if ('not' in v) return p[k] !== v.not
        if ('lt' in v) return p[k] != null && p[k] < v.lt
      }
      if (v === null) return p[k] == null
      return p[k] === v
    })

  beforeEach(() => {
    pedido = { ...PEDIDO }
    tx = 0
    txAbierta = 0
    escrituras.length = 0
    ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => {
      txAbierta = ++tx
      try {
        return await fn(prismaMock)
      } finally {
        txAbierta = 0
      }
    })
    prismaMock.onlineOrder.findFirst.mockImplementation((async () => ({ ...pedido, charge: CHARGE })) as any)
    prismaMock.onlineOrder.updateMany.mockImplementation((async (a: any) => {
      escrituras.push({ que: 'onlineOrder', tx: txAbierta, arg: a })
      if (!cumple(pedido, a.where)) return { count: 0 }
      Object.assign(pedido, a.data)
      return { count: 1 }
    }) as any)
    prismaMock.order.updateMany.mockImplementation((async (a: any) => {
      escrituras.push({ que: 'order', tx: txAbierta, arg: a })
      return { count: 1 }
    }) as any)
    prismaMock.activityLog.create.mockImplementation((async (a: any) => {
      escrituras.push({ que: 'activityLog', tx: txAbierta, arg: a })
      return { id: 'al1' }
    }) as any)
    prismaMock.onlineOrderCharge.findUnique.mockImplementation((async () => ({
      ...CHARGE,
      onlineOrder: { orderId: 'ord1', requiresAcceptance: pedido.requiresAcceptance },
    })) as any)
    cardRefund.updateMany.mockImplementation(async (a: any) => {
      escrituras.push({ que: 'cardRefund', tx: txAbierta, arg: a })
      return updateManyDeLaTabla(a)
    })
  })
  // La tabla de devoluciones vuelve a su doble sin registro.
  afterAll(() => cardRefund.updateMany.mockImplementation(updateManyDeLaTabla))
  const cierres = () => escrituras.filter(e => e.que === 'activityLog' && e.arg.data.action === 'ONLINE_ORDER_CLOSED_AS_REFUNDED')

  it('«Nadie»: parcial → 400 FULL_REFUND_ONLY; «Mi equipo» parcial sigue', async () => {
    await expect(pedir({ amount: '125.00' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'FULL_REFUND_ONLY',
      message: expect.stringContaining('$250.00'),
    })
    expect(store.size).toBe(0)
    expect(refund).not.toHaveBeenCalled()
    expect(pedido.refundRequestedAt).toBeNull()

    // «Mi equipo»: la parcial pasa como hoy, sin reserva ni cierre.
    pedido = { ...PEDIDO, requiresAcceptance: true }
    await expect(pedir({ amount: '125.00', key: 'llave-mi-equipo' })).resolves.toMatchObject({ status: 'RECORDED' })
    expect(pedido).toMatchObject({ status: 'ACCEPTED', refundRequestedAt: null, refundedAt: null })
    expect(escrituras.filter(e => e.que === 'onlineOrder')).toHaveLength(0)
    expect(cierres()).toHaveLength(0)
  })

  it('reserva antes de Stripe; con la reserva, entregar → 409 (la reserva va bajo el candado, en la transacción de la fila)', async () => {
    let reservadaAlLlamarAStripe: unknown = 'no se llamó'
    refund.mockImplementation(async () => {
      reservadaAlLlamarAStripe = pedido.refundRequestedAt
      return created('PENDING')
    })
    const r = await pedir()
    expect(r).toMatchObject({ status: 'PENDING', cardRefundStatus: 'PENDING' })
    expect(reservadaAlLlamarAStripe).toEqual(NOW)
    const reserva = escrituras.find(e => e.que === 'onlineOrder' && e.arg.data.refundRequestedAt)!
    expect(reserva.arg).toEqual({
      where: {
        id: 'oo1',
        requiresAcceptance: false,
        paymentMode: 'CARD_ONLINE',
        status: { in: ['ACCEPTED', 'READY'] },
        refundRequestedAt: null,
        refundedAt: null,
        // Ruling 9: el reclamo de papel no toma el candado de la orden; el CAS repite «sin papel en vuelo».
        OR: [{ printClaimedAt: null }, { printedAt: { not: null } }, { printClaimedAt: { lt: at(-90_000) } }],
      },
      data: { refundRequestedAt: NOW },
    })
    // Bajo el candado de la orden y en la MISMA transacción que la fila.
    expect(reserva.tx).toBeGreaterThan(0)
    expect(cardRefund.create.mock.invocationCallOrder[0]).toBeGreaterThan(prismaMock.onlineOrder.updateMany.mock.invocationCallOrder[0])
    expect((prismaMock.$queryRaw as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      prismaMock.onlineOrder.updateMany.mock.invocationCallOrder[0],
    )
    // Mientras Stripe no devuelve, sigue «Devolviendo…» (no se cierra).
    expect(pedido).toMatchObject({ status: 'ACCEPTED', refundRequestedAt: NOW, refundedAt: null })
    expect(cierres()).toHaveLength(0)
  })

  it('RECORDED → pedido COMPLETED con refundedAt, la cocina pendiente se limpia y la bitácora del cierre queda una vez (en su transacción)', async () => {
    const r = await pedir()
    expect(r).toMatchObject({ status: 'RECORDED' })
    expect(pedido).toMatchObject({ status: 'COMPLETED', completedAt: NOW, refundedAt: NOW, refundRequestedAt: NOW })
    const cierre = escrituras.find(e => e.que === 'onlineOrder' && e.arg.data.status === 'COMPLETED')!
    expect(cierre.arg.where).toMatchObject({
      id: 'oo1',
      requiresAcceptance: false,
      paymentMode: 'CARD_ONLINE',
      status: { in: ['ACCEPTED', 'READY'] },
      refundRequestedAt: { not: null },
      refundedAt: null,
    })
    expect(escrituras).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          que: 'order',
          tx: cierre.tx,
          arg: { where: { id: 'ord1', venueId: 'v1' }, data: { kitchenPendingAt: null } },
        }),
      ]),
    )
    expect(cierres()).toHaveLength(1)
    expect(cierres()[0]).toMatchObject({
      tx: cierre.tx,
      arg: { data: { venueId: 'v1', entity: 'OnlineOrder', entityId: 'oo1', staffId: 'staff1' } },
    })

    // Otra pasada (o el barrido) no lo vuelve a cerrar ni repite la bitácora.
    await advanceCardRefund(r.cardRefundId, at(HOUR))
    expect(cierres()).toHaveLength(1)
  })

  it('cerrarComoDevueltoEnTx es idempotente: la segunda vez no escribe nada', async () => {
    pedido = { ...PEDIDO, refundRequestedAt: NOW }
    await expect(cerrarComoDevueltoEnTx(prismaMock as any, { venueId: 'v1', orderId: 'ord1', now: NOW })).resolves.toMatchObject({
      cerrado: true,
    })
    await expect(cerrarComoDevueltoEnTx(prismaMock as any, { venueId: 'v1', orderId: 'ord1', now: at(MIN) })).resolves.toEqual({
      cerrado: false,
    })
    expect(pedido.refundedAt).toEqual(NOW)
    expect(cierres()).toHaveLength(1)
    // Sin reserva un pedido entregable NO se cierra (nunca «Devuelto» sin que una devolución lo haya reservado).
    pedido = { ...PEDIDO }
    await expect(cerrarComoDevueltoEnTx(prismaMock as any, { venueId: 'v1', orderId: 'ord1', now: NOW })).resolves.toEqual({
      cerrado: false,
    })
    expect(pedido.status).toBe('ACCEPTED')
  })

  it('devolver un pedido ya entregado: queda COMPLETED con refundedAt, sin reserva', async () => {
    const ENTREGADO = new Date('2026-10-29T17:00:00.000Z')
    pedido = { ...PEDIDO, status: 'COMPLETED', completedAt: ENTREGADO }
    await expect(pedir()).resolves.toMatchObject({ status: 'RECORDED' })
    expect(pedido).toMatchObject({ status: 'COMPLETED', completedAt: ENTREGADO, refundRequestedAt: null, refundedAt: NOW })
    expect(escrituras.find(e => e.que === 'onlineOrder' && e.arg.data.refundRequestedAt)).toBeUndefined()
    expect(cierres()).toHaveLength(1)
  })

  it.each(['FAILED', 'CANCELED'] as const)(
    'FAILED → se quita la reserva, vuelve a entregable, con aviso (Stripe dice %s); el estado terminal y el retiro, en UNA transacción',
    async desenlace => {
      refund.mockResolvedValue(created('PENDING'))
      const r = await pedir()
      expect(pedido.refundRequestedAt).toEqual(NOW)
      getRefund.mockResolvedValue(stateOf(desenlace, { failureReason: 'declined' }))
      await expect(advanceCardRefund(r.cardRefundId, at(MIN))).resolves.toBe(desenlace)

      expect(pedido).toMatchObject({ status: 'ACCEPTED', refundRequestedAt: null, refundedAt: null })
      const terminal = escrituras.find(e => e.que === 'cardRefund' && e.arg.data.status === desenlace)!
      const retiro = escrituras.find(
        e => e.que === 'onlineOrder' && 'refundRequestedAt' in e.arg.data && e.arg.data.refundRequestedAt === null,
      )!
      expect(terminal.tx).toBeGreaterThan(0)
      expect(retiro.tx).toBe(terminal.tx)
      expect(retiro.arg.where).toMatchObject({
        orderId: 'ord1',
        venueId: 'v1',
        requiresAcceptance: false,
        // D661 (B3): también la reserva de un «No lo recogió» (la pone el papel); su cocina no se rearma (abajo, sólo por entregar).
        status: { in: ['ACCEPTED', 'READY', 'COMPLETED'] },
        refundRequestedAt: { not: null },
        refundedAt: null,
      })
      // Cocina retoma: la marca vuelve a quedar escrita en la misma transacción.
      expect(escrituras).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            que: 'order',
            tx: terminal.tx,
            arg: { where: { id: 'ord1', venueId: 'v1' }, data: { kitchenPendingAt: at(MIN) } },
          }),
        ]),
      )
      expect(sendVenueNotification).toHaveBeenCalledWith(
        'v1',
        expect.objectContaining({ message: expect.stringContaining('W-1'), entityId: r.cardRefundId }),
        expect.any(Array),
      )
      expect(logAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'ONLINE_ORDER_CARD_REFUND_FAILED', entityId: r.cardRefundId }),
      )
      expect(cierres()).toHaveLength(0)
    },
  )

  it('Ruling 9: con un reclamo de papel en vuelo no se reserva (409 PRINT_IN_FLIGHT); vencido o ya impreso, sí', async () => {
    pedido = { ...PEDIDO, printClaimedAt: at(-30_000) }
    await expect(pedir()).rejects.toMatchObject({
      statusCode: 409,
      code: 'PRINT_IN_FLIGHT',
      message: 'Se está imprimiendo la comanda; intenta en un momento',
    })
    expect(store.size).toBe(0)
    expect(pedido.refundRequestedAt).toBeNull()
    expect(refund).not.toHaveBeenCalled()

    for (const [i, papel] of [{ printClaimedAt: at(-91_000) }, { printClaimedAt: at(-30_000), printedAt: at(-10_000) }].entries()) {
      store.clear()
      pedido = { ...PEDIDO, ...papel }
      await expect(pedir({ key: `llave-papel-${i}`, expected: null })).resolves.toMatchObject({ status: 'RECORDED' })
    }
  })

  it('MCP: el efecto esperado se revalida bajo el candado; si cambió, 409 y nada escrito', async () => {
    // La vista previa dijo «también lo cierra como Devuelto», pero ya se entregó.
    pedido = { ...PEDIDO, status: 'COMPLETED', completedAt: NOW }
    await expect(pedir({ efectoEsperado: { cierraComoDevuelto: true } })).rejects.toMatchObject({
      statusCode: 409,
      code: 'REFUND_EFFECT_CHANGED',
      message: expect.stringContaining('vista previa nueva'),
    })
    // Y al revés: la vista previa no lo cerraba y ahora sí está por entregar.
    pedido = { ...PEDIDO }
    await expect(pedir({ efectoEsperado: { cierraComoDevuelto: false } })).rejects.toMatchObject({ code: 'REFUND_EFFECT_CHANGED' })
    expect(store.size).toBe(0)
    expect(refund).not.toHaveBeenCalled()
    expect(pedido.refundRequestedAt).toBeNull()
    // Igual que lo visto: pasa.
    await expect(pedir({ efectoEsperado: { cierraComoDevuelto: true } })).resolves.toMatchObject({ status: 'RECORDED' })
    expect(pedido.status).toBe('COMPLETED')
  })

  it('el barrido cierra lo que quedó anotado sin cerrar (RECORDED, REVERSED o RESOLVED) y no toca otra cosa', async () => {
    pedido = { ...PEDIDO, refundRequestedAt: NOW }
    const pendientes = jest.fn(async () => [{ venueId: 'v1', staffId: 'staff1', charge: { onlineOrder: { orderId: 'ord1' } } }])
    cardRefund.findMany.mockImplementationOnce(pendientes as any)
    await expect(cerrarDevueltosPendientes({ venueId: 'v1' }, at(MIN), readEntry)).resolves.toBe(1)
    expect(pedido).toMatchObject({ status: 'COMPLETED', refundedAt: at(MIN) })
    const consulta = (pendientes.mock.calls[0] as any[])[0]
    expect(consulta.where.venueId).toBe('v1')
    expect(consulta.where.status).toEqual({ in: ['RECORDED', 'REVERSED', 'RESOLVED'] })
    expect(consulta.take).toBe(50)
    // Lo mismo dentro del recorrido de cada minuto (sin sucursal).
    cardRefund.findMany.mockImplementationOnce(async () => []) // las filas por revisar
    cardRefund.findMany.mockImplementationOnce(async () => []) // las por cerrar
    await expect(sweepCardRefunds(at(2 * MIN), readEntry)).resolves.toMatchObject({ closed: 0 })
  })

  it('D661 · C5: el barrido de cierres sólo mira el último mes y rota: un lote lleno que no se cierra no tapa a los de atrás', async () => {
    const DIA = 24 * 60 * MIN
    const consultas = () => (cardRefund.findMany.mock.calls as any[][]).map(c => c[0])
    // 50 filas anotadas que no se pueden cerrar (aquí, sin pedido): el lote siguiente empieza DESPUÉS de la última.
    const lote = Array.from({ length: 50 }, (_, i) => ({
      venueId: 'v1',
      staffId: null,
      id: `cr${String(i).padStart(2, '0')}`,
      createdAt: at(i * 1000),
      charge: { onlineOrder: null },
    }))
    cardRefund.findMany.mockClear()
    cardRefund.findMany.mockImplementationOnce(async () => lote as any)
    await expect(cerrarDevueltosPendientes({ venueId: 'v1' }, NOW, readEntry)).resolves.toBe(0)
    const primera = consultas()[0]
    expect(primera.where.createdAt).toEqual({ gte: new Date(NOW.getTime() - 31 * DIA) })
    expect(primera.where.OR).toBeUndefined()
    expect(primera.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }])

    cardRefund.findMany.mockImplementationOnce(async () => [])
    await cerrarDevueltosPendientes({ venueId: 'v1' }, NOW, readEntry)
    expect(consultas()[1].where.OR).toEqual([{ createdAt: { gt: at(49_000) } }, { createdAt: at(49_000), id: { gt: 'cr49' } }])
    expect(consultas()[1].where.createdAt).toEqual({ gte: new Date(NOW.getTime() - 31 * DIA) })

    // Una página corta cierra la vuelta: la siguiente empieza otra vez desde la más vieja del mes.
    cardRefund.findMany.mockImplementationOnce(async () => [])
    await cerrarDevueltosPendientes({ venueId: 'v1' }, NOW, readEntry)
    expect(consultas()[2].where.OR).toBeUndefined()
    // Cada alcance rota aparte (el recorrido de cada minuto no hereda la vuelta de una sucursal).
    cardRefund.findMany.mockImplementationOnce(async () => lote as any)
    await cerrarDevueltosPendientes({ venueId: 'v1' }, NOW, readEntry)
    cardRefund.findMany.mockImplementationOnce(async () => [])
    await cerrarDevueltosPendientes({}, NOW, readEntry)
    expect(consultas()[4].where.OR).toBeUndefined()
  })
})

// ── D661 (Task 6): devolver a saldo a favor (local, atómico) y la devolución hecha por fuera en Stripe (Ruling 28) ─────────────────
describe('D661 (Task 6): saldo a favor y devolución por fuera en Stripe', () => {
  const VERIFICADO = '+525511112222'
  const CARGO_NADIE = {
    ...CHARGE,
    request: { customerId: 'cus1', telefonoVerificado: VERIFICADO, nadie: true },
    onlineOrder: { requiresAcceptance: false },
  }
  const PEDIDO = {
    id: 'oo1',
    orderId: 'ord1',
    paymentMode: 'CARD_ONLINE',
    requiresAcceptance: false,
    status: 'ACCEPTED',
    refundRequestedAt: null,
    refundedAt: null,
    completedAt: null,
    printClaimedAt: null,
    printedAt: null,
    order: { orderNumber: 'W-1' },
  }
  let pedido: Row
  let cargo: Row
  /** Qué escribió cada paso y en qué transacción (0 = ninguna). */
  let tx = 0
  let txAbierta = 0
  const pasos: Array<{ que: string; tx: number; arg?: any }> = []
  const paso = (que: string, arg?: any) => pasos.push({ que, tx: txAbierta, arg })
  const updateManyDeLaTabla = cardRefund.updateMany.getMockImplementation()!
  const createDeLaTabla = cardRefund.create.getMockImplementation()!
  const cumple = (p: Row, where: Record<string, any>): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (['orderId', 'venueId', 'charge'].includes(k)) return true
      if (k === 'OR') return (v as Record<string, any>[]).some(sub => cumple(p, sub))
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        if ('in' in v) return v.in.includes(p[k])
        if ('not' in v) return p[k] !== v.not
        if ('lt' in v) return p[k] != null && p[k] < v.lt
      }
      if (v === null) return p[k] == null
      return p[k] === v
    })
  const aSaldo = (o: Parameters<typeof pedir>[0] = {}) => pedir({ destino: 'STORE_CREDIT', key: 'llave-saldo-1', ...o })
  const nada = () => {
    expect(store.size).toBe(0)
    expect(refund).not.toHaveBeenCalled()
    expect(writeRefundInTx).not.toHaveBeenCalled()
    expect(abonarSaldoAFavorEnTx).not.toHaveBeenCalled()
    expect(pedido.refundRequestedAt).toBeNull()
    expect(pedido.refundedAt).toBeNull()
  }

  beforeEach(() => {
    pedido = { ...PEDIDO }
    cargo = { ...CARGO_NADIE }
    tx = 0
    txAbierta = 0
    pasos.length = 0
    ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => {
      txAbierta = ++tx
      try {
        return await fn(prismaMock)
      } finally {
        txAbierta = 0
      }
    })
    ;(prismaMock.$queryRaw as jest.Mock).mockImplementation(async (q: any, ...valores: any[]) => {
      const sql = Array.isArray(q) ? q.join('?') : Array.isArray(q?.strings) ? q.strings.join('?') : String(q)
      if (sql.includes('pg_advisory_xact_lock')) paso(`candado:${String(valores[0]).split(':')[0]}`)
      else paso('candado:orden')
      return [{ id: 'ord1' }]
    })
    prismaMock.giftCard.findFirst.mockResolvedValue(null) // la sucursal todavía no tiene sobres: se toma «primer-sobre»
    prismaMock.onlineOrderCharge.findFirst.mockImplementation((async () => cargo) as any)
    prismaMock.onlineOrder.findFirst.mockImplementation((async () => ({ ...pedido, charge: cargo })) as any)
    prismaMock.onlineOrder.updateMany.mockImplementation((async (a: any) => {
      paso('pedido', a)
      if (!cumple(pedido, a.where)) return { count: 0 }
      Object.assign(pedido, a.data)
      return { count: 1 }
    }) as any)
    prismaMock.order.updateMany.mockImplementation((async (a: any) => (paso('cuenta', a), { count: 1 })) as any)
    prismaMock.activityLog.create.mockImplementation((async (a: any) => (paso('bitacora', a), { id: 'al1' })) as any)
    ;(bloquearCobroParaReembolso as jest.Mock).mockImplementation(async () => {
      paso('cobro')
      return {
        original: { id: 'pay1', orderId: 'ord1', amount: '250.00', tipAmount: '0.00' },
        refundedSalesCents: 0,
        refundedTipsCents: 0,
        unclassifiedPriorRefundCents: 0,
        remainingBeforeCents: 25_000,
      }
    })
    cardRefund.create.mockImplementation(async (a: any) => (paso('fila', a), createDeLaTabla(a)))
    cardRefund.updateMany.mockImplementation(async (a: any) => (paso('fila:update', a), updateManyDeLaTabla(a)))
    ;(cardRefund as any).update = jest.fn(async ({ where, data }: any) => {
      paso('fila:update', { where, data })
      Object.assign(store.get(where.id)!, data)
      return { ...store.get(where.id)! }
    })
    ;(writeRefundInTx as jest.Mock).mockImplementation(async (t: any, input: any) => {
      paso('renglon', input)
      // El núcleo real llama al abono en SU transacción, tras escribir la fila REFUND.
      const abono = await input.aSaldoAFavor.abonar(
        t,
        'pay-refund-saldo',
        { venueId: 'v1', customerId: 'cus1' },
        { orderId: 'ord1', montoCents: 25_000 },
      )
      return { refundPaymentId: 'pay-refund-saldo', replay: false, abono }
    })
    ;(abonarSaldoAFavorEnTx as jest.Mock).mockImplementation(async (_t: any, p: any) => {
      paso('abono', p)
      return { giftCardId: 'gc1', abonado: p.monto, saldoNuevo: p.monto, telefonoDelSobre: VERIFICADO, telefonoNoCoincide: false }
    })
    ;(enqueueRefundPaymentEffectsInTx as jest.Mock).mockImplementation(async (...a: any[]) => paso('efectos', a))
    ;(storeCreditAvailable as jest.Mock).mockReturnValue(true)
  })
  afterAll(() => {
    cardRefund.updateMany.mockImplementation(updateManyDeLaTabla)
    cardRefund.create.mockImplementation(createDeLaTabla)
    prismaMock.onlineOrderCharge.findFirst.mockReset()
    prismaMock.giftCard.findFirst.mockReset()
  })

  it('saldo a favor: en UNA transacción — primer-sobre, orden, cobro, reserva, fila RESOLVED, renglón REFUND con el abono, efectos y cierre; Stripe no devuelve nada', async () => {
    const r = await aSaldo()
    expect(r).toMatchObject({ status: 'RECORDED', cardRefundStatus: 'RESOLVED', refundId: 'pay-refund-saldo', replay: false })
    expect(refund).not.toHaveBeenCalled()
    expect(getRefund).not.toHaveBeenCalled()

    // El orden de los candados y de las escrituras (primer-sobre ANTES de la orden, como writeRefundInTx exige).
    const enLaTx = pasos.filter(p => p.tx > 0)
    expect(new Set(enLaTx.map(p => p.tx)).size).toBe(1)
    const orden = enLaTx.map(p => p.que)
    const primero = (que: string) => orden.indexOf(que)
    expect(primero('candado:primer-sobre')).toBe(0)
    for (const [antes, despues] of [
      ['candado:primer-sobre', 'candado:orden'],
      ['candado:orden', 'cobro'],
      ['cobro', 'pedido'],
      ['pedido', 'fila'],
      ['fila', 'renglon'],
      ['renglon', 'abono'],
      ['abono', 'efectos'],
      ['efectos', 'bitacora'],
    ])
      expect({ antes, despues, ok: primero(antes) > -1 && primero(antes) < primero(despues) }).toMatchObject({ ok: true })

    // La fila nace RESOLVED a saldo (nunca REQUESTED), fuera del recorrido de Stripe, y queda ligada a su renglón.
    const fila = rows()[0]
    expect(pasos.find(p => p.que === 'fila')!.arg.data).toMatchObject({
      status: 'RESOLVED',
      toStoreCredit: true,
      amountCents: 25_000,
      feeRefundedCents: 0,
      recordedAt: NOW,
      nextCheckAt: NEVER_AGAIN,
    })
    expect(fila).toMatchObject({ status: 'RESOLVED', toStoreCredit: true, refundPaymentId: 'pay-refund-saldo', stripeRefundId: null })
    // El renglón: el núcleo con la transacción, el cobro ya bloqueado, a saldo con el medio de sistema y sin turno vivo.
    expect(pasos.find(p => p.que === 'renglon')!.arg).toMatchObject({
      originalPaymentId: 'pay1',
      venueId: 'v1',
      salesRefundCents: 25_000,
      tipRefundCents: 0,
      refundedItems: [],
      reason: 'CANCELLED_ORDER',
      staffId: 'staff1',
      idempotencyKey: `oocr_${fila.id}`,
      tenderCommission: 'NONE',
      shift: 'INHERIT_ORIGINAL',
      provenance: 'MANUAL',
      aSaldoAFavor: {
        customerId: 'cus1',
        tender: expect.objectContaining({
          tenderTypeId: 'tt-saldo',
          merchantAccountId: null,
          source: 'OTHER',
          fundsFlow: 'EXTERNAL_RECORDED',
        }),
      },
    })
    expect(enqueueRefundPaymentEffectsInTx).toHaveBeenCalledWith(prismaMock, 'pay-refund-saldo', 'pay1')
    // El cierre «Devuelto», en la MISMA transacción.
    expect(pedido).toMatchObject({ status: 'COMPLETED', refundRequestedAt: NOW, refundedAt: NOW, completedAt: NOW })
    expect(pasos.filter(p => p.que === 'bitacora' && p.arg.data.action === 'ONLINE_ORDER_CLOSED_AS_REFUNDED')).toHaveLength(1)
    expect(prepararMediosDeSaldoAFavor).toHaveBeenCalledWith('v1')
  })

  it('D661 · C4: si el cierre «Devuelto» compartido no cierra tras abonar ({ cerrado: false }), 409 ORDER_STATE_CHANGED DENTRO de la transacción del abono: nada queda abonado ni se anuncia', async () => {
    const cierre = jest.spyOn(devuelto, 'cerrarComoDevueltoEnTx').mockImplementationOnce(async () => {
      paso('cierre')
      return { cerrado: false }
    })
    try {
      await expect(aSaldo()).rejects.toMatchObject({ statusCode: 409, code: 'ORDER_STATE_CHANGED' })
    } finally {
      cierre.mockRestore()
    }
    // La fila, el renglón, el abono y el cierre fallido van en UNA transacción (la que truena y se revierte entera).
    const deLaTx = pasos.filter(p => ['fila', 'renglon', 'abono', 'cierre'].includes(p.que))
    expect(deLaTx.map(p => p.que)).toEqual(['fila', 'renglon', 'abono', 'cierre'])
    expect(new Set(deLaTx.map(p => p.tx)).size).toBe(1)
    expect(deLaTx[0].tx).toBeGreaterThan(0)
    // Nada después del commit: ni la bitácora del saldo ni la de la devolución.
    expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'ONLINE_ORDER_REFUNDED_TO_STORE_CREDIT' }))
    expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'REFUND_CREATED' }))
  })

  it('saldo a favor: la libreta recibe la clienta y el teléfono VERIFICADO del borrador (exigirMismoTelefono), el 100 % y el folio', async () => {
    await aSaldo()
    expect(abonarSaldoAFavorEnTx).toHaveBeenCalledTimes(1)
    expect((abonarSaldoAFavorEnTx as jest.Mock).mock.calls[0][1]).toMatchObject({
      monto: D('250'),
      staffId: 'staff1',
      origen: { orderId: 'ord1', refundPaymentId: 'pay-refund-saldo' },
      folio: 'W-1',
      tipo: 'REEMBOLSO',
      exigirMismoTelefono: { telefonoVerificado: VERIFICADO },
    })
    // Sin teléfono verificado se pasa null (la libreta decide: sin sobre no abre uno, con sobre no lo reconoce).
    store.clear()
    pedido = { ...PEDIDO }
    cargo = { ...CARGO_NADIE, request: { customerId: 'cus1', nadie: true } }
    await aSaldo({ key: 'llave-saldo-2', expected: null })
    expect((abonarSaldoAFavorEnTx as jest.Mock).mock.calls[1][1].exigirMismoTelefono).toEqual({ telefonoVerificado: null })
  })

  it('saldo a favor sin clienta en el borrador → 400 STORE_CREDIT_CUSTOMER_REQUIRED y nada escrito', async () => {
    cargo = { ...CARGO_NADIE, request: { nadie: true } }
    await expect(aSaldo()).rejects.toMatchObject({
      statusCode: 400,
      code: 'STORE_CREDIT_CUSTOMER_REQUIRED',
      message: expect.stringContaining('tarjeta'),
    })
    nada()
  })

  it('saldo a favor sin las llaves del servidor (lo mismo que /info.storeCredit) → 422 STORE_CREDIT_UNAVAILABLE, sin leer Stripe ni escribir', async () => {
    ;(storeCreditAvailable as jest.Mock).mockReturnValue(false)
    await expect(aSaldo()).rejects.toMatchObject({
      statusCode: 422,
      code: 'STORE_CREDIT_UNAVAILABLE',
      message: expect.stringContaining('tarjeta'),
    })
    expect(getChargeRefunds).not.toHaveBeenCalled()
    expect(prepararMediosDeSaldoAFavor).not.toHaveBeenCalled()
    nada()
  })

  it('saldo a favor en «Mi equipo» → 400 REFUND_DESTINATION_NOT_AVAILABLE (sólo tarjeta), sin leer Stripe ni escribir', async () => {
    pedido = { ...PEDIDO, requiresAcceptance: true }
    cargo = { ...CARGO_NADIE, onlineOrder: { requiresAcceptance: true } }
    await expect(aSaldo()).rejects.toMatchObject({ statusCode: 400, code: 'REFUND_DESTINATION_NOT_AVAILABLE' })
    expect(getChargeRefunds).not.toHaveBeenCalled()
    nada()
  })

  it('«Mi equipo» con tarjeta no lee Stripe antes de devolver (sin cambio)', async () => {
    pedido = { ...PEDIDO, requiresAcceptance: true }
    cargo = { ...CARGO_NADIE, onlineOrder: { requiresAcceptance: true } }
    await expect(pedir({ amount: '125.00', key: 'llave-mi-equipo' })).resolves.toMatchObject({ status: 'RECORDED' })
    expect(getChargeRefunds).not.toHaveBeenCalled()
  })

  // Ruling 28: cualquier devolución por fuera de Avoqado (hecha o pendiente, total o parcial) frena los DOS destinos.
  const POR_FUERA = {
    '100 % hecha por fuera': { amountRefundedCents: 25_000, refunds: [stateOf('SUCCEEDED', { refundId: 're_fuera' })] },
    'parcial pendiente por fuera': {
      amountRefundedCents: 5_000,
      refunds: [stateOf('PENDING', { refundId: 're_fuera', amountCents: 5_000 })],
    },
    // Stripe dice que algo ya se devolvió aunque la lista no la traiga: también frena.
    'sólo amount_refunded': { amountRefundedCents: 1_000, refunds: [] },
  }
  it.each(
    (['STORE_CREDIT', 'CARD'] as const).flatMap(destino =>
      Object.entries(POR_FUERA).map(([caso, estado]) => [destino, caso, estado] as const),
    ),
  )(
    'Ruling 28 · %s con %s → 409 EXTERNAL_REFUND_DETECTED: nada se reserva, nada se abona, nada se manda a Stripe',
    async (destino, _caso, estado) => {
      getChargeRefunds.mockResolvedValue({ ...estado, refunds: estado.refunds.map(r => ({ ...r, metadata: {} })) })
      await expect(pedir({ destino, key: `llave-fuera-${destino}` })).rejects.toMatchObject({
        statusCode: 409,
        code: 'EXTERNAL_REFUND_DETECTED',
        message: expect.stringMatching(/fuera de Avoqado[\s\S]*Stripe/),
      })
      expect(getChargeRefunds).toHaveBeenCalledWith(
        expect.objectContaining({ providerCredentials: { connectAccountId: 'acct_A' } }),
        'pi_1',
      )
      expect(prepararMediosDeSaldoAFavor).not.toHaveBeenCalled()
      expect(pasos.filter(p => p.tx > 0)).toEqual([])
      nada()
    },
  )

  it('Ruling 28: si la lectura de Stripe falla → 503 STRIPE_REFUND_CHECK_UNAVAILABLE («intenta de nuevo»), nunca se abona ni se devuelve', async () => {
    getChargeRefunds.mockRejectedValue(Object.assign(new Error('socket hang up'), { type: 'StripeConnectionError' }))
    for (const destino of ['STORE_CREDIT', 'CARD'] as const) {
      await expect(pedir({ destino, key: `llave-caida-${destino}` })).rejects.toMatchObject({
        statusCode: 503,
        code: 'STRIPE_REFUND_CHECK_UNAVAILABLE',
        message: expect.stringContaining('Intenta de nuevo'),
      })
    }
    nada()
  })

  it('hayDevolucionPorFuera: las nuestras (de las filas de este cargo) no cuentan; una ajena viva sí; fallidas o canceladas no', () => {
    type Estado = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED'
    const nuestra = (status: Estado, cardRefundId = 'cr001') => ({
      ...stateOf(status),
      status,
      metadata: { type: 'online_order_refund', cardRefundId } as Record<string, string>,
    })
    const ajena = (status: Estado) => ({ ...stateOf(status, { refundId: 're_x' }), status, metadata: {} as Record<string, string> })
    const nuestras = new Set(['cr001'])
    expect(hayDevolucionPorFuera({ amountRefundedCents: 0, refunds: [] }, nuestras)).toBe(false)
    expect(hayDevolucionPorFuera({ amountRefundedCents: 25_000, refunds: [nuestra('PENDING')] }, nuestras)).toBe(false)
    expect(
      hayDevolucionPorFuera({ amountRefundedCents: 0, refunds: [nuestra('FAILED'), ajena('CANCELED'), ajena('FAILED')] }, nuestras),
    ).toBe(false)
    expect(hayDevolucionPorFuera({ amountRefundedCents: 25_000, refunds: [ajena('SUCCEEDED')] }, nuestras)).toBe(true)
    expect(hayDevolucionPorFuera({ amountRefundedCents: 0, refunds: [ajena('PENDING')] }, nuestras)).toBe(true)
    // Con nuestra metadata pero de una fila que NO es de este cargo: no es nuestra.
    expect(hayDevolucionPorFuera({ amountRefundedCents: 25_000, refunds: [nuestra('SUCCEEDED', 'cr-de-otro')] }, nuestras)).toBe(true)
    // Más devuelto en Stripe que lo que suman las nuestras vivas: por fuera.
    expect(hayDevolucionPorFuera({ amountRefundedCents: 26_000, refunds: [nuestra('SUCCEEDED')] }, nuestras)).toBe(true)
  })

  it('repetir la misma llave de saldo no vuelve a leer Stripe, ni a abonar, ni a escribir', async () => {
    const r = await aSaldo()
    getChargeRefunds.mockClear()
    ;(abonarSaldoAFavorEnTx as jest.Mock).mockClear()
    ;(writeRefundInTx as jest.Mock).mockClear()
    const otra = await aSaldo()
    expect(otra).toMatchObject({ cardRefundId: r.cardRefundId, refundId: 'pay-refund-saldo', cardRefundStatus: 'RESOLVED', replay: true })
    expect(getChargeRefunds).not.toHaveBeenCalled()
    expect(writeRefundInTx).not.toHaveBeenCalled()
    expect(abonarSaldoAFavorEnTx).not.toHaveBeenCalled()
    expect(store.size).toBe(1)
    // Y la misma llave a la tarjeta es otra solicitud: 409.
    await expect(pedir({ key: 'llave-saldo-1' })).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED' })
  })
})
