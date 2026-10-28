import prisma from '@/utils/prismaClient'
import { createExchange } from '@/services/exchanges/exchange.service'
import { recordRefund } from '@/services/tpv/refund.tpv.service'
import { centavosYaDevueltos } from '@/services/shared/devueltoDeUnCobro'
import { seedClothingSale } from './seedExchange'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { broadcastToUser: jest.fn(), getBroadcastingService: jest.fn(() => null) },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn(async () => undefined) }))

// Codex rM1 P1 y decisión «A» del founder (28-oct): la terminal devuelve a la tarjeta DESPUÉS del SDK. Si un Cambio ya usó ese
// dinero, la devolución se anota (el dinero ya salió) y el Cambio pasa a revisar. Promesa:
// docs/audit/2026-10-20-cambio-de-producto/promesa-devolucion-de-terminal-tras-cambio.md
jest.setTimeout(60000)
type Seed = Awaited<ReturnType<typeof seedClothingSale>>
const fixtures: Seed[] = []
const seed = async (opts?: Parameters<typeof seedClothingSale>[0]) => {
  const s = await seedClothingSale(opts)
  fixtures.push(s)
  return s
}
beforeAll(() => {
  expect(new URL(process.env.TEST_DATABASE_URL!).pathname).toMatch(/^\/avoqado_(?:cambio_(?:fix_|r5_)?test_\d{8}|h1a_test_\d{8}(?:_\d+)?)$/)
})
afterAll(async () => {
  for (const s of fixtures) await s.cleanup()
  await prisma.$disconnect()
})

let ref = 0
const terminalRefund = (s: Seed, cents: number) =>
  recordRefund(
    s.venueId,
    {
      venueId: s.venueId,
      originalPaymentId: s.payments[0].id,
      originalOrderId: s.order.id,
      amount: cents,
      reason: 'CUSTOMER_REQUEST',
      merchantAccountId: s.payments[0].merchantAccountId,
      authorizationNumber: `AUT${++ref}`,
      referenceNumber: `REF${ref}`,
      isPartialRefund: false,
      currency: 'MXN',
      processor: 'angelpay',
      idempotencyKey: `${s.venueId}-devolucion-${ref}`,
    } as Parameters<typeof recordRefund>[1],
    s.staffId,
  )
const devuelto = async (s: Seed) =>
  centavosYaDevueltos({ processorData: (await prisma.payment.findUniqueOrThrow({ where: { id: s.payments[0].id } })).processorData as never })

describe('devolución de la terminal después de un Cambio', () => {
  it('con tarjeta: se anota, el Cambio queda por revisar y el banco sigue siendo el tope', async () => {
    const s = await seed({ card: true })
    const { exchange } = await createExchange(s.input())
    expect(exchange.status).toBe('COMPLETED')

    const refund = await terminalRefund(s, 50000)
    expect(refund).toBeTruthy()
    const fila = await prisma.payment.findFirstOrThrow({
      where: { venueId: s.venueId, type: 'REFUND', method: 'CREDIT_CARD', processorData: { path: ['originalPaymentId'], equals: s.payments[0].id } },
    })
    expect(Number(fila.amount)).toBe(-500)
    // El crédito del Cambio (500) y la devolución del banco (500): las dos salieron del mismo cobro.
    expect(await devuelto(s)).toBe(100000)

    const revisado = await prisma.exchange.findUniqueOrThrow({ where: { id: exchange.id } })
    expect(revisado).toMatchObject({ status: 'NEEDS_REVIEW', reviewReason: 'TERMINAL_REFUND_AFTER_EXCHANGE', reviewedAt: null })
    const bitacora = await prisma.activityLog.findMany({ where: { venueId: s.venueId, entityId: exchange.id, action: 'EXCHANGE_NEEDS_REVIEW' } })
    expect(bitacora).toHaveLength(1)
    expect(bitacora[0].data).toMatchObject({ reviewReason: 'TERMINAL_REFUND_AFTER_EXCHANGE', refundPaymentId: fila.id })

    // El banco ya devolvió todo: un centavo más no se anota.
    await expect(terminalRefund(s, 1)).rejects.toThrow(/exceeds remaining refundable/)
    expect(await devuelto(s)).toBe(100000)
  })

  it('en efectivo sigue rechazándose: el dinero todavía no salió', async () => {
    const s = await seed()
    const { exchange } = await createExchange(s.input())
    await expect(terminalRefund(s, 50000)).rejects.toThrow(/exceeds remaining refundable/)
    expect(await devuelto(s)).toBe(50000)
    expect((await prisma.exchange.findUniqueOrThrow({ where: { id: exchange.id } })).status).toBe('COMPLETED')
  })

  it('sin Cambio, el exceso con tarjeta se rechaza igual que hoy', async () => {
    const s = await seed({ card: true })
    await expect(terminalRefund(s, 50001)).rejects.toThrow(/exceeds remaining refundable/)
    expect(await devuelto(s)).toBe(0)
  })
})
