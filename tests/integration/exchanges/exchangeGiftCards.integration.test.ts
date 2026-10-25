import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { createExchange } from '@/services/exchanges/exchange.service'
import { activarSobresDeCuentaPagadaEnTx } from '@/services/giftCards/giftCardLedger'
import { GiftCardReconciliationJob } from '@/jobs/giftCardReconciliation.job'
import { ORDER_LOCK_WAIT_BUDGET, lockExistingOrderForPayment } from '@/services/shared/paymentShiftClaim'
import { sembrarVentaDeTarjetas, sembrarVentaDeTarjetasSinPagar } from '../giftCards/sembrarTarjetasDeRegalo'
import { seedClothingSale } from './seedExchange'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn(async () => undefined) }))
jest.setTimeout(120000)

let s: Awaited<ReturnType<typeof seedClothingSale>>

beforeAll(() => {
  expect(new URL(process.env.TEST_DATABASE_URL!).pathname).toMatch(/^\/avoqado_cambio_(r5_)?test_202610(20|24)$/)
})
afterAll(async () => {
  if (s) await s.cleanup()
  await prisma.$disconnect()
})

it('ignores the real exchange credit pair during envelope activation and nightly reconciliation, while cash activates envelopes', async () => {
  s = await seedClothingSale()
  const p = { venueId: s.venueId, organizationId: s.organizationId, staffId: s.staffId }
  const activa = await sembrarVentaDeTarjetas({ ...p, montos: [100], metodo: 'CASH' })
  const pendiente = await sembrarVentaDeTarjetasSinPagar({ ...p, montos: [200] })
  const control = await sembrarVentaDeTarjetasSinPagar({ ...p, montos: [300] })
  const ids = [...activa.giftCardIds, ...pendiente.giftCardIds]
  const sobres = () =>
    prisma.giftCard.findMany({ where: { venueId: s.venueId, id: { in: ids } }, orderBy: { id: 'asc' }, take: ids.length })
  const antes = await sobres()
  const movimientosAntes = await prisma.giftCardActivity.count({ where: { venueId: s.venueId, giftCardId: { in: ids } } })

  const { exchange: e } = await createExchange(s.input())
  const creditIds = [...e.paymentIds, ...e.refundPaymentIds]
  const creditos = await prisma.payment.findMany({
    where: { venueId: s.venueId, id: { in: creditIds } },
    include: { tenderType: true },
    take: creditIds.length,
  })
  expect(creditos).toHaveLength(2)
  expect(creditos.map(c => c.type).sort()).toEqual(['REFUND', 'REGULAR'])
  expect(creditos.every(c => c.tenderType?.systemKind === 'EXCHANGE_CREDIT')).toBe(true)
  expect(creditos.map(c => c.amount.toNumber()).sort((a, b) => a - b)).toEqual([-500, 500])

  // Sin pasar `items`: se recorre la búsqueda real de sobres, no el retorno rápido del llamador.
  for (const orderId of [s.order.id, e.newOrderId]) {
    const r = await prisma.$transaction(async tx => {
      expect(await lockExistingOrderForPayment(tx, { venueId: s.venueId, orderId })).toBe(true)
      return activarSobresDeCuentaPagadaEnTx(tx, { venueId: s.venueId, orderId, staffId: s.staffId })
    }, ORDER_LOCK_WAIT_BUDGET)
    expect(r).toEqual({ activated: [] })
  }
  expect(await sobres()).toEqual(antes)

  // Control positivo: la noche debe encontrar y activar una venta de tarjeta pagada en efectivo.
  await prisma.payment.create({
    data: {
      venueId: s.venueId,
      orderId: control.orderId,
      amount: new Prisma.Decimal(300),
      netAmount: new Prisma.Decimal(300),
      feePercentage: new Prisma.Decimal(0),
      feeAmount: new Prisma.Decimal(0),
      method: 'CASH',
      status: 'COMPLETED',
      type: 'REGULAR',
      splitType: 'FULLPAYMENT',
      source: 'POS',
      fundsFlow: 'CASH_DRAWER',
      processedById: s.staffId,
    },
  })
  await prisma.order.update({
    where: { id: control.orderId },
    data: { paymentStatus: 'PAID', paidAmount: new Prisma.Decimal(300), remainingBalance: new Prisma.Decimal(0) },
  })
  await prisma.$executeRaw`UPDATE "Order" SET "updatedAt" = "updatedAt" - interval '1 hour' WHERE id = ${control.orderId}`
  const job = new GiftCardReconciliationJob({ cron: { start: jest.fn(), stop: jest.fn() } })
  await job.runNow()
  await job.runNow()

  expect(await sobres()).toEqual(antes)
  expect(await prisma.giftCardActivity.count({ where: { venueId: s.venueId, giftCardId: { in: ids } } })).toBe(movimientosAntes)
  expect(
    await prisma.giftCardActivity.count({
      where: { venueId: s.venueId, OR: [{ paymentId: { in: creditIds } }, { refundPaymentId: { in: creditIds } }] },
    }),
  ).toBe(0)
  const anomaliasDelNegocio = { expectedState: { path: ['venueId'], equals: s.venueId }, category: { startsWith: 'GIFT_CARD_' } }
  expect(await prisma.moneyAnomaly.count({ where: anomaliasDelNegocio })).toBe(1)
  expect(await prisma.moneyAnomaly.findFirst({ where: anomaliasDelNegocio })).toMatchObject({
    stripeEventId: `giftcard:PAID_WITH_PENDING:${control.orderId}`,
  })
  expect(await prisma.giftCard.findUniqueOrThrow({ where: { id: control.giftCardIds[0] } })).toMatchObject({
    status: 'ACTIVE',
    balance: new Prisma.Decimal(300),
  })
  expect(await prisma.giftCardActivity.count({ where: { venueId: s.venueId, giftCardId: control.giftCardIds[0], type: 'ACTIVATE' } })).toBe(
    1,
  )
})
