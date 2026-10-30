/**
 * Un cobro ya hecho no se corrige ni se borra desde el panel (founder 23-oct, «como Square»), contra Postgres real.
 * Antes: una venta de $100 PAID cuyo cobro se corregía a $50 (o se borraba) seguía PAID «debe $0» — la cuenta mentía y no volvía
 * al plano. Ahora el panel responde «usa Reembolso» y ni el cobro ni la cuenta cambian; lo que no es dinero se sigue corrigiendo.
 *   TEST_DATABASE_URL='postgresql://…/avoqado_cobrohecho_test_20261023' \
 *     npx jest --selectProjects=integration --runInBand --runTestsByPath tests/integration/payments/cobroHechoNoSeEdita.integration.test.ts
 * Sin limpieza a propósito: venue único en una base desechable.
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { deletePayment, updatePayment } from '@/services/dashboard/payment.dashboard.service'

const target = new URL(process.env.TEST_DATABASE_URL ?? '')
if (!['localhost', '127.0.0.1'].includes(target.hostname) || !/^\/avoqado_(?:[a-z0-9]+|cambio_r5)_test_/.test(target.pathname)) {
  throw new Error('Exige una base de prueba local y desechable (p. ej. avoqado_cobrohecho_test_20261023).')
}

let venueId = ''

beforeEach(async () => {
  venueId = `cobro-hecho-${randomUUID()}`
  await prisma.organization.create({
    data: { id: venueId, name: 'Cobro hecho org', email: `${venueId}@example.test`, phone: '5500000000' },
  })
  await prisma.venue.create({ data: { id: venueId, organizationId: venueId, name: 'Cobro hecho', slug: venueId } })
})

afterAll(() => prisma.$disconnect())

async function ventaPagada() {
  const order = await prisma.order.create({
    data: {
      venueId,
      orderNumber: randomUUID(),
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      subtotal: 100,
      taxAmount: 0,
      total: 100,
      paidAmount: 100,
      remainingBalance: 0,
      completedAt: new Date(),
    },
  })
  const payment = await prisma.payment.create({
    data: {
      venueId,
      orderId: order.id,
      amount: 100,
      tipAmount: 0,
      method: 'CASH',
      status: 'COMPLETED',
      feePercentage: 0,
      feeAmount: 0,
      netAmount: 100,
      referenceNumber: 'R1',
    },
  })
  return { order, payment }
}

const foto = async (orderId: string, paymentId: string) => {
  const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
  const p = await prisma.payment.findUnique({ where: { id: paymentId } })
  return {
    order: {
      status: o.status,
      paymentStatus: o.paymentStatus,
      paidAmount: Number(o.paidAmount),
      remainingBalance: Number(o.remainingBalance),
    },
    payment: p && { amount: Number(p.amount), tip: Number(p.tipAmount), status: p.status, method: p.method, ref: p.referenceNumber },
  }
}

describe('venta de $100 PAID con su cobro en efectivo', () => {
  it.each([
    ['corregir el importe a $50', { amount: 50 }],
    ['subir la propina', { tipAmount: 10 }],
    ['marcarlo FAILED', { status: 'FAILED' }],
    ['pasarlo a tarjeta', { method: 'CREDIT_CARD' }],
  ])('%s ⇒ 409 «usa Reembolso»; ni el cobro ni la cuenta cambian', async (_caso, cambio) => {
    const { order, payment } = await ventaPagada()
    const antes = await foto(order.id, payment.id)
    await expect(updatePayment(venueId, payment.id, cambio as never)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PAYMENT_SETTLED_USE_REFUND',
    })
    expect(await foto(order.id, payment.id)).toEqual(antes)
  })

  it('borrarlo ⇒ 409 «usa Reembolso»; el cobro sigue y la cuenta sigue cuadrando', async () => {
    const { order, payment } = await ventaPagada()
    const antes = await foto(order.id, payment.id)
    await expect(deletePayment(venueId, payment.id)).rejects.toMatchObject({ statusCode: 409, code: 'PAYMENT_SETTLED_USE_REFUND' })
    expect(await foto(order.id, payment.id)).toEqual(antes)
  })

  it('corregir la referencia (no es dinero) se guarda, aunque el formulario mande también los mismos importes', async () => {
    const { order, payment } = await ventaPagada()
    await expect(
      updatePayment(venueId, payment.id, {
        amount: 100,
        tipAmount: 0,
        method: 'CASH',
        status: 'COMPLETED',
        referenceNumber: 'R2',
      } as never),
    ).resolves.toMatchObject({ referenceNumber: 'R2' })
    expect((await foto(order.id, payment.id)).payment).toMatchObject({ amount: 100, ref: 'R2', status: 'COMPLETED' })
  })

  it('un cobro que NO se hizo (FAILED) se sigue borrando como hoy', async () => {
    const { order } = await ventaPagada()
    const fallido = await prisma.payment.create({
      data: {
        venueId,
        orderId: order.id,
        amount: 100,
        tipAmount: 0,
        method: 'CREDIT_CARD',
        status: 'FAILED',
        feePercentage: 0,
        feeAmount: 0,
        netAmount: 0,
      },
    })
    await deletePayment(venueId, fallido.id)
    expect(await prisma.payment.findUnique({ where: { id: fallido.id } })).toBeNull()
  })
})
