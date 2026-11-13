/**
 * Sellos con promo de lealtad (plan 2026-11-12-promo-de-lealtad, Task 6), contra Postgres real: una venta reparte N sellos en
 * partes (una por tarjeta que toca), el sobrante pasa a la tarjeta nueva, el tope del día cuenta VISITAS (parte 0) y la
 * devolución quita todo lo que dio la venta, nivel por nivel (ruling 1), sin negativos ni tocar lo canjeado.
 */
import '../../__helpers__/integration-setup'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'

// El aviso al pase y el correo del primer sello son fire-and-forget hacia afuera: aquí no aportan y dejarían trabajo vivo.
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({ notifyCustomerPassUpdated: jest.fn() }))
jest.mock('@/services/wallet/firstStampEmail.service', () => ({ sendFirstStampEmailIfDue: jest.fn() }))
// La vista previa del MCP exige el plan con lealtad; aquí sólo importa el conteo del tope.
jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  venueHasFeatureAccess: jest.fn(async () => true),
}))

import { grantStamp, reverseStampForOrder } from '@/services/wallet/stampLedger.service'
import { previewSaleStamp } from '@/services/shared/loyaltyOnLateCustomer'

const sello = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`
let orgId: string | undefined
const venueIds: string[] = []
let n = 0
const DIA = 24 * 60 * 60 * 1000

/** Un negocio por prueba (las promos de una no se cuelan en otra), con su programa de sellos y una clienta. */
async function negocio(programa: { stampsRequired: number; maxStampsPerDay?: number }) {
  const v = await prisma.venue.create({
    data: {
      name: `itest-sellopromo-${sello}-${++n}`,
      slug: `itest-sellopromo-${sello}-${n}`,
      organizationId: orgId!,
      timezone: 'America/Mexico_City',
    },
  })
  venueIds.push(v.id)
  await prisma.loyaltyConfig.create({
    data: {
      venueId: v.id,
      active: true,
      stampsEnabled: true,
      stampsRequired: programa.stampsRequired,
      maxStampsPerDay: programa.maxStampsPerDay ?? 0,
      stampRewardLabel: 'Un café gratis',
    },
  })
  const c = await prisma.customer.create({ data: { venueId: v.id, firstName: `Promo ${n}` } })
  return { venueId: v.id, customerId: c.id }
}

async function venta(venueId: string, extra: Partial<Prisma.OrderUncheckedCreateInput> = {}): Promise<string> {
  const o = await prisma.order.create({
    data: {
      venueId,
      orderNumber: `ORD-SELLOPROMO-${sello}-${++n}`,
      subtotal: 100,
      taxAmount: 0,
      total: 100,
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      ...extra,
    },
  })
  return o.id
}

const promo = (venueId: string, extra: Partial<Prisma.LoyaltyPromotionUncheckedCreateInput> = {}) =>
  prisma.loyaltyPromotion.create({
    data: { venueId, name: 'Sello doble', kind: 'MULTIPLY', multiplier: 2, startsAt: new Date(Date.now() - 3 * DIA), ...extra },
  })

const tarjeta = (venueId: string, customerId: string, cycle: number, stampsEarned: number, stampsRequired: number, llena = false) =>
  prisma.stampCard.create({
    data: { venueId, customerId, cycle, stampsEarned, stampsRequired, completedAt: llena ? new Date() : null },
  })

const tarjetas = (venueId: string, customerId: string) =>
  prisma.stampCard.findMany({
    where: { venueId, customerId },
    orderBy: { cycle: 'asc' },
    select: { id: true, cycle: true, stampsEarned: true, completedAt: true, rewards: { select: { status: true }, take: 1 } },
    take: 20,
  })

const asientos = (venueId: string, orderId: string, type: 'EARN' | 'REVERSAL') =>
  prisma.stampEvent.findMany({
    where: { venueId, orderId, type },
    orderBy: { part: 'asc' },
    select: { stampCardId: true, part: true, quantity: true, promotionId: true, createdAt: true },
    take: 20,
  })

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `ITEST SelloPromo ${sello}`, email: `itest-sellopromo-${sello}@test.com`, phone: '5550000000' },
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
    await prisma.stampReward.deleteMany({ where: { venueId } })
    await prisma.stampEvent.deleteMany({ where: { venueId } })
    await prisma.stampCard.deleteMany({ where: { venueId } })
    await prisma.loyaltyPromotion.deleteMany({ where: { venueId } })
    await prisma.order.deleteMany({ where: { venueId } })
    await prisma.customer.deleteMany({ where: { venueId } })
    await prisma.loyaltyConfig.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
  }
  await prisma.organization.deleteMany({ where: { id: orgId } })
  await prisma.$disconnect()
})

describe('grantStamp con promo (Postgres real)', () => {
  it('×2 con 3/8 → 5/8, una parte, stampsAdded 2', async () => {
    const { venueId, customerId } = await negocio({ stampsRequired: 8 })
    const p = await promo(venueId)
    await tarjeta(venueId, customerId, 1, 3, 8)
    const orderId = await venta(venueId)

    const r = await grantStamp(venueId, customerId, orderId)

    expect(r).toMatchObject({ granted: true, stampsAdded: 2, stampsEarned: 5, stampsRequired: 8, completed: false, promotionId: p.id })
    expect((await tarjetas(venueId, customerId)).map(t => t.stampsEarned)).toEqual([5])
    const earn = await asientos(venueId, orderId, 'EARN')
    expect(earn).toEqual([expect.objectContaining({ part: 0, quantity: 2, promotionId: p.id })])
    const uso = await prisma.loyaltyPromotionUse.findUnique({ where: { venueId_orderId: { venueId, orderId } } })
    expect(uso).toMatchObject({ promotionId: p.id, customerId, stampsBonus: 1, pointsBonus: 0 })
  })

  it('×2 con 7/8 → tarjeta 1 completa con premio y tarjeta 2 en 1/8; dos partes', async () => {
    const { venueId, customerId } = await negocio({ stampsRequired: 8 })
    await promo(venueId)
    const t1 = await tarjeta(venueId, customerId, 1, 7, 8)
    const orderId = await venta(venueId)

    const r = await grantStamp(venueId, customerId, orderId)

    expect(r).toMatchObject({ granted: true, stampsAdded: 2, stampCardId: t1.id, stampsEarned: 8, completed: true })
    expect(r.rewardIds).toHaveLength(1)
    expect(r.rewardId).toBe(r.rewardIds![0])
    const ts = await tarjetas(venueId, customerId)
    expect(ts.map(t => [t.cycle, t.stampsEarned, t.completedAt !== null, t.rewards[0]?.status ?? null])).toEqual([
      [1, 8, true, 'PENDING'],
      [2, 1, false, null],
    ])
    const earn = await asientos(venueId, orderId, 'EARN')
    expect(earn.map(e => [e.part, e.stampCardId, e.quantity])).toEqual([
      [0, ts[0].id, 1],
      [1, ts[1].id, 1],
    ])
  })

  it('×10 con tarjetas de 3 → 3 premios y 1/3', async () => {
    const { venueId, customerId } = await negocio({ stampsRequired: 3 })
    await promo(venueId, { multiplier: 10 })
    const orderId = await venta(venueId)

    const r = await grantStamp(venueId, customerId, orderId)

    expect(r).toMatchObject({ granted: true, stampsAdded: 10, completed: true })
    expect(r.rewardIds).toHaveLength(3)
    const ts = await tarjetas(venueId, customerId)
    expect(ts.map(t => [t.stampsEarned, t.completedAt !== null])).toEqual([
      [3, true],
      [3, true],
      [3, true],
      [1, false],
    ])
    expect(await prisma.stampReward.count({ where: { venueId, customerId, status: 'PENDING' } })).toBe(3)
    expect((await asientos(venueId, orderId, 'EARN')).map(e => e.quantity)).toEqual([3, 3, 3, 1])
    expect((await prisma.loyaltyPromotionUse.findUnique({ where: { venueId_orderId: { venueId, orderId } } }))?.stampsBonus).toBe(9)
  })

  it('segunda llamada de la misma venta → ALREADY_STAMPED y nada cambia', async () => {
    const { venueId, customerId } = await negocio({ stampsRequired: 8 })
    await promo(venueId)
    await tarjeta(venueId, customerId, 1, 7, 8)
    const orderId = await venta(venueId)
    await grantStamp(venueId, customerId, orderId)
    const antes = await tarjetas(venueId, customerId)

    const r = await grantStamp(venueId, customerId, orderId)

    expect(r).toMatchObject({ granted: false, reason: 'ALREADY_STAMPED', stampCardId: antes[0].id })
    expect(await tarjetas(venueId, customerId)).toEqual(antes)
    expect(await asientos(venueId, orderId, 'EARN')).toHaveLength(2)
    expect((await prisma.loyaltyPromotionUse.findUnique({ where: { venueId_orderId: { venueId, orderId } } }))?.stampsBonus).toBe(1)
  })

  it('dos ventas a la vez de la misma clienta con ONCE_PER_DAY → sólo una con bono', async () => {
    const { venueId, customerId } = await negocio({ stampsRequired: 10 })
    await promo(venueId, { limit: 'ONCE_PER_DAY' })
    const o1 = await venta(venueId)
    const o2 = await venta(venueId)

    const r = await Promise.all([grantStamp(venueId, customerId, o1), grantStamp(venueId, customerId, o2)])

    expect(r.map(x => x.granted)).toEqual([true, true])
    expect(r.map(x => x.stampsAdded).sort()).toEqual([1, 2])
    expect(await prisma.loyaltyPromotionUse.count({ where: { venueId, customerId } })).toBe(1)
    expect((await tarjetas(venueId, customerId))[0].stampsEarned).toBe(3)
  })

  it('venta del POS sin red con loyaltySaleAt dentro de la promo, sincronizada con la promo ya terminada → con bono', async () => {
    const { venueId, customerId } = await negocio({ stampsRequired: 10 })
    const p = await promo(venueId, { endedAt: new Date(Date.now() - 30 * 60 * 1000) })
    const vendida = new Date(Date.now() - 60 * 60 * 1000)
    const orderId = await venta(venueId, { loyaltySaleAt: vendida })

    const r = await grantStamp(venueId, customerId, orderId)

    expect(r).toMatchObject({ granted: true, stampsAdded: 2, promotionId: p.id })
    expect(await asientos(venueId, orderId, 'EARN')).toEqual([expect.objectContaining({ quantity: 2, createdAt: vendida })])
  })

  it('tope del día de 1: la venta ×2 pasa; la segunda venta del día no', async () => {
    const { venueId, customerId } = await negocio({ stampsRequired: 10, maxStampsPerDay: 1 })
    await promo(venueId)

    expect(await grantStamp(venueId, customerId, await venta(venueId))).toMatchObject({ granted: true, stampsAdded: 2 })
    expect(await grantStamp(venueId, customerId, await venta(venueId))).toEqual({ granted: false, reason: 'DAILY_LIMIT_REACHED' })
  })

  it('tope de 2 tras una venta ×2 que cruzó de tarjeta: grantStamp cuenta UNA visita (ruling 8)', async () => {
    const { venueId, customerId } = await negocio({ stampsRequired: 2, maxStampsPerDay: 2 })
    await promo(venueId)
    await tarjeta(venueId, customerId, 1, 1, 2)
    const cruza = await venta(venueId)
    await grantStamp(venueId, customerId, cruza)
    expect(await asientos(venueId, cruza, 'EARN')).toHaveLength(2)

    expect(await grantStamp(venueId, customerId, await venta(venueId))).toMatchObject({ granted: true })
    expect(await grantStamp(venueId, customerId, await venta(venueId))).toEqual({ granted: false, reason: 'DAILY_LIMIT_REACHED' })
  })

  it('tope de 2 tras una venta ×2 que cruzó de tarjeta: topeDelDiaAlcanzado dice «no alcanzado» (ruling 8)', async () => {
    const { venueId, customerId } = await negocio({ stampsRequired: 2, maxStampsPerDay: 2 })
    await promo(venueId)
    await tarjeta(venueId, customerId, 1, 1, 2)
    const cruza = await venta(venueId)
    await grantStamp(venueId, customerId, cruza)
    expect(await asientos(venueId, cruza, 'EARN')).toHaveLength(2)
    const otra = await venta(venueId, { loyaltyEligibleAt: new Date() })

    const v = await previewSaleStamp({ venueId, orderId: otra, customerId })

    expect(v).toMatchObject({ decision: 'ELIGIBLE', dailyLimitReached: false })
  })

  it('tope de seguridad: más de 11 partes lanza y no deja nada (no se alcanza con configuraciones válidas)', async () => {
    const { venueId, customerId } = await negocio({ stampsRequired: 1 })
    await promo(venueId, { multiplier: 12 })
    const orderId = await venta(venueId)

    await expect(grantStamp(venueId, customerId, orderId)).rejects.toThrow()
    expect(await asientos(venueId, orderId, 'EARN')).toHaveLength(0)
    expect(await prisma.stampCard.count({ where: { venueId, customerId } })).toBe(0)
  })
})

describe('reverseStampForOrder de una venta con promo (Postgres real)', () => {
  it('dos tarjetas abiertas con 1 sello y una llena con premio pendiente: devolver una venta de 2 quita de las abiertas y NO cancela el premio', async () => {
    const { venueId, customerId } = await negocio({ stampsRequired: 8 })
    const a = await tarjeta(venueId, customerId, 1, 8, 8, true)
    await prisma.stampReward.create({
      data: { stampCardId: a.id, customerId, venueId, status: 'PENDING', rewardType: 'FREE_PRODUCT', rewardLabel: 'Un café gratis' },
    })
    const b = await tarjeta(venueId, customerId, 2, 1, 8)
    const c = await tarjeta(venueId, customerId, 3, 1, 8)
    const orderId = await venta(venueId)
    await prisma.stampEvent.createMany({
      data: [
        { stampCardId: a.id, venueId, orderId, type: 'EARN', part: 0, quantity: 1 },
        { stampCardId: b.id, venueId, orderId, type: 'EARN', part: 1, quantity: 1 },
      ],
    })

    expect(await reverseStampForOrder(venueId, orderId)).toMatchObject({ reversed: true, stampCardId: a.id })

    const ts = await tarjetas(venueId, customerId)
    expect(ts.map(t => [t.cycle, t.stampsEarned, t.completedAt !== null, t.rewards[0]?.status ?? null])).toEqual([
      [1, 8, true, 'PENDING'],
      [2, 0, false, null],
      [3, 0, false, null],
    ])
    const rev = await asientos(venueId, orderId, 'REVERSAL')
    expect(rev.map(r => r.part)).toEqual([0, 1])
    expect(rev.map(r => r.quantity)).toEqual([-1, -1])
    expect(new Set(rev.map(r => r.stampCardId))).toEqual(new Set([b.id, c.id]))
  })

  it('devolver la venta del sobrante con el premio ya canjeado → se quitan 2, ninguna tarjeta negativa, el canje no se toca', async () => {
    const { venueId, customerId } = await negocio({ stampsRequired: 8 })
    await promo(venueId)
    await tarjeta(venueId, customerId, 1, 7, 8)
    const orderId = await venta(venueId)
    const r = await grantStamp(venueId, customerId, orderId)
    const canjeadaEn = new Date()
    await prisma.stampReward.update({ where: { id: r.rewardId! }, data: { status: 'REDEEMED', redeemedAt: canjeadaEn } })

    expect(await reverseStampForOrder(venueId, orderId)).toMatchObject({ reversed: true })

    const ts = await tarjetas(venueId, customerId)
    expect(ts.map(t => [t.stampsEarned, t.completedAt !== null, t.rewards[0]?.status ?? null])).toEqual([
      [7, true, 'REDEEMED'],
      [0, false, null],
    ])
    expect(ts.every(t => t.stampsEarned >= 0)).toBe(true)
    const rev = await asientos(venueId, orderId, 'REVERSAL')
    expect(rev.reduce((s, x) => s + x.quantity, 0)).toBe(-2)
    expect(await prisma.stampReward.findUniqueOrThrow({ where: { id: r.rewardId! } })).toMatchObject({
      status: 'REDEEMED',
      redeemedAt: canjeadaEn,
    })
  })

  it('devolver con premio pendiente → premio cancelado y tarjeta reabierta, como hoy', async () => {
    const { venueId, customerId } = await negocio({ stampsRequired: 8 })
    await promo(venueId)
    await tarjeta(venueId, customerId, 1, 7, 8)
    const orderId = await venta(venueId)
    const r = await grantStamp(venueId, customerId, orderId)

    expect(await reverseStampForOrder(venueId, orderId)).toMatchObject({ reversed: true })

    const ts = await tarjetas(venueId, customerId)
    expect(ts.map(t => [t.stampsEarned, t.completedAt !== null])).toEqual([
      [7, false],
      [0, false],
    ])
    expect((await prisma.stampReward.findUniqueOrThrow({ where: { id: r.rewardId! } })).status).toBe('CANCELLED')
    expect((await asientos(venueId, orderId, 'REVERSAL')).reduce((s, x) => s + x.quantity, 0)).toBe(-2)
  })

  it('devolver dos veces → la segunda no hace nada', async () => {
    const { venueId, customerId } = await negocio({ stampsRequired: 8 })
    await promo(venueId)
    await tarjeta(venueId, customerId, 1, 7, 8)
    const orderId = await venta(venueId)
    await grantStamp(venueId, customerId, orderId)
    await reverseStampForOrder(venueId, orderId)
    const antes = await tarjetas(venueId, customerId)

    expect(await reverseStampForOrder(venueId, orderId)).toMatchObject({ reversed: false })

    expect(await tarjetas(venueId, customerId)).toEqual(antes)
    expect(await asientos(venueId, orderId, 'REVERSAL')).toHaveLength(2)
  })
})
