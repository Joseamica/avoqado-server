/**
 * R1: sin comisión ni referido por VENDER tarjetas de regalo, y por lo tanto sin sus reversas. `enqueuePaymentEffect` es el punto por
 * el que pasan todas esas obligaciones (cobro y devolución); el recibo y la reseña siguen como siempre.
 */
import { Prisma } from '@prisma/client'
import { enqueuePaymentEffect, enqueueRefundPaymentEffectsInTx } from '@/services/tpv/paymentEffects.service'

// El reverso de la comisión: una persona con comisión en el cobro original (lo que pasaría si algo se hubiera acreditado).
jest.mock('@/services/dashboard/commission/commission-calculation.service', () => ({
  createRefundCommission: jest.fn(async (_devolucion: string, _original: string, opts: { sink: (d: object) => Promise<unknown> }) => {
    await opts.sink({ venueId: 'v1', paymentId: 'ref1', orderId: 'o1', configId: 'cfg1', staffId: 'st1', netCommission: -5 })
  }),
}))

function txFalso(esDeTarjetas: boolean) {
  return {
    payment: {
      findFirst: jest.fn().mockResolvedValue({ orderId: 'o1', order: { items: esDeTarjetas ? [{ id: 'oi-gc' }] : [] } }),
    },
    paymentEffect: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
  } as unknown as Prisma.TransactionClient & { paymentEffect: { createMany: jest.Mock }; payment: { findFirst: jest.Mock } }
}
const efecto = (kind: 'COMMISSION' | 'REFERRAL' | 'RECEIPT') => ({
  venueId: 'v1',
  paymentId: 'pay1',
  orderId: 'o1',
  kind,
  dedupeKey: `${kind}:pay1`,
  payload: {},
})

describe('enqueuePaymentEffect · tarjetas de regalo (R1)', () => {
  it.each(['COMMISSION', 'REFERRAL'] as const)('🔴 cuenta de tarjetas: %s no se encola', async kind => {
    const tx = txFalso(true)
    await enqueuePaymentEffect(tx, efecto(kind))
    expect(tx.paymentEffect.createMany).not.toHaveBeenCalled()
  })

  it('cuenta de tarjetas: el recibo SÍ se encola', async () => {
    const tx = txFalso(true)
    await enqueuePaymentEffect(tx, efecto('RECEIPT'))
    expect(tx.paymentEffect.createMany).toHaveBeenCalledTimes(1)
  })

  it('regresión: cuenta de mercancía (también si se pagó con saldo) ⇒ la comisión se encola', async () => {
    const tx = txFalso(false)
    await enqueuePaymentEffect(tx, efecto('COMMISSION'))
    expect(tx.paymentEffect.createMany).toHaveBeenCalledTimes(1)
  })

  it('la marca viaja en la MISMA lectura de siempre (sin consulta nueva), y sólo para comisión y referido', async () => {
    const tx = txFalso(false)
    await enqueuePaymentEffect(tx, efecto('COMMISSION'))
    expect(tx.payment.findFirst).toHaveBeenCalledTimes(1)
    expect(tx.payment.findFirst.mock.calls[0][0].select).toEqual({
      orderId: true,
      order: {
        select: {
          items: { where: { giftCardId: { not: null } }, select: { id: true }, take: 1 },
          _count: { select: { items: { where: { giftCardId: null } } } },
        },
      },
    })
    // B6 r1: sin `relationJoins`, la marca anidada son 2 SQL más dentro de la transacción del cobro (con el FOR UPDATE tomado). Los
    // demás efectos —recibo, reseña, costo— no la usan, así que leen lo de siempre.
    const recibo = txFalso(false)
    await enqueuePaymentEffect(recibo, efecto('RECEIPT'))
    expect(recibo.payment.findFirst.mock.calls[0][0].select).toEqual({ orderId: true })
  })

  it('⭐ B6 M2 (cierre): la marca COMPLETA de giftCardMarks — una cuenta con un renglón de tarjeta Y otro sin ella NO es de tarjetas', async () => {
    const tx = txFalso(false)
    tx.payment.findFirst.mockResolvedValueOnce({ orderId: 'o1', order: { items: [{ id: 'oi-gc' }], _count: { items: 1 } } })
    await enqueuePaymentEffect(tx, efecto('COMMISSION'))
    expect(tx.paymentEffect.createMany).toHaveBeenCalledTimes(1)
    expect(tx.payment.findFirst.mock.calls[0][0].select.order.select._count).toEqual({
      select: { items: { where: { giftCardId: null } } },
    })
  })

  it('regresión: el doble de Prisma sin `order` (pruebas viejas) se comporta como antes', async () => {
    const tx = txFalso(false)
    tx.payment.findFirst.mockResolvedValueOnce({ orderId: 'o1' })
    await enqueuePaymentEffect(tx, efecto('COMMISSION'))
    expect(tx.paymentEffect.createMany).toHaveBeenCalledTimes(1)
  })
})

/** La devolución pasa por el mismo embudo: la marca se lee de la cuenta de la DEVOLUCIÓN, que es la misma cuenta del cobro original. */
describe('enqueueRefundPaymentEffectsInTx · tarjetas de regalo (R1)', () => {
  function devolucionFalsa(esDeTarjetas: boolean) {
    const doble = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(0),
      $queryRaw: jest.fn().mockResolvedValue([{ previo: '0' }]),
      payment: {
        findFirst: jest.fn().mockResolvedValue({ orderId: 'o1', order: { items: esDeTarjetas ? [{ id: 'oi-gc' }] : [] } }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ venueId: 'v1', orderId: 'o1' }),
      },
      paymentEffect: { createMany: jest.fn().mockResolvedValue({ count: 1 }), updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    }
    const tipos = () => doble.paymentEffect.createMany.mock.calls.map(([arg]) => (arg as { data: Array<{ kind: string }> }).data[0].kind)
    return { tx: doble as unknown as Prisma.TransactionClient, tipos }
  }

  it('🔴 devolver una venta de tarjetas no encola reversas de comisión ni de referido (nada se acreditó)', async () => {
    const { tx, tipos } = devolucionFalsa(true)
    await enqueueRefundPaymentEffectsInTx(tx, 'ref1', 'pay1')
    expect(tipos()).toEqual([])
  })

  it('regresión: devolver mercancía (también la pagada con saldo) revierte comisión y referido como siempre', async () => {
    const { tx, tipos } = devolucionFalsa(false)
    await enqueueRefundPaymentEffectsInTx(tx, 'ref1', 'pay1')
    expect(tipos()).toEqual(['COMMISSION', 'REFERRAL'])
  })
})
