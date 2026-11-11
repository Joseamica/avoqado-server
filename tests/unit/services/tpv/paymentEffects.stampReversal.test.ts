import { Prisma } from '@prisma/client'
import logger from '@/config/logger'
import {
  enqueueLoyaltyReversalsInTx,
  enqueueStampReversalInTx,
  failClaimedPaymentEffect,
  runClaimedPaymentEffect,
  type PaymentEffectClaim,
} from '@/services/tpv/paymentEffects.service'
import { reverseStampForOrder } from '@/services/wallet/stampLedger.service'

jest.mock('@/services/wallet/stampLedger.service', () => ({ reverseStampForOrder: jest.fn() }))

const reverse = reverseStampForOrder as jest.Mock
const refund = { venueId: 'v1', refundPaymentId: 'r1', orderId: 'o1' }
const claim = (attempts = 1): PaymentEffectClaim =>
  ({
    ...refund,
    id: 'e1',
    paymentId: 'r1',
    kind: 'STAMP_REVERSAL',
    payload: {},
    dedupeKey: 'stamp-refund:r1:v1',
    claimToken: 'token1',
    leaseUntil: new Date(Date.now() + 120000),
    attempts,
  }) as PaymentEffectClaim

function producer(orderId: string | null = 'o1') {
  const db = {
    payment: { findFirst: jest.fn().mockResolvedValue({ orderId }) },
    paymentEffect: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
  }
  return { db, tx: db as unknown as Prisma.TransactionClient }
}

function consumer(attempts = 1) {
  const row = { ...claim(attempts), status: 'PROCESSING', lastError: null }
  const db = {
    paymentEffect: {
      findFirst: jest.fn(async (a: any) =>
        a.where.claimToken === row.claimToken && a.where.status === row.status && (!a.where.kind || a.where.kind.in.includes(row.kind))
          ? row
          : null,
      ),
      updateMany: jest.fn(async (a: any) => {
        if (a.where.claimToken !== row.claimToken || a.where.status !== row.status) return { count: 0 }
        Object.assign(row, a.data)
        return { count: 1 }
      }),
    },
    $transaction: jest.fn(async (fn: any) => fn({ $queryRaw: jest.fn().mockResolvedValue([]) })),
  }
  return { db, row }
}

beforeEach(() => {
  jest.clearAllMocks()
  reverse.mockResolvedValue({ reversed: true })
})

describe('reversa durable de sellos', () => {
  it('el gancho común encola puntos y sello en la misma transacción con claves estables', async () => {
    const { db, tx } = producer()
    await enqueueLoyaltyReversalsInTx(tx, refund)
    expect(db.paymentEffect.createMany.mock.calls.map(([a]: any) => a.data[0])).toEqual([
      expect.objectContaining({ kind: 'LOYALTY_POINTS_REVERSAL', dedupeKey: 'loyalty-points-refund:r1:v1' }),
      expect.objectContaining({ kind: 'STAMP_REVERSAL', dedupeKey: 'stamp-refund:r1:v1', paymentId: 'r1', venueId: 'v1', orderId: 'o1' }),
    ])
    for (const [arg] of db.paymentEffect.createMany.mock.calls as any) expect(arg.skipDuplicates).toBe(true)
  })

  it('sin cuenta conserva la reversa de puntos y no inventa un sello', async () => {
    const { db, tx } = producer(null)
    await enqueueLoyaltyReversalsInTx(tx, { ...refund, orderId: null })
    expect(db.paymentEffect.createMany).toHaveBeenCalledTimes(1)
    expect(db.paymentEffect.createMany.mock.calls[0][0].data[0].kind).toBe('LOYALTY_POINTS_REVERSAL')
  })

  it('el helper de sello conserva la validación del pago/venue/orden antes de escribir', async () => {
    const { db, tx } = producer('otra-orden')
    await expect(enqueueStampReversalInTx(tx, refund)).rejects.toThrow('PAYMENT_EFFECT_SOURCE_MISMATCH')
    expect(db.paymentEffect.createMany).not.toHaveBeenCalled()
  })

  it('el consumidor real de sellos termina con DONE/completedAt bajo su token', async () => {
    const { db, row } = consumer()
    expect(await runClaimedPaymentEffect(claim(), db as never)).toBe(true)
    expect(reverse).toHaveBeenCalledWith('v1', 'o1')
    expect(row).toMatchObject({ status: 'DONE', completedAt: expect.any(Date), claimToken: null, leaseUntil: null, lastError: null })
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  it('si falla la reversa, propaga, deja error visible y reintenta hasta DEAD_LETTER sin guardar texto sensible', async () => {
    const error = new Error('texto sensible del proveedor')
    reverse.mockRejectedValue(error)
    for (let attempts = 1; attempts <= 6; attempts++) {
      const { db, row } = consumer(attempts)
      await expect(runClaimedPaymentEffect(claim(attempts), db as never)).rejects.toBe(error)
      expect(row.status).toBe('PROCESSING')
      await failClaimedPaymentEffect(claim(attempts), new Date(), error, db as never)
      expect(row).toMatchObject({ status: attempts === 6 ? 'DEAD_LETTER' : 'PENDING', lastError: 'PAYMENT_EFFECT_EXECUTION_FAILED' })
    }
    expect(logger.error).toHaveBeenCalledTimes(6)
    expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain(error.message)
  })

  it('un consumidor que pierde el token tras el commit no cierra el reclamo nuevo', async () => {
    const { db, row } = consumer()
    reverse.mockImplementationOnce(async () => {
      row.claimToken = 'nuevo'
      return { reversed: true }
    })
    expect(await runClaimedPaymentEffect(claim(), db as never)).toBe(false)
    expect(row.status).toBe('PROCESSING')
    expect(row.claimToken).toBe('nuevo')
  })

  it('un efecto mal formado sin orden falla antes de llamar al consumidor, y no termina DONE', async () => {
    const { db, row } = consumer()
    Object.assign(row, { orderId: null })
    await expect(runClaimedPaymentEffect(claim(), db as never)).rejects.toThrow('STAMP_REVERSAL_ORDER_REQUIRED')
    expect(reverse).not.toHaveBeenCalled()
    expect(row.status).toBe('PROCESSING')
  })
})
