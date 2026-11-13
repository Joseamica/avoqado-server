/**
 * Puntos con promo de lealtad (plan 2026-11-12-promo-de-lealtad, Task 7), contra Postgres real: `earnPoints` decide la promo de la
 * venta bajo el candado de la clienta (y luego el de la venta), la comparte con los sellos (regla 14), guarda el bono en el EARN y
 * gasta el límite de la clienta sólo si hubo bono. La devolución proporcional de D7 sigue igual sobre los puntos ya multiplicados.
 */
import '../../__helpers__/integration-setup'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'

// El aviso al pase y el correo del primer sello son fire-and-forget hacia afuera: aquí no aportan y dejarían trabajo vivo.
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({ notifyCustomerPassUpdated: jest.fn() }))
jest.mock('@/services/wallet/firstStampEmail.service', () => ({ sendFirstStampEmailIfDue: jest.fn() }))
jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  venueHasFeatureAccess: jest.fn(async () => true),
}))

import { earnPoints } from '@/services/dashboard/loyalty.dashboard.service'
import { quitarPuntosPorReembolso } from '@/services/shared/puntosAlReembolsar'

const sello = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`
let orgId: string | undefined
const venueIds: string[] = []
let n = 0
const DIA = 24 * 60 * 60 * 1000

/** Un negocio por prueba (las promos de una no se cuelan en otra), con su programa y una clienta. Sin sellos salvo que se pidan. */
async function negocio(programa: { pointsPerVisit?: number; sellos?: { stampsRequired: number; maxStampsPerDay?: number } } = {}) {
  const v = await prisma.venue.create({
    data: {
      name: `itest-puntospromo-${sello}-${++n}`,
      slug: `itest-puntospromo-${sello}-${n}`,
      organizationId: orgId!,
      timezone: 'America/Mexico_City',
    },
  })
  venueIds.push(v.id)
  await prisma.loyaltyConfig.create({
    data: {
      venueId: v.id,
      active: true,
      pointsPerDollar: 1,
      pointsPerVisit: programa.pointsPerVisit ?? 0,
      stampsEnabled: !!programa.sellos,
      stampsRequired: programa.sellos?.stampsRequired ?? 10,
      maxStampsPerDay: programa.sellos?.maxStampsPerDay ?? 0,
      stampRewardLabel: 'Un café gratis',
    },
  })
  const c = await prisma.customer.create({ data: { venueId: v.id, firstName: `PuntosPromo ${n}` } })
  return { venueId: v.id, customerId: c.id }
}

type Renglon = Omit<Prisma.OrderItemUncheckedCreateWithoutOrderInput, 'taxAmount'>

async function venta(venueId: string, total: number, renglones: Renglon[] = []): Promise<string> {
  const o = await prisma.order.create({
    data: {
      venueId,
      orderNumber: `ORD-PUNTOSPROMO-${sello}-${++n}`,
      subtotal: total,
      taxAmount: 0,
      total,
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      items: { create: renglones.map(r => ({ taxAmount: 0, ...r })) },
    },
  })
  return o.id
}

const promo = (venueId: string, extra: Partial<Prisma.LoyaltyPromotionUncheckedCreateInput> = {}) =>
  prisma.loyaltyPromotion.create({
    data: { venueId, name: 'Puntos dobles', kind: 'MULTIPLY', multiplier: 2, startsAt: new Date(Date.now() - 3 * DIA), ...extra },
  })

async function producto(venueId: string, nombre: string) {
  const cat = await prisma.menuCategory.create({ data: { venueId, name: `Cat ${nombre}`, slug: `cat-${sello}-${++n}` } })
  return (
    await prisma.product.create({
      data: { venueId, sku: `SKU-${sello}-${++n}`, name: nombre, categoryId: cat.id, price: new Prisma.Decimal(10) },
    })
  ).id
}

const renglon = (productId: string, precio: number): Renglon => ({ productId, quantity: 1, unitPrice: precio, total: precio })

const earnDe = (orderId: string) => prisma.loyaltyTransaction.findFirstOrThrow({ where: { orderId, type: 'EARN' } })
const usoDe = (venueId: string, orderId: string) =>
  prisma.loyaltyPromotionUse.findUnique({ where: { venueId_orderId: { venueId, orderId } } })
const saldo = async (customerId: string) => (await prisma.customer.findUniqueOrThrow({ where: { id: customerId } })).loyaltyPoints

/** Un cobro o una devolución en efectivo (la reversa de puntos lee lo cobrado de la venta). */
const movimiento = (venueId: string, orderId: string, pesos: number) =>
  prisma.payment.create({
    data: {
      venueId,
      orderId,
      amount: new Prisma.Decimal(pesos),
      netAmount: new Prisma.Decimal(pesos),
      feePercentage: 0,
      feeAmount: 0,
      method: 'CASH',
      status: 'COMPLETED',
      type: pesos < 0 ? 'REFUND' : 'REGULAR',
      fundsFlow: 'CASH_DRAWER',
    },
  })

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `ITEST PuntosPromo ${sello}`, email: `itest-puntospromo-${sello}@test.com`, phone: '5550000000' },
    })
  ).id
})

afterAll(async () => {
  // 🔴 Sin fixture no se limpia NADA: un filtro vacío borraría tablas enteras.
  if (!orgId) return
  for (const venueId of venueIds) {
    if (!venueId) continue
    await prisma.walletPassOutbox.deleteMany({ where: { venueId } })
    await prisma.loyaltyPromotionUse.deleteMany({ where: { venueId } })
    await prisma.loyaltyTransaction.deleteMany({ where: { customer: { venueId } } })
    await prisma.stampReward.deleteMany({ where: { venueId } })
    await prisma.stampEvent.deleteMany({ where: { venueId } })
    await prisma.stampCard.deleteMany({ where: { venueId } })
    await prisma.loyaltyPromotion.deleteMany({ where: { venueId } })
    await prisma.payment.deleteMany({ where: { venueId } })
    await prisma.order.deleteMany({ where: { venueId } })
    await prisma.product.deleteMany({ where: { venueId } })
    await prisma.menuCategory.deleteMany({ where: { venueId } })
    await prisma.customer.deleteMany({ where: { venueId } })
    await prisma.loyaltyConfig.deleteMany({ where: { venueId } })
    await prisma.activityLog.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
  }
  await prisma.organization.deleteMany({ where: { id: orgId } })
  await prisma.$disconnect()
})

describe('earnPoints con promo (Postgres real)', () => {
  it('×2 con $100, ppd 1, bono 10 → 220 puntos; un reintento no da otra vez', async () => {
    const { venueId, customerId } = await negocio({ pointsPerVisit: 10 })
    const p = await promo(venueId)
    const orderId = await venta(venueId, 100)

    const r = await earnPoints(venueId, customerId, 100, orderId)

    expect(r).toMatchObject({ pointsEarned: 220, newBalance: 220 })
    const earn = await earnDe(orderId)
    expect(earn).toMatchObject({ points: 220, bonusPoints: 110, visitBonusPoints: 20, promotionId: p.id })
    expect(earn.baseAmount?.toFixed(2)).toBe('100.00')
    expect(earn.reason).toContain('Puntos dobles')
    expect(earn.reason).toContain('promoción')
    expect(await usoDe(venueId, orderId)).toMatchObject({ promotionId: p.id, customerId, stampsBonus: 0, pointsBonus: 110 })

    // Reintento del cobro: idempotente, ni puntos ni uso de más.
    expect(await earnPoints(venueId, customerId, 100, orderId)).toMatchObject({ pointsEarned: 220, newBalance: 220 })
    expect(await saldo(customerId)).toBe(220)
    expect((await usoDe(venueId, orderId))?.pointsBonus).toBe(110)
  })

  it('promo de producto: sólo esa línea se multiplica (más el bono por visita)', async () => {
    const { venueId, customerId } = await negocio({ pointsPerVisit: 10 })
    const a = await producto(venueId, 'Pastel')
    const b = await producto(venueId, 'Café')
    const p = await promo(venueId, { productIds: [a] })
    const orderId = await venta(venueId, 110, [renglon(a, 30), renglon(b, 80)])

    const r = await earnPoints(venueId, customerId, 110, orderId)

    // Normal: 110 + 10 = 120. Bono: (30 + 10) × (2 − 1) = 40.
    expect(r.pointsEarned).toBe(160)
    expect(await earnDe(orderId)).toMatchObject({ points: 160, bonusPoints: 40, visitBonusPoints: 20, promotionId: p.id })
  })

  it('el tope de sellos bloquea el sello, pero los puntos sí llevan bono y el uso queda gastado (regla 14)', async () => {
    const { venueId, customerId } = await negocio({ sellos: { stampsRequired: 8, maxStampsPerDay: 1 } })
    // La primera venta del día se selló antes de existir la promo.
    const primera = await venta(venueId, 100)
    expect(await earnPoints(venueId, customerId, 100, primera)).toMatchObject({ pointsEarned: 100 })
    const p = await promo(venueId, { limit: 'ONCE_PER_DAY' })

    const segunda = await venta(venueId, 100)
    const r = await earnPoints(venueId, customerId, 100, segunda)

    expect(r.pointsEarned).toBe(200)
    expect(await prisma.stampEvent.count({ where: { venueId, orderId: segunda } })).toBe(0)
    expect(await earnDe(segunda)).toMatchObject({ points: 200, bonusPoints: 100, promotionId: p.id })
    expect(await usoDe(venueId, segunda)).toMatchObject({ promotionId: p.id, stampsBonus: 0, pointsBonus: 100 })

    // «1 vez al día» ya se usó: la tercera venta del día da los puntos normales.
    const tercera = await venta(venueId, 100)
    expect((await earnPoints(venueId, customerId, 100, tercera)).pointsEarned).toBe(100)
    expect(await earnDe(tercera)).toMatchObject({ points: 100, bonusPoints: null, promotionId: null })
    expect(await usoDe(venueId, tercera)).toBeNull()
  })

  it('negocio sólo de puntos con ONCE_PER_DAY y dos ventas a la vez → una con bono', async () => {
    const { venueId, customerId } = await negocio()
    await promo(venueId, { limit: 'ONCE_PER_DAY' })
    const o1 = await venta(venueId, 100)
    const o2 = await venta(venueId, 100)

    const r = await Promise.all([earnPoints(venueId, customerId, 100, o1), earnPoints(venueId, customerId, 100, o2)])

    expect(r.map(x => x.pointsEarned).sort()).toEqual([100, 200])
    expect(await prisma.loyaltyPromotionUse.count({ where: { venueId, customerId } })).toBe(1)
    expect(await saldo(customerId)).toBe(300)
  })

  it('sellos y puntos: la venta se decide una vez y un solo uso guarda los dos bonos', async () => {
    const { venueId, customerId } = await negocio({ sellos: { stampsRequired: 8 } })
    const p = await promo(venueId)
    const orderId = await venta(venueId, 50)

    expect((await earnPoints(venueId, customerId, 50, orderId)).pointsEarned).toBe(100)

    expect(await prisma.stampEvent.findFirst({ where: { venueId, orderId, type: 'EARN' } })).toMatchObject({
      quantity: 2,
      promotionId: p.id,
    })
    expect(await earnDe(orderId)).toMatchObject({ points: 100, bonusPoints: 50, promotionId: p.id })
    expect(await usoDe(venueId, orderId)).toMatchObject({ promotionId: p.id, stampsBonus: 1, pointsBonus: 50 })
  })

  it('reembolso parcial del 50 % de una venta de $100 ×2 (220 puntos, bono por visita 10) quita 100 (ruling 3, D7)', async () => {
    const { venueId, customerId } = await negocio({ pointsPerVisit: 10 })
    await promo(venueId)
    const orderId = await venta(venueId, 100)
    await movimiento(venueId, orderId, 100)
    expect((await earnPoints(venueId, customerId, 100, orderId)).pointsEarned).toBe(220)

    const devolucion = await movimiento(venueId, orderId, -50)
    await quitarPuntosPorReembolso(venueId, devolucion.id)

    expect(await saldo(customerId)).toBe(120)
    expect(await prisma.loyaltyTransaction.findFirstOrThrow({ where: { refundPaymentId: devolucion.id } })).toMatchObject({
      type: 'ADJUST',
      points: -100,
    })
  })

  it('ONCE_PER_PROMOTION: A $0.50 + B $100 da 0 de bono y NO gasta el uso; la siguiente compra de A por $10 sí lleva bono (r2 #3)', async () => {
    const { venueId, customerId } = await negocio()
    const a = await producto(venueId, 'Galleta')
    const b = await producto(venueId, 'Pastel')
    const p = await promo(venueId, { productIds: [a], limit: 'ONCE_PER_PROMOTION' })

    const primera = await venta(venueId, 100.5, [renglon(a, 0.5), renglon(b, 100)])
    expect((await earnPoints(venueId, customerId, 100.5, primera)).pointsEarned).toBe(100)
    expect(await earnDe(primera)).toMatchObject({ points: 100, bonusPoints: null, promotionId: null })
    expect(await usoDe(venueId, primera)).toBeNull()

    const segunda = await venta(venueId, 10, [renglon(a, 10)])
    expect((await earnPoints(venueId, customerId, 10, segunda)).pointsEarned).toBe(20)
    expect(await earnDe(segunda)).toMatchObject({ points: 20, bonusPoints: 10, promotionId: p.id })
    expect(await usoDe(venueId, segunda)).toMatchObject({ promotionId: p.id, pointsBonus: 10 })
  })
})
