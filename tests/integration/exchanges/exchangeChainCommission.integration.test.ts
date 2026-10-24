import { Prisma, type PaymentEffect } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { createExchange } from '@/services/exchanges/exchange.service'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { anularComision, createRefundCommission } from '@/services/dashboard/commission/commission-calculation.service'
import { createClawback } from '@/services/dashboard/commission/commission-clawback.service'
import { comisionesBarribles } from '@/services/dashboard/staffPay/fuentesVenta'
import { enqueuePaymentEffect, enqueueRefundPaymentEffectsInTx, runClaimedPaymentEffect } from '@/services/tpv/paymentEffects.service'
import {
  asegurarBaseDePrueba,
  barreraDeFila,
  borrarMundoComisiones,
  categoria,
  cobro,
  crearMundoComisiones,
  netoVivo,
  orden,
  planear,
  procesarEfectos,
  type MundoComisiones,
} from '../commission/_mundoComisiones'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/shared/cashDrawerPosting', () => ({ postCashRefundToDrawer: jest.fn(async () => undefined) }))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn(async () => undefined) }))

let m: MundoComisiones
beforeAll(asegurarBaseDePrueba)
beforeEach(async () => {
  m = await crearMundoComisiones('cadena')
  await prisma.venue.update({ where: { id: m.venueId }, data: { type: 'CLOTHING' } })
})
afterEach(async () => {
  if (!m?.venueId) return
  await prisma.exchangeCreditLink.deleteMany({ where: { venueId: m.venueId } })
  await prisma.exchange.deleteMany({ where: { venueId: m.venueId } })
  await borrarMundoComisiones(m)
})
afterAll(() => prisma.$disconnect())

async function ventaCambiada(materializar = true, monto = 500, piezas = 1) {
  const cat = await categoria(m)
  const orderId = await orden(m, {
    subtotal: monto * piezas,
    renglones: Array.from({ length: piezas }, () => ({ categoryId: cat, precio: monto })),
  })
  const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId } })
  const pago = await cobro(m, orderId, monto * piezas, { createdAt: new Date() })
  await prisma.payment.update({ where: { id: pago }, data: { fundsFlow: 'CASH_DRAWER', source: 'POS' } })
  await planear(pago)
  if (materializar) await procesarEfectos(m)
  const { exchange } = await createExchange({
    venueId: m.venueId,
    actorStaffId: m.bea,
    body: {
      idempotencyKey: `${pago}-cambio`,
      originalPaymentId: pago,
      returned: [{ orderItemId: item.id, quantity: 1, restock: false, reason: 'TASTE' }],
      taken: [{ productId: item.productId!, quantity: 1 }],
      settlement: { kind: 'EVEN', method: null, expectedDifferenceCents: 0 },
      staffId: m.bea,
      deviceId: 'caja-cadena',
      createdAtLocal: new Date().toISOString(),
    },
  })
  return { pago, orderId, exchange, creditId: exchange.paymentIds[0] }
}
const devolverCredito = (creditId: string, amount = 50000) =>
  issueRefund({
    venueId: m.venueId,
    paymentId: creditId,
    amount,
    reason: 'RETURNED_GOODS',
    staffId: m.bea,
  })
const efectoDe = (paymentId: string) =>
  prisma.paymentEffect.findFirstOrThrow({
    where: { venueId: m.venueId, paymentId, kind: 'COMMISSION' },
  })
async function aplicar(e: PaymentEffect) {
  const claimToken = `cadena-${e.id}`
  const leaseUntil = new Date(Date.now() + 60000)
  await prisma.paymentEffect.update({ where: { id: e.id }, data: { status: 'PROCESSING', claimToken, leaseUntil, attempts: 1 } })
  return runClaimedPaymentEffect({ ...e, kind: 'COMMISSION', payload: e.payload as Prisma.InputJsonValue, claimToken, leaseUntil })
}

describe('chain commission through real enqueue and staff pay', () => {
  it('chain refund after an even exchange reverses the 5000 commission down to the staff pay amount', async () => {
    const v = await ventaCambiada()
    expect(await netoVivo({ venueId: m.venueId, staffId: m.ana })).toBe('50.00')
    const r = await devolverCredito(v.creditId)
    const e = await efectoDe(r.refundId)
    expect(e).toMatchObject({ orderId: v.exchange.newOrderId, payload: { orderId: v.orderId, staffId: m.ana, netCommission: '-50' } })
    expect(e.lastError).toBeNull()
    await procesarEfectos(m)
    expect(await netoVivo({ venueId: m.venueId, staffId: m.ana })).toBe('0.00')
    expect(await netoVivo({ venueId: m.venueId, staffId: m.bea })).toBe('0.00')
    const rango = [{ venueId: m.venueId, desde: new Date('2020-01-01T00:00:00Z'), hasta: new Date('2100-01-01T00:00:00Z') }]
    const lineas = await comisionesBarribles(
      prisma,
      {
        organizationId: m.orgId,
        periodo: { id: null, start: '2020-01-01', end: '2099-12-31' },
        sedes: [{ venueId: m.venueId, tz: 'America/Mexico_City' }],
        startDate: '2020-01-01',
      },
      { periodo: rango, participacion: rango },
      { limite: 100 },
    )
    expect(lineas.map(l => l.monto.toFixed(2)).sort()).toEqual(['-50.00', '50.00'])
    expect(lineas.reduce((s, l) => s.plus(l.monto), new Prisma.Decimal(0)).toFixed(2)).toBe('0.00')
    expect(await aplicar(await efectoDe(r.refundId))).toBe(true)
    expect(await prisma.commissionCalculation.count({ where: { paymentId: r.refundId } })).toBe(1)
  })

  it.each([false, true])('partial chain refunds total exactly the root commission (first reversal materialized=%s)', async materializar => {
    const v = await ventaCambiada()
    const a = await devolverCredito(v.creditId, 20000)
    if (materializar) await procesarEfectos(m)
    const b = await devolverCredito(v.creditId, 30000)
    expect(Number(((await efectoDe(a.refundId)).payload as Prisma.JsonObject).netCommission)).toBe(-20)
    expect(Number(((await efectoDe(b.refundId)).payload as Prisma.JsonObject).netCommission)).toBe(-30)
    await procesarEfectos(m)
    expect(await netoVivo({ venueId: m.venueId })).toBe('0.00')
  })

  it('direct and chain refunds share the root commission without counting the credit twin', async () => {
    const v = await ventaCambiada(true, 500, 2)
    const a = await devolverCredito(v.creditId, 20000)
    const b = await devolverCredito(v.pago, 50000)
    const c = await devolverCredito(v.creditId, 30000)
    expect(
      await Promise.all([a, b, c].map(async r => Number(((await efectoDe(r.refundId)).payload as Prisma.JsonObject).netCommission))),
    ).toEqual([-20, -50, -30])
    await procesarEfectos(m)
    expect(await netoVivo({ venueId: m.venueId })).toBe('0.00')
  })

  it('a refund after a second exchange still reverses the first sale commission', async () => {
    const v = await ventaCambiada()
    const item = v.exchange.lines.taken[0]
    const { exchange: segunda } = await createExchange({
      venueId: m.venueId,
      actorStaffId: m.bea,
      body: {
        idempotencyKey: `${v.creditId}-segundo`,
        originalPaymentId: v.creditId,
        returned: [{ orderItemId: item.newOrderItemIds[0], quantity: 1, restock: false, reason: 'SIZE' }],
        taken: [{ productId: item.productId, quantity: 1 }],
        settlement: { kind: 'EVEN', method: null, expectedDifferenceCents: 0 },
        staffId: m.bea,
        deviceId: 'caja-cadena',
        createdAtLocal: new Date().toISOString(),
      },
    })
    const r = await devolverCredito(segunda.paymentIds[0])
    await procesarEfectos(m)
    expect(await netoVivo({ venueId: m.venueId })).toBe('0.00')
    expect((await efectoDe(r.refundId)).status).toBe('DONE')
  })

  it('a chain snapshot must name the root order and its credit must have a matching link', async () => {
    const v = await ventaCambiada()
    const r = await devolverCredito(v.creditId)
    const e = await efectoDe(r.refundId)
    await prisma.paymentEffect.update({
      where: { id: e.id },
      data: { payload: { ...(e.payload as Prisma.JsonObject), orderId: v.exchange.newOrderId } },
    })
    await expect(aplicar(await efectoDe(r.refundId))).rejects.toThrow('INVALID_COMMISSION_SNAPSHOT')
    expect(await prisma.commissionCalculation.count({ where: { paymentId: r.refundId } })).toBe(0)
    await prisma.paymentEffect.update({ where: { id: e.id }, data: { payload: e.payload as Prisma.InputJsonValue, orderId: null } })
    await expect(aplicar(await efectoDe(r.refundId))).rejects.toThrow('INVALID_COMMISSION_SNAPSHOT')
    await prisma.exchangeCreditLink.delete({ where: { creditPaymentId: v.creditId } })
    await expect(createRefundCommission(r.refundId, v.pago)).rejects.toThrow('REFUND_COMMISSION_SOURCE_MISMATCH')
  })

  it('a chain reversal waits for the original row and applies once it materializes', async () => {
    const v = await ventaCambiada(false)
    const r = await devolverCredito(v.creditId)
    expect(await aplicar(await efectoDe(r.refundId))).toBe(false)
    expect((await efectoDe(r.refundId)).lastError).toBe('COMMISSION_AWAITS_ORIGINAL')
    await procesarEfectos(m)
    expect(await netoVivo({ venueId: m.venueId })).toBe('0.00')
    expect((await efectoDe(r.refundId)).status).toBe('DONE')
  })

  it.each(['void', 'clawback', 'queued'] as const)('root %s also voids or discards its chain reversal', async modo => {
    const v = await ventaCambiada()
    const r = await devolverCredito(v.creditId)
    if (modo !== 'queued') await procesarEfectos(m)
    const original = await prisma.commissionCalculation.findFirstOrThrow({ where: { paymentId: v.pago } })
    if (modo === 'clawback') await createClawback(original.id, m.venueId, { reason: 'CORRECTION' }, m.owner)
    else await anularComision({ calculationId: original.id, venueId: m.venueId, actorId: m.owner, motivo: 'Corrección' })
    await procesarEfectos(m)
    expect(await prisma.commissionCalculation.count({ where: { venueId: m.venueId, status: { not: 'VOIDED' } } })).toBe(0)
    expect(await netoVivo({ venueId: m.venueId })).toBe('0.00')
    expect((await efectoDe(r.refundId)).status).toBe('DONE')
  })

  it('the worker waits on the root order before applying a chain reversal', async () => {
    const v = await ventaCambiada()
    const r = await devolverCredito(v.creditId)
    const barrera = await barreraDeFila('Order', v.orderId)
    const trabajo = aplicar(await efectoDe(r.refundId))
    try {
      await barrera.esperarA(1)
      await barrera.soltar()
      expect(await trabajo).toBe(true)
    } finally {
      await barrera.soltar()
      await trabajo
    }
  })

  it('non-chain mismatched sources still fail and remain review obligations', async () => {
    const v = await ventaCambiada()
    const otro = await orden(m, { subtotal: 10 })
    const reembolso = await prisma.payment.create({
      data: {
        venueId: m.venueId,
        orderId: otro,
        amount: -10,
        netAmount: -10,
        feeAmount: 0,
        feePercentage: 0,
        method: 'CASH',
        type: 'REFUND',
        status: 'COMPLETED',
        processorData: { originalPaymentId: v.pago },
      },
    })
    await expect(createRefundCommission(reembolso.id, v.pago)).rejects.toThrow('REFUND_COMMISSION_SOURCE_MISMATCH')
    await prisma.$transaction(tx => enqueueRefundPaymentEffectsInTx(tx, reembolso.id, v.pago))
    expect((await efectoDe(reembolso.id)).payload).toMatchObject({ policyError: 'COMMISSION_SNAPSHOT_REQUIRES_REVIEW' })
    await expect(
      prisma.$transaction(tx =>
        enqueuePaymentEffect(tx, {
          venueId: m.venueId,
          paymentId: reembolso.id,
          orderId: v.orderId,
          kind: 'COMMISSION',
          dedupeKey: 'bad-source',
          payload: {},
        }),
      ),
    ).rejects.toThrow('PAYMENT_EFFECT_SOURCE_MISMATCH')
  })
})
