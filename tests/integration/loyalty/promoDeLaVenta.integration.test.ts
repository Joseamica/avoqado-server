/**
 * La decisión de la promo de una venta (plan 2026-11-12-promo-de-lealtad, Task 5), contra Postgres real: lo que la decisión lee de
 * la base (promos que cubren la hora de la venta, usos de la clienta en el día del negocio, neto de cada renglón) y el upsert del uso.
 */
import '../../__helpers__/integration-setup'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { withSerializableRetry } from '@/utils/serializableRetry'
import { decidirPromoDeLaVentaEnTx, registrarUsoEnTx } from '@/services/loyalty/promotions/promoDeLaVenta'
import type { PromoDecidida } from '@/services/loyalty/promotions/evaluarPromo'
import { createLoyaltyPromotion } from '@/services/loyalty/promotions/loyaltyPromotion.service'

// La bitácora del alta es fire-and-forget: sin esto escribiría después de la limpieza.
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

const sello = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`
let orgId: string | undefined
const venueIds: string[] = []
let n = 0

/** Un negocio por prueba: las promos de una no se cuelan en otra. */
async function negocio() {
  const v = await prisma.venue.create({
    data: {
      name: `itest-promo-${sello}-${++n}`,
      slug: `itest-promo-${sello}-${n}`,
      organizationId: orgId!,
      timezone: 'America/Mexico_City',
    },
  })
  venueIds.push(v.id)
  const c = await prisma.customer.create({ data: { venueId: v.id, firstName: `Promo ${n}` } })
  return { venueId: v.id, customerId: c.id }
}

type Renglon = Omit<Prisma.OrderItemUncheckedCreateWithoutOrderInput, 'taxAmount'>

async function venta(venueId: string, customerId: string, renglones: Renglon[] = []): Promise<string> {
  const o = await prisma.order.create({
    data: {
      venueId,
      customerId,
      orderNumber: `ORD-PROMO-${sello}-${++n}`,
      subtotal: 100,
      taxAmount: 0,
      total: 100,
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      items: { create: renglones.map(r => ({ taxAmount: 0, ...r })) },
    },
  })
  return o.id
}

const promo = (venueId: string, extra: Partial<Prisma.LoyaltyPromotionUncheckedCreateInput> = {}) =>
  prisma.loyaltyPromotion.create({
    data: { venueId, name: 'Sello doble', kind: 'MULTIPLY', multiplier: 2, startsAt: new Date('2026-11-01T06:00:00Z'), ...extra },
  })

const decidir = (a: Parameters<typeof decidirPromoDeLaVentaEnTx>[1]) =>
  withSerializableRetry(tx => decidirPromoDeLaVentaEnTx(tx, a), { reintentarInterbloqueo: true })

const registrar = (a: Parameters<typeof registrarUsoEnTx>[1]) =>
  withSerializableRetry(tx => registrarUsoEnTx(tx, a), { reintentarInterbloqueo: true })

async function categoriaYProducto(venueId: string, categoria: string, producto: string) {
  const cat = await prisma.menuCategory.create({ data: { venueId, name: categoria, slug: `${categoria.toLowerCase()}-${sello}-${++n}` } })
  const prod = await prisma.product.create({
    data: { venueId, sku: `SKU-${sello}-${++n}`, name: producto, categoryId: cat.id, price: new Prisma.Decimal(50) },
  })
  return { categoryId: cat.id, productId: prod.id }
}

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `ITEST Promo ${sello}`, email: `itest-promo-${sello}@test.com`, phone: '5550000000' },
    })
  ).id
})

afterAll(async () => {
  // 🔴 Sin fixture no se limpia NADA: un filtro vacío borraría tablas enteras.
  if (!orgId) return
  for (const venueId of venueIds) {
    if (!venueId) continue
    await prisma.loyaltyPromotionUse.deleteMany({ where: { venueId } })
    await prisma.loyaltyPromotion.deleteMany({ where: { venueId } })
    await prisma.order.deleteMany({ where: { venueId } })
    await prisma.product.deleteMany({ where: { venueId } })
    await prisma.menuCategory.deleteMany({ where: { venueId } })
    await prisma.customer.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
  }
  await prisma.organization.deleteMany({ where: { id: orgId } })
  await prisma.$disconnect()
})

describe('decidirPromoDeLaVentaEnTx (Postgres real)', () => {
  it('una venta con uso previo reusa la misma promo aunque ya se haya creado otra más nueva', async () => {
    const { venueId, customerId } = await negocio()
    // «1 vez al día»: su propio uso no la debe tumbar al volver a decidir la misma venta.
    const vieja = await promo(venueId, { name: 'Vieja', limit: 'ONCE_PER_DAY', createdAt: new Date('2026-11-01T00:00:00Z') })
    const orderId = await venta(venueId, customerId)
    const soldAt = new Date('2026-11-12T18:00:00Z')
    await prisma.loyaltyPromotionUse.create({ data: { venueId, promotionId: vieja.id, customerId, orderId, soldAt, stampsBonus: 1 } })
    const nueva = await promo(venueId, { name: 'Nueva', multiplier: 3, createdAt: new Date('2026-11-12T00:00:00Z') })

    const d = await decidir({ venueId, customerId, orderId, soldAt, amount: 100 })
    expect(d).toMatchObject({ promotionId: vieja.id, name: 'Vieja', kind: 'MULTIPLY', multiplier: 2 })
    expect(d!.montoQueCalifica.toFixed(2)).toBe('100.00')

    // Otra venta de la misma hora, sin uso: ahí sí gana la más nueva.
    const otra = await venta(venueId, customerId)
    expect((await decidir({ venueId, customerId, orderId: otra, soldAt, amount: 100 }))?.promotionId).toBe(nueva.id)
  })

  it('el uso de la venta es de OTRA clienta → null (no se reusa ni se decide de nuevo)', async () => {
    const { venueId, customerId } = await negocio()
    const otra = (await prisma.customer.create({ data: { venueId, firstName: 'Otra' } })).id
    const p = await promo(venueId)
    const orderId = await venta(venueId, customerId)
    const soldAt = new Date('2026-11-12T18:00:00Z')
    await prisma.loyaltyPromotionUse.create({ data: { venueId, promotionId: p.id, customerId: otra, orderId, soldAt, stampsBonus: 1 } })

    expect(await decidir({ venueId, customerId, orderId, soldAt, amount: 100 })).toBeNull()
  })

  it('sin uso y sin promo vigente → null', async () => {
    const { venueId, customerId } = await negocio()
    await promo(venueId, { name: 'Pasada', endsAt: new Date('2026-11-10T05:59:59.999Z') })
    await promo(venueId, { name: 'Terminada', endedAt: new Date('2026-11-12T17:00:00Z') })
    await promo(venueId, { name: 'Futura', startsAt: new Date('2026-11-13T06:00:00Z') })
    const orderId = await venta(venueId, customerId)

    expect(await decidir({ venueId, customerId, orderId, soldAt: new Date('2026-11-12T18:00:00Z'), amount: 100 })).toBeNull()
  })

  it('usos del día se cuentan en el día del negocio de soldAt', async () => {
    const { venueId, customerId } = await negocio()
    const p = await promo(venueId, { limit: 'ONCE_PER_DAY' })
    const previa = await venta(venueId, customerId)
    // 11-nov 21:00 en Ciudad de México (12-nov en UTC).
    await prisma.loyaltyPromotionUse.create({
      data: { venueId, promotionId: p.id, customerId, orderId: previa, soldAt: new Date('2026-11-12T03:00:00Z'), stampsBonus: 1 },
    })

    // 11-nov 23:30 en el negocio: mismo día del negocio → ya la usó.
    const mismaNoche = await venta(venueId, customerId)
    expect(await decidir({ venueId, customerId, orderId: mismaNoche, soldAt: new Date('2026-11-12T05:30:00Z'), amount: 100 })).toBeNull()

    // 12-nov 00:30 en el negocio: mismo día UTC que el uso, pero otro día del negocio → sí aplica.
    const madrugada = await venta(venueId, customerId)
    const d = await decidir({ venueId, customerId, orderId: madrugada, soldAt: new Date('2026-11-12T06:30:00Z'), amount: 100 })
    expect(d?.promotionId).toBe(p.id)
  })

  it('el monto que califica sale del neto de cada renglón (lo cobrado tras su descuento)', async () => {
    const { venueId, customerId } = await negocio()
    const pastel = await categoriaYProducto(venueId, 'Postres', 'Pastel')
    const cafe = await categoriaYProducto(venueId, 'Bebidas', 'Café')
    await promo(venueId, { productIds: [pastel.productId] })
    const orderId = await venta(venueId, customerId, [
      // Pastel $50 con $20 de descuento → neto $30; café $80 → neto $80. Cobrado: $110.
      { productId: pastel.productId, categoryName: 'Postres', quantity: 1, unitPrice: 50, discountAmount: 20, total: 50 },
      { productId: cafe.productId, categoryName: 'Bebidas', quantity: 1, unitPrice: 80, total: 80 },
    ])

    const d = await decidir({ venueId, customerId, orderId, soldAt: new Date('2026-11-12T18:00:00Z'), amount: 110 })
    expect(d!.montoQueCalifica.toFixed(2)).toBe('30.00')
  })

  it('promo de categoría: califica por la categoría ACTUAL del producto y por el nombre guardado en el renglón', async () => {
    const { venueId, customerId } = await negocio()
    const cafe = await categoriaYProducto(venueId, 'Bebidas', 'Café')
    const calientes = await prisma.menuCategory.create({ data: { venueId, name: 'Calientes', slug: `calientes-${sello}-${++n}` } })
    const orderId = await venta(venueId, customerId, [
      { productId: cafe.productId, categoryName: 'Bebidas', quantity: 1, unitPrice: 80, total: 80 },
    ])
    // Después de la venta, el café se mueve de «Bebidas» a «Calientes».
    await prisma.product.update({ where: { id: cafe.productId }, data: { categoryId: calientes.id } })
    const soldAt = new Date('2026-11-12T18:00:00Z')

    const porActual = await promo(venueId, {
      name: 'Calientes ×2',
      categoryIds: [calientes.id],
      createdAt: new Date('2026-11-01T00:00:00Z'),
    })
    expect((await decidir({ venueId, customerId, orderId, soldAt, amount: 80 }))?.promotionId).toBe(porActual.id)

    const porNombre = await promo(venueId, {
      name: 'Bebidas ×2',
      categoryIds: [cafe.categoryId],
      createdAt: new Date('2026-11-02T00:00:00Z'),
    })
    const d = await decidir({ venueId, customerId, orderId, soldAt, amount: 80 })
    expect(d?.promotionId).toBe(porNombre.id)
    expect(d!.montoQueCalifica.toFixed(2)).toBe('80.00')
  })
})

// Codex código r1 #2 (ruling): foto de los productos de las categorías al guardar la promo.
describe('promo de categoría con la foto de sus productos (Postgres real)', () => {
  const hoy = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' })
  const deBebidas = (venueId: string, categoryId: string) =>
    createLoyaltyPromotion(
      venueId,
      { name: 'Bebidas ×2', kind: 'MULTIPLY', multiplier: 2, startDate: hoy(), categoryIds: [categoryId] },
      null,
    )

  it('venta sin red de un producto de «Bebidas» que pasaron a «Postres» antes de sincronizar: sigue ×2', async () => {
    const { venueId, customerId } = await negocio()
    const cafe = await categoriaYProducto(venueId, 'Bebidas', 'Café')
    const postres = await prisma.menuCategory.create({ data: { venueId, name: 'Postres', slug: `postres-${sello}-${++n}` } })
    const p = await deBebidas(venueId, cafe.categoryId)
    expect((await prisma.loyaltyPromotion.findUniqueOrThrow({ where: { id: p.id } })).categoryProductIds).toEqual([cafe.productId])

    const soldAt = new Date() // la venta sin red, con la promo ya vigente
    // Antes de sincronizar, el café pasa a «Postres»: el renglón nace al sincronizar, con la categoría nueva.
    await prisma.product.update({ where: { id: cafe.productId }, data: { categoryId: postres.id } })
    const orderId = await venta(venueId, customerId, [
      { productId: cafe.productId, categoryName: 'Postres', quantity: 1, unitPrice: 80, total: 80 },
    ])

    const d = await decidir({ venueId, customerId, orderId, soldAt, amount: 80 })
    expect(d).toMatchObject({ promotionId: p.id, kind: 'MULTIPLY', multiplier: 2 })
    expect(d!.montoQueCalifica.toFixed(2)).toBe('80.00')
  })

  it('un producto que entra a la categoría DESPUÉS de crear la promo califica por su categoría actual', async () => {
    const { venueId, customerId } = await negocio()
    const cafe = await categoriaYProducto(venueId, 'Bebidas', 'Café')
    const p = await deBebidas(venueId, cafe.categoryId)
    const te = await prisma.product.create({
      data: { venueId, sku: `SKU-${sello}-${++n}`, name: 'Té', categoryId: cafe.categoryId, price: new Prisma.Decimal(40) },
    })
    expect((await prisma.loyaltyPromotion.findUniqueOrThrow({ where: { id: p.id } })).categoryProductIds).not.toContain(te.id)

    // Sin nombre de categoría en el renglón: sólo la categoría actual del producto lo hace calificar.
    const orderId = await venta(venueId, customerId, [{ productId: te.id, categoryName: null, quantity: 1, unitPrice: 40, total: 40 }])
    const d = await decidir({ venueId, customerId, orderId, soldAt: new Date(), amount: 40 })
    expect(d?.promotionId).toBe(p.id)
    expect(d!.montoQueCalifica.toFixed(2)).toBe('40.00')
  })
})

describe('registrarUsoEnTx (Postgres real)', () => {
  it('registrar dos veces (sellos y luego puntos) deja UNA fila con los dos bonos', async () => {
    const { venueId, customerId } = await negocio()
    const p = await promo(venueId)
    const orderId = await venta(venueId, customerId)
    const soldAt = new Date('2026-11-12T18:00:00Z')
    const decision = (await decidir({ venueId, customerId, orderId, soldAt, amount: 100 })) as PromoDecidida
    expect(decision.promotionId).toBe(p.id)

    await registrar({ venueId, customerId, orderId, soldAt, decision, stampsBonus: 1 })
    await registrar({ venueId, customerId, orderId, soldAt, decision, pointsBonus: 110 })

    const filas = await prisma.loyaltyPromotionUse.findMany({ where: { venueId, orderId }, take: 5 })
    expect(filas).toHaveLength(1)
    expect(filas[0]).toMatchObject({ promotionId: p.id, customerId, soldAt, stampsBonus: 1, pointsBonus: 110 })
  })

  it('sin bono en ninguna mitad no crea fila (toda fila de uso tiene bono)', async () => {
    const { venueId, customerId } = await negocio()
    await promo(venueId)
    const orderId = await venta(venueId, customerId)
    const soldAt = new Date('2026-11-12T18:00:00Z')
    const decision = (await decidir({ venueId, customerId, orderId, soldAt, amount: 100 })) as PromoDecidida

    await registrar({ venueId, customerId, orderId, soldAt, decision, stampsBonus: 0, pointsBonus: 0 })
    await registrar({ venueId, customerId, orderId, soldAt, decision })

    expect(await prisma.loyaltyPromotionUse.count({ where: { venueId, orderId } })).toBe(0)
  })
})
