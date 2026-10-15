/**
 * 🔴 H4 (auditoría de Codex del código, 15-oct-2026): la recuperación NO puede acreditar puntos a otro cliente por la MISMA venta.
 *
 * El caso: Ana ya recibió el sello y los puntos de la venta, pero la venta quedó pendiente (otro efecto falló o el proceso murió
 * antes de cerrarla). Desde la TPV se quita a Ana y se agrega a Beto como primario. Después corre el reconciliador: antes,
 * `grantStamp` respondía «ya sellada» (el sello es POR VENTA) y `earnPoints`, cuya deduplicación es por cliente + venta, le daba
 * a Beto los puntos de una compra que ya le había sumado a Ana. Ahora el envoltorio de la recuperación ve el EARN de otro
 * cliente y cierra la venta como OTHER_CUSTOMER sin acreditar a nadie.
 *
 * Todo real contra Postgres: la TPV (quitar y agregar cliente), el reconciliador, el envoltorio, `earnPoints` y `grantStamp`.
 */
import '../../__helpers__/integration-setup'
import prisma from '@/utils/prismaClient'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/communication/sockets/managers/socketManager', () => {
  const sm = { getServer: jest.fn(), getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() }
  return { __esModule: true, default: sm, socketManager: sm }
})
// El aviso al pase y el correo del primer sello salen hacia afuera: aquí no aportan.
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({ notifyCustomerPassUpdated: jest.fn() }))
jest.mock('@/services/wallet/firstStampEmail.service', () => ({ sendFirstStampEmailIfDue: jest.fn() }))
// El plan del negocio no es lo que se prueba: con LOYALTY_PROGRAM los puntos y los sellos corren de verdad.
jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  venueHasFeatureAccess: jest.fn().mockResolvedValue(true),
}))

import { earnPoints } from '@/services/dashboard/loyalty.dashboard.service'
import { addCustomerToOrder, removeCustomerFromOrder } from '@/services/tpv/order.tpv.service'
import { LoyaltyReconciliationJob } from '@/jobs/loyalty-reconciliation.job'

const sello = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`
let orgId: string | undefined
let venueId: string | undefined
let n = 0

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `ITEST OtroCliente ${sello}`, email: `itest-otro-${sello}@test.com`, phone: '5550000000' },
    })
  ).id
  venueId = (
    await prisma.venue.create({
      data: { name: `itest-otro-${sello}`, slug: `itest-otro-${sello}`, organizationId: orgId, timezone: 'America/Mexico_City' },
    })
  ).id
  await prisma.loyaltyConfig.create({
    data: { venueId, active: true, pointsPerDollar: 1, stampsEnabled: true, stampsRequired: 7, maxStampsPerDay: 0 },
  })
})

afterAll(async () => {
  // 🔴 Sin fixture no se limpia NADA: un filtro con venueId undefined borraría tablas enteras.
  if (!venueId || !orgId) return
  await prisma.loyaltyTransaction.deleteMany({ where: { customer: { venueId } } })
  await prisma.stampReward.deleteMany({ where: { venueId } })
  await prisma.stampEvent.deleteMany({ where: { venueId } })
  await prisma.stampCard.deleteMany({ where: { venueId } })
  await prisma.customerOrderMetric.deleteMany({ where: { venueId } })
  await prisma.activityLog.deleteMany({ where: { venueId } })
  await prisma.order.deleteMany({ where: { venueId } }) // OrderCustomer cae en cascada
  await prisma.customer.deleteMany({ where: { venueId } })
  await prisma.loyaltyConfig.deleteMany({ where: { venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
  await prisma.$disconnect()
})

async function cliente(nombre: string): Promise<string> {
  const i = ++n
  return (await prisma.customer.create({ data: { venueId: venueId!, firstName: nombre, phone: `+52556677${String(i).padStart(4, '0')}` } }))
    .id
}

/** El reconciliador REAL (su envoltorio por defecto), acotado a ESTA venta: otras pruebas pueden compartir la base. */
function reconciliadorDe(orderId: string) {
  const soloEsta = (args: any) => ({ ...args, where: { AND: [args.where, { id: orderId }] } })
  return new LoyaltyReconciliationJob({
    prisma: {
      order: {
        findMany: (args: any) => prisma.order.findMany(soloEsta(args)),
        updateMany: (args: any) => prisma.order.updateMany(soloEsta(args)),
      },
    } as never,
    cron: { start: jest.fn(), stop: jest.fn() },
    now: () => new Date(),
  })
}

describe('🔴 H4: la recuperación no le acredita a OTRO cliente lo que la venta ya le dio a uno (Postgres real)', () => {
  it('Ana sellada y con puntos → la TPV quita a Ana y pone a Beto → el reconciliador ⇒ Beto no recibe nada', async () => {
    const ana = await cliente('Ana')
    const beto = await cliente('Beto')
    const orderId = (
      await prisma.order.create({
        data: {
          venueId: venueId!,
          orderNumber: `ORD-OTRO-${sello}-${++n}`,
          subtotal: 50,
          taxAmount: 0,
          total: 50,
          status: 'COMPLETED',
          paymentStatus: 'PAID',
          // Cobrada hace un minuto; la lealtad del cobro quedó PENDIENTE (no se cerró).
          loyaltyEligibleAt: new Date(Date.now() - 60_000),
        },
      })
    ).id
    await prisma.orderCustomer.create({ data: { orderId, customerId: ana, isPrimary: true } })

    // Ana recibió su sello y sus puntos; el proceso murió antes de cerrar la venta.
    expect((await earnPoints(venueId!, ana, 50, orderId)).pointsEarned).toBe(50)

    // La TPV quita a Ana y agrega a Beto, que queda como primario.
    await removeCustomerFromOrder(venueId!, orderId, ana)
    const ligada = await addCustomerToOrder(venueId!, orderId, beto)
    expect(ligada.loyalty).toMatchObject({ stamped: false, reason: 'OTHER_CUSTOMER' })

    // El reconciliador de siempre toma la venta pendiente.
    expect(await reconciliadorDe(orderId).runNow()).toMatchObject({ scanned: 1, applied: 1, failed: 0 })

    // Beto: ni puntos ni sello ni saldo por una compra que ya era de Ana.
    expect(await prisma.loyaltyTransaction.count({ where: { orderId, customerId: beto, type: 'EARN' } })).toBe(0)
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: beto }, select: { loyaltyPoints: true } })).loyaltyPoints).toBe(0)
    expect(await prisma.stampEvent.count({ where: { venueId, orderId, type: 'EARN', stampCard: { customerId: beto } } })).toBe(0)
    // Ana conserva lo suyo: un sello y sus puntos.
    expect(await prisma.stampEvent.count({ where: { venueId, orderId, type: 'EARN', stampCard: { customerId: ana } } })).toBe(1)
    expect(await prisma.loyaltyTransaction.count({ where: { orderId, customerId: ana, type: 'EARN' } })).toBe(1)
    // Y la venta queda cerrada: el reconciliador no la vuelve a tomar 15 veces.
    const fila = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { loyaltyProcessedAt: true } })
    expect(fila.loyaltyProcessedAt).toBeInstanceOf(Date)
  })
})
