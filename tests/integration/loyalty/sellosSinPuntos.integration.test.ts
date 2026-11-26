/**
 * hz:be99f328:D42 (founder, «A», 25-nov-2026), contra Postgres real: la tarjeta de sellos ya no depende del interruptor de PUNTOS
 * (`LoyaltyConfig.active`). Un negocio que sólo prendió la tarjeta de sellos (la config nace con `active: false`) nunca sellaba,
 * mientras el escaneo le prometía a la clienta «esta compra le suma otro».
 *
 * `awardLoyaltyForPaidOrder` es el embudo de todos los cobros (TPV, POS con lo encolado sin red, pago manual, liga de pago y el
 * reconciliador). Aquí se prueba de verdad: sello sin puntos, el tope del día, los sellos a mano que llenan la cartilla y crean
 * el premio, el canje del premio en una venta y que con los sellos apagados no se sella.
 */
import '../../__helpers__/integration-setup'
import prisma from '@/utils/prismaClient'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/communication/sockets/managers/socketManager', () => {
  const sm = { getServer: jest.fn(), getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() }
  return { __esModule: true, default: sm, socketManager: sm }
})
// El aviso al pase y el correo del primer sello salen hacia afuera: aquí no aportan.
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn(),
  reintentarAvisosDeTarjeta: jest.fn().mockResolvedValue({ avisados: 0, fallidos: 0, ocupados: 0 }),
}))
jest.mock('@/services/wallet/firstStampEmail.service', () => ({ sendFirstStampEmailIfDue: jest.fn() }))
// El plan no es lo que se prueba: con LOYALTY_PROGRAM la lealtad corre de verdad.
jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  venueHasFeatureAccess: jest.fn().mockResolvedValue(true),
}))

import { awardLoyaltyForPaidOrder } from '@/services/shared/loyaltyOnPaidOrder'
import { adjustStamps } from '@/services/wallet/stampLedger.service'
import { redeemStampReward } from '@/services/wallet/redeemStampReward.service'

const sello = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`
let orgId: string | undefined
const venueIds: string[] = []
let n = 0

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `ITEST SellosSinPuntos ${sello}`, email: `itest-ssp-${sello}@test.com`, phone: '5550000000' },
    })
  ).id
})

afterAll(async () => {
  // 🔴 Sin fixture no se limpia NADA: un filtro vacío borraría tablas enteras.
  if (!orgId) return
  for (const venueId of venueIds) {
    if (!venueId) continue
    await prisma.walletPassOutbox.deleteMany({ where: { venueId } })
    await prisma.loyaltyTransaction.deleteMany({ where: { customer: { venueId } } })
    await prisma.orderDiscount.deleteMany({ where: { order: { venueId } } })
    await prisma.stampReward.deleteMany({ where: { venueId } })
    await prisma.stampEvent.deleteMany({ where: { venueId } })
    await prisma.stampCard.deleteMany({ where: { venueId } })
    await prisma.customerOrderMetric.deleteMany({ where: { venueId } })
    await prisma.activityLog.deleteMany({ where: { venueId } })
    await prisma.order.deleteMany({ where: { venueId } }) // OrderCustomer cae en cascada
    await prisma.customer.deleteMany({ where: { venueId } })
    await prisma.loyaltyConfig.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
  }
  await prisma.organization.deleteMany({ where: { id: orgId } })
  await prisma.$disconnect()
})

/** Un negocio por prueba con su config y una clienta. Los PUNTOS (`active`) apagados salvo que se pida. */
async function negocio(cfg: { active?: boolean; stampsEnabled?: boolean; maxStampsPerDay?: number; stampsRequired?: number } = {}) {
  const v = await prisma.venue.create({
    data: { name: `itest-ssp-${sello}-${++n}`, slug: `itest-ssp-${sello}-${n}`, organizationId: orgId!, timezone: 'America/Mexico_City' },
  })
  venueIds.push(v.id)
  await prisma.loyaltyConfig.create({
    data: {
      venueId: v.id,
      active: cfg.active ?? false,
      pointsPerDollar: 1,
      stampsEnabled: cfg.stampsEnabled ?? true,
      stampsRequired: cfg.stampsRequired ?? 2,
      maxStampsPerDay: cfg.maxStampsPerDay ?? 1,
      stampRewardType: 'FIXED_AMOUNT',
      stampRewardValue: 20,
      stampRewardLabel: 'Postre gratis',
    },
  })
  const c = await prisma.customer.create({ data: { venueId: v.id, firstName: `Clienta ${n}`, phone: `+52556699${String(n).padStart(4, '0')}` } })
  return { venueId: v.id, customerId: c.id }
}

/** Una venta pagada de $100 con la clienta como primaria, y su lealtad repartida por el embudo de los cobros. */
async function ventaPagada(venueId: string, customerId: string): Promise<string> {
  const o = await prisma.order.create({
    data: {
      venueId,
      orderNumber: `ORD-SSP-${sello}-${++n}`,
      subtotal: 100,
      taxAmount: 0,
      total: 100,
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      customerId,
      orderCustomers: { create: { customerId, isPrimary: true } },
    },
  })
  const r = await awardLoyaltyForPaidOrder({ venueId, orderId: o.id, orderTotal: 100 })
  expect(r).toMatchObject({ complete: true, errors: [] })
  return o.id
}

const sellosDeLaVenta = (venueId: string, orderId: string) =>
  prisma.stampEvent.count({ where: { venueId, orderId, type: 'EARN' } })
const puntosDe = async (customerId: string) => ({
  saldo: (await prisma.customer.findUniqueOrThrow({ where: { id: customerId }, select: { loyaltyPoints: true } })).loyaltyPoints,
  movimientos: await prisma.loyaltyTransaction.count({ where: { customerId } }),
})

describe('D42 · los sellos no dependen del interruptor de puntos (Postgres real)', () => {
  it('puntos apagados + sellos prendidos: la venta suma su sello y NO da puntos', async () => {
    const { venueId, customerId } = await negocio()
    const orderId = await ventaPagada(venueId, customerId)

    expect(await sellosDeLaVenta(venueId, orderId)).toBe(1)
    const cartilla = await prisma.stampCard.findFirstOrThrow({ where: { venueId, customerId } })
    expect(cartilla.stampsEarned).toBe(1)
    expect(await puntosDe(customerId)).toEqual({ saldo: 0, movimientos: 0 })
  })

  it('el tope de 1 sello al día se respeta con los puntos apagados', async () => {
    const { venueId, customerId } = await negocio({ maxStampsPerDay: 1 })
    const primera = await ventaPagada(venueId, customerId)
    const segunda = await ventaPagada(venueId, customerId)

    expect(await sellosDeLaVenta(venueId, primera)).toBe(1)
    expect(await sellosDeLaVenta(venueId, segunda)).toBe(0)
  })

  it('con los sellos apagados (y los puntos también) no se sella ni se dan puntos', async () => {
    const { venueId, customerId } = await negocio({ stampsEnabled: false })
    const orderId = await ventaPagada(venueId, customerId)

    expect(await sellosDeLaVenta(venueId, orderId)).toBe(0)
    expect(await prisma.stampCard.count({ where: { venueId, customerId } })).toBe(0)
    expect(await puntosDe(customerId)).toEqual({ saldo: 0, movimientos: 0 })
  })

  it('los sellos a mano llenan la cartilla, nace el premio y se canjea en una venta, todo con los puntos apagados', async () => {
    const { venueId, customerId } = await negocio({ maxStampsPerDay: 0, stampsRequired: 2 })
    await ventaPagada(venueId, customerId) // 1 de 2
    const card = await prisma.stampCard.findFirstOrThrow({ where: { venueId, customerId } })
    const version = await prisma.stampEvent.count({ where: { stampCardId: card.id } })

    const ajuste = await adjustStamps(venueId, customerId, {
      stampsEarned: 2,
      expectedStampCardId: card.id,
      expectedStampsEarned: 1,
      expectedVersion: version,
      expectedStampsRequired: 2,
      reason: 'Prueba D42: cartón de papel',
    })
    expect(ajuste).toMatchObject({ completed: true })
    const premio = await prisma.stampReward.findFirstOrThrow({ where: { venueId, customerId, status: 'PENDING' } })

    const otra = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `ORD-SSP-${sello}-${++n}`,
        subtotal: 100,
        taxAmount: 0,
        total: 100,
        status: 'PENDING',
        paymentStatus: 'PENDING',
        customerId,
        orderCustomers: { create: { customerId, isPrimary: true } },
      },
    })
    await redeemStampReward(venueId, otra.id, premio.id)

    expect((await prisma.stampReward.findUniqueOrThrow({ where: { id: premio.id } })).status).toBe('REDEEMED')
    expect(await puntosDe(customerId)).toEqual({ saldo: 0, movimientos: 0 })
  })

  it('regresión: con los puntos y los sellos prendidos, la venta da los dos', async () => {
    const { venueId, customerId } = await negocio({ active: true })
    const orderId = await ventaPagada(venueId, customerId)

    expect(await sellosDeLaVenta(venueId, orderId)).toBe(1)
    expect(await puntosDe(customerId)).toEqual({ saldo: 100, movimientos: 1 })
  })
})
