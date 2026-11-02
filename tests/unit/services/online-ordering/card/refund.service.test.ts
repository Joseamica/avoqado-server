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
jest.mock('@/services/payments/provider-registry', () => ({
  __esModule: true,
  getProvider: jest.fn(() => ({ refund, getRefund, listRefunds, getApplicationFeeRefundedCents })),
}))
jest.mock('@/services/dashboard/refund.dashboard.service', () => ({
  __esModule: true,
  issueRefund: jest.fn(),
  bloquearCobroParaReembolso: jest.fn(),
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
import { bloquearCobroParaReembolso, issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { sendVenueNotification } from '@/services/dashboard/notification.dashboard.service'
import { reverseStampForOrder } from '@/services/wallet/stampLedger.service'
import {
  advanceCardRefund,
  handleStripeRefundEvent,
  listCardRefunds,
  refundCardOnlineOrder,
  resolveReversedCardRefund,
  NEVER_AGAIN,
} from '@/services/online-ordering/card/refund.service'
import { sweepCardRefunds } from '@/services/online-ordering/card/refund-reconciler.service'

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
const cardRefund = {
  findUnique: jest.fn(async ({ where, select }: any) => {
    const r = rows().find(x => matches(x, where))
    // El aviso de Stripe pide la foto del cargo (Codex r1 C2): en este doble el único cargo es ch1.
    return r ? { ...r, ...(select?.charge ? { charge: CHARGE } : {}) } : null
  }),
  findFirst: jest.fn(async ({ where }: any) => {
    const r = rows().find(x => matches(x, where))
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
const pedir = (o: Partial<{ amount: string; key: string; note: string | null; reason: string; orderId: string }> = {}) =>
  refundCardOnlineOrder({
    venueId: 'v1',
    orderId: o.orderId ?? 'ord1',
    amount: D(o.amount ?? '250.00'),
    reason: (o.reason ?? 'CANCELLED_ORDER') as any,
    staffId: 'staff1',
    idempotencyKey: o.key ?? 'llave-del-panel-1',
    note: o.note === undefined ? null : o.note,
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
})

describe('listCardRefunds', () => {
  it('S9: cada devolución dice con qué llave nació, tal cual la mandó el panel (concilia su intento pendiente exacto, no por monto)', async () => {
    const r = await pedir({ key: 'llave-del-panel-1', amount: '50.00' })
    expect(await listCardRefunds('v1', 'ord1')).toEqual([expect.objectContaining({ id: r.cardRefundId, key: 'llave-del-panel-1' })])
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
