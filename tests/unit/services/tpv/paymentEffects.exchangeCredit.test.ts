/**
 * El crédito de cambio no genera comisión en la venta nueva ni la revierte en la devolución, y no toca referidos (spec 2026-10-20
 * §7.6): `enqueuePaymentEffect` es el embudo por el que pasan la comisión de cada cobro, el referido y las reversas de una
 * devolución. Sólo la diferencia cobrada o devuelta comisiona o revierte.
 *
 * La venta nueva de un cambio no es una compra nueva, así que tampoco dispara referidos, ni con la diferencia cobrada en efectivo.
 * Su comisión sí va.
 */
import { Prisma } from '@prisma/client'
import { enqueuePaymentEffect, enqueueRefundPaymentEffectsInTx } from '@/services/tpv/paymentEffects.service'

// El reverso de la comisión: una persona con comisión en el cobro original.
jest.mock('@/services/dashboard/commission/commission-calculation.service', () => ({
  createRefundCommission: jest.fn(async (_devolucion: string, _original: string, opts: { sink: (d: object) => Promise<unknown> }) => {
    await opts.sink({ venueId: 'v', paymentId: 'ref', orderId: 'o', configId: 'cfg', staffId: 'st', netCommission: -5 })
  }),
}))

type Tender = { systemKind: string | null } | null

/** El cobro que relee el embudo (con su tender) y si su orden es la venta nueva de un cambio. */
function txFalso(tender: Tender, esVentaNuevaDeCambio = false) {
  const doble = {
    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
    $queryRaw: jest.fn().mockResolvedValue([{ previo: '0' }]),
    payment: {
      findFirst: jest.fn().mockResolvedValue({ orderId: 'o', order: { items: [], _count: { items: 1 } }, tenderType: tender }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ venueId: 'v', orderId: 'o' }),
    },
    exchange: { findUnique: jest.fn().mockResolvedValue(esVentaNuevaDeCambio ? { id: 'exch-1' } : null) },
    paymentEffect: { createMany: jest.fn().mockResolvedValue({ count: 1 }), updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
  }
  const tipos = () => doble.paymentEffect.createMany.mock.calls.map(([arg]) => (arg as { data: Array<{ kind: string }> }).data[0].kind)
  return { doble, tx: doble as unknown as Prisma.TransactionClient, tipos }
}

const efecto = (kind: 'COMMISSION' | 'REFERRAL' | 'RECEIPT') => ({
  venueId: 'v',
  paymentId: 'p',
  orderId: 'o',
  kind,
  dedupeKey: 'k',
  payload: {},
})

const CREDITO: Tender = { systemKind: 'EXCHANGE_CREDIT' }

describe('enqueuePaymentEffect · exchange credit (spec §7.6)', () => {
  it.each(['COMMISSION', 'REFERRAL'] as const)(
    'enqueuePaymentEffect skips %s for a payment whose tender is EXCHANGE_CREDIT',
    async kind => {
      const { doble, tx } = txFalso(CREDITO)
      await enqueuePaymentEffect(tx, efecto(kind))
      expect(doble.paymentEffect.createMany).not.toHaveBeenCalled()
    },
  )

  it('enqueuePaymentEffect still enqueues COMMISSION for a GIFT_CARD-tender payment and for a cash payment', async () => {
    // Usar saldo de regalo sí comisiona, y el efectivo clásico (sin tender) y un tender del negocio también.
    for (const tender of [{ systemKind: 'GIFT_CARD' }, null, { systemKind: null }] as Tender[]) {
      const { doble, tx } = txFalso(tender)
      await enqueuePaymentEffect(tx, efecto('COMMISSION'))
      expect(doble.paymentEffect.createMany).toHaveBeenCalledTimes(1)
    }
  })

  it('reads the tender in the same payment read, and only for commission and referral', async () => {
    const { doble, tx } = txFalso(null)
    await enqueuePaymentEffect(tx, efecto('COMMISSION'))
    expect(doble.payment.findFirst).toHaveBeenCalledTimes(1)
    expect(doble.payment.findFirst.mock.calls[0][0].select.tenderType).toEqual({ select: { systemKind: true } })

    const recibo = txFalso(null)
    await enqueuePaymentEffect(recibo.tx, efecto('RECEIPT'))
    expect(recibo.doble.payment.findFirst.mock.calls[0][0].select).toEqual({ orderId: true })
  })

  it('refunding with EXCHANGE_CREDIT enqueues no commission reversal and no referral reversal', async () => {
    const { tx, tipos } = txFalso(CREDITO)
    await enqueueRefundPaymentEffectsInTx(tx, 'ref', 'p')
    expect(tipos()).toEqual([])
  })

  it('regression: refunding in cash still enqueues the commission reversal and the referral reversal', async () => {
    const { tx, tipos } = txFalso(null)
    await enqueueRefundPaymentEffectsInTx(tx, 'ref', 'p')
    expect(tipos()).toEqual(['COMMISSION', 'REFERRAL'])
  })
})

describe('enqueuePaymentEffect · the new sale of an exchange never triggers referrals', () => {
  it('a REFERRAL on the new sale of an exchange is not enqueued, while the COMMISSION of the cash difference is', async () => {
    const { doble, tx, tipos } = txFalso(null, true)
    await enqueuePaymentEffect(tx, efecto('REFERRAL'))
    await enqueuePaymentEffect(tx, efecto('COMMISSION'))
    expect(tipos()).toEqual(['COMMISSION'])
    expect(doble.exchange.findUnique).toHaveBeenCalledWith({ where: { newOrderId: 'o' }, select: { id: true } })
  })

  it('a REFERRAL on any other order is enqueued, and COMMISSION never asks for the exchange', async () => {
    const { doble, tx, tipos } = txFalso(null, false)
    await enqueuePaymentEffect(tx, efecto('REFERRAL'))
    expect(tipos()).toEqual(['REFERRAL'])

    const comision = txFalso(null, true)
    await enqueuePaymentEffect(comision.tx, efecto('COMMISSION'))
    expect(comision.doble.exchange.findUnique).not.toHaveBeenCalled()
    expect(doble.exchange.findUnique).toHaveBeenCalledTimes(1)
  })
})
