// tests/integration/customer-display/promotionCarousel.integration.test.ts
import prisma from '@/utils/prismaClient'
import { buildPromotionCarousel, CAROUSEL_MAX_ITEMS } from '@/services/customer-display/promotionCarousel.service'

jest.mock('@/services/customer-display/storageOrigins', () => ({
  ...jest.requireActual('@/services/customer-display/storageOrigins'),
  configuredStorageBucket: jest.fn(() => 'bucket-de-prueba.appspot.com'),
}))

/**
 * La selección del carrusel contra Postgres: los filtros de «vendible» viven en la consulta (antes del tope), así que
 * sólo la base los puede probar. Andamiaje: una organización, un venue con su categoría y productos, y otro venue con un
 * producto ajeno. `AHORA` fijo: jueves 24-sep-2026, 15:00 en CDMX.
 */
const suffix = `car-${Date.now()}`
const AHORA = new Date('2026-09-24T21:00:00.000Z')
const HORA = 60 * 60 * 1000
let orgId: string
let venueId: string
let otroVenueId: string
let activo: string
let inactivo: string
let borrado: string
let ajeno: string

async function producto(venue: string, nombre: string, precio: string, over: Record<string, unknown> = {}) {
  const categoria = await prisma.menuCategory.findFirst({ where: { venueId: venue }, select: { id: true }, take: 1 })
  return (
    await prisma.product.create({
      data: { venueId: venue, categoryId: categoria!.id, sku: `${nombre}-${suffix}`, name: nombre, price: precio, ...over },
      select: { id: true },
    })
  ).id
}

async function promo(
  data: Record<string, unknown>,
  productos: Array<{ productId: string; quantity?: number; chargedQuantity?: number }> = [],
) {
  return prisma.promotion.create({
    data: {
      venueId,
      name: `P ${suffix}`,
      type: productos.length ? 'BUNDLE' : 'DISCOUNT',
      pricingMode: 'FIXED_TOTAL',
      status: 'PUBLISHED',
      ...data,
      ...(productos.length
        ? {
            groups: {
              create: productos.map((o, i) => ({
                name: `G${i}`,
                displayOrder: i,
                options: { create: [{ productId: o.productId, quantity: o.quantity ?? 1, chargedQuantity: o.chargedQuantity ?? 1 }] },
              })),
            },
          }
        : {}),
    },
    select: { id: true },
  })
}

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  const venue = (n: string) =>
    prisma.venue.create({
      data: { organizationId: orgId, name: `${n} ${suffix}`, slug: `${n}-${suffix}`, timezone: 'America/Mexico_City' },
      select: { id: true },
    })
  venueId = (await venue('a')).id
  otroVenueId = (await venue('b')).id
  for (const v of [venueId, otroVenueId]) await prisma.menuCategory.create({ data: { venueId: v, name: 'Todo', slug: `todo-${v}` } })
  activo = await producto(venueId, 'Cafe', '90.00')
  inactivo = await producto(venueId, 'Viejo', '90.00', { active: false })
  borrado = await producto(venueId, 'Borrado', '90.00', { deletedAt: new Date() })
  ajeno = await producto(otroVenueId, 'Ajeno', '90.00')
})

afterEach(async () => {
  if (!venueId) return // sin esta guarda, un `venueId` undefined borraría TODAS las promociones de la base (8-oct)
  await prisma.promotion.deleteMany({ where: { venueId } })
})

afterAll(async () => {
  if (!venueId || !otroVenueId) return
  await prisma.product.deleteMany({ where: { venueId: { in: [venueId, otroVenueId] } } })
  await prisma.menuCategory.deleteMany({ where: { venueId: { in: [venueId, otroVenueId] } } })
  await prisma.venue.deleteMany({ where: { id: { in: [venueId, otroVenueId] } } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

describe('buildPromotionCarousel — quién entra', () => {
  it('vigencia abierta (validUntil null) entra; vencida y en borrador no', async () => {
    const abierta = await promo({ name: 'Abierta' })
    await promo({ name: 'Vencida', validUntil: new Date(AHORA.getTime() - HORA) })
    await promo({ name: 'Borrador', status: 'DRAFT' })
    const r = await buildPromotionCarousel(venueId, AHORA)
    expect(r.carousel.map(c => c.id)).toEqual([abierta.id])
  })

  it('🔴 una promoción que no se puede vender no se anuncia: producto inactivo, borrado o de OTRO negocio', async () => {
    const buena = await promo({ name: 'Buena', priceCents: 5000 }, [{ productId: activo }])
    await promo({ name: 'Con inactivo' }, [{ productId: activo }, { productId: inactivo }])
    await promo({ name: 'Con borrado' }, [{ productId: borrado }])
    await promo({ name: 'Con ajeno' }, [{ productId: ajeno }])
    const r = await buildPromotionCarousel(venueId, AHORA)
    expect(r.carousel.map(c => c.id)).toEqual([buena.id])
    expect(r.evaluated).toBe(1) // el filtro corre EN LA BASE, antes del tope: las muertas ni se evalúan
  })

  it('🔴 1,000 futuras no desplazan a una vigente, y el tope de las futuras se reporta', async () => {
    const vigente = await promo({ name: 'Vigente', displayOrder: 999 })
    await prisma.promotion.createMany({
      data: Array.from({ length: 1_000 }, (_, i) => ({
        venueId,
        name: `F${i}`,
        type: 'DISCOUNT' as const,
        pricingMode: 'FIXED_TOTAL' as const,
        status: 'PUBLISHED' as const,
        displayOrder: 0,
        validFrom: new Date(AHORA.getTime() + HORA + i * 60_000),
      })),
    })
    const r = await buildPromotionCarousel(venueId, AHORA)
    expect(r.carousel[0].id).toBe(vigente.id) // se descarga primero
    expect(r.carousel).toHaveLength(CAROUSEL_MAX_ITEMS)
    expect(r.truncated).toBe(true)
    expect(r.evaluated).toBe(1 + 200)
    expect(r.carousel[0].presentationRank).toBe(CAROUSEL_MAX_ITEMS - 1) // pero se MUESTRA según su orden
  })

  it('entre las que abren, primero la que abre antes', async () => {
    const tarde = await promo({ name: 'Tarde', validFrom: new Date(AHORA.getTime() + 5 * HORA) })
    const pronto = await promo({ name: 'Pronto', validFrom: new Date(AHORA.getTime() + HORA) })
    const pasadoManana = await promo({ name: 'Lejos', validFrom: new Date(AHORA.getTime() + 30 * HORA) })
    const r = await buildPromotionCarousel(venueId, AHORA)
    expect(r.carousel.map(c => c.id)).toEqual([pronto.id, tarde.id])
    expect(r.carousel.map(c => c.id)).not.toContain(pasadoManana.id)
  })

  it('cerrada hoy por horario pero que abre en 24 h entra; la que no abre, no', async () => {
    const esta = await promo({ name: 'Noche', timeFrom: '20:00', timeUntil: '23:00' })
    await promo({ name: 'Domingo', daysOfWeek: [0], timeFrom: '10:00', timeUntil: '12:00' })
    const r = await buildPromotionCarousel(venueId, AHORA)
    expect(r.carousel.map(c => c.id)).toEqual([esta.id])
  })
})

describe('buildPromotionCarousel — cada tarjeta', () => {
  it('trae horario completo, precio normativo, insignia, rango y foto sólo si el origen es nuestro', async () => {
    const conFoto = await promo(
      {
        name: 'Combo',
        priceCents: 8000,
        imageUrl: 'https://storage.googleapis.com/bucket-de-prueba.appspot.com/dev/venues/x/p.png',
        daysOfWeek: [5, 1],
      },
      [{ productId: activo }],
    )
    await promo({ name: 'Ajena', imageUrl: 'https://evil.test/p.png' })
    const r = await buildPromotionCarousel(venueId, AHORA)
    const combo = r.carousel.find(c => c.id === conFoto.id)!
    expect(combo.displayPriceCents).toBe(8000) // 90.00 ≥ 80.00
    expect(combo.schedule.daysOfWeek).toEqual([1, 5])
    expect(combo.photo).toEqual({ url: expect.stringContaining('bucket-de-prueba'), version: expect.any(String) })
    expect(r.carousel.find(c => c.name === 'Ajena')!.photo).toBeNull()
    expect(r.timezone).toBe('America/Mexico_City')
  })
})

describe('buildPromotionCarousel — la huella { timezone, carousel }', () => {
  it('estable sin cambios', async () => {
    await promo({ name: 'Una' }, [{ productId: activo }])
    expect((await buildPromotionCarousel(venueId, AHORA)).fingerprint).toBe((await buildPromotionCarousel(venueId, AHORA)).fingerprint)
  })

  it('cambia al desactivar un producto de un combo', async () => {
    await promo({ name: 'Una' }, [{ productId: activo }])
    const antes = (await buildPromotionCarousel(venueId, AHORA)).fingerprint
    await prisma.product.update({ where: { id: activo }, data: { active: false } })
    try {
      expect((await buildPromotionCarousel(venueId, AHORA)).fingerprint).not.toBe(antes)
    } finally {
      await prisma.product.update({ where: { id: activo }, data: { active: true } })
    }
  })

  it('cambia al bajar el precio de un producto por debajo del precio fijo (el anuncio deja de ser demostrable)', async () => {
    await promo({ name: 'Combo', priceCents: 8000 }, [{ productId: activo }])
    const antes = await buildPromotionCarousel(venueId, AHORA)
    await prisma.product.update({ where: { id: activo }, data: { price: '70.00' } })
    try {
      const despues = await buildPromotionCarousel(venueId, AHORA)
      expect(despues.carousel[0].displayPriceCents).toBeNull()
      expect(despues.fingerprint).not.toBe(antes.fingerprint)
    } finally {
      await prisma.product.update({ where: { id: activo }, data: { price: '90.00' } })
    }
  })

  it('cambia al cambiar SÓLO la zona horaria del negocio', async () => {
    await promo({ name: 'Una' })
    const antes = (await buildPromotionCarousel(venueId, AHORA)).fingerprint
    await prisma.venue.update({ where: { id: venueId }, data: { timezone: 'America/Tijuana' } })
    try {
      expect((await buildPromotionCarousel(venueId, AHORA)).fingerprint).not.toBe(antes)
    } finally {
      await prisma.venue.update({ where: { id: venueId }, data: { timezone: 'America/Mexico_City' } })
    }
  })
})
